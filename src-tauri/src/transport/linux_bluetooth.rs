//! Driverless Bluetooth printing on Linux: an RFCOMM (serial port
//! profile) socket dialled straight to the paired device.
//!
//! No CUPS queue, no printer driver — the kernel's Bluetooth stack
//! carries the bytes. Pairing itself stays an OS flow (bluetoothctl or
//! the desktop's Bluetooth settings); once the device is paired this
//! transport opens the socket by MAC, exactly like Android's plugin
//! does through its own RFCOMM code.
//!
//! Every operation here is a blocking syscall, so each one runs on the
//! blocking pool with a deadline of its own: a printer that is off,
//! out of range or wedged fails in seconds and names the stage, never
//! hangs the queue. The socket stays non-blocking and is polled, so a
//! deadline is always ours rather than the kernel's page timeout.

use crate::transport::bluetooth_addr::{self, BluetoothTarget, Mac};
use crate::transport::{send_timeout, status, PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::io;
use std::os::unix::io::RawFd;
use std::time::{Duration, Instant};

/// `AF_BLUETOOTH` and `BTPROTO_RFCOMM` from `<bluetooth/bluetooth.h>` /
/// `<bluetooth/rfcomm.h>`. Fixed kernel ABI values, spelled out so the
/// module does not depend on which of them a given `libc` version
/// happens to export.
const AF_BLUETOOTH: libc::c_int = 31;
const BTPROTO_RFCOMM: libc::c_int = 3;

/// How long one connection may take to be accepted.
///
/// Short so an unreachable printer fails in seconds rather than after
/// the whole send budget (a page timeout on an absent device is longer
/// than this; the poll deadline is what fires first).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the bytes of one job may take to be accepted, before
/// [`send_timeout`] overrides it (the same seam raw TCP uses).
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a status query's answer. Replies are specified
/// to be immediate, but the wait is still bounded so a printer that
/// never answers pays seconds, not a hung job.
const STATUS_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// Bluetooth printers are reached by dialing their MAC — there is no
/// discovery here, because pairing stays an OS flow (the same rule as
/// Android's bonded list): `discover` is empty.
#[derive(Clone)]
pub struct LinuxBluetoothPrinter {
    pub name: String,
    pub address: String,
}

impl LinuxBluetoothPrinter {
    pub fn new(name: String, address: String) -> Self {
        Self { name, address }
    }

    /// How every message about this printer names it.
    fn at(&self) -> String {
        format!("Bluetooth printer {}", self.address.trim())
    }

    /// The MAC and RFCOMM channel this row dials.
    ///
    /// `COM…` is Windows' serial port and has no meaning here; the
    /// message points back at the shape Linux needs instead of at the
    /// generic format error alone.
    fn device(&self) -> Result<(Mac, u8), String> {
        match bluetooth_addr::parse(&self.address) {
            Ok(BluetoothTarget::Device { mac, channel }) => Ok((mac, channel)),
            Ok(BluetoothTarget::ComPort(port)) => Err(format!(
                "{port} is a Windows serial port — on Linux, use the printer's MAC \
                 (for example A4:77:17:22:33:44); pair it in your OS Bluetooth \
                 settings first"
            )),
            Err(e) => Err(e),
        }
    }

    /// Is the printer answering? Connects an RFCOMM socket and closes
    /// it — nothing is written, so looking cannot print.
    pub async fn reach(&self) -> Result<(), String> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.reach_blocking())
            .await
            .unwrap_or_else(|e| Err(format!("Bluetooth probe task failed: {e}")))
    }

    fn reach_blocking(&self) -> Result<(), String> {
        let (mac, channel) = self.device()?;
        let t = Instant::now();
        let fd = connect_rfcomm(&mac, channel, CONNECT_TIMEOUT)?;
        unsafe { libc::close(fd) };
        tracing::debug!(
            address = %mac.text(),
            channel,
            probe_ms = t.elapsed().as_millis() as u64,
            "Bluetooth probe"
        );
        Ok(())
    }

    /// Open, ask, write, close — all on one held socket, all on the
    /// blocking pool with deadlines inside.
    fn send_blocking(&self, job: RenderedJob) -> Result<(), String> {
        let (mac, channel) = self.device()?;
        let at = self.at();
        let fd = connect_rfcomm(&mac, channel, CONNECT_TIMEOUT)?;
        let outcome = (|| {
            self.precheck(fd, &job)?;
            let budget = send_timeout(SEND_TIMEOUT);
            let t = Instant::now();
            write_all(fd, &job.data, Instant::now() + budget, budget, &at)?;
            tracing::debug!(
                address = %mac.text(),
                bytes = job.data.len(),
                write_ms = t.elapsed().as_millis() as u64,
                "Bluetooth write"
            );
            Ok(())
        })();
        // Best-effort release on every path — success, refusal or a
        // broken link. The kernel reaps the socket when we die anyway.
        unsafe { libc::close(fd) };
        outcome
    }

    /// Ask the printer about itself before the job goes out, and refuse
    /// to send if it says it cannot print.
    ///
    /// Same contract as the raw-TCP and Android prechecks: the printer's
    /// own configured language decides which status query, if any, it is
    /// asked (`status::dialect_for`); an unanswered query is only a fault
    /// once the printer has answered before. The question and the job
    /// share one connection, so the send pays one connect, not two.
    ///
    /// A question that cannot even be written is swallowed: the job's own
    /// write reports a dead link better than a probe's would.
    fn precheck(&self, fd: RawFd, job: &RenderedJob) -> Result<(), String> {
        let Some(dialect) = status::dialect_for(&job.language) else {
            return Ok(());
        };
        if !status::should_probe(&self.address, Instant::now()) {
            return Ok(());
        }
        let at = self.at();
        let query = dialect.query();
        if write_all(
            fd,
            &query,
            Instant::now() + STATUS_REPLY_TIMEOUT,
            STATUS_REPLY_TIMEOUT,
            &at,
        )
        .is_err()
        {
            return Ok(());
        }
        let (reply, end) = read_reply(fd, STATUS_REPLY_TIMEOUT, |r| dialect.answered(r));

        if reply.is_empty() {
            // Closed mid-question: the job's own write will say that
            // better than any status message could — not a fault here.
            if matches!(end, ReplyEnd::Closed) {
                return Ok(());
            }
            let was_answering = status::had_answered(&self.address);
            status::note_silent(&self.address, Instant::now());
            return if was_answering {
                Err(status::silence_message(&at, STATUS_REPLY_TIMEOUT))
            } else {
                // Never answered: may not implement status — job goes out.
                Ok(())
            };
        }

        status::note_answered(&self.address);
        match status::decode(dialect, &reply) {
            Some(fault) => Err(fault.message(&at)),
            None => {
                status::note_healthy(&self.address, Instant::now());
                Ok(())
            }
        }
    }

    /// Ask one dialect at a time over fresh connections and return the
    /// first that answers, for the printer form's Detect button.
    ///
    /// Deliberately no status bookkeeping: a question asked from the add
    /// form is not a print (the same rule as the raw-TCP probe).
    pub(crate) async fn probe_wire_dialect(address: &str) -> Option<status::Dialect> {
        let target = bluetooth_addr::parse(address).ok()?;
        let BluetoothTarget::Device { mac, channel } = target else {
            return None;
        };
        tokio::task::spawn_blocking(move || {
            for dialect in [
                status::Dialect::Zpl,
                status::Dialect::Tspl,
                status::Dialect::EscPos,
            ] {
                // One connect decides for all three: an unreachable
                // device does not become reachable by asking again.
                let fd = connect_rfcomm(&mac, channel, CONNECT_TIMEOUT).ok()?;
                let answered = {
                    let query = dialect.query();
                    let write_ok = write_all(
                        fd,
                        &query,
                        Instant::now() + STATUS_REPLY_TIMEOUT,
                        STATUS_REPLY_TIMEOUT,
                        "the printer",
                    )
                    .is_ok();
                    let (reply, _) = read_reply(fd, STATUS_REPLY_TIMEOUT, |r| {
                        dialect.answered(r)
                    });
                    write_ok && dialect.answered(&reply)
                };
                unsafe { libc::close(fd) };
                if answered {
                    return Some(dialect);
                }
            }
            None
        })
        .await
        .unwrap_or(None)
    }
}

