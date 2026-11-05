//! Phase 0 spike internals — everything is Windows-only (the example's
//! `main` is the non-Windows stub).
//!
//! Answers the open questions from
//! `docs/planned/DIRECT_PRINTING.md` §8 Phase 0 (BLE is out of scope;
//! its subcommands are kept for reference):
//! 1. USB access while a queue exists        → `usb`, `usb-wait`, `pause`, `resume`
//! 2. Queue ↔ device mapping (ContainerId)   → `mapping`
//! 3. Vendor-class USB (which driver binds)  → `mapping` (driver + hardware ids)
//! 4. BLE characteristics / MTU / events     → `ble-scan`, `ble`
//! 5. Throughput, 100 KB                     → `bt`, `ble`, `usb --kb 100`
//!
//! The `windows` 0.58 crate is stale in a few spots this tool touches, so a
//! few types are defined locally against the current SDK headers:
//! - `SOCKADDR_BTH` (0.58 has the deprecated XP-era layout),
//! - `PRINTER_INFO_7` (0.58 models it with two unrelated fields),
//! - the `PRINTER_*` state flags and `AF_BTH` usage (0.58 omits them).
//! Phase 1+ may need to bump the crate; note it in the findings.

use std::mem::size_of;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Devices::Bluetooth::AF_BTH;
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiEnumDeviceInfo, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
    SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceInterfaceDetailW, SetupDiGetDevicePropertyW,
    SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
    HDEVINFO, SETUP_DI_REGISTRY_PROPERTY, SPDRP_DRIVER, SPDRP_FRIENDLYNAME, SPDRP_HARDWAREID,
    SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W, SP_DEVINFO_DATA,
};
use windows::Win32::Devices::Properties::{DEVPROPKEY, DEVPROPTYPE};
use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Graphics::Printing::{
    EnumPrintersW, OpenPrinterW, SetPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
    PRINTER_INFO_2W,
};
use windows::Win32::Networking::WinSock::{
    closesocket, connect, send, shutdown, socket, WSAGetLastError, WSAStartup, SOCKADDR,
    SOCK_STREAM, WINSOCK_SHUTDOWN_HOW, WSADATA,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Threading::WaitForSingleObject;

/// `{28D78FAD-5A12-11D1-AE5B-0000F803A8C2}` — USB printer-class interface
/// (the value the doc fixes; the crate exports it too, but this keeps the
/// tool independent of where the crate puts it).
const GUID_USBPRINT: windows::core::GUID = windows::core::GUID::from_values(
    0x28d78fad,
    0x5a12,
    0x11d1,
    [0xae, 0x5b, 0x00, 0x00, 0xf8, 0x03, 0xa8, 0xc2],
);

/// SPP (Serial Port Profile) UUID.
const SPP_UUID: windows::core::GUID = windows::core::GUID::from_values(
    0x00001101,
    0x0000,
    0x1000,
    [0x80, 0x00, 0x00, 0x80, 0x5f, 0x9b, 0x34, 0xfb],
);

/// DEVPKEY_Device_ContainerId (devprop.h).
const DEVPKEY_CONTAINER_ID: windows::core::GUID = windows::core::GUID::from_values(
    0x25448bfc,
    0x4ba5,
    0x4851,
    [0x96, 0xe1, 0x7d, 0x3a, 0x9b, 0x17, 0xf0, 0xd0],
);

// bthhdef.h / winsock2.h
const BTH_RADIO_TYPE: u8 = 1; // BT_RADIO_TYPE for a classic radio
const BT_DEVICE_EUI48_ADDRESS_TYPE: u8 = 7;
const BTHPROTO_RFCOMM: i32 = 1;

// winpr.h — the printer state flags SetPrinterW applies at level 7.
const PRINTER_PAUSED: u32 = 0x0080;
const PRINTER_WORK_OFFLINE: u32 = 0x0100;
const PRINTER_NO_PAUSE: u32 = 0x0400;
const PRINTER_WORK_ONLINE: u32 = 0x2000;

/// Modern winsock2.h `SOCKADDR_BTH` (Vista+). The `windows` 0.58 copy is
/// the deprecated XP-era layout (`addrFamily/btAddr/serviceClassId/port`)
/// and would mis-parse every field. Explicit padding pins the ABI:
/// u16 @0, u8 @2, pad @3, GUID @4..20, pad @20..24, u64 @24..32,
/// u8 @32, [u8;20] @33..53 → size 56.
#[repr(C)]
#[derive(Clone, Copy)]
struct SockaddrBth {
    addr_family: u16,
    btype: u8,
    _pad1: [u8; 1],
    service_guid: windows::core::GUID,
    _pad2: [u8; 4],
    uuid: u64,
    address_type: u8,
    address: [u8; 20],
}

/// Current winpr.h `PRINTER_INFO_7` (the `windows` 0.58 struct is wrong).
#[repr(C)]
#[derive(Clone, Copy)]
struct PrinterInfo7 {
    status: u32,
    attributes: u32,
    priority: u32,
    start_time: u32,
    until_time: u32,
    flags: u32,
    p_job_names: *mut std::ffi::c_char,
    c_jobs: u32,
    p_security_descriptor: *mut std::ffi::c_void,
}

impl Default for PrinterInfo7 {
    fn default() -> Self {
        Self {
            status: 0,
            attributes: 0,
            priority: 0,
            start_time: 0,
            until_time: 0,
            flags: 0,
            p_job_names: std::ptr::null_mut(),
            c_jobs: 0,
            p_security_descriptor: std::ptr::null_mut(),
        }
    }
}

/// ERROR_NO_MORE_ITEMS (259) as an HRESULT — the enumeration stop signal.
/// 0x80070103, written as the signed `i32` the crate's HRESULT wraps.
fn no_more_items() -> windows::core::HRESULT {
    windows::core::HRESULT(-2147024637i32)
}

fn usage() {
    eprintln!(
        "direct_print_spike subcommands:\n \
         usb [--kb N]                 open every usbprint device, 1284 ID, timed write\n \
         usb-wait <secs>              poll opening; send a spooler job mid-window\n \
         mapping                      queue <-> device ContainerId + driver table\n \
         queues                       list Windows print queues\n \
         pause <queue name>           pause + work the queue offline\n \
         resume <queue name>          resume the queue\n \
         bt <mac> [--kb N]            RFCOMM SPP timed write (default 100 KB)\n \
         ble-scan [secs]              scan BLE (default 15 s)\n \
         ble <mac> [--kb N]           BLE connect, MTU, characteristics, timed write"
    );
}

pub async fn run(args: Vec<String>) -> anyhow::Result<()> {
    let [cmd, rest @ ..] = args.as_slice() else {
        usage();
        return Err(anyhow::anyhow!("no subcommand"));
    };
    match cmd.as_str() {
        "usb" => cmd_usb(kb_flag(rest)).await,
        "usb-wait" => {
            let secs = first(rest).and_then(|s| s.parse().ok()).unwrap_or(60);
            cmd_usb_wait(secs)
        }
        "mapping" => cmd_mapping(),
        "queues" => cmd_queues(),
        "pause" | "resume" => {
            let name = first(rest).ok_or(anyhow::anyhow!("missing queue name"))?;
            set_queue_state(name, cmd == "pause")
        }
        "bt" => cmd_bt(rest),
        "ble-scan" => {
            let secs = first(rest).and_then(|s| s.parse().ok()).unwrap_or(15);
            cmd_ble_scan(secs).await
        }
        "ble" => cmd_ble(rest).await,
        other => {
            eprintln!("unknown subcommand '{other}'");
            usage();
            Err(anyhow::anyhow!("unknown subcommand '{other}'"))
        }
    }
}

fn first<'a>(args: &'a [String]) -> Option<&'a str> {
    args.iter()
        .find(|a| !a.starts_with('-'))
        .map(String::as_str)
}

