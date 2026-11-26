//! Windows spooler: page printers and every queue installed in Windows.
//!
//! The spooler is a durable OS queue, not a wire: `OpenPrinter` is the
//! connect, one `StartDocPrinter`/`WritePrinter`/`EndDocPrinter` is one
//! unit, and there is no status-reply channel — a spooled job ends
//! unconfirmed, which is the honest answer (plan §5.7). Pacing and close
//! delay are raw-wire concerns; the queue buffers, so the plan's chunk
//! and pause do not apply here.
//!
//! The datatype is the queue's contract: `RAW` passes bytes unchanged
//! (every command language must reach the head unaltered); `PDF` tells a
//! PDF-aware driver the payload is a PDF. Declaring `PDF` to a queue
//! whose print processor does not offer it fails `StartDocPrinter` with
//! 1804, which [`describe_start_doc_error`] reads back as plain words.
//!
//! The queue's *offered* datatypes (the live `EnumPrintProcessorDatatypes`
//! query behind [`choose_datatype`]) land with printer discovery; until
//! then the caller declares what the job is and a refusal is reported
//! readably.

#[cfg(windows)]
use std::ffi::CString;
#[cfg(windows)]
use std::ptr::null_mut;

#[cfg(windows)]
use crate::{SendError, SendPlan, Transport, UnitReport};

/// Which spooler datatype to declare for a job.
///
/// `RAW` passes bytes unchanged; `PDF` tells a PDF-aware driver the
/// payload is a PDF. A PDF sent as `RAW` to a GDI-only queue prints as
/// garbage, and `RAW` is correct for every command language (ESC/POS,
/// ZPL, TSPL, CPCL, bare raster) which must reach the head unaltered.
pub fn spool_datatype(mime_type: &str) -> &'static str {
    if mime_type == "application/pdf" {
        "PDF"
    } else {
        "RAW"
    }
}

/// Whether a datatype list offers `PDF`.
///
/// `None` means the *list* is unknown (remote queue, access denied, the
/// call failed) — not that the queue lacks PDF, so callers must not read
/// it as "no PDF". The match ignores case and surrounding spaces, so a
/// driver's ` Pdf ` entry counts.
pub fn offers_pdf_datatype(offered: Option<&[String]>) -> Option<bool> {
    offered.map(|list| list.iter().any(|d| d.trim().eq_ignore_ascii_case("pdf")))
}

/// A `\\server\share` port is a remote queue: its driver lives on the
/// server, so this machine cannot know whether it offers `PDF` — and
/// probing a down server can stall the list. Best effort: leave the hint
/// unknown.
pub fn remote_share_port(port: &str) -> bool {
    port.starts_with("\\\\")
}

/// The datatype to declare for a job, given what the queue's print
/// processor offers.
///
/// `spool_datatype` says what a job *wants*; this says what the queue
/// *can take*. The stock `winprint` processor lists `RAW`, `NT EMF` and
/// `TEXT`, so declaring `PDF` there makes `StartDocPrinter` fail with
/// error 1804. `PDF` is used only when the queue offers it.
///
/// - `offered` is `None` when the list could not be read (remote queue,
///   access denied): the wanted datatype is kept, and a refusal is
///   reported readably by [`describe_start_doc_error`].
/// - A PDF for a queue that offers no `PDF` falls back to `RAW`, which is
///   what worked before on printers that read PDF directly. On a queue
///   whose driver only understands GDI that prints the PDF source, so the
///   caller logs the fallback.
///
/// Command languages are always `RAW` and never consult the list.
pub fn choose_datatype(mime_type: &str, offered: Option<&[String]>) -> &'static str {
    let wanted = spool_datatype(mime_type);
    if wanted != "PDF" {
        return wanted;
    }
    match offers_pdf_datatype(offered) {
        // Readable list without PDF: fall back to RAW.
        Some(false) => "RAW",
        // Offers PDF, or the list is unreadable: keep what the job wants.
        Some(true) | None => wanted,
    }
}

