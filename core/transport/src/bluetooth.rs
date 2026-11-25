//! Driverless Bluetooth printing: one byte stream to the device, chosen by
//! platform.
//!
//! Linux dials an RFCOMM (Serial Port Profile) socket straight to the
//! paired device — no CUPS queue, no driver; the kernel's Bluetooth stack
//! carries the bytes. Windows writes to the paired device's own COM port
//! (the SPP port Windows assigns at pairing), or, when the row stores a
//! MAC, to the port looked up for that MAC in the device enumeration.
//! Pairing itself is an OS flow on both platforms: this module never pairs
//! and never discovers — a row names the device, and everything else is a
//! dial.
//!
//! RFCOMM and a SPP COM port are both byte streams in both directions, so
//! the transport follows the raw-TCP contract: the profile's pacing, a
//! send deadline that a wedged link cannot outlive, a status reply read on
//! the same connection (silence is not an error), and a close delay.

// The transport itself exists only where a Bluetooth byte stream can
// be opened — Linux dials an RFCOMM socket, Windows a COM port. The
// address parsing above stays on every platform, so the imports
// follow the platform paths.
#[cfg(any(target_os = "linux", windows))]
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", windows))]
use crate::{SendError, SendPlan, Transport, UnitReport};

// ─────────────────────────────────────────────────────────────────────
// Addresses: where a Bluetooth printer row points.
//
// Shared by both platform paths and parseable on every platform, so the
// same row (synced from a phone) reads the same everywhere:
//
// - `A4:77:17:22:33:44` — the MAC of a device paired in the OS Bluetooth
//   settings. Any case, `:` or `-` separators; RFCOMM channel 1 unless
//   said otherwise.
// - `A4:77:17:22:33:44:2` — the same device on RFCOMM channel 2 (valid
//   channels are 1–30; the Serial Port Profile usually lives on channel
//   1).
// - `COM7` (or `\\.\COM7`) — Windows: the device's own serial port, when
//   Windows has already assigned one.
//
// Anything else is an error that names the shape it should have had.
// ─────────────────────────────────────────────────────────────────────

/// RFCOMM channel a printer is dialled on when the address does not say
/// otherwise. The Serial Port Profile is registered on channel 1 on
/// essentially every printer; a device that uses another one takes the
/// `:channel` suffix above.
pub const RFCOMM_DEFAULT_CHANNEL: u8 = 1;

/// Highest valid RFCOMM channel (the spec reserves 0).
const RFCOMM_MAX_CHANNEL: u8 = 30;

/// A Bluetooth device address as the user writes it: six octets in
/// display order (`A4` first). The kernel wants the octets reversed — see
/// [`Mac::bdaddr_le`].
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
    let parts: Vec<&str> = trimmed.split([':', '-']).collect();
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
    if !(1..=RFCOMM_MAX_CHANNEL).contains(&channel) {
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

// ─────────────────────────────────────────────────────────────────────
// Failure words that differ by platform, but are pure: testable on all.
// ─────────────────────────────────────────────────────────────────────

/// A `COM…` address on a platform that dials by MAC (Linux): the message
/// says where to look instead of repeating the generic format error.
pub fn com_port_on_mac_dialing(port: &str) -> String {
    format!(
        "{port} is a Windows serial port — on Linux, use the printer's MAC \
         (for example A4:77:17:22:33:44); pair it in your OS Bluetooth \
         settings first"
    )
}

/// A MAC that resolves to no COM port on this PC (Windows): the message
/// names both fixes — get Windows to assign a port, or print through the
/// installed OS driver.
pub fn no_com_port_for_mac(mac: &Mac) -> String {
    format!(
        "the address {} names no COM port on this PC. Pair the \
         printer in Windows settings (Settings → Bluetooth & devices) so \
         Windows assigns one and enter it here (for example COM7); or \
         print through the OS driver for this printer to use its installed \
         Windows queue instead",
        mac.text()
    )
}

// ─────────────────────────────────────────────────────────────────────
// Linux: the RFCOMM socket.
//
// Every operation is a blocking syscall, so the socket is non-blocking
// and each one is bounded by its own poll deadline — a printer that is
// off, out of range or wedged fails in seconds and names the stage,
// never hangs the queue. The deadline is always ours, not the kernel's
// page timeout.
// ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod sys {
    use std::os::raw::{c_int, c_void};

    /// `AF_BLUETOOTH` and `BTPROTO_RFCOMM` from `<bluetooth/bluetooth.h>`
    /// / `<bluetooth/rfcomm.h>`. Fixed kernel ABI values, spelled out so
    /// the module does not depend on which of them a given `libc` version
    /// happens to export.
    pub const AF_BLUETOOTH: c_int = 31;
    pub const BTPROTO_RFCOMM: c_int = 3;
    pub const SOCK_STREAM: c_int = 1;
    pub const SOCK_CLOEXEC: c_int = 0x0080_0000;
    pub const SOL_SOCKET: c_int = 1;
    pub const SO_ERROR: c_int = 4;
    /// The `fcntl` command numbers are fixed kernel ABI (asm-generic and
    /// i386 alike: `F_GETFL` 3, `F_SETFL` 4).
    pub const F_GETFL: c_int = 3;
    pub const F_SETFL: c_int = 4;
    pub const O_NONBLOCK: c_int = 0o4000;
    pub const POLLIN: i16 = 0x001;
    pub const POLLOUT: i16 = 0x004;
    pub const POLLERR: i16 = 0x008;
    pub const POLLHUP: i16 = 0x010;
    pub const POLLNVAL: i16 = 0x020;

    /// The errno values the connect/write/read paths map (Linux values,
    /// stable across architectures).
    pub const EAGAIN: c_int = 11;
    pub const EINTR: c_int = 4;
    pub const EINPROGRESS: c_int = 115;
    pub const ECONNREFUSED: c_int = 111;
    pub const ECONNRESET: c_int = 104;
    pub const EHOSTUNREACH: c_int = 113;
    pub const ETIMEDOUT: c_int = 110;
    pub const ENODEV: c_int = 19;
    pub const EHOSTDOWN: c_int = 112;
    pub const EINVAL: c_int = 22;
    pub const EAFNOSUPPORT: c_int = 97;
    pub const EPFNOSUPPORT: c_int = 98;

    /// `struct pollfd` from `<poll.h>`.
    #[repr(C)]
    pub struct pollfd {
        pub fd: c_int,
        pub events: i16,
        pub revents: i16,
    }

    /// `struct sockaddr_rc` from `<bluetooth/rfcomm.h>`: family, address
    /// (stored reversed — see [`crate::bluetooth::Mac::bdaddr_le`]),
    /// channel. The explicit pad byte keeps every byte initialised and
    /// the size at the C layout's 10.
    #[repr(C)]
    pub struct SockAddrRc {
        pub rc_family: u16,
        pub rc_bdaddr: [u8; 6],
        pub rc_channel: u8,
        pub _pad: u8,
    }

    impl SockAddrRc {
        pub fn new(mac: &super::Mac, channel: u8) -> Self {
            SockAddrRc {
                rc_family: AF_BLUETOOTH as u16,
                rc_bdaddr: mac.bdaddr_le(),
                rc_channel: channel,
                _pad: 0,
            }
        }
    }

    extern "C" {
        pub fn socket(domain: c_int, ty: c_int, protocol: c_int) -> c_int;
        pub fn connect(fd: c_int, addr: *const c_void, len: u32) -> c_int;
        pub fn close(fd: c_int) -> c_int;
        pub fn fcntl(fd: c_int, cmd: c_int, arg: c_int) -> c_int;
        pub fn poll(fds: *mut pollfd, nfds: u64, timeout: i32) -> c_int;
        pub fn getsockopt(
            fd: c_int,
            level: c_int,
            optname: c_int,
            optval: *mut c_void,
            optlen: *mut u32,
        ) -> c_int;
        pub fn read(fd: c_int, buf: *mut c_void, count: usize) -> isize;
        pub fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
    }
}