fn kb_flag(args: &[String]) -> u64 {
    let mut kb: u64 = 100;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--kb" {
            if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                kb = v;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    kb
}

fn parse_mac(s: &str) -> anyhow::Result<[u8; 6]> {
    let mut out = [0u8; 6];
    let parts: Vec<&str> = s.split([':', '-']).collect();
    anyhow::ensure!(parts.len() == 6, "MAC must be 6 groups, got '{s}'");
    for (i, p) in parts.iter().enumerate() {
        out[i] = u8::from_str_radix(p, 16).map_err(|_| anyhow::anyhow!("bad MAC group '{p}'"))?;
    }
    Ok(out)
}

fn mac_str(m: &[u8; 6]) -> String {
    m.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn read_wide(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut n = 0;
    unsafe {
        while *p.add(n) != 0 {
            n += 1;
        }
    }
    unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(p, n)) }
}

fn multi_sz(buf: &[u8]) -> Vec<String> {
    let wide = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u16, buf.len() / 2) };
    wide.split(|&c| c == 0)
        .filter(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

fn win32_code(e: &windows::core::Error) -> u32 {
    // HRESULT wraps the Win32 code for these calls; 0.58's `HRESULT` field
    // is `i32`, so a device-open error like ERROR_ACCESS_DENIED (5) is
    // positive and the cast is lossless for the codes in `map_open_error`.
    e.code().0 as u32
}

/// A human note for the Win32 errors the plan's error table cares about.
fn map_open_error(code: u32) -> &'static str {
    match code {
        2 => "file not found (device path stale?)",
        5 => "ACCESS_DENIED",
        21 => "not a real device",
        32 => "SHARING_VIOLATION (in use)",
        31 => "GEN_FAILURE (stopped responding)",
        225 => "VOLUME_OFFLINE",
        501 => "NOT_READY (offline)",
        640 => "CANNOT_ACCESS_FILE (device gone)",
        1167 => "DEVICE_NOT_CONNECTED",
        _ => "other",
    }
}