/// `StartDocPrinter` failed with `code`: say what it means.
///
/// 1804 is `ERROR_INVALID_DATATYPE`, the spooler's answer when the print
/// processor does not offer the declared datatype. Other codes keep the
/// raw number, which is all that is known.
pub fn describe_start_doc_error(printer: &str, datatype: &str, code: u32) -> String {
    const ERROR_INVALID_DATATYPE: u32 = 1804;
    if code == ERROR_INVALID_DATATYPE {
        format!(
            "Printer `{printer}` does not accept {datatype} jobs (Windows error 1804, invalid data type): its print processor does not offer that datatype"
        )
    } else {
        format!("StartDocPrinter failed: {code}")
    }
}

/// `WritePrinter` can return success having taken fewer bytes than offered,
/// which would print a truncated job as if it were complete.
pub fn ensure_fully_written(written: u32, expected: usize) -> Result<(), String> {
    if written as usize == expected {
        Ok(())
    } else {
        Err(format!(
            "WritePrinter wrote {written} of {expected} bytes; the job is incomplete"
        ))
    }
}

/// `PRINTER_INFO_2` status bits (winspool.h) that mean a job cannot print.
///
/// Returns the reason, or `None` when the queue looks ready. Kept free of
/// Windows types so it is unit-tested on every platform.
pub fn spooler_status_problem(status: u32) -> Option<&'static str> {
    const ERROR: u32 = 0x0000_0002;
    const PAPER_JAM: u32 = 0x0000_0008;
    const PAPER_OUT: u32 = 0x0000_0010;
    const OFFLINE: u32 = 0x0000_0080;
    const NOT_AVAILABLE: u32 = 0x0000_1000;
    const NO_TONER: u32 = 0x0004_0000;
    const DOOR_OPEN: u32 = 0x0040_0000;

    if status & OFFLINE != 0 {
        Some("offline")
    } else if status & NOT_AVAILABLE != 0 {
        Some("not available")
    } else if status & PAPER_OUT != 0 {
        Some("out of paper")
    } else if status & PAPER_JAM != 0 {
        Some("paper jammed")
    } else if status & DOOR_OPEN != 0 {
        Some("cover open")
    } else if status & NO_TONER != 0 {
        Some("out of toner")
    } else if status & ERROR != 0 {
        Some("reporting an error")
    } else {
        None
    }
}

#[cfg(windows)]
#[allow(clippy::upper_case_acronyms)]
mod winapi {
    use std::os::raw::{c_char, c_void};

    pub type HANDLE = *mut c_void;
    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type LPSTR = *mut c_char;
    pub type LPVOID = *mut c_void;
    pub type LPDWORD = *mut DWORD;

    /// `DOC_INFO_1A` (winspool.h): one document header.
    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct DOC_INFO_1A {
        pub pDocName: LPSTR,
        pub pOutputFile: LPSTR,
        pub pDatatype: LPSTR,
    }

    // The printer spooler functions live in winspool.drv.
    #[link(name = "winspool")]
    extern "system" {
        pub fn OpenPrinterA(
            pPrinterName: LPSTR,
            phPrinter: *mut HANDLE,
            pDefault: *mut c_void,
        ) -> BOOL;
        pub fn ClosePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartDocPrinterA(
            hPrinter: HANDLE,
            Level: DWORD,
            pDocInfo: *mut DOC_INFO_1A,
        ) -> DWORD;
        pub fn EndDocPrinter(hPrinter: HANDLE) -> BOOL;
        pub fn WritePrinter(
            hPrinter: HANDLE,
            pBuf: LPVOID,
            cbBuf: DWORD,
            pcWritten: LPDWORD,
        ) -> BOOL;
        pub fn GetLastError() -> DWORD;
    }
}

#[cfg(windows)]
/// One open spooler queue — the transport's "connection".
pub struct WindowsSpoolerTransport {
    handle: winapi::HANDLE,
    printer_name: String,
    datatype: &'static str,
}

#[cfg(windows)]
impl WindowsSpoolerTransport {
    /// Open the queue named `printer_name`, declaring `datatype` for its
    /// documents. Fails with a retryable [`SendError::Connect`] when the
    /// queue does not exist or cannot be opened.
    pub fn connect(printer_name: &str, datatype: &'static str) -> Result<Self, SendError> {
        use winapi::*;

        let name = CString::new(printer_name.to_string())
            .map_err(|e| SendError::Connect(format!("invalid printer name: {e}")))?;
        let mut handle: HANDLE = null_mut();
        let opened = unsafe { OpenPrinterA(name.as_ptr() as *mut _, &mut handle, null_mut()) };
        if opened == 0 {
            let code = unsafe { GetLastError() };
            return Err(SendError::Connect(format!(
                "OpenPrinter failed for `{printer_name}`: {code}"
            )));
        }
        Ok(Self {
            handle,
            printer_name: printer_name.to_string(),
            datatype,
        })
    }
}