#[async_trait]
impl PrinterTransport for LinuxBluetoothPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        // Pairing stays an OS flow; there is nothing to scan for here.
        Vec::new()
    }

    async fn test(&self) -> Result<(), String> {
        // Connectivity only: the socket open proves the printer answers,
        // and writing probe bytes could put marks on paper.
        self.reach().await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.send_blocking(job))
            .await
            .unwrap_or_else(|e| Err(format!("Bluetooth send task failed: {e}")))
    }
}

/// `sockaddr_rc` from `<bluetooth/rfcomm.h>`: family, address (stored
/// reversed — see [`Mac::bdaddr_le`]), channel. The explicit pad byte
/// keeps every byte initialised and the size at the C layout's 10.
#[repr(C)]
struct SockAddrRc {
    rc_family: u16,
    rc_bdaddr: [u8; 6],
    rc_channel: u8,
    _pad: u8,
}

impl SockAddrRc {
    fn new(mac: &Mac, channel: u8) -> Self {
        Self {
            rc_family: AF_BLUETOOTH as u16,
            rc_bdaddr: mac.bdaddr_le(),
            rc_channel: channel,
            _pad: 0,
        }
    }
}

/// Create the RFCOMM socket and put it in non-blocking mode, so every
/// deadline below is enforced by our own poll rather than by the
/// kernel's page timeout.
fn socket_rfcomm() -> Result<RawFd, String> {
    let fd = unsafe { libc::socket(AF_BLUETOOTH, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, BTPROTO_RFCOMM) };
    if fd < 0 {
        let e = io::Error::last_os_error();
        return Err(match e.raw_os_error() {
            Some(libc::EAFNOSUPPORT) | Some(libc::EPFNOSUPPORT) => format!(
                "this system has no Bluetooth support (the kernel has no Bluetooth \
                 stack): {e}"
            ),
            _ => format!("could not open a Bluetooth socket: {e}"),
        });
    }
    if let Err(e) = set_nonblocking(fd) {
        unsafe { libc::close(fd) };
        return Err(format!("could not configure the Bluetooth socket: {e}"));
    }
    Ok(fd)
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Dial the device, bounded by `timeout`.
///
/// A non-blocking `connect` answers `EINPROGRESS`; the socket is then
/// polled for writability and `SO_ERROR` carries the real outcome, so
/// an absent, refusing or unreachable device each fail here with their
/// own words instead of hanging.
fn connect_rfcomm(mac: &Mac, channel: u8, timeout: Duration) -> Result<RawFd, String> {
    let at = format!("Bluetooth printer {}", mac.text());
    let fd = socket_rfcomm()?;
    let addr = SockAddrRc::new(mac, channel);
    let rc = unsafe {
        libc::connect(
            fd,
            &addr as *const SockAddrRc as *const libc::sockaddr,
            std::mem::size_of::<SockAddrRc>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINPROGRESS) {
            unsafe { libc::close(fd) };
            return Err(connect_error(&at, channel, e));
        }
        match wait(fd, libc::POLLOUT, Instant::now() + timeout) {
            Ok(false) => {
                unsafe { libc::close(fd) };
                Err(format!(
                    "{at} did not answer within {}s — check it is paired, powered on \
                     and in range",
                    timeout.as_secs()
                ))
            }
            Ok(true) => {
                let mut so_error: libc::c_int = 0;
                let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
                let got = unsafe {
                    libc::getsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_ERROR,
                        &mut so_error as *mut libc::c_int as *mut libc::c_void,
                        &mut len,
                    )
                };
                if got != 0 {
                    let e = io::Error::last_os_error();
                    unsafe { libc::close(fd) };
                    return Err(connect_error(&at, channel, e));
                }
                if so_error != 0 {
                    let e = io::Error::from_raw_os_error(so_error);
                    unsafe { libc::close(fd) };
                    return Err(connect_error(&at, channel, e));
                }
                Ok(fd)
            }
            Err(e) => {
                unsafe { libc::close(fd) };
                Err(e)
            }
        }
    } else {
        Ok(fd)
    }
}