// --------------------------------------------------------------------------
// Device enumeration (SetupDi)
// --------------------------------------------------------------------------

struct Dev {
    instance_id: String,
    friendly: String,
    hardware_ids: Vec<String>,
    driver: String,
    container: String,
}

fn reg_sz(di: HDEVINFO, d: &SP_DEVINFO_DATA, prop: SETUP_DI_REGISTRY_PROPERTY) -> String {
    let mut buf = [0u8; 8192];
    let mut kind: u32 = 0;
    unsafe {
        if SetupDiGetDeviceRegistryPropertyW(
            di,
            d,
            prop,
            Some(&mut kind),
            Some(buf.as_mut_slice()),
            None,
        )
        .is_ok()
            && kind == 1
        // REG_SZ
        {
            return read_wide(buf.as_ptr() as *const u16);
        }
    }
    String::new()
}

fn device_instance_id(di: HDEVINFO, d: &SP_DEVINFO_DATA) -> String {
    let mut buf = [0u16; 1024];
    unsafe {
        if SetupDiGetDeviceInstanceIdW(di, d, Some(&mut buf), None).is_ok() {
            return read_wide(buf.as_ptr());
        }
    }
    String::new()
}

/// A REG_SZ DEVPROP value (used for the ContainerId). Best effort: if the
/// key is not recognised on this OS the table shows blank and the doc's
/// 1284-ID fallback still stands.
fn devprop_reg_sz(di: HDEVINFO, d: &SP_DEVINFO_DATA, fmtid: &windows::core::GUID) -> String {
    let key = DEVPROPKEY {
        fmtid: *fmtid,
        pid: 0,
    };
    let mut typ = DEVPROPTYPE(0);
    let mut size: u32 = 0;
    unsafe {
        if SetupDiGetDevicePropertyW(di, d, &key, &mut typ, None, Some(&mut size), 0).is_err()
            || size == 0
        {
            return String::new();
        }
        let mut buf = vec![0u8; size as usize];
        if SetupDiGetDevicePropertyW(di, d, &key, &mut typ, Some(&mut buf), None, 0).is_ok()
            && typ.0 == 1
        // DEVPROP_TYPE_STRING
        {
            let wide = std::slice::from_raw_parts(buf.as_ptr() as *const u16, (size / 2) as usize);
            let wide: Vec<u16> = wide.iter().copied().take_while(|&c| c != 0).collect();
            return String::from_utf16_lossy(&wide);
        }
    }
    String::new()
}

fn all_devices() -> anyhow::Result<Vec<Dev>> {
    let di = unsafe {
        SetupDiGetClassDevsW(None, PCWSTR::null(), None, DIGCF_ALLCLASSES | DIGCF_PRESENT)
            .map_err(|e| anyhow::anyhow!("SetupDiGetClassDevsW(ALLCLASSES): {e}"))?
    };
    let mut out = Vec::new();
    let mut idx: u32 = 0;
    loop {
        let mut d: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
        d.cbSize = size_of::<SP_DEVINFO_DATA>() as u32;
        match unsafe { SetupDiEnumDeviceInfo(di, idx, &mut d) } {
            Ok(()) => {}
            Err(e) if e.code() == no_more_items() => break,
            Err(e) => anyhow::bail!("SetupDiEnumDeviceInfo: {e}"),
        }
        let mut hw = [0u8; 16384];
        let mut kind: u32 = 0;
        unsafe {
            let _ = SetupDiGetDeviceRegistryPropertyW(
                di,
                &d,
                SPDRP_HARDWAREID,
                Some(&mut kind),
                Some(hw.as_mut_slice()),
                None,
            );
        }
        let hardware_ids = if kind == 7 { multi_sz(&hw) } else { vec![] }; // REG_MULTI_SZ
        out.push(Dev {
            instance_id: device_instance_id(di, &d),
            friendly: reg_sz(di, &d, SPDRP_FRIENDLYNAME),
            hardware_ids,
            driver: reg_sz(di, &d, SPDRP_DRIVER),
            container: devprop_reg_sz(di, &d, &DEVPKEY_CONTAINER_ID),
        });
        idx += 1;
    }
    Ok(out)
}