#[cfg(windows)]
impl Drop for WindowsSpoolerTransport {
    fn drop(&mut self) {
        unsafe { winapi::ClosePrinter(self.handle) };
    }
}

#[cfg(windows)]
impl std::fmt::Debug for WindowsSpoolerTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The handle is a raw pointer; name and datatype are what matter.
        f.debug_struct("WindowsSpoolerTransport")
            .field("printer_name", &self.printer_name)
            .field("datatype", &self.datatype)
            .finish()
    }
}

#[cfg(windows)]
impl Transport for WindowsSpoolerTransport {
    fn send_unit(&mut self, data: &[u8], _plan: &SendPlan) -> UnitReport {
        use winapi::*;

        // The queue buffers the document, so the plan's chunk and pause
        // (raw-wire pacing) do not apply to a spooled unit.
        let doc_name = CString::new("PrintNinja Job").expect("static, no NUL");
        let datatype = CString::new(self.datatype).expect("static, no NUL");
        let doc_info = DOC_INFO_1A {
            pDocName: doc_name.as_ptr() as *mut _,
            pOutputFile: null_mut(),
            pDatatype: datatype.as_ptr() as *mut _,
        };
        let started = unsafe { StartDocPrinterA(self.handle, 1, &doc_info as *const _ as *mut _) };
        if started == 0 {
            // Read the code before anything else can overwrite it.
            let code = unsafe { GetLastError() };
            return UnitReport {
                bytes_written: 0,
                error: Some(SendError::Io(describe_start_doc_error(
                    &self.printer_name,
                    self.datatype,
                    code,
                ))),
            };
        }
        let mut written: DWORD = 0;
        let result = unsafe {
            WritePrinter(
                self.handle,
                data.as_ptr() as *mut _,
                data.len() as DWORD,
                &mut written,
            )
        };
        // Read the error before the cleanup call below can overwrite it.
        let write_error = if result == 0 {
            Some(unsafe { GetLastError() })
        } else {
            None
        };
        unsafe { EndDocPrinter(self.handle) };

        if let Some(code) = write_error {
            return UnitReport {
                bytes_written: 0,
                error: Some(SendError::Io(format!("WritePrinter failed: {code}"))),
            };
        }
        match ensure_fully_written(written, data.len()) {
            Ok(()) => UnitReport::ok(data.len() as u64),
            Err(msg) => UnitReport {
                bytes_written: written as u64,
                error: Some(SendError::Io(msg)),
            },
        }
    }

