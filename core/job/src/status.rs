//! Status-reply decoding: turn the printer's reply into a reading the job
//! can act on (plan §5.7).
//!
//! The decoders are ported from the current app (`src-tauri/src/transport/
//! status.rs`), where they were checked against real printers. The rule is
//! the same: an unreadable reply is *unknown*, and unknown is never a
//! failure — a print is never blocked on a status we cannot read.

use pn_profiles::Language;

/// What a status reply says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusReading {
    /// The reply says the printer is ready.
    Ready,
    /// The reply names a fault, in plain words ("it is out of paper").
    Fault(String),
    /// The reply is in a different dialect than the profile's language:
    /// the printer is probably in the wrong mode (plan §5.7).
    WrongMode,
    /// The reply is unreadable, or there was none. Never a failure.
    Unknown,
}

/// Decide when a status reply is complete enough to read — the
/// language-blind transport stops reading here rather than waiting for the
/// printer's idle timeout. Port of `Dialect::answered`.
pub fn reply_complete(language: Language, reply: &[u8]) -> bool {
    match language {
        // Four naked bytes, one per DLE EOT question.
        Language::Escpos => reply.len() >= 4,
        // Three STX/ETX frames.
        Language::Zpl => reply.iter().filter(|&&b| b == 0x02).count() >= 3,
        // TSPL answers with a single byte; everything else: any bytes at
        // all are a start, and silence is handled by the read deadline.
        _ => !reply.is_empty(),
    }
}

/// Decode a status reply for the profile's language. `None` is silence.
pub fn decode(language: Language, reply: Option<&[u8]>) -> StatusReading {
    let reply = match reply {
        Some(r) if !r.is_empty() => r,
        _ => return StatusReading::Unknown, // silence: never a failure
    };
    match language {
        Language::Zpl => decode_zpl(reply),
        Language::Escpos => decode_escpos(reply),
        Language::Tspl => decode_tspl(reply),
        // No documented status dialect.
        Language::Cpcl | Language::Pdf => StatusReading::Unknown,
    }
}

/// Zebra's `~HS` reply: three STX/ETX frames, of which line 1 carries
/// `aaa,b,c,…` — paper-out and pause.
///
/// Line 1 has no jam flag; a real Zebra reports a jam by pausing (read
/// here) or by not answering at all (read by the silence rule).
fn decode_zpl(reply: &[u8]) -> StatusReading {
    let Some(stx) = reply.iter().position(|&b| b == 0x02) else {
        // A single well-formed ESC/POS status byte in reply to a ZPL query
        // is the classic wrong-mode signature: the head is in ESC/POS mode
        // and answered the ZPL query with its own dialect.
        if looks_like_escpos_byte(reply) {
            return StatusReading::WrongMode;
        }
        return StatusReading::Unknown;
    };
    let start = stx + 1;
    let Some(rel_end) = reply[start..].iter().position(|&b| b == 0x03) else {
        return StatusReading::Unknown;
    };
    let Ok(line) = std::str::from_utf8(&reply[start..start + rel_end]) else {
        return StatusReading::Unknown;
    };
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() < 3 {
        return StatusReading::Unknown;
    }

    let mut faults = Vec::new();
    // Compared as text rather than parsed: anything that is not exactly
    // `1` is treated as "not set", so a field we do not understand cannot
    // fail a print.
    if fields[1].trim() == "1" {
        faults.push("it is out of paper");
    }
    if fields[2].trim() == "1" {
        faults.push("it is paused");
    }
    if faults.is_empty() {
        StatusReading::Ready
    } else {
        StatusReading::Fault(faults.join("; "))
    }
}