/// Turn a connect failure into words an operator can act on.
fn connect_error(at: &str, channel: u8, e: io::Error) -> String {
    match e.raw_os_error() {
        Some(libc::ECONNREFUSED) => format!(
            "{at} refused the connection on RFCOMM channel {channel} — the printer may \
             expose its serial port on another channel (try …:{}, or re-pair it)",
            if channel < 30 { channel + 1 } else { 1 }
        ),
        Some(libc::EHOSTUNREACH)
        | Some(libc::ETIMEDOUT)
        | Some(libc::ENODEV)
        | Some(libc::EHOSTDOWN) => format!(
            "Could not reach {at} — check it is paired, powered on and in range: {e}"
        ),
        Some(libc::EINVAL) => format!(
            "{at} rejected the address — check the MAC and the RFCOMM channel ({channel})"
        ),
        _ => format!("Could not reach {at}: {e}"),
    }
}

/// Wait until `events` is ready or the deadline passes.
///
/// `Ok(true)` — ready (or an error condition the next call reports);
/// `Ok(false)` — the deadline passed; `Err` — `poll` itself failed.
fn wait(fd: RawFd, events: libc::c_short, deadline: Instant) -> Result<bool, String> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let ms = (deadline - now).as_millis().min(i32::MAX as u128) as i32;
        let mut pfd = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let rc = unsafe { libc::poll(&mut pfd, 1, ms) };
        if rc < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("Bluetooth connection failed: {e}"));
        }
        if rc == 0 {
            return Ok(false);
        }
        // POLLERR / POLLHUP / POLLNVAL: the follow-up call (SO_ERROR on
        // connect, read/write on the held socket) reports the reason.
        if pfd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
            || pfd.revents & events != 0
        {
            return Ok(true);
        }
        // A wake that carried neither: wait again inside the deadline.
    }
}

