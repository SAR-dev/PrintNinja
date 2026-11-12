# TODO — Driverless Bluetooth printing on PC

Branch: `feat/desktop-bt-driverless`

Goal: a PC can print to a Bluetooth printer **without installing a printer
driver**. Windows opens the paired device's COM port directly (falling back
to the spooler queue when the address names no port); Linux dials an RFCOMM
socket straight to the paired device. Android already works this way and is
unchanged. USB stays as-is (spooler / CUPS raw queue).

## Parts

- [x] 1. Shared address parsing — `src-tauri/src/transport/bluetooth_addr.rs`
      Parse `AA:BB:CC:DD:EE:FF` (any case, `:` or `-`), optional RFCOMM
      channel suffix `:1`–`:30` (default 1), and Windows `COM7` /
      `\\.\COM7`. Normalised MAC text, 12-hex compact form (registry
      match) and little-endian `bdaddr` bytes for `sockaddr_rc`. Clear
      error for anything else. Unit tests.
- [x] 2. Linux RFCOMM transport — `src-tauri/src/transport/linux_bluetooth.rs`
      `#[cfg(target_os = "linux")]` module: `socket(AF_BLUETOOTH,
      SOCK_STREAM, BTPROTO_RFCOMM)` + non-blocking connect with poll
      deadlines (connect 10 s, send 30 s via `PRINTNINJA_SEND_TIMEOUT_SECS`,
      status reply 3 s). One held socket per send: status precheck
      (`status::dialect_for`, same contract as raw_tcp/Android) then the
      job bytes. `test`/probe = connect + close, no bytes. No discovery
      (pairing stays an OS flow). Unit tests: sockaddr layout + byte order,
      address errors, bounded failure against a dead address.
- [x] 3. Windows direct COM transport — `src-tauri/src/transport/windows_bluetooth.rs`
      Address resolves to a port when it is `COM7` directly, or a MAC whose
      paired device already owns one (best-effort registry scan of
      `Enum\BTHENUM` / `Enum\Bluetooth` for `Device Parameters\PortName`).
      Direct path: `CreateFileW("\\.\COM7")` + `WriteFile` with
      `COMMTIMEOUTS` and an outer deadline — no spooler, no driver. When
      the address names no port: current spooler-by-name behaviour, so
      existing rows keep working; on failure the error explains how to get
      a COM port. `test` mirrors send (open+close vs queue status).
- [x] 4. Wiring — `src-tauri/src/transport/mod.rs`
      Declare `bluetooth_addr` (all platforms) and `linux_bluetooth`
      (Linux only). `create_transport`: Linux gets a Bluetooth transport;
      Windows passes the address through. `probe()`: Linux dials RFCOMM,
      Windows resolves direct-else-spooler, others keep today's message.
      Update `usb_and_bluetooth_on_linux_are_cups_raw_queues` (USB keeps
      the CUPS advice; Bluetooth is now direct).
- [x] 5. Capability probe — `src-tauri/src/transport/capabilities.rs`
      Linux `probe_bluetooth`: model-name table first, then a dialect
      wire probe over RFCOMM (ZPL → TSPL → ESC/POS, fresh connection each,
      same `answered()` rules as raw_tcp). Module doc updated. Windows and
      Android unchanged.
- [x] 6. Frontend hint — `src/pages/PrinterSetup.tsx`, `en.ts`, `ja.ts`
      Desktop Bluetooth hint: pair in the OS Bluetooth settings first,
      enter the MAC (no driver needed); Windows may enter the COM port.
      Android keeps its bonded-list hint.
- [x] 7. Docs — README, `docs/architecture/PRINTERS_AND_TRANSPORTS.md`,
      `docs/MISSING_FEATURES.md`, `docs/DEVELOPMENT.md`
      Capability matrix (Bluetooth: direct on Windows/Linux/Android),
      transports and per-OS paragraphs, "deliberate limits" now USB-only,
      README add/troubleshooting/feature lines, tech-stack row.
- [ ] 8. Verification
      `pnpm lint`, `pnpm test`, `pnpm build` for the web side; Rust via
      `pnpm test:rust` (Docker, no local cargo); Windows `cfg(windows)`
      code type-checked with `cargo check --target x86_64-pc-windows-gnu`.

## Out of scope

- BLE (classic SPP only, same as Android — MISSING_FEATURES item 1).
- Direct USB on desktop (deliberately ruled out; unchanged).
- Scanning/discovery of paired devices on desktop (pairing stays an OS
  flow; `discover` stays empty, as on Android's non-bonded path).
- `/dev/rfcomm*` device-path addresses (the RFCOMM socket dials the MAC
  itself; no `rfcomm bind` needed).