/// The Epson `DLE EOT 1..4` real-time status: four naked reply bytes, in
/// query order.
///
/// Bits follow the Epson TM reference, which every ESC/POS printer we
/// checked copies: `n=1` bit 3 is offline; `n=2` bits 2/5/6 are cover open,
/// paper end and error; `n=3` bits 3/5/6 are cutter, unrecoverable and
/// recoverable error; `n=4` bits 5-6 are paper end. Near-end (bits 2-3 of
/// `n=4`) is deliberately not a fault: the printer still prints.
fn decode_escpos(reply: &[u8]) -> StatusReading {
    const FAULT_BITS: [u8; 4] = [
        0x08, // 1: offline
        0x64, // 2: cover | paper end | error
        0x68, // 3: cutter | unrecoverable | recoverable
        0x60, // 4: paper end (near-end 0x0C excluded)
    ];

    let mut faults = Vec::new();
    for (i, &b) in reply.iter().take(4).enumerate() {
        // Structure bits — bits 1 and 4 set, 0 and 7 clear — are fixed in
        // the spec. Anything else is job data or line noise read off a live
        // socket, and trusting it would fail a healthy print.
        if (b & 0x12) != 0x12 || (b & 0x81) != 0 {
            continue;
        }
        if b & FAULT_BITS[i] == 0 {
            continue;
        }
        match i {
            0 => faults.push("it is offline"),
            1 => {
                if b & 0x04 != 0 {
                    faults.push("its cover is open");
                }
                if b & 0x20 != 0 {
                    faults.push("it is out of paper");
                }
                if b & 0x40 != 0 {
                    faults.push("an error is set");
                }
            }
            2 => {
                if b & 0x08 != 0 {
                    faults.push("the cutter has jammed");
                }
                if b & 0x60 != 0 {
                    faults.push("an error is set");
                }
            }
            _ => faults.push("it is out of paper"),
        }
    }
    if faults.is_empty() {
        // A Zebra-style STX frame in reply to an ESC/POS query is the
        // mirror-image wrong-mode signature.
        if reply.contains(&0x02) && reply.contains(&0x03) {
            StatusReading::WrongMode
        } else {
            StatusReading::Ready
        }
    } else {
        // De-duplicate while keeping order ("it is out of paper" can be
        // named by both n=2 and n=4).
        let mut seen = std::collections::BTreeSet::new();
        let faults: Vec<&str> = faults
            .into_iter()
            .filter(|f| seen.insert((*f).to_string()))
            .collect();
        StatusReading::Fault(faults.join("; "))
    }
}

/// TSPL's `ESC !?`: exactly one byte, a bitmask whose documented values
/// (`00` normal, `01` head open, `04` out of paper … `80` other error) are
/// combinations of the same bits.
fn decode_tspl(reply: &[u8]) -> StatusReading {
    if reply.len() != 1 {
        return StatusReading::Unknown;
    }
    let b = reply[0];
    let mut faults = Vec::new();
    if b & 0x01 != 0 {
        faults.push("its print head is open");
    }
    if b & 0x02 != 0 {
        faults.push("there is a paper jam");
    }
    if b & 0x04 != 0 {
        faults.push("it is out of paper");
    }
    if b & 0x08 != 0 {
        faults.push("it has run out of ribbon");
    }
    if b & 0x10 != 0 {
        faults.push("it is paused");
    }
    if b & 0x40 != 0 {
        faults.push("its cover is open");
    }
    if b & 0x80 != 0 {
        faults.push("an error is set");
    }
    // 0x20 is "printing" — not a fault — and is the only common bit this
    // leaves out.
    if faults.is_empty() {
        StatusReading::Ready
    } else {
        StatusReading::Fault(faults.join("; "))
    }
}