#[cfg(target_os = "linux")]
/// One open RFCOMM socket to a paired device.
pub struct BluetoothTransport {
    fd: Option<i32>,
    at: String,
}

#[cfg(target_os = "linux")]
impl std::fmt::Debug for BluetoothTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BluetoothTransport")
            .field("fd", &self.fd)
            .field("at", &self.at)
            .finish()
    }
}

#[cfg(target_os = "linux")]
impl BluetoothTransport {
    /// Dial the device named by `address` (a MAC, optionally with an
    /// RFCOMM channel), giving up after `deadline`.
    ///
    /// A refused channel or a malformed address is a configuration fault
    /// ([`SendError::Io`], not retried); an unreachable device is
    /// [`SendError::Connect`] (it may power on, so a retry is safe — no
    /// byte has been flushed).
    pub fn connect(address: &str, deadline: Duration) -> Result<Self, SendError> {
        use std::io;
        use std::os::raw::{c_int, c_void};
        use sys::*;

        let (mac, channel) = match crate::bluetooth::parse(address) {
            Ok(BluetoothTarget::Device { mac, channel }) => (mac, channel),
            Ok(BluetoothTarget::ComPort(port)) => {
                return Err(SendError::Io(com_port_on_mac_dialing(&port)))
            }
            Err(e) => return Err(SendError::Io(e)),
        };
        let at = format!("Bluetooth printer {}", mac.text());
        let fd = socket_rfcomm()?;
        let addr = SockAddrRc::new(&mac, channel);
        let rc = unsafe {
            connect(
                fd,
                &addr as *const SockAddrRc as *const c_void,
                std::mem::size_of::<SockAddrRc>() as u32,
            )
        };
        let fd = if rc != 0 {
            let e = io::Error::last_os_error();
            if e.raw_os_error() != Some(EINPROGRESS) {
                let _ = unsafe { close(fd) };
                return Err(connect_error(&at, channel, e));
            }
            match wait(fd, POLLOUT, Instant::now() + deadline) {
                Ok(false) => {
                    let _ = unsafe { close(fd) };
                    Err(SendError::Connect(format!(
                        "{at} did not answer within {}s — check it is paired, powered on \
                         and in range",
                        deadline.as_secs()
                    )))
                }
                Ok(true) => {
                    let mut so_error: c_int = 0;
                    let mut len = std::mem::size_of::<c_int>() as u32;
                    let got = unsafe {
                        getsockopt(
                            fd,
                            SOL_SOCKET,
                            SO_ERROR,
                            &mut so_error as *mut c_int as *mut c_void,
                            &mut len,
                        )
                    };
                    if got != 0 {
                        let e = io::Error::last_os_error();
                        let _ = unsafe { close(fd) };
                        return Err(connect_error(&at, channel, e));
                    }
                    if so_error != 0 {
                        let e = io::Error::from_raw_os_error(so_error);
                        let _ = unsafe { close(fd) };
                        return Err(connect_error(&at, channel, e));
                    }
                    Ok(fd)
                }
                Err(e) => {
                    let _ = unsafe { close(fd) };
                    Err(e)
                }
            }
        } else {
            Ok(fd)
        };
        fd.map(|fd| BluetoothTransport { fd: Some(fd), at })
    }
}