    fn status_reply(
        &mut self,
        _query: &[u8],
        _deadline: std::time::Duration,
        _complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError> {
        // The spooler has no status-reply channel: it is a durable
        // OS-level queue, not a dialect-speaking device. Silence is the
        // honest answer — a spooled job ends unconfirmed (plan §5.7).
        // Queue health (offline, paper out, …) is surfaced through
        // `spooler_status_problem` by the discovery and probe paths.
        Ok(None)
    }

    fn finish(&mut self, _plan: &SendPlan) {
        // Nothing to hold open or drain: the queue keeps the document
        // whether or not the printer is healthy right now. The handle
        // closes in `Drop`.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_status_is_ready() {
        assert_eq!(spooler_status_problem(0), None);
        // Printing, busy and warming up are not faults.
        assert_eq!(spooler_status_problem(0x400 | 0x200 | 0x1_0000), None);
    }

    #[test]
    fn the_offline_and_paper_out_bits_are_the_documented_ones() {
        // PRINTER_STATUS_OFFLINE = 0x80, PRINTER_STATUS_PAPER_OUT = 0x10.
        assert_eq!(spooler_status_problem(0x80), Some("offline"));
        assert_eq!(spooler_status_problem(0x10), Some("out of paper"));
        assert_eq!(spooler_status_problem(0x08), Some("paper jammed"));
        assert_eq!(spooler_status_problem(0x0040_0000), Some("cover open"));
        assert_eq!(spooler_status_problem(0x02), Some("reporting an error"));
    }

    #[test]
    fn each_fault_bit_reports_its_reason() {
        // Every bit that should block a job, one at a time.
        assert_eq!(
            spooler_status_problem(0x0000_0002),
            Some("reporting an error")
        );
        assert_eq!(spooler_status_problem(0x0000_0008), Some("paper jammed"));
        assert_eq!(spooler_status_problem(0x0000_0010), Some("out of paper"));
        assert_eq!(spooler_status_problem(0x0000_0080), Some("offline"));
        assert_eq!(spooler_status_problem(0x0000_1000), Some("not available"));
        assert_eq!(spooler_status_problem(0x0004_0000), Some("out of toner"));
        assert_eq!(spooler_status_problem(0x0040_0000), Some("cover open"));
    }

    #[test]
    fn non_fault_status_bits_are_ignored() {
        // Bits that describe activity, not faults, must not block a probe.
        // PRINTER_STATUS_PAUSED=1, PRINTING=0x400, PROCESSING=0x4000, BUSY=0x200,
        // WAITING=0x20, IO_ACTIVE=0x100, OUTPUT_BIN_FULL=0x800, etc.
        const NON_FAULT: u32 = 0x0000_0001
            | 0x0000_0020
            | 0x0000_0040
            | 0x0000_0200
            | 0x0000_0400
            | 0x0000_0800
            | 0x0000_4000
            | 0x0001_0000
            | 0x0002_0000;
        assert_eq!(spooler_status_problem(NON_FAULT), None);
        assert_eq!(
            spooler_status_problem(NON_FAULT | 0x400 | 0x200),
            None,
            "adding more non-fault bits must stay ready"
        );
    }

    #[test]
    fn combined_faults_respect_priority() {
        // Priority is offline > not available > paper out > jam > door > toner > error,
        // so the operator sees the most actionable reason first.
        assert_eq!(spooler_status_problem(0x80 | 0x10), Some("offline"));
        assert_eq!(spooler_status_problem(0x80 | 0x08), Some("offline"));
        assert_eq!(spooler_status_problem(0x1000 | 0x10), Some("not available"));
        assert_eq!(spooler_status_problem(0x10 | 0x08), Some("out of paper"));
        assert_eq!(
            spooler_status_problem(0x08 | 0x0040_0000),
            Some("paper jammed")
        );
        assert_eq!(
            spooler_status_problem(0x0040_0000 | 0x0004_0000),
            Some("cover open")
        );
        assert_eq!(
            spooler_status_problem(0x0004_0000 | 0x0000_0002),
            Some("out of toner")
        );
        // All faults at once still reports offline.
        assert_eq!(
            spooler_status_problem(
                0x0000_0002
                    | 0x0000_0008
                    | 0x0000_0010
                    | 0x0000_0080
                    | 0x0000_1000
                    | 0x0004_0000
                    | 0x0040_0000
            ),
            Some("offline")
        );
    }

    #[test]
    fn a_short_write_is_an_error() {
        assert!(ensure_fully_written(10, 10).is_ok());
        assert!(ensure_fully_written(0, 0).is_ok());
        let err = ensure_fully_written(4, 10).unwrap_err();
        assert!(err.contains("4 of 10"), "{err}");
    }

    #[test]
    fn short_write_errors_are_operator_readable() {
        let err = ensure_fully_written(0, 1024).unwrap_err();
        assert!(err.contains("0 of 1024"), "{err}");
        assert!(err.contains("incomplete"), "{err}");
        let err = ensure_fully_written(u32::MAX, 10).unwrap_err();
        assert!(err.contains("incomplete"), "{err}");
    }

    #[test]
    fn status_reasons_are_operator_readable() {
        // The strings from spooler_status_problem end up in History and in
        // the API error. They must not leak hex codes.
        for (bits, want) in [
            (0x80u32, "offline"),
            (0x10, "out of paper"),
            (0x08, "paper jammed"),
            (0x0040_0000, "cover open"),
        ] {
            let reason = spooler_status_problem(bits).unwrap();
            assert_eq!(reason, want);
            assert!(!reason.contains("0x"), "{reason}");
        }
    }

    #[test]
    fn pdf_uses_pdf_datatype_and_others_use_raw() {
        assert_eq!(spool_datatype("application/pdf"), "PDF");
        assert_eq!(spool_datatype("application/octet-stream"), "RAW");
        assert_eq!(spool_datatype("text/plain"), "RAW");
        assert_eq!(spool_datatype(""), "RAW");
    }

    fn list(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn pdf_is_declared_only_when_the_queue_offers_it() {
        let stock = list(&["RAW", "RAW [FF appended]", "NT EMF 1.008", "TEXT"]);
        assert_eq!(choose_datatype("application/pdf", Some(&stock)), "RAW");
        let with_pdf = list(&["RAW", "PDF", "NT EMF 1.008"]);
        assert_eq!(choose_datatype("application/pdf", Some(&with_pdf)), "PDF");
    }

    #[test]
    fn the_pdf_match_ignores_case_and_padding() {
        let odd = list(&["raw", " Pdf "]);
        assert_eq!(choose_datatype("application/pdf", Some(&odd)), "PDF");
    }

    #[test]
    fn a_readable_list_without_pdf_is_the_gdi_risk() {
        // The stock winprint processor: RAW/EMF/TEXT, no PDF entry.
        let stock = list(&["RAW", "RAW [FF appended]", "NT EMF 1.008", "TEXT"]);
        assert_eq!(offers_pdf_datatype(Some(&stock)), Some(false));
        // A PDF-capable driver registers a PDF datatype.
        let with_pdf = list(&["RAW", "PDF", "NT EMF 1.008"]);
        assert_eq!(offers_pdf_datatype(Some(&with_pdf)), Some(true));
    }

    #[test]
    fn the_pdf_offer_match_ignores_case_and_padding() {
        assert_eq!(
            offers_pdf_datatype(Some(&list(&["raw", " Pdf "]))),
            Some(true)
        );
        assert_eq!(
            offers_pdf_datatype(Some(&list(&["RAW", "TEXT"]))),
            Some(false)
        );
    }

    #[test]
    fn an_unreadable_datatype_list_is_unknown_not_gdi() {
        // No list must not be reported as "no PDF": a queue that does not
        // take PDF refuses the job loudly (1804), it does not print
        // garbage.
        assert_eq!(offers_pdf_datatype(None), None);
    }

    #[test]
    fn remote_share_ports_are_not_probed_for_datatypes() {
        // \\server\share queues live on another machine; the local
        // spooler cannot see their processor's datatypes.
        assert!(remote_share_port(r"\\print-server\lobby"));
        assert!(remote_share_port(r"\\192.168.1.20\shared"));
        assert!(!remote_share_port("WINSPOOL"));
        assert!(!remote_share_port("USB001"));
        assert!(!remote_share_port("PORT:10.0.0.5:9100"));
        // A single backslash is not a UNC prefix.
        assert!(!remote_share_port(r"\not-unc"));
    }

    #[test]
    fn an_unreadable_datatype_list_keeps_the_wanted_datatype() {
        assert_eq!(choose_datatype("application/pdf", None), "PDF");
    }

    #[test]
    fn command_languages_are_raw_whatever_the_queue_offers() {
        let with_pdf = list(&["RAW", "PDF"]);
        let none_raw = list(&["NT EMF 1.008"]);
        for mime in ["application/octet-stream", "text/plain", ""] {
            assert_eq!(choose_datatype(mime, Some(&with_pdf)), "RAW");
            assert_eq!(choose_datatype(mime, Some(&none_raw)), "RAW");
            assert_eq!(choose_datatype(mime, None), "RAW");
        }
    }

    #[test]
    fn error_1804_reads_as_an_unsupported_datatype() {
        let msg = describe_start_doc_error("Front Desk", "PDF", 1804);
        assert!(msg.contains("Front Desk"), "{msg}");
        assert!(msg.contains("PDF"), "{msg}");
        assert!(msg.contains("1804"), "{msg}");
        assert!(msg.contains("data type"), "{msg}");
    }

    #[test]
    fn other_start_doc_errors_keep_the_code() {
        assert_eq!(
            describe_start_doc_error("P", "RAW", 5),
            "StartDocPrinter failed: 5"
        );
    }

    #[cfg(windows)]
    #[test]
    fn opening_a_missing_queue_is_a_connect_error() {
        let err =
            WindowsSpoolerTransport::connect("PrintNinja No Such Queue 9876", "RAW").unwrap_err();
        assert!(matches!(err, SendError::Connect(_)), "{err}");
        assert!(err.retryable());
    }
}
