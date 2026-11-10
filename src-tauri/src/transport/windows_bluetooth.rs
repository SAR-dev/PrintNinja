//! Bluetooth printers on Windows — driverless first, spooler as the
//! fallback.
//!
//! A paired printer normally gets a virtual serial port from Windows
//! (its Serial Port Profile service), and that port needs no printer
//! driver at all: when the row's address names one — `COM7` directly,
//! or a MAC whose device already owns a port — the job is written to
//! the port itself, exactly like Android writes to its RFCOMM socket.
//! The spooler is never involved on that path, so there is no queue to
//! install and no spooler latency on the wire.
//!
//! When the address names no port, behaviour is what it always was:
//! jobs go to the Windows printer queue of the same *name*, which must
//! already be installed. Old rows — whose address used to be ignored —
//! therefore keep printing, and a failed fallback explains how to get a
//! COM port for the driverless path instead.
//!
//! Nothing here scans for paired devices: pairing stays an OS flow and
//! `discover` is empty, as on every other desktop transport.

use crate::transport::bluetooth_addr::{self, BluetoothTarget};
use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;

#[cfg(windows)]
use crate::transport::send_timeout;
#[cfg(windows)]
use std::ptr::null_mut;
#[cfg(windows)]
use std::time::Duration;

/// How long the direct (COM port) path may take for one job: the same
/// budget raw TCP uses, overridable by `PRINTNINJA_SEND_TIMEOUT_SECS`.
#[cfg(windows)]
const DIRECT_SEND_TIMEOUT: Duration = Duration::from_secs(30);

pub struct WindowsBluetoothPrinter {
    pub name: String,
    pub address: String,
}

impl WindowsBluetoothPrinter {
    pub fn new(name: String, address: String) -> Self {
        Self { name, address }
    }

    /// The COM port this row should print through, when it can name
    /// one: `COM7` (or `\\.\COM7`) explicitly, or a MAC whose paired
    /// device already owns a port on this machine (best-effort
    /// registry lookup — see [`com_port_for_mac`]).
    #[cfg(windows)]
    fn direct_port(&self) -> Option<String> {
        match bluetooth_addr::parse(self.address.trim()).ok()? {
            BluetoothTarget::ComPort(port) => Some(port),
            BluetoothTarget::Device { mac, .. } => com_port_for_mac(&mac),
        }
    }

    /// Spooler failures for a row that *meant* to go direct say how to
    /// get a COM port, because "queue not found" alone hides the
    /// driverless route that was the point of the address.
    fn fallback_error(&self, base: String) -> String {
        match bluetooth_addr::parse(self.address.trim()) {
            Ok(BluetoothTarget::Device { mac, .. }) => format!(
                "{base} — the address {} names no COM port on this PC. Pair the \
                 printer in Windows settings (Settings → Bluetooth & devices) so \
                 Windows assigns one and enter it here (for example COM7); or \
                 install the printer as a Windows printer and keep this row's name \
                 equal to that queue's name",
                mac.text()
            ),
            _ => base,
        }
    }

    /// Is the printer answering? Direct: open the port and close it —
    /// nothing is written, so looking cannot print. Fallback: the
    /// queue's own status check.
    pub async fn reach(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Some(port) = self.direct_port() {
                return direct::open_and_close(&port).await;
            }
        }
        let spooler = crate::transport::windows_spooler::WindowsSpooler::new(self.name.clone());
        let res = tokio::task::spawn_blocking(move || spooler.check_ready())
            .await
            .unwrap_or_else(|e| Err(format!("spooler test task failed: {e}")));
        res.map_err(|e| self.fallback_error(e))
    }

    /// Direct when the address names a port; otherwise the queue of
    /// the same name, exactly as before this module grew a direct
    /// path. Command languages always go out as `RAW` — the bytes are
    /// the printer's own dialect with nothing in between.
    pub async fn send_job(&self, job: RenderedJob) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Some(port) = self.direct_port() {
                return direct::send(&port, &job.data, send_timeout(DIRECT_SEND_TIMEOUT)).await;
            }
        }
        let spooler = crate::transport::windows_spooler::WindowsSpooler::new(self.name.clone());
        let data = job.data;
        let res = tokio::task::spawn_blocking(move || spooler.send_raw(&data))
            .await
            .unwrap_or_else(|e| Err(format!("spooler send task failed: {e}")));
        res.map_err(|e| self.fallback_error(e))
    }
}

#[async_trait]
impl PrinterTransport for WindowsBluetoothPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Vec::new()
    }

    async fn test(&self) -> Result<(), String> {
        // Status only: no bytes go out, so no assumption about the
        // language (the same rule as the spooler's own test).
        self.reach().await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_job(job).await
    }
}