#[cfg(target_os = "linux")]
impl Drop for BluetoothTransport {
    fn drop(&mut self) {
        if let Some(fd) = self.fd.take() {
            let _ = unsafe { sys::close(fd) };
        }
    }
}

/// Create the RFCOMM socket and put it in non-blocking mode, so every
/// deadline is enforced by our own poll rather than by the kernel's page
/// timeout.
#[cfg(target_os = "linux")]
fn socket_rfcomm() -> Result<i32, SendError> {
    use std::io;
    use sys::*;

    let fd = unsafe { socket(AF_BLUETOOTH, SOCK_STREAM | SOCK_CLOEXEC, BTPROTO_RFCOMM) };
    if fd < 0 {
        let e = io::Error::last_os_error();
        return Err(match e.raw_os_error() {
            // A kernel without a Bluetooth stack answers EINVAL; a build
            // without the family at all answers EAFNOSUPPORT.
            Some(EAFNOSUPPORT) | Some(EPFNOSUPPORT) | Some(EINVAL) => SendError::Io(format!(
                "this system has no Bluetooth support (the kernel has no Bluetooth \
                     stack): {e}"
            )),
            _ => SendError::Io(format!("could not open a Bluetooth socket: {e}")),
        });
    }
    let flags = unsafe { fcntl(fd, F_GETFL, 0) };
    if flags < 0 || unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) } < 0 {
        let _ = unsafe { close(fd) };
        return Err(SendError::Io(format!(
            "could not configure the Bluetooth socket: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(fd)
}

/// Turn a connect failure into words an operator can act on.
///
/// A refused channel and a rejected address are configuration faults —
/// not retried. Unreachable is transient (power, range) — retried, and
/// safe: nothing has been flushed.
#[cfg(target_os = "linux")]
fn connect_error(at: &str, channel: u8, e: std::io::Error) -> SendError {
    use sys::*;

    match e.raw_os_error() {
        Some(ECONNREFUSED) => SendError::Io(format!(
            "{at} refused the connection on RFCOMM channel {channel} — the printer may \
             expose its serial port on another channel (try …:{}, or re-pair it)",
            if channel < RFCOMM_MAX_CHANNEL {
                channel + 1
            } else {
                RFCOMM_DEFAULT_CHANNEL
            }
        )),
        Some(EHOSTUNREACH) | Some(ETIMEDOUT) | Some(ENODEV) | Some(EHOSTDOWN) => {
            SendError::Connect(format!(
                "could not reach {at} — check it is paired, powered on and in range: {e}"
            ))
        }
        Some(EINVAL) => SendError::Io(format!(
            "{at} rejected the address — check the MAC and the RFCOMM channel ({channel})"
        )),
        _ => SendError::Connect(format!("could not reach {at}: {e}")),
    }
}

/// Wait until `events` is ready or the deadline passes.
///
/// `Ok(true)` — ready (or an error condition the next call reports);
/// `Ok(false)` — the deadline passed; `Err` — `poll` itself failed.
#[cfg(target_os = "linux")]
fn wait(fd: i32, events: i16, deadline: Instant) -> Result<bool, SendError> {
    use std::io;
    use sys::*;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let ms = (deadline - now).as_millis().min(i32::MAX as u128) as i32;
        let mut pfd = sys::pollfd {
            fd,
            events,
            revents: 0,
        };
        let rc = unsafe { poll(&mut pfd, 1, ms) };
        if rc < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(SendError::Io(format!("Bluetooth connection failed: {e}")));
        }
        if rc == 0 {
            return Ok(false);
        }
        // POLLERR / POLLHUP / POLLNVAL: the follow-up call (SO_ERROR on
        // connect, read/write on the held socket) reports the reason.
        if pfd.revents & (POLLERR | POLLHUP | POLLNVAL) != 0 || pfd.revents & events != 0 {
            return Ok(true);
        }
        // A wake that carried neither: wait again inside the deadline.
    }
}

/// Write `piece` in full before `deadline`.
///
/// `Ok(true)` — every byte went out; `Ok(false)` — the deadline passed;
/// `Err` — the link broke (the error already names it).
#[cfg(target_os = "linux")]
fn write_piece(fd: i32, piece: &[u8], deadline: Instant) -> Result<bool, SendError> {
    use std::io;
    use std::os::raw::c_void;
    use sys::*;

    let mut off = 0usize;
    while off < piece.len() {
        if !wait(fd, POLLOUT, deadline)? {
            return Ok(false);
        }
        let n = unsafe {
            write(
                fd,
                piece[off..].as_ptr() as *const c_void,
                piece.len() - off,
            )
        };
        if n < 0 {
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                // EAGAIN covers the would-block case too: EWOULDBLOCK is
                // the same value on Linux.
                Some(EAGAIN) | Some(EINTR) => continue,
                Some(ECONNRESET) => return Err(SendError::ClosedByPeer),
                _ => return Err(SendError::Io(format!("the link broke while sending: {e}"))),
            }
        }
        if n == 0 {
            return Err(SendError::ClosedByPeer);
        }
        off += n as usize;
    }
    Ok(true)
}

/// Write every byte before the deadline.
///
/// A printer that accepts the connection and then stops reading — a
/// full buffer or a wedged link — would otherwise block the queue
/// forever, exactly the failure the send deadline exists to end.
///
/// On failure the error carries the count of whole pieces the kernel
/// accepted first, so the job can tell a partial delivery from a clean
/// refusal. A stalled piece's own partial count is kernel-dependent and
/// not claimed.
#[cfg(target_os = "linux")]
fn write_all(
    fd: i32,
    data: &[u8],
    chunk: usize,
    pause: Duration,
    deadline: Instant,
) -> Result<usize, (usize, SendError)> {
    let mut off = 0usize;
    let mut pieces = data.chunks(chunk).peekable();
    while let Some(piece) = pieces.next() {
        let last = pieces.peek().is_none();
        match write_piece(fd, piece, deadline) {
            Ok(true) => {}
            Ok(false) => return Err((off, SendError::SendDeadline)),
            Err(e) => return Err((off, e)),
        }
        off += piece.len();
        if !last && !pause.is_zero() {
            std::thread::sleep(pause);
        }
    }
    Ok(off)
}