/// Write every byte before the deadline.
///
/// A printer that accepts the connection and then stops reading — a
/// full buffer or a wedged link — would otherwise block the queue
/// forever, exactly the failure raw TCP's deadline exists to end.
fn write_all(
    fd: RawFd,
    data: &[u8],
    deadline: Instant,
    budget: Duration,
    at: &str,
) -> Result<(), String> {
    let mut off = 0usize;
    while off < data.len() {
        match wait(fd, libc::POLLOUT, deadline) {
            Ok(false) => {
                return Err(format!(
                    "{at} stopped responding after {}s while sending — check for a \
                     paper jam or out-of-paper, or that it is still connected",
                    budget.as_secs()
                ));
            }
            Ok(true) => {}
            Err(e) => return Err(e),
        }
        let n = unsafe {
            libc::write(
                fd,
                data[off..].as_ptr() as *const libc::c_void,
                data.len() - off,
            )
        };
        if n < 0 {
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::EAGAIN) | Some(libc::EWOULDBLOCK) | Some(libc::EINTR) => {
                    continue;
                }
                _ => {
                    return Err(format!(
                        "{at} closed the connection while the job was sending: {e}"
                    ));
                }
            }
        }
        if n == 0 {
            return Err(format!("{at} accepted no bytes"));
        }
        off += n as usize;
    }
    Ok(())
}

/// How a status question ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplyEnd {
    /// The answer arrived complete.
    Answered,
    /// The printer hung up (or the link broke) — possibly mid-answer.
    Closed,
    /// The deadline passed with no complete answer.
    Timeout,
}