/// A well-formed single ESC/POS status byte: the fixed structure bits are
/// right and the value is one the spec's bit layout can produce.
fn looks_like_escpos_byte(reply: &[u8]) -> bool {
    reply.len() == 1 && (reply[0] & 0x12) == 0x12 && (reply[0] & 0x81) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zpl_line(fields: &str) -> Vec<u8> {
        // Three STX/ETX frames; only line 1 is decoded.
        format!("\x02{fields}\x03\r\n\x02line2\x03\r\n\x02line3\x03\r\n").into_bytes()
    }

    #[test]
    fn zpl_ready() {
        assert_eq!(
            decode(
                Language::Zpl,
                Some(zpl_line("030,0,0,1234,000,0,0,0,000,0,0,0").as_slice())
            ),
            StatusReading::Ready
        );
    }

    #[test]
    fn zpl_paper_out_and_paused() {
        assert_eq!(
            decode(
                Language::Zpl,
                Some(zpl_line("030,1,1,1234,000,0,0,0,000,0,0,0").as_slice())
            ),
            StatusReading::Fault("it is out of paper; it is paused".to_string())
        );
    }

    #[test]
    fn zpl_paper_out_only() {
        assert_eq!(
            decode(
                Language::Zpl,
                Some(zpl_line("030,1,0,1234,000,0,0,0,000,0,0,0").as_slice())
            ),
            StatusReading::Fault("it is out of paper".to_string())
        );
    }

    #[test]
    fn zpl_unknown_fields_do_not_fail() {
        // Anything that is not exactly `1` is "not set".
        assert_eq!(
            decode(
                Language::Zpl,
                Some(zpl_line("030,2,0,1234,000,0,0,0,000,0,0,0").as_slice())
            ),
            StatusReading::Ready
        );
    }

    #[test]
    fn zpl_silence_is_unknown() {
        assert_eq!(decode(Language::Zpl, None), StatusReading::Unknown);
        assert_eq!(decode(Language::Zpl, Some(&[])), StatusReading::Unknown);
    }

    #[test]
    fn zpl_wants_escpos_reply_is_wrong_mode() {
        // A well-formed ESC/POS ready byte, answered a ZPL query.
        assert_eq!(
            decode(Language::Zpl, Some(&[0x12])),
            StatusReading::WrongMode
        );
    }

    #[test]
    fn zpl_garbage_is_unknown() {
        assert_eq!(
            decode(Language::Zpl, Some(b"hello".as_ref())),
            StatusReading::Unknown
        );
    }

    #[test]
    fn escpos_ready() {
        // Four structure-valid ready bytes.
        assert_eq!(
            decode(Language::Escpos, Some([0x12, 0x12, 0x12, 0x12].as_slice())),
            StatusReading::Ready
        );
    }

    #[test]
    fn escpos_offline() {
        assert_eq!(
            decode(Language::Escpos, Some([0x1e, 0x12, 0x12, 0x12].as_slice())),
            StatusReading::Fault("it is offline".to_string())
        );
    }

    #[test]
    fn escpos_paper_out_deduplicated() {
        // n=2 bit 5 and n=4 bits 5-6 both say paper end.
        assert_eq!(
            decode(Language::Escpos, Some([0x12, 0x32, 0x12, 0x72].as_slice())),
            StatusReading::Fault("it is out of paper".to_string())
        );
    }

    #[test]
    fn escpos_cover_open() {
        assert_eq!(
            decode(Language::Escpos, Some([0x12, 0x16, 0x12, 0x12].as_slice())),
            StatusReading::Fault("its cover is open".to_string())
        );
    }

    #[test]
    fn escpos_structure_invalid_byte_is_ignored() {
        // Job data read off the socket: structure bits wrong, skipped.
        assert_eq!(
            decode(Language::Escpos, Some([0x00, 0xff, 0x12, 0x12].as_slice())),
            StatusReading::Ready
        );
    }

    #[test]
    fn escpos_near_end_is_not_a_fault() {
        // n=4 near-end bits (0x0C) set: the printer still prints.
        assert_eq!(
            decode(Language::Escpos, Some([0x12, 0x12, 0x12, 0x1e].as_slice())),
            StatusReading::Ready
        );
    }

    #[test]
    fn escpos_wants_zpl_reply_is_wrong_mode() {
        // A Zebra STX frame answered an ESC/POS query.
        assert_eq!(
            decode(Language::Escpos, Some(zpl_line("030,0,0,1").as_slice())),
            StatusReading::WrongMode
        );
    }

    #[test]
    fn tspl_bits() {
        assert_eq!(decode(Language::Tspl, Some(&[0x00])), StatusReading::Ready);
        assert_eq!(
            decode(Language::Tspl, Some(&[0x04])),
            StatusReading::Fault("it is out of paper".to_string())
        );
        assert_eq!(
            decode(Language::Tspl, Some(&[0x11])),
            StatusReading::Fault("its print head is open; it is paused".to_string())
        );
        // 0x20 printing: not a fault.
        assert_eq!(decode(Language::Tspl, Some(&[0x20])), StatusReading::Ready);
        // Two bytes is not the dialect: unknown, not a failure.
        assert_eq!(
            decode(Language::Tspl, Some(&[0x00, 0x00])),
            StatusReading::Unknown
        );
    }

    #[test]
    fn cpcl_and_pdf_have_no_dialect() {
        assert_eq!(
            decode(Language::Cpcl, Some(b"@STA".as_ref())),
            StatusReading::Unknown
        );
        assert_eq!(
            decode(Language::Pdf, Some(b"ok".as_ref())),
            StatusReading::Unknown
        );
    }

    #[test]
    fn completeness_marks() {
        assert!(!reply_complete(Language::Escpos, &[0x12, 0x12]));
        assert!(reply_complete(Language::Escpos, &[0x12; 4]));
        // One of the three Zebra frames: not complete yet.
        assert!(!reply_complete(Language::Zpl, b"\x02030,0,0\x03\r\n"));
        assert!(reply_complete(
            Language::Zpl,
            zpl_line("030,0,0,1234,000,0,0,0,000,0,0,0").as_slice()
        ));
        assert!(!reply_complete(Language::Tspl, &[]));
        assert!(reply_complete(Language::Tspl, &[0x00]));
    }
}