/// Read until `answered` says the reply is complete, the link hangs up,
/// or the deadline passes. Returns everything read and how it ended, so
/// the caller can tell silence from a closed connection.
#[cfg(target_os = "linux")]
enum ReplyEnd {
    /// The answer arrived complete.
    Answered,
    /// The printer hung up (or the link broke) — possibly mid-answer.
    Closed,
    /// The deadline passed with no complete answer.
    Timeout,
}

#[cfg(target_os = "linux")]
fn read_reply(fd: i32, deadline: Instant, answered: impl Fn(&[u8]) -> bool) -> (Vec<u8>, ReplyEnd) {
    use std::io;
    use std::os::raw::c_void;
    use sys::*;

    let mut reply = Vec::new();
    let mut chunk = [0u8; 256];
    loop {
        match wait(fd, POLLIN, deadline) {
            Ok(false) => return (reply, ReplyEnd::Timeout),
            Err(_) => return (reply, ReplyEnd::Closed),
            Ok(true) => {}
        }
        let n = unsafe { read(fd, chunk.as_mut_ptr() as *mut c_void, chunk.len()) };
        if n < 0 {
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                // EAGAIN covers the would-block case (see `write_piece`).
                Some(EAGAIN) | Some(EINTR) => continue,
                _ => return (reply, ReplyEnd::Closed),
            }
        }
        if n == 0 {
            return (reply, ReplyEnd::Closed);
        }
        reply.extend_from_slice(&chunk[..n as usize]);
        if answered(&reply) {
            return (reply, ReplyEnd::Answered);
        }
    }
}

#[cfg(target_os = "linux")]
impl Transport for BluetoothTransport {
    fn send_unit(&mut self, data: &[u8], plan: &SendPlan) -> UnitReport {
        let fd = match self.fd {
            Some(fd) => fd,
            None => {
                return UnitReport {
                    bytes_written: 0,
                    error: Some(SendError::Io(
                        "the connection is already closed".to_string(),
                    )),
                }
            }
        };
        let deadline = Instant::now() + plan.send;
        let chunk = plan.chunk_bytes.max(1) as usize;
        let pause = Duration::from_millis(plan.pause_ms as u64);
        match write_all(fd, data, chunk, pause, deadline) {
            Ok(n) => UnitReport::ok(n as u64),
            // A link that died mid-write: the whole pieces that went
            // first are counted, so the job can tell a partial delivery
            // from a clean refusal.
            Err((partial, e)) => UnitReport {
                bytes_written: partial as u64,
                error: Some(e),
            },
        }
    }