struct UsbPrinter {
    device_path: String,
    friendly: String,
    driver: String,
    hardware_ids: Vec<String>,
}

/// Devices bound to the USB printer class (usbprint.sys), with the
/// interface device path usable in `CreateFileW`.
fn usbprint_devices() -> anyhow::Result<Vec<UsbPrinter>> {
    let di = unsafe {
        SetupDiGetClassDevsW(
            Some(&GUID_USBPRINT),
            PCWSTR::null(),
            None,
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        )
        .map_err(|e| anyhow::anyhow!("SetupDiGetClassDevsW(USBPRINT): {e}"))?
    };
    let mut out = Vec::new();
    let mut idx: u32 = 0;
    loop {
        let mut d: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
        d.cbSize = size_of::<SP_DEVINFO_DATA>() as u32;
        match unsafe { SetupDiEnumDeviceInfo(di, idx, &mut d) } {
            Ok(()) => {}
            Err(e) if e.code() == no_more_items() => break,
            Err(e) => anyhow::bail!("SetupDiEnumDeviceInfo(USBPRINT): {e}"),
        }
        let mut iface_idx: u32 = 0;
        loop {
            let mut ifdata: SP_DEVICE_INTERFACE_DATA = unsafe { std::mem::zeroed() };
            ifdata.cbSize = size_of::<SP_DEVICE_INTERFACE_DATA>() as u32;
            match unsafe {
                SetupDiEnumDeviceInterfaces(di, None, &GUID_USBPRINT, iface_idx, &mut ifdata)
            } {
                Ok(()) => {}
                Err(_) => break,
            }
            let mut detail: SP_DEVICE_INTERFACE_DETAIL_DATA_W = unsafe { std::mem::zeroed() };
            detail.cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
            let mut req: u32 = 0;
            if unsafe {
                SetupDiGetDeviceInterfaceDetailW(
                    di,
                    &ifdata,
                    Some(&mut detail),
                    size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32,
                    Some(&mut req),
                    None,
                )
            }
            .is_ok()
            {
                let mut hw = [0u8; 16384];
                let mut kind: u32 = 0;
                unsafe {
                    let _ = SetupDiGetDeviceRegistryPropertyW(
                        di,
                        &d,
                        SPDRP_HARDWAREID,
                        Some(&mut kind),
                        Some(hw.as_mut_slice()),
                        None,
                    );
                }
                out.push(UsbPrinter {
                    device_path: read_wide(detail.DevicePath.as_ptr()),
                    friendly: reg_sz(di, &d, SPDRP_FRIENDLYNAME),
                    driver: reg_sz(di, &d, SPDRP_DRIVER),
                    hardware_ids: if kind == 7 { multi_sz(&hw) } else { vec![] },
                });
            }
            iface_idx += 1;
        }
        idx += 1;
    }
    Ok(out)
}

/// `USB\VID_04B8&PID_0E15&REV_...` → `04b8:0e15`.
fn vid_pid(hwids: &[String]) -> String {
    for h in hwids {
        if let Some(rest) = h.strip_prefix("USB\\VID_") {
            let mut parts = rest.split('&');
            let vid = parts.next().unwrap_or("");
            let pid = parts
                .next()
                .unwrap_or("")
                .strip_prefix("PID_")
                .unwrap_or("");
            if !vid.is_empty() && !pid.is_empty() {
                return format!("{vid}:{pid}");
            }
        }
    }
    String::new()
}

// --------------------------------------------------------------------------
// usbprint open / 1284 ID / timed write
// --------------------------------------------------------------------------

/// Synchronous open (no OVERLAPPED) — the spike only needs access + speed.
fn open_printer(path: &str) -> Result<HANDLE, u32> {
    let path = windows::core::HSTRING::from(path);
    unsafe {
        CreateFileW(
            &path,
            GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            HANDLE::default(),
        )
        .map_err(|e| win32_code(&e))
    }
}

