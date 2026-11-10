//! Where a Bluetooth printer row's `address` points.
//!
//! Shared by the desktop Bluetooth transports — Windows opens the paired
//! device's COM port, Linux dials an RFCOMM socket — and parseable on
//! every platform, so the same row (synced from a phone) reads the same
//! everywhere:
//!
//! - `A4:77:17:22:33:44` — the MAC of a device paired in the OS
//!   Bluetooth settings. Any case, `:` or `-` separators; RFCOMM
//!   channel 1 unless said otherwise.
//! - `A4:77:17:22:33:44:2` — the same device on RFCOMM channel 2
//!   (valid channels are 1–30; the Serial Port Profile usually lives
//!   on channel 1).
//! - `COM7` (or `\\.\COM7`) — Windows only: the device's own serial
//!   port, when Windows has already assigned one.
//!
//! Anything else is an error that names the shape it should have had.

/// RFCOMM channel a printer is dialled on when the address does not say
/// otherwise. The Serial Port Profile is registered on channel 1 on
/// essentially every printer; a device that uses another one takes the
/// `:channel` suffix above.
pub const RFCOMM_DEFAULT_CHANNEL: u8 = 1;

/// Highest valid RFCOMM channel (the spec reserves 0).
const RFCOMM_MAX_CHANNEL: u8 = 30;

/// A Bluetooth device address as the user writes it: six octets in
/// display order (`A4` first). The wire and the kernel want the octets
/// reversed — see [`Mac::bdaddr_le`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mac([u8; 6]);

impl Mac {
    /// `AA:BB:CC:DD:EE:FF`, uppercase — how the app shows the address.
    pub fn text(&self) -> String {
        self.0
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":")
    }

    /// `AABBCCDDEEFF`, uppercase — what Windows device-instance keys
    /// carry the address as, once separators are gone.
    pub fn compact(&self) -> String {
        self.0.iter().map(|b| format!("{b:02X}")).collect()
    }

    /// The six octets in kernel `bdaddr_t` order (last octet first):
    /// `sockaddr_rc.rc_bdaddr` and BlueZ's `str2ba` both store the
    /// address reversed relative to how it is printed.
    pub fn bdaddr_le(&self) -> [u8; 6] {
        let mut out = self.0;
        out.reverse();
        out
    }
}

/// The target a stored Bluetooth address resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BluetoothTarget {
    /// Windows: an explicitly named serial port, normalised to
    /// `COM` + number so it can go straight to `CreateFileW`.
    ComPort(String),
    /// A paired device. `channel` is the RFCOMM channel Linux dials;
    /// Windows only uses `mac` to look the device's COM port up.
    Device { mac: Mac, channel: u8 },
}

/// Parse a stored printer address into [`BluetoothTarget`].
///
/// The error is shown as-is in the printer form and in probe/send
/// failures, so it carries the full set of accepted shapes.
pub fn parse(raw: &str) -> Result<BluetoothTarget, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(address_error(raw));
    }
    if let Some(port) = com_port(trimmed) {
        return Ok(BluetoothTarget::ComPort(port));
    }
    parse_device(trimmed)
        .map(|(mac, channel)| BluetoothTarget::Device { mac, channel })
        .ok_or_else(|| address_error(raw))
}