    fn status_reply(
        &mut self,
        query: &[u8],
        deadline: Duration,
        complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError> {
        let fd = match self.fd {
            Some(fd) => fd,
            None => {
                return Err(SendError::Io(
                    "the connection is already closed".to_string(),
                ))
            }
        };
        let end = Instant::now() + deadline;
        // The question and the job share one connection, so the send
        // pays one dial, not two. A question that cannot even be written
        // is a dead link — say so; the job decides whether that fails it.
        if !write_piece(fd, query, end)? {
            return Err(SendError::SendDeadline);
        }
        // Absolute read deadline: each read gets the *remaining* budget,
        // so a chatty but incomplete reply cannot stretch past it.
        let (out, end_state) = read_reply(fd, end, complete);
        if matches!(end_state, ReplyEnd::Closed) && out.is_empty() {
            // The link broke before any answer: that is a lost
            // connection, not silence.
            return Err(SendError::ClosedByPeer);
        }
        // Silence (timeout) is an answer, not a failure; a partial reply
        // is returned as-is and the decoder decides what it is.
        Ok(if out.is_empty() { None } else { Some(out) })
    }

    fn finish(&mut self, plan: &SendPlan) {
        if plan.close_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(plan.close_delay_ms as u64));
        }
        if let Some(fd) = self.fd.take() {
            let _ = unsafe { sys::close(fd) };
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Windows: the paired device's COM port.
//
// A paired SPP printer normally gets a virtual serial port from Windows,
// and the row's address names it — `COM7` directly, or a MAC whose
// device already owns a port (best-effort registry lookup). The port is
// bounded at the driver: `SetCommTimeouts` gives each direction a hard
// total timeout, and the write count is checked exactly as the spooler
// checks `WritePrinter`.
// ─────────────────────────────────────────────────────────────────────

#[cfg(windows)]
#[allow(clippy::upper_case_acronyms)]
mod winapi {
    use std::ffi::c_void;

    pub type HANDLE = *mut c_void;
    pub type HKEY = *mut c_void;
    pub type BOOL = i32;
    pub type DWORD = u32;

    /// `COMMTIMEOUTS` (winbase.h): the total timeout is
    /// `multiplier × bytes + constant`, which is how a wedged link is
    /// bounded on the direct path.
    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct COMMTIMEOUTS {
        pub ReadIntervalTimeout: DWORD,
        pub ReadTotalTimeoutMultiplier: DWORD,
        pub ReadTotalTimeoutConstant: DWORD,
        pub WriteTotalTimeoutMultiplier: DWORD,
        pub WriteTotalTimeoutConstant: DWORD,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: DWORD,
            dwShareMode: DWORD,
            lpSecurityAttributes: *mut c_void,
            dwCreationDisposition: DWORD,
            dwFlagsAndAttributes: DWORD,
            hTemplateFile: HANDLE,
        ) -> HANDLE;
        pub fn WriteFile(
            hFile: HANDLE,
            lpBuffer: *const c_void,
            nNumberOfBytesToWrite: DWORD,
            lpNumberOfBytesWritten: *mut DWORD,
            lpOverlapped: *mut c_void,
        ) -> BOOL;
        pub fn ReadFile(
            hFile: HANDLE,
            lpBuffer: *mut c_void,
            nNumberOfBytesToRead: DWORD,
            lpNumberOfBytesRead: *mut DWORD,
            lpOverlapped: *mut c_void,
        ) -> BOOL;
        pub fn CloseHandle(hObject: HANDLE) -> BOOL;
        pub fn SetCommTimeouts(hFile: HANDLE, lpCommTimeouts: *const COMMTIMEOUTS) -> BOOL;
        pub fn GetLastError() -> DWORD;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegOpenKeyExW(
            hKey: HKEY,
            lpSubKey: *const u16,
            ulOptions: DWORD,
            samDesired: DWORD,
            phkResult: *mut HKEY,
        ) -> i32;
        pub fn RegEnumKeyExW(
            hKey: HKEY,
            dwIndex: DWORD,
            lpName: *mut u16,
            lpcchName: *mut DWORD,
            lpReserved: *mut DWORD,
            lpClass: *mut u16,
            lpcchClass: *mut DWORD,
            lftLastWriteTime: *mut c_void,
        ) -> i32;
        pub fn RegQueryValueExW(
            hKey: HKEY,
            lpValueName: *const u16,
            lpReserved: *mut DWORD,
            lpType: *mut DWORD,
            lpData: *mut u8,
            lpcbData: *mut DWORD,
        ) -> i32;
        pub fn RegCloseKey(hKey: HKEY) -> i32;
    }

    pub const GENERIC_READ: DWORD = 0x8000_0000;
    pub const GENERIC_WRITE: DWORD = 0x4000_0000;
    pub const OPEN_EXISTING: DWORD = 3;
    pub const FILE_ATTRIBUTE_NORMAL: DWORD = 0x80;
    pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
    pub const ERROR_FILE_NOT_FOUND: DWORD = 2;
    pub const ERROR_ACCESS_DENIED: DWORD = 5;
    pub const ERROR_SHARING_VIOLATION: DWORD = 32;
    /// `ReadFile`/`WriteFile` failed because the total timeout expired.
    pub const ERROR_SEM_TIMEOUT: DWORD = 258;
    pub const REG_SZ: DWORD = 1;
    pub const KEY_READ: DWORD = 0x20019;
    pub const HKEY_LOCAL_MACHINE: HKEY = 0x8000_0002usize as HKEY;
}

/// UTF-16 with a terminator — the shape `CreateFileW` and the registry
/// calls expect.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
/// One open COM port on a paired Bluetooth device.
pub struct BluetoothTransport {
    handle: Option<winapi::HANDLE>,
    port: String,
}

#[cfg(windows)]
impl std::fmt::Debug for BluetoothTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The handle is a raw pointer; the port name is what matters.
        f.debug_struct("BluetoothTransport")
            .field("port", &self.port)
            .finish()
    }
}

#[cfg(windows)]
impl BluetoothTransport {
    /// Open the port named by `address`: `COM7` directly, or a MAC whose
    /// paired device owns a port on this PC (registry lookup). Giving up
    /// on the open itself is bounded by `deadline`.
    ///
    /// A port another program holds is [`SendError::Connect`] — it may
    /// clear, and no byte has been flushed. A port that does not exist,
    /// or a MAC whose device owns no port here, is a configuration fault
    /// ([`SendError::Io`], not retried).
    pub fn connect(address: &str, deadline: Duration) -> Result<Self, SendError> {
        use winapi::*;

        let port = match crate::bluetooth::parse(address) {
            Ok(BluetoothTarget::ComPort(port)) => port,
            Ok(BluetoothTarget::Device { mac, .. }) => match com_port_for_mac(&mac) {
                Some(port) => port,
                None => return Err(SendError::Io(no_com_port_for_mac(&mac))),
            },
            Err(e) => return Err(SendError::Io(e)),
        };

        // The open may wait on the radio; bound it in a worker and let
        // the deadline win if it does not. The worker is detached on a
        // timeout: `CreateFileW` cannot be cancelled, and it finishes
        // (or fails) on its own.
        let (tx, rx) = std::sync::mpsc::channel();
        let port_name = port.clone();
        let worker = std::thread::spawn(move || {
            let result = open_port(&port_name);
            let _ = tx.send(result.map(|h| h as usize));
        });
        let handle = match rx.recv_timeout(deadline) {
            Ok(Ok(h)) => {
                // The worker already sent its result; reap the thread so
                // it does not outlive the connection.
                let _ = worker.join();
                h as winapi::HANDLE
            }
            Ok(Err(e)) => return Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(SendError::Connect(format!(
                    "COM port {port} did not open within {}s — check the printer is \
                     powered on and in range",
                    deadline.as_secs()
                )))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                unreachable!("the worker always sends")
            }
        };
        // Read as well as write: the status query is answered on the same
        // port — a SPP port is full-duplex, like the RFCOMM socket on
        // Linux.
        apply_timeouts(
            handle,
            &port,
            Duration::from_secs(3),
            Duration::from_secs(30),
        )
        .map_err(|e| {
            let _ = unsafe { CloseHandle(handle) };
            SendError::Io(e)
        })?;
        Ok(BluetoothTransport {
            handle: Some(handle),
            port,
        })
    }
}