// ─────────────────────────────────────────────────────────────────────
// Win32, declared the way `windows_spooler` declares its winspool
// calls: kernel32 for the port, advapi32 for the registry lookup that
// maps a MAC to its port.
// ─────────────────────────────────────────────────────────────────────

#[cfg(windows)]
#[allow(clippy::upper_case_acronyms)]
mod winapi {
    use std::ffi::c_void;

    pub type HANDLE = *mut c_void;
    pub type HKEY = *mut c_void;
    pub type BOOL = i32;
    pub type DWORD = u32;

    /// `COMMTIMEOUTS` (winbase.h): the write total timeout is
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
        pub fn CloseHandle(hObject: HANDLE) -> BOOL;
        pub fn SetCommTimeouts(hFile: HANDLE, lpCommTimeouts: *const COMMTIMEOUTS) -> BOOL;
        pub fn GetLastError() -> DWORD;
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

    pub const GENERIC_WRITE: DWORD = 0x4000_0000;
    pub const OPEN_EXISTING: DWORD = 3;
    pub const FILE_ATTRIBUTE_NORMAL: DWORD = 0x80;
    pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
    pub const ERROR_FILE_NOT_FOUND: DWORD = 2;
    pub const ERROR_ACCESS_DENIED: DWORD = 5;
    pub const ERROR_SHARING_VIOLATION: DWORD = 32;
    pub const ERROR_NO_MORE_ITEMS: i32 = 259;
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

// ─────────────────────────────────────────────────────────────────────
// The driverless path: the paired device's own COM port.
// ─────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod direct {
    use super::winapi::*;
    use super::{wide, DIRECT_SEND_TIMEOUT};
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::time::{Duration, Instant};

    /// Open the port, write every byte, close — all on the blocking
    /// pool, with the send budget enforced twice: once by the port's
    /// own write timeout and once by a deadline around the whole call,
    /// so a driver that ignores `COMMTIMEOUTS` still cannot hang the
    /// queue.
    pub(super) async fn send(port: &str, data: &[u8], budget: Duration) -> Result<(), String> {
        let port = port.to_string();
        let data = data.to_vec();
        let task = tokio::task::spawn_blocking(move || {
            let handle = open_port(&port, budget)?;
            let result = write_job(handle, &port, &data, budget);
            unsafe { CloseHandle(handle) };
            result
        });
        match tokio::time::timeout(budget + Duration::from_secs(5), task).await {
            Err(_) => Err(format!(
                "the printer on {port} stopped responding after {}s — check for a \
                 paper jam or out-of-paper, or that it is still connected",
                budget.as_secs()
            )),
            Ok(Err(e)) => Err(format!("Bluetooth send task failed: {e}")),
            Ok(Ok(res)) => res,
        }
    }

    /// Connectivity only: opening the port proves the device answers,
    /// and nothing is written, so looking cannot print.
    pub(super) async fn open_and_close(port: &str) -> Result<(), String> {
        let port = port.to_string();
        tokio::task::spawn_blocking(move || {
            let handle = open_port(&port, DIRECT_SEND_TIMEOUT)?;
            unsafe { CloseHandle(handle) };
            Ok(())
        })
        .await
        .unwrap_or_else(|e| Err(format!("Bluetooth probe task failed: {e}")))
    }