/// `COM7`, `com7` or `\\.\COM7` → the normalised port name.
///
/// Returns `None` for anything else (including `COM0` and `COMx` with a
/// non-numeric tail), which then falls through to MAC parsing and fails
/// with the shared format message rather than a port-specific one.
fn com_port(trimmed: &str) -> Option<String> {
    let body = trimmed
        .strip_prefix(r"\\.\")
        .or_else(|| trimmed.strip_prefix("//./"))
        .unwrap_or(trimmed);
    if body.len() < 4 || !body[..3].eq_ignore_ascii_case("COM") {
        return None;
    }
    let digits = &body[3..];
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    (1..=65535).contains(&n).then(|| format!("COM{n}"))
}

/// Six (or seven) separator-split groups: a MAC, plus an optional
/// RFCOMM channel as the seventh.
fn parse_device(trimmed: &str) -> Option<(Mac, u8)> {
    let parts: Vec<&str> = trimmed.split(|c| c == ':' || c == '-').collect();
    if parts.len() != 6 && parts.len() != 7 {
        return None;
    }
    let mut octets = [0u8; 6];
    for (i, part) in parts[..6].iter().enumerate() {
        octets[i] = u8::from_str_radix(part, 16).ok()?;
        // `from_str_radix` accepts "a" — the shape is two digits.
        if part.len() != 2 {
            return None;
        }
    }
    let channel = if parts.len() == 7 {
        parts[6].parse::<u8>().ok()?
    } else {
        RFCOMM_DEFAULT_CHANNEL
    };
    if channel < 1 || channel > RFCOMM_MAX_CHANNEL {
        return None;
    }
    Some((Mac(octets), channel))
}

/// The message for an address that is neither of the accepted shapes.
fn address_error(raw: &str) -> String {
    format!(
        "\"{raw}\" is not a Bluetooth address — use the MAC of a device paired in your \
         OS Bluetooth settings (for example A4:77:17:22:33:44, optionally :1 to :30 for \
         the RFCOMM channel); on Windows the printer's serial port (for example COM7) \
         also works"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mac_parses_in_any_case_and_separator() {
        for raw in [
            "A4:77:17:22:33:44",
            "a4:77:17:22:33:44",
            "A4-77-17-22-33-44",
            "  A4:77:17:22:33:44  ",
        ] {
            match parse(raw).expect("mac parses") {
                BluetoothTarget::Device { mac, channel } => {
                    assert_eq!(mac.text(), "A4:77:17:22:33:44", "{raw:?}");
                    assert_eq!(channel, RFCOMM_DEFAULT_CHANNEL, "{raw:?}");
                }
                other => panic!("{raw:?} resolved to {other:?}"),
            }
        }
    }

    #[test]
    fn an_rfcomm_channel_suffix_is_read_and_ranged() {
        let BluetoothTarget::Device { channel, .. } = parse("A4:77:17:22:33:44:2").unwrap() else {
            panic!("expected a device");
        };
        assert_eq!(channel, 2);
        // 0 is reserved by the spec, 31 is past the channel space.
        for bad in ["A4:77:17:22:33:44:0", "A4:77:17:22:33:44:31", "A4:77:17:22:33:44:zz"] {
            assert!(parse(bad).is_err(), "{bad} must not parse");
        }
        assert_eq!(
            parse("A4:77:17:22:33:44:30").unwrap(),
            BluetoothTarget::Device {
                mac: Mac([0xA4, 0x77, 0x17, 0x22, 0x33, 0x44]),
                channel: 30
            }
        );
    }

    #[test]
    fn com_ports_normalise_including_the_extended_prefix() {
        for (raw, want) in [
            ("COM7", "COM7"),
            ("com7", "COM7"),
            (r"\\.\COM7", "COM7"),
            ("COM12", "COM12"),
        ] {
            assert_eq!(parse(raw).unwrap(), BluetoothTarget::ComPort(want.into()), "{raw}");
        }
        // Not ports: fall through to the shared format message.
        for bad in ["COM0", "COM", "COMx", "PORT7"] {
            assert!(parse(bad).is_err(), "{bad} must not parse as a port");
        }
    }

    #[test]
    fn anything_else_says_what_it_should_look_like() {
        for bad in ["", "   ", "usb://dummy", "Front Desk", "A4:77:17"] {
            let err = parse(bad).unwrap_err();
            assert!(err.contains("A4:77:17:22:33:44"), "{bad:?}: {err}");
            assert!(err.contains("COM7"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn the_mac_keeps_both_byte_orders() {
        let BluetoothTarget::Device { mac, .. } = parse("A4:77:17:22:33:44").unwrap() else {
            panic!("expected a device");
        };
        // Display order, and the reversed order sockaddr_rc wants.
        assert_eq!(mac.text(), "A4:77:17:22:33:44");
        assert_eq!(mac.compact(), "A47717223344");
        assert_eq!(mac.bdaddr_le(), [0x44, 0x33, 0x22, 0x17, 0x77, 0xA4]);
    }
}