#[cfg(windows)]
impl Drop for BluetoothTransport {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            unsafe { winapi::CloseHandle(handle) };
        }
    }
}

#[cfg(windows)]
/// Open the virtual serial port the paired device owns.
fn open_port(port: &str) -> Result<winapi::HANDLE, SendError> {
    use std::ptr::null_mut;
    use winapi::*;

    let path = wide(&format!(r"\\.\{port}"));
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let code = unsafe { GetLastError() };
        return Err(match code {
            ERROR_FILE_NOT_FOUND => SendError::Io(format!(
                "COM port {port} does not exist — pair the printer in Windows settings \
                 so Windows assigns one, then set this printer's address to the port \
                 Device Manager shows (Ports (COM & LPT))"
            )),
            ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION => SendError::Connect(format!(
                "COM port {port} is in use by another program — close it and try again"
            )),
            _ => SendError::Connect(format!(
                "could not open COM port {port} (Windows error {code})"
            )),
        });
    }
    Ok(handle)
}

/// Put the port's own deadlines in place: `read` bounds a status reply,
/// `write` bounds the job. `SetCommTimeouts` is total-timeout based (the
/// multipliers stay at 0), so these are hard caps on each direction.
#[cfg(windows)]
fn apply_timeouts(
    handle: winapi::HANDLE,
    port: &str,
    read: Duration,
    write: Duration,
) -> Result<(), String> {
    use winapi::*;

    let read_constant = u32::try_from(read.as_millis()).unwrap_or(u32::MAX).max(1);
    let write_constant = u32::try_from(write.as_millis()).unwrap_or(u32::MAX).max(1);
    let timeouts = COMMTIMEOUTS {
        ReadIntervalTimeout: 0,
        ReadTotalTimeoutMultiplier: 0,
        ReadTotalTimeoutConstant: read_constant,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: write_constant,
    };
    if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
        let code = unsafe { GetLastError() };
        return Err(format!(
            "could not set timeouts on COM port {port} (Windows error {code})"
        ));
    }
    Ok(())
}

#[cfg(windows)]
impl Transport for BluetoothTransport {
    fn send_unit(&mut self, data: &[u8], plan: &SendPlan) -> UnitReport {
        use std::ptr::null_mut;
        use winapi::*;

        let handle = match self.handle {
            Some(handle) => handle,
            None => {
                return UnitReport {
                    bytes_written: 0,
                    error: Some(SendError::Io(
                        "the connection is already closed".to_string(),
                    )),
                }
            }
        };
        let deadline = Instant::now() + plan.send;
        let chunk = plan.chunk_bytes.max(1) as usize;
        let pause = Duration::from_millis(plan.pause_ms as u64);
        let mut written = 0u64;
        let mut pieces = data.chunks(chunk).peekable();
        while let Some(piece) = pieces.next() {
            let last = pieces.peek().is_none();
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return UnitReport {
                    bytes_written: written,
                    error: Some(SendError::SendDeadline),
                };
            }
            // The question has run (if it will); only the write cap
            // matters per piece now.
            if let Err(e) = apply_timeouts(handle, &self.port, Duration::ZERO, remaining) {
                return UnitReport {
                    bytes_written: written,
                    error: Some(SendError::Io(e)),
                };
            }
            // `WriteFile` takes at most a DWORD of bytes per call; the
            // piece is written in 64 KiB slices of it.
            let mut off = 0usize;
            let result = (|| {
                while off < piece.len() {
                    let end = (off + 64 * 1024).min(piece.len());
                    let slice = &piece[off..end];
                    let mut n: DWORD = 0;
                    let ok = unsafe {
                        WriteFile(
                            handle,
                            slice.as_ptr() as *const _,
                            slice.len() as DWORD,
                            &mut n,
                            null_mut(),
                        )
                    };
                    if ok == 0 {
                        let code = unsafe { GetLastError() };
                        return Err(if code == ERROR_SEM_TIMEOUT {
                            SendError::SendDeadline
                        } else {
                            SendError::Io(format!(
                                "COM port {} stopped accepting the job (Windows error {code})",
                                self.port
                            ))
                        });
                    }
                    if n as usize != slice.len() {
                        // A write timeout reads as success-with-fewer-bytes
                        // too: the count is checked exactly as the spooler
                        // checks `WritePrinter`.
                        return Err(SendError::Io(format!(
                            "COM port {} accepted {n} of {} bytes — the job is incomplete",
                            self.port,
                            slice.len()
                        )));
                    }
                    off += n as usize;
                }
                Ok(())
            })();
            if let Err(e) = result {
                return UnitReport {
                    bytes_written: written,
                    error: Some(e),
                };
            }
            written += piece.len() as u64;
            if !last && !pause.is_zero() {
                std::thread::sleep(pause);
            }
        }
        UnitReport::ok(data.len() as u64)
    }

    fn status_reply(
        &mut self,
        query: &[u8],
        deadline: Duration,
        complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError> {
        use std::ptr::null_mut;
        use winapi::*;

        let handle = match self.handle {
            Some(handle) => handle,
            None => {
                return Err(SendError::Io(
                    "the connection is already closed".to_string(),
                ))
            }
        };
        // Bound both directions at the reply budget so a wedged link
        // fails the question in seconds, not the send budget.
        if let Err(e) = apply_timeouts(handle, &self.port, deadline, deadline) {
            return Err(SendError::Io(e));
        }
        let mut written: DWORD = 0;
        let asked = unsafe {
            WriteFile(
                handle,
                query.as_ptr() as *const _,
                query.len() as DWORD,
                &mut written,
                null_mut(),
            )
        };
        if asked == 0 {
            let code = unsafe { GetLastError() };
            return Err(if code == ERROR_SEM_TIMEOUT {
                SendError::SendDeadline
            } else {
                SendError::ClosedByPeer
            });
        }
        // Absolute read deadline on top of the port's own: a driver that
        // ignores `COMMTIMEOUTS` still cannot stretch the wait past it.
        let end = Instant::now() + deadline;
        let mut out = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            if Instant::now() >= end {
                break;
            }
            let mut got: DWORD = 0;
            let ok = unsafe {
                ReadFile(
                    handle,
                    buf.as_mut_ptr() as *mut _,
                    buf.len() as DWORD,
                    &mut got,
                    null_mut(),
                )
            };
            if ok == 0 {
                let code = unsafe { GetLastError() };
                if code == ERROR_SEM_TIMEOUT {
                    if got == 0 {
                        // Pure silence at the port level: the deadline
                        // above ends the wait.
                        continue;
                    }
                    // Timed out but carried bytes: keep them and read on.
                } else {
                    // The port is gone — a lost connection, not silence.
                    return Err(SendError::ClosedByPeer);
                }
            }
            if got == 0 {
                break; // the port closed
            }
            out.extend_from_slice(&buf[..got as usize]);
            if complete(&out) {
                break;
            }
        }
        // Silence is an answer, not a failure; a partial reply is
        // returned as-is and the decoder decides what it is.
        Ok(if out.is_empty() { None } else { Some(out) })
    }

    fn finish(&mut self, plan: &SendPlan) {
        if plan.close_delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(plan.close_delay_ms as u64));
        }
        if let Some(handle) = self.handle.take() {
            unsafe { winapi::CloseHandle(handle) };
        }
    }
}