/// IEEE 1284 ID: DLE EOT (0x12), then read whatever comes back within a few
/// seconds. Printers that answer give `Manufacturer, Model, ...` — the
/// Phase 2 fallback-matching data and a sanity check on the open.
fn ieee1284_id(h: HANDLE) -> String {
    let mut out = String::new();
    unsafe {
        let mut written = 0u32;
        if WriteFile(
            h,
            Some(std::slice::from_ref(&0x12u8)),
            Some(&mut written),
            None,
        )
        .is_err()
        {
            return String::new();
        }
        for _ in 0..8 {
            // 0.58's WaitForSingleObject returns the WAIT_EVENT directly
            // (no Result): WAIT_OBJECT_0 means the device has data pending.
            if WaitForSingleObject(h, 500) != WAIT_OBJECT_0 {
                break;
            }
            let mut buf = [0u8; 512];
            let mut n = 0u32;
            if ReadFile(h, Some(buf.as_mut_slice()), Some(&mut n), None).is_err() || n == 0 {
                break;
            }
            out.push_str(&String::from_utf8_lossy(&buf[..n as usize]));
            if buf[..n as usize].contains(&0) {
                break;
            }
        }
    }
    out.trim().to_string()
}

/// Write `kb` KiB and return KiB/s.
async fn timed_write(h: HANDLE, kb: u64) -> anyhow::Result<f64> {
    let payload: Vec<u8> = (0..kb * 1024).map(|i| (i % 251) as u8).collect();
    let t = Instant::now();
    let mut done = 0usize;
    while done < payload.len() {
        let chunk = &payload[done..(done + 64 * 1024).min(payload.len())];
        let mut n = 0u32;
        unsafe { WriteFile(h, Some(chunk), Some(&mut n), None) }
            .map_err(|e| anyhow::anyhow!("WriteFile failed: win32 {}", win32_code(&e)))?;
        done += n as usize;
    }
    let dt = t.elapsed();
    Ok(kb as f64 / dt.as_secs_f64())
}

async fn cmd_usb(kb: u64) -> anyhow::Result<()> {
    let devs = usbprint_devices()?;
    if devs.is_empty() {
        println!(
            "no usbprint device interfaces found (is the printer installed as a Windows printer?)"
        );
        return Ok(());
    }
    for d in &devs {
        println!(
            "device: {}",
            if d.friendly.is_empty() {
                "?"
            } else {
                &d.friendly
            }
        );
        println!("  vid:pid: {}", vid_pid(&d.hardware_ids));
        println!("  driver: {}", d.driver);
        println!("  path:   {}", d.device_path);
        match open_printer(&d.device_path) {
            Ok(h) => {
                println!("  OPEN: ok");
                let id = ieee1284_id(h);
                if !id.is_empty() {
                    println!("  1284 ID: {id}");
                }
                match timed_write(h, kb).await {
                    Ok(kbs) => println!("  wrote {kb} KB in {kbs:.1} KB/s"),
                    Err(e) => println!("  write failed: {e}"),
                }
                unsafe {
                    let _ = CloseHandle(h);
                }
            }
            Err(code) => println!("  OPEN: FAILED win32={code} — {}", map_open_error(code)),
        }
    }
    Ok(())
}