    /// Open the virtual serial port the paired device owns.
    ///
    /// The `\\.\` prefix is required (and harmless) for COM10 and
    /// above, so it is always used. Failures are named the way an
    /// operator can act on them: a missing port means Windows never
    /// assigned one, an in-use port means another program holds it.
    fn open_port(port: &str, budget: Duration) -> Result<HANDLE, String> {
        let path = wide(&format!(r"\\.\{port}"));
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE,
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
                ERROR_FILE_NOT_FOUND => format!(
                    "COM port {port} does not exist — pair the printer in Windows \
                     settings so Windows assigns one, then set this printer's \
                     address to the port Device Manager shows (Ports (COM & LPT))"
                ),
                ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION => format!(
                    "COM port {port} is in use by another program — close it and try \
                     again"
                ),
                _ => format!("could not open COM port {port} (Windows error {code})"),
            });
        }
        // Bound the write at the port itself: a link that stops
        // draining must fail the job, not park it forever.
        apply_write_timeout(handle, port, budget)?;
        Ok(handle)
    }

    /// Put the port's own write deadline in place.
    fn apply_write_timeout(handle: HANDLE, port: &str, budget: Duration) -> Result<(), String> {
        let constant = u32::try_from(budget.as_millis()).unwrap_or(u32::MAX).max(1);
        let timeouts = COMMTIMEOUTS {
            ReadIntervalTimeout: 0,
            ReadTotalTimeoutMultiplier: 0,
            ReadTotalTimeoutConstant: 0,
            WriteTotalTimeoutMultiplier: 0,
            WriteTotalTimeoutConstant: constant,
        };
        if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "could not set write timeouts on COM port {port} (Windows error {code})"
            ));
        }
        Ok(())
    }

    /// Write the job in bounded chunks, each with the time the budget
    /// still allows. `WriteFile` can return success having taken fewer
    /// bytes than offered (a write timeout reads that way too), so the
    /// count is checked exactly as the spooler checks `WritePrinter`.
    fn write_job(handle: HANDLE, port: &str, data: &[u8], budget: Duration) -> Result<(), String> {
        let deadline = Instant::now() + budget;
        for chunk in data.chunks(64 * 1024) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "the printer on {port} stopped responding after {}s while \
                     sending — check for a paper jam or out-of-paper, or that it is \
                     still connected",
                    budget.as_secs()
                ));
            }
            apply_write_timeout(handle, port, remaining)?;
            let mut written: DWORD = 0;
            let ok = unsafe {
                WriteFile(
                    handle,
                    chunk.as_ptr() as *const c_void,
                    chunk.len() as DWORD,
                    &mut written,
                    null_mut(),
                )
            };
            if ok == 0 {
                let code = unsafe { GetLastError() };
                return Err(format!(
                    "COM port {port} stopped accepting the job (Windows error {code})"
                ));
            }
            if written as usize != chunk.len() {
                return Err(format!(
                    "COM port {port} accepted {written} of {} bytes — the job is \
                     incomplete",
                    chunk.len()
                ));
            }
        }
        Ok(())
    }
}

/// Find the COM port Windows assigned to a paired device, by walking
/// the device enumeration for an instance that carries the MAC and
/// reading its `PortName`.
///
/// Best-effort by design: the instance-ID spelling differs between
/// device classes and Windows versions, so a miss is not an error —
/// the caller falls back to the spooler, and the failure message tells
/// the operator to type the port Device Manager shows.
#[cfg(windows)]
fn com_port_for_mac(mac: &bluetooth_addr::Mac) -> Option<String> {
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
    use winapi::*;

    let mut hkey: HKEY = null_mut();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide(root).as_ptr(), 0, KEY_READ, &mut hkey) }
        != 0
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
    use winapi::*;

    let mut hkey: HKEY = null_mut();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide(instance).as_ptr(), 0, KEY_READ, &mut hkey) }
        != 0
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
    use winapi::*;

    let mut hkey: HKEY = null_mut();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide(path).as_ptr(), 0, KEY_READ, &mut hkey) }
        != 0
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
            bluetooth_addr::parse(value),
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
    fn an_explicit_com_port_resolves() {
        // The parse half of `direct_port` is platform-independent, so
        // it is asserted everywhere; the registry half needs Windows
        // and runs in the Windows CI job.
        let p = WindowsBluetoothPrinter::new("T".into(), "COM7".into());
        #[cfg(windows)]
        assert_eq!(p.direct_port().as_deref(), Some("COM7"));
        assert!(p.fallback_error("boom".into()).starts_with("boom"));
    }

    #[test]
    fn a_failed_fallback_explains_how_to_get_a_port() {
        let p = WindowsBluetoothPrinter::new("T".into(), "A4:77:17:22:33:44".into());
        let err = p.fallback_error("queue `T` not found".into());
        assert!(err.contains("A4:77:17:22:33:44"), "{err}");
        assert!(err.contains("COM7"), "{err}");
        assert!(err.contains("Pair the printer"), "{err}");
        // An address that names nothing in particular keeps the
        // spooler's own wording untouched.
        let plain = WindowsBluetoothPrinter::new("T".into(), "whatever".into());
        assert_eq!(
            plain.fallback_error("queue `T` not found".into()),
            "queue `T` not found"
        );
    }

    #[test]
    fn a_mac_address_is_a_valid_target_not_a_parse_error() {
        // Rows sync from phones with the MAC in the address column;
        // treating that as invalid would break every synced row. The
        // contract is "try direct, then explain" — see the fallback
        // message asserted above.
        let p = WindowsBluetoothPrinter::new("T".into(), "A4:77:17:22:33:44".into());
        assert!(bluetooth_addr::parse(p.address.trim()).is_ok());
    }
}