/// Find the COM port Windows assigned to a paired device, by walking
/// the device enumeration for an instance that carries the MAC and
/// reading its `PortName`.
///
/// Best-effort by design: the instance-ID spelling differs between
/// device classes and Windows versions, so a miss is not an error — the
/// failure message tells the operator to type the port Device Manager
/// shows.
#[cfg(windows)]
fn com_port_for_mac(mac: &Mac) -> Option<String> {
    let needle = mac.compact();
    for root in [
        r"SYSTEM\CurrentControlSet\Enum\BTHENUM",
        r"SYSTEM\CurrentControlSet\Enum\Bluetooth",
    ] {
        if let Some(port) = scan_enum_for_port(root, &needle) {
            return Some(port);
        }
    }
    None
}

/// Enumerate `HKLM\<root>`'s subkeys (bounded — this runs on every
/// print) and read `Device Parameters\PortName` from the first instance
/// whose key carries the MAC. Both the instance and its immediate
/// children are checked: the port has been observed on either level.
#[cfg(windows)]
fn scan_enum_for_port(root: &str, needle: &str) -> Option<String> {
    use std::ptr::null_mut;
    use winapi::*;

    let mut hkey: HKEY = null_mut();
    if unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(root).as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    } != 0
    {
        return None;
    }
    let found = (|| {
        for index in 0..4096u32 {
            let mut name_buf = [0u16; 512];
            let mut name_len: DWORD = name_buf.len() as DWORD;
            let rc = unsafe {
                RegEnumKeyExW(
                    hkey,
                    index,
                    name_buf.as_mut_ptr(),
                    &mut name_len,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                )
            };
            if rc != 0 {
                // ERROR_NO_MORE_ITEMS (259) ends the walk; access
                // denied or an over-long name stops it too — best
                // effort, and the fallback explains the rest.
                break;
            }
            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            if !normalise(&name).contains(needle) {
                continue;
            }
            let instance = format!(r"{root}\{name}");
            if let Some(port) = read_port_name(&format!(r"{instance}\Device Parameters")) {
                return Some(port);
            }
            if let Some(port) = read_port_name(&instance) {
                return Some(port);
            }
            for child in child_keys(&instance) {
                if let Some(port) =
                    read_port_name(&format!(r"{instance}\{child}\Device Parameters"))
                {
                    return Some(port);
                }
            }
        }
        None
    })();
    unsafe { RegCloseKey(hkey) };
    found
}

/// The immediate subkeys of one instance, bounded: only a matched
/// instance is ever enumerated, and device-instance trees are small.
#[cfg(windows)]
fn child_keys(instance: &str) -> Vec<String> {
    use std::ptr::null_mut;
    use winapi::*;

    let mut hkey: HKEY = null_mut();
    if unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(instance).as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    } != 0
    {
        return Vec::new();
    }
    let mut out = Vec::new();
    for index in 0..64u32 {
        let mut name_buf = [0u16; 512];
        let mut name_len: DWORD = name_buf.len() as DWORD;
        let rc = unsafe {
            RegEnumKeyExW(
                hkey,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        if rc != 0 {
            break;
        }
        out.push(String::from_utf16_lossy(&name_buf[..name_len as usize]));
    }
    unsafe { RegCloseKey(hkey) };
    out
}

/// Read `PortName` (a `REG_SZ` like `COM7`) under `path`.
#[cfg(windows)]
fn read_port_name(path: &str) -> Option<String> {
    use std::ptr::null_mut;
    use winapi::*;

    let mut hkey: HKEY = null_mut();
    if unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide(path).as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    } != 0
    {
        return None;
    }
    let found = (|| {
        let mut kind: DWORD = 0;
        let mut size: DWORD = 512;
        let mut buf = [0u8; 512];
        let rc = unsafe {
            RegQueryValueExW(
                hkey,
                wide("PortName").as_ptr(),
                null_mut(),
                &mut kind,
                buf.as_mut_ptr(),
                &mut size,
            )
        };
        if rc != 0 || kind != REG_SZ || size < 2 {
            return None;
        }
        let units = size as usize / 2;
        let utf16: Vec<u16> = buf
            .chunks_exact(2)
            .take(units)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let value = String::from_utf16_lossy(&utf16);
        let value = value.trim_end_matches('\0');
        // Only a real port name: `PortName` exists on device keys that
        // are not serial ports too.
        matches!(
            crate::bluetooth::parse(value),
            Ok(BluetoothTarget::ComPort(_))
        )
        .then(|| value.to_string())
    })();
    unsafe { RegCloseKey(hkey) };
    found
}