fn cmd_usb_wait(secs: u64) -> anyhow::Result<()> {
    let devs = usbprint_devices()?;
    if devs.is_empty() {
        println!("no usbprint device interfaces found");
        return Ok(());
    }
    println!(
        "polling {} device(s) every 500 ms for {secs}s — start a spooler job mid-window and watch when opens start failing",
        devs.len()
    );
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        for d in &devs {
            match open_printer(&d.device_path) {
                Ok(h) => {
                    unsafe {
                        let _ = CloseHandle(h);
                    }
                    println!(
                        "[{:>6.1} s] {} OPEN",
                        t0.elapsed().as_secs_f64(),
                        d.friendly
                    );
                }
                Err(code) => {
                    println!(
                        "[{:>6.1} s] {} DENIED win32={code} ({})",
                        t0.elapsed().as_secs_f64(),
                        d.friendly,
                        map_open_error(code)
                    )
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Print queues (spooler)
// --------------------------------------------------------------------------

struct Queue {
    name: String,
    port: String,
    driver: String,
    status: u32,
}

fn print_queues() -> anyhow::Result<Vec<Queue>> {
    let mut n: u32 = 0;
    let mut need: u32 = 0;
    unsafe {
        EnumPrintersW(
            PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
            PCWSTR::null(),
            2,
            None,
            &mut n,
            &mut need,
        )
        .map_err(|e| anyhow::anyhow!("EnumPrintersW (size): {e}"))?;
        let mut buf = vec![0u8; need as usize];
        EnumPrintersW(
            PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
            PCWSTR::null(),
            2,
            Some(buf.as_mut_slice()),
            &mut n,
            &mut need,
        )
        .map_err(|e| anyhow::anyhow!("EnumPrintersW: {e}"))?;
        let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_2W, n as usize);
        Ok(infos
            .iter()
            .map(|q| Queue {
                name: read_wide(q.pPrinterName.0 as *const u16),
                port: read_wide(q.pPortName.0 as *const u16),
                driver: read_wide(q.pDriverName.0 as *const u16),
                status: q.Status,
            })
            .collect())
    }
}

fn cmd_queues() -> anyhow::Result<()> {
    let queues = print_queues()?;
    if queues.is_empty() {
        println!("no print queues");
        return Ok(());
    }
    for q in &queues {
        let paused = q.status & 0x0000_0080 != 0; // PRINTER_STATUS_PAUSED
        let offline = q.status & 0x0000_0010 != 0; // PRINTER_STATUS_WORK_OFFLINE
        println!(
            "{:?}  port={:?}  driver={:?}  status={:#010x}{}{}",
            q.name,
            q.port,
            q.driver,
            q.status,
            if paused { " PAUSED" } else { "" },
            if offline { " OFFLINE" } else { "" }
        );
    }
    Ok(())
}

fn set_queue_state(name: &str, pause: bool) -> anyhow::Result<()> {
    let name = windows::core::HSTRING::from(name);
    unsafe {
        let mut h: HANDLE = HANDLE::default();
        OpenPrinterW(&name, &mut h, None)
            .map_err(|e| anyhow::anyhow!("OpenPrinterW({name:?}): {e}"))?;
        let flags = if pause {
            PRINTER_PAUSED | PRINTER_WORK_OFFLINE
        } else {
            PRINTER_NO_PAUSE | PRINTER_WORK_ONLINE
        };
        let mut info = PrinterInfo7::default();
        info.flags = flags;
        SetPrinterW(h, 7, Some(&info as *const _ as *const u8), flags)
            .map_err(|e| anyhow::anyhow!("SetPrinterW({name:?}): {e}"))?;
        let _ = CloseHandle(h);
    }
    println!(
        "{} queue '{name}'",
        if pause {
            "paused + work offline"
        } else {
            "resumed"
        }
    );
    Ok(())
}

// --------------------------------------------------------------------------
// Queue <-> device mapping (Phase 0 item 2 + 3)
// --------------------------------------------------------------------------

fn cmd_mapping() -> anyhow::Result<()> {
    let all = all_devices()?;
    let is_print_enum = |d: &&Dev| {
        d.hardware_ids
            .iter()
            .any(|h| h.starts_with("SWD\\PRINTENUM"))
    };
    let is_usb = |d: &&Dev| d.hardware_ids.iter().any(|h| h.starts_with("USB\\"));
    let queues: Vec<&Dev> = all.iter().filter(is_print_enum).collect();
    let usb: Vec<&Dev> = all.iter().filter(is_usb).collect();

    println!("== print-queue devnodes (SWD\\PRINTENUM) ==");
    if queues.is_empty() {
        println!("  (none)");
    }
    for q in &queues {
        println!(
            "  {}  driver={:?}  container={}",
            if q.friendly.is_empty() {
                q.instance_id.as_str()
            } else {
                q.friendly.as_str()
            },
            q.driver,
            if q.container.is_empty() {
                "n/a"
            } else {
                q.container.as_str()
            }
        );
    }

    println!("== USB device nodes (hardware class) ==");
    if usb.is_empty() {
        println!("  (none)");
    }
    for u in &usb {
        println!(
            "  {}  vid:pid={}  driver={:?}  container={}",
            if u.friendly.is_empty() {
                u.instance_id.as_str()
            } else {
                u.friendly.as_str()
            },
            vid_pid(&u.hardware_ids),
            u.driver,
            if u.container.is_empty() {
                "n/a"
            } else {
                u.container.as_str()
            }
        );
    }

    println!("== spooler queues (EnumPrintersW) ==");
    let pq = print_queues()?;
    for q in &pq {
        let container = all
            .iter()
            .find(|d| !d.friendly.is_empty() && d.friendly == q.name)
            .map(|d| d.container.clone())
            .unwrap_or_default();
        println!(
            "  {:?}  port={:?}{}",
            q.name,
            q.port,
            if container.is_empty() {
                String::new()
            } else {
                format!("  container={container}")
            }
        );
    }

    println!("== ContainerId intersections (queue devnode vs USB devnode) ==");
    let mut matches = 0;
    for q in &queues {
        for u in &usb {
            if !q.container.is_empty() && q.container == u.container {
                matches += 1;
                println!("  MATCH: queue '{}' <-> USB '{}'", q.friendly, u.friendly);
            }
        }
    }
    if matches == 0 {
        println!("  (no shared ContainerId — the doc's candidate is DROPPED; use 1284 ID + user confirmation)");
    }

    // Vendor-class question (item 3): any USB device whose hardware ids lack
    // the `USB\Class_*` part is vendor-specific (Microsoft OS 2.0
    // descriptor) — and the driver column shows what Windows bound
    // (WinUSB? usbprint?).
    println!("== vendor-class candidates (no USB\\Class_* hardware id) ==");
    let mut vc = 0;
    for u in &usb {
        let has_class = u.hardware_ids.iter().any(|h| h.starts_with("USB\\Class_"));
        if !has_class {
            vc += 1;
            println!(
                "  {}  driver={:?}  hwids={:?}",
                u.friendly, u.driver, u.hardware_ids
            );
        }
    }
    if vc == 0 {
        println!("  (none — all USB devices here use a standard class)");
    }
    Ok(())
}

// --------------------------------------------------------------------------
// Classic Bluetooth RFCOMM (SPP) — Phase 0 item 5
// --------------------------------------------------------------------------

fn cmd_bt(rest: &[String]) -> anyhow::Result<()> {
    let mac_s = rest
        .iter()
        .find(|a| !a.starts_with('-'))
        .ok_or(anyhow::anyhow!("usage: bt <mac> [--kb N]"))?;
    let mac = parse_mac(mac_s)?;
    let kb = kb_flag(rest);
    bt_write(&mac, kb)
}

fn bt_write(mac: &[u8; 6], kb: u64) -> anyhow::Result<()> {
    unsafe {
        let mut wsadata: WSADATA = std::mem::zeroed();
        if WSAStartup(0x0202, &mut wsadata) == windows::Win32::Networking::WinSock::SOCKET_ERROR {
            anyhow::bail!("WSAStartup failed: win32 {}", WSAGetLastError().0);
        }

        let s = socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM)
            .map_err(|e| anyhow::anyhow!("socket(AF_BTH): win32 {}", win32_code(&e)))?;

        let mut addr = SockaddrBth {
            addr_family: AF_BTH,
            btype: BTH_RADIO_TYPE,
            _pad1: [0; 1],
            service_guid: SPP_UUID,
            _pad2: [0; 4],
            uuid: 0,
            address_type: BT_DEVICE_EUI48_ADDRESS_TYPE,
            address: [0; 20],
        };
        addr.address[..6].copy_from_slice(mac);

        if connect(
            s,
            std::ptr::addr_of!(addr) as *const _ as *const SOCKADDR,
            size_of::<SockaddrBth>() as i32,
        ) == windows::Win32::Networking::WinSock::SOCKET_ERROR
        {
            closesocket(s);
            anyhow::bail!(
                "connect to {} failed: win32 {} (paired, powered on, SPP device?)",
                mac_str(mac),
                WSAGetLastError().0
            );
        }
        println!("RFCOMM SPP connected to {}", mac_str(mac));

        let payload: Vec<u8> = (0..kb * 1024).map(|i| (i % 251) as u8).collect();
        let t = Instant::now();
        let mut done = 0usize;
        while done < payload.len() {
            let chunk = &payload[done..(done + 4096).min(payload.len())];
            let n = send(
                s,
                chunk,
                windows::Win32::Networking::WinSock::SEND_RECV_FLAGS(0),
            );
            if n == windows::Win32::Networking::WinSock::SOCKET_ERROR {
                closesocket(s);
                anyhow::bail!("send failed: win32 {}", WSAGetLastError().0);
            }
            done += n as usize;
        }
        let dt = t.elapsed();
        println!(
            "sent {kb} KB in {:.1} s => {:.1} KB/s",
            dt.as_secs_f64(),
            kb as f64 / dt.as_secs_f64()
        );
        let _ = shutdown(s, WINSOCK_SHUTDOWN_HOW(1));
        let _ = closesocket(s);
    }
    Ok(())
}

// --------------------------------------------------------------------------
// BLE (btleplug) — Phase 0 item 4 + 5
// --------------------------------------------------------------------------

// btleplug 0.11 API (checked against the 0.11.x source in the registry):
// Manager::new() -> adapters() -> adapter.start_scan(ScanFilter) ->
// peripherals() -> peripheral.connect() -> discover_services() ->
// services()/characteristics() -> peripheral.write(&char, data, WriteType).
// There is NO MTU request API in 0.11, so the spike probes the largest
// single write payload empirically (a few hundred bytes of noise, noted in
// the findings).
use btleplug::api::{
    BDAddr, Central as _, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter,
    WriteType,
};
use btleplug::platform::{Adapter, Manager, PeripheralId};

async fn ble_adapter() -> anyhow::Result<Adapter> {
    let mgr = Manager::new()
        .await
        .map_err(|e| anyhow::anyhow!("ble manager: {e}"))?;
    let adapters = mgr
        .adapters()
        .await
        .map_err(|e| anyhow::anyhow!("adapters: {e}"))?;
    anyhow::ensure!(!adapters.is_empty(), "no Bluetooth adapter found");
    Ok(adapters.into_iter().next().expect("checked non-empty"))
}

async fn cmd_ble_scan(secs: u64) -> anyhow::Result<()> {
    let adapter = ble_adapter().await?;
    println!("scanning {secs}s for BLE advertisers...");
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| anyhow::anyhow!("start_scan: {e}"))?;
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let _ = adapter.stop_scan().await;
    let peris = adapter
        .peripherals()
        .await
        .map_err(|e| anyhow::anyhow!("peripherals: {e}"))?;
    println!("found {} peripheral(s)", peris.len());
    for p in &peris {
        let name = p
            .properties()
            .await
            .ok()
            .flatten()
            .and_then(|pr| pr.local_name);
        println!("  {}  name={:?}", p.address(), name);
    }
    Ok(())
}

async fn cmd_ble(rest: &[String]) -> anyhow::Result<()> {
    let mac_s = rest
        .iter()
        .find(|a| !a.starts_with('-'))
        .ok_or(anyhow::anyhow!("usage: ble <mac> [--kb N]"))?;
    let addr =
        BDAddr::from_str_delim(mac_s).map_err(|e| anyhow::anyhow!("bad MAC '{mac_s}': {e}"))?;
    let kb = kb_flag(rest);

    let adapter = ble_adapter().await?;
    let id = PeripheralId::from(addr);
    let p = match adapter.peripheral(&id).await {
        Ok(p) => p,
        Err(_) => adapter
            .add_peripheral(&id)
            .await
            .map_err(|e| anyhow::anyhow!("add_peripheral: {e}"))?,
    };
    p.connect()
        .await
        .map_err(|e| anyhow::anyhow!("connect: {e}"))?;
    let name = p
        .properties()
        .await
        .map_err(|e| anyhow::anyhow!("properties: {e}"))?
        .and_then(|pr| pr.local_name);
    println!("connected name={name:?}");

    p.discover_services()
        .await
        .map_err(|e| anyhow::anyhow!("discover_services: {e}"))?;

    // Best writable characteristic: prefer WriteWithoutResponse, fall back to Write.
    let mut wor: Option<Characteristic> = None;
    let mut wr: Option<Characteristic> = None;
    for s in p.services() {
        println!("service {} (primary={})", s.uuid, s.primary);
        for c in &s.characteristics {
            println!("  char {} props={:?}", c.uuid, c.properties);
            if c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) && wor.is_none() {
                wor = Some(c.clone());
            } else if c.properties.contains(CharPropFlags::WRITE) && wr.is_none() {
                wr = Some(c.clone());
            }
        }
    }
    match wor.or(wr) {
        Some(c) => {
            let wt = if c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) {
                WriteType::WithoutResponse
            } else {
                WriteType::WithResponse
            };
            println!(
                "write target: {} ({})",
                c.uuid,
                if matches!(wt, WriteType::WithoutResponse) {
                    "without response"
                } else {
                    "with response"
                }
            );
            // Probe the largest single write payload (no MTU API in 0.11).
            let mut chunk = 20usize;
            for size in [509usize, 244, 180, 120, 60, 24] {
                let probe = vec![0u8; size];
                match p.write(&c, &probe, wt).await {
                    Ok(()) => {
                        chunk = size;
                        break;
                    }
                    Err(e) => println!("  probe {size} B failed: {e}"),
                }
            }
            println!("max single write payload: {chunk} B (effective MTU ≈ {})", chunk + 3);

            let payload: Vec<u8> = (0..kb * 1024).map(|i| (i % 251) as u8).collect();
            let t = Instant::now();
            let mut done = 0usize;
            while done < payload.len() {
                let piece = &payload[done..(done + chunk).min(payload.len())];
                p.write(&c, piece, wt)
                    .await
                    .map_err(|e| anyhow::anyhow!("write: {e}"))?;
                done += piece.len();
                // BLE is paced by the peripheral.
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let dt = t.elapsed();
            println!(
                "wrote {kb} KB in {:.1} s => {:.1} KB/s (chunk {chunk} B)",
                dt.as_secs_f64(),
                kb as f64 / dt.as_secs_f64()
            );
        }
        None => println!(
            "no writable characteristic found — record the table above and drop the auto-select guess from the doc"
        ),
    }
    Ok(())
}