/// Read until `answered` says the reply is complete, the printer hangs
/// up, or `budget` runs out. Returns everything read and how it ended,
/// so the caller can tell silence from a closed connection.
fn read_reply(
    fd: RawFd,
    budget: Duration,
    answered: impl Fn(&[u8]) -> bool,
) -> (Vec<u8>, ReplyEnd) {
    let deadline = Instant::now() + budget;
    let mut reply = Vec::new();
    let mut chunk = [0u8; 256];
    loop {
        match wait(fd, libc::POLLIN, deadline) {
            Ok(false) => return (reply, ReplyEnd::Timeout),
            Err(_) => return (reply, ReplyEnd::Closed),
            Ok(true) => {}
        }
        let n = unsafe { libc::read(fd, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len()) };
        if n < 0 {
            let e = io::Error::last_os_error();
            match e.raw_os_error() {
                Some(libc::EAGAIN) | Some(libc::EWOULDBLOCK) | Some(libc::EINTR) => {
                    continue;
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn printer(address: &str) -> LinuxBluetoothPrinter {
        LinuxBluetoothPrinter::new("Label".into(), address.into())
    }

    /// The kernel reads `sockaddr_rc` field for field; getting the byte
    /// order backwards connects to nothing (or the wrong thing), so the
    /// layout is pinned here rather than trusted to memory.
    #[test]
    fn the_sockaddr_lays_out_the_way_the_kernel_reads_it() {
        let (mac, channel) = printer("A4:77:17:22:33:44").device().unwrap();
        let addr = SockAddrRc::new(&mac, channel);
        assert_eq!(addr.rc_family, AF_BLUETOOTH as u16);
        // bdaddr_t is stored last-octet-first, like BlueZ's str2ba.
        assert_eq!(addr.rc_bdaddr, [0x44, 0x33, 0x22, 0x17, 0x77, 0xA4]);
        assert_eq!(addr.rc_channel, 1);
        // C's sizeof(struct sockaddr_rc): 2 + 6 + 1, padded to 2.
        assert_eq!(std::mem::size_of::<SockAddrRc>(), 10);
    }

    #[test]
    fn the_channel_suffix_reaches_the_socket() {
        let (mac, channel) = printer("A4:77:17:22:33:44:7").device().unwrap();
        assert_eq!(channel, 7);
        assert_eq!(SockAddrRc::new(&mac, channel).rc_channel, 7);
    }

    /// A Windows serial port is not an address this platform can dial;
    /// the message must say where to look instead of repeating the
    /// generic format error.
    #[test]
    fn a_com_port_says_this_platform_wants_a_mac() {
        let err = printer("COM7").device().unwrap_err();
        assert!(err.contains("COM7"), "{err}");
        assert!(err.contains("Windows"), "{err}");
        assert!(err.contains("MAC"), "{err}");
    }

    #[test]
    fn a_junk_address_carries_the_format_message() {
        let err = printer("usb://dummy").device().unwrap_err();
        assert!(err.contains("A4:77:17:22:33:44"), "{err}");
    }

    /// No Bluetooth hardware, no paired device, a dead address: every
    /// route fails with an error, and none of them can hang — the
    /// connect deadline is what the outer timeout guards.
    #[tokio::test]
    async fn an_unreachable_device_fails_instead_of_hanging() {
        let p = printer("00:00:00:00:00:00");
        let reached = tokio::time::timeout(Duration::from_secs(15), p.reach())
            .await
            .expect("the connect deadline must fire before any hang");
        let err = reached.expect_err("nothing answers at 00:00:00:00:00:00");
        assert!(err.contains("Bluetooth printer"), "{err}");
    }

    /// A test never writes: `test` is reachability, and probe bytes on
    /// an ESC/POS head would print a blank line.
    #[tokio::test]
    async fn test_is_reach_and_nothing_more() {
        let p = printer("A4:77:17:22:33:44");
        // Unpaired in CI: must come back as an error, not as a print.
        let result = tokio::time::timeout(Duration::from_secs(15), p.test()).await;
        assert!(matches!(result, Ok(Err(_))), "test must not succeed or hang");
    }
}