/// What Windows puts in instance IDs: no separators, any case.
#[cfg(windows)]
fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
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
        for bad in [
            "A4:77:17:22:33:44:0",
            "A4:77:17:22:33:44:31",
            "A4:77:17:22:33:44:zz",
        ] {
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
            assert_eq!(
                parse(raw).unwrap(),
                BluetoothTarget::ComPort(want.into()),
                "{raw}"
            );
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

    #[test]
    fn a_com_port_says_the_mac_dialing_platform_wants_a_mac() {
        let err = com_port_on_mac_dialing("COM7");
        assert!(err.contains("COM7"), "{err}");
        assert!(err.contains("Windows"), "{err}");
        assert!(err.contains("MAC"), "{err}");
    }

    #[test]
    fn a_mac_without_a_port_says_both_fixes() {
        let BluetoothTarget::Device { mac, .. } = parse("A4:77:17:22:33:44").unwrap() else {
            panic!("expected a device");
        };
        let err = no_com_port_for_mac(&mac);
        assert!(err.contains("A4:77:17:22:33:44"), "{err}");
        assert!(err.contains("COM7"), "{err}");
        assert!(err.contains("Pair the printer"), "{err}");
        assert!(err.contains("OS driver"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_sockaddr_lays_out_the_way_the_kernel_reads_it() {
        // The kernel reads `sockaddr_rc` field for field; getting the
        // byte order backwards connects to nothing (or the wrong
        // thing), so the layout is pinned here rather than trusted to
        // memory.
        let (mac, channel) = match parse("A4:77:17:22:33:44") {
            Ok(BluetoothTarget::Device { mac, channel }) => (mac, channel),
            other => panic!("expected a device: {other:?}"),
        };
        let addr = sys::SockAddrRc::new(&mac, channel);
        assert_eq!(addr.rc_family, sys::AF_BLUETOOTH as u16);
        // bdaddr_t is stored last-octet-first, like BlueZ's str2ba.
        assert_eq!(addr.rc_bdaddr, [0x44, 0x33, 0x22, 0x17, 0x77, 0xA4]);
        assert_eq!(addr.rc_channel, 1);
        // C's sizeof(struct sockaddr_rc): 2 + 6 + 1, padded to 2.
        assert_eq!(std::mem::size_of::<sys::SockAddrRc>(), 10);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_channel_suffix_reaches_the_socket() {
        let (mac, channel) = match parse("A4:77:17:22:33:44:7") {
            Ok(BluetoothTarget::Device { mac, channel }) => (mac, channel),
            other => panic!("expected a device: {other:?}"),
        };
        assert_eq!(channel, 7);
        assert_eq!(sys::SockAddrRc::new(&mac, channel).rc_channel, 7);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_com_port_is_not_dialled_on_linux() {
        let err = BluetoothTransport::connect("COM7", Duration::from_secs(2)).unwrap_err();
        assert!(!err.retryable(), "{err}");
        assert!(err.reason().contains("COM7"), "{err}");
        assert!(err.reason().contains("MAC"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_junk_address_carries_the_format_message() {
        let err = BluetoothTransport::connect("usb://dummy", Duration::from_secs(2)).unwrap_err();
        assert!(!err.retryable(), "{err}");
        assert!(err.reason().contains("A4:77:17:22:33:44"), "{err}");
    }

    /// No Bluetooth hardware, no paired device, a dead address: the dial
    /// fails with an error, and it cannot hang — the connect deadline is
    /// what fires.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_unreachable_device_fails_instead_of_hanging() {
        let started = Instant::now();
        let err =
            BluetoothTransport::connect("00:00:00:00:00:00", Duration::from_secs(5)).unwrap_err();
        // A kernel with a Bluetooth stack names the unreachable printer;
        // a kernel with none at all (containers, CI images) says so
        // instead. Both are the clean failure this test guards — never a
        // hang.
        assert!(
            err.reason().contains("Bluetooth printer")
                || err.reason().contains("no Bluetooth support"),
            "{err}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the dial must not outlive its deadline by much"
        );
    }

    #[cfg(windows)]
    #[test]
    fn opening_a_missing_port_is_a_connect_error() {
        // COM 65000 is never assigned. The open is bounded by the
        // deadline, so this cannot hang.
        let err = BluetoothTransport::connect("COM65000", Duration::from_secs(5)).unwrap_err();
        assert!(err.reason().contains("COM65000"), "{err}");
        assert!(
            err.retryable() || err.reason().contains("does not exist"),
            "a missing port must either be retryable or say it does not exist: {err}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_junk_address_carries_the_format_message_on_windows() {
        let err = BluetoothTransport::connect("usb://dummy", Duration::from_secs(5)).unwrap_err();
        assert!(!err.retryable(), "{err}");
        assert!(err.reason().contains("A4:77:17:22:33:44"), "{err}");
    }
}
