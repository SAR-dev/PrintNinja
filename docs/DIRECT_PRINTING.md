# Direct printing on Windows (no spooler) — implementation plan

> **Status:** approved scope, not yet implemented.
> **Audience:** whoever implements the Windows USB, Bluetooth and BLE transports.
> **Platform:** Windows. Android already prints directly; Linux is unchanged
> (see `docs/PLAN.md` §8, F14–F15).

## Phase 0 — running the spike tool

The Phase 0 spike is a standalone example:
`src-tauri/examples/direct_print_spike.rs` (internals in
`src-tauri/examples/spike.rs`). It probes real hardware and prints its findings
to the console; it touches no app state and merges nothing.

Run from the repo root (`PrintNinja/`), with the printer attached and powered
on. Every write subcommand feeds the printer real bytes — **it will print
noise, so keep paper out.**

```bash
# USB printer-class printer (installed as a Windows printer)
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- usb
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- usb --kb 100   # 100 KB throughput

# Queue ↔ device mapping + queue list (printer attached)
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- mapping
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- queues

# USB access while the spooler owns the device (item 1):
# 1. start `usb-wait 60`, 2. within the window send a normal PrintNinja print, 3. let it finish
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- usb-wait 60
# Optionally, from a second shell, pause/resume the queue to see if it releases the port:
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- pause  "Queue Name"
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- resume "Queue Name"

# Classic Bluetooth printer (paired + powered on; MAC from Settings → Bluetooth)
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- bt AA:BB:CC:DD:EE:FF
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- bt AA:BB:CC:DD:EE:FF --kb 1   # quick open test first

# BLE printer (scan first to confirm the advertised address)
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- ble-scan 15
cargo run --manifest-path src-tauri/Cargo.toml --example direct_print_spike -- ble AA:BB:CC:DD:EE:FF
```

Notes:

- A refused open/connect with a win32 code is a **finding**, not a failure —
  paste the full terminal output of every subcommand, successes and failures.
- `usb-wait` is the interactive one: the spooler job must be sent **during**
  the 60 s window so we learn whether the `usbprint` handle opens while the
  spooler owns the device.
- The output becomes the Phase 0 "findings" note below (§8, Phase 0).

## 1. Goal

Send ESC/POS, ZPL, TSPL and CPCL bytes from PrintNinja to a printer on
Windows **without the Windows print spooler**: no installed Windows printer,
no queue, no driver in the path.

Non-goals:

- PDF printing to office printers. That stays on IPP, raw TCP or `system`
  (spooler) printers.
- Android and Linux changes.
- Replacing `system` printers. They keep using the spooler by design.

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | What happens to existing Windows USB/Bluetooth printers on upgrade? | **Hard cut.** They stop using the spooler and must be re-linked to a device. The printer row itself (id, name, profile, history) is kept; only its address changes (§6). |
| D2 | Which printers must work at launch? | **All four:** USB printer-class, classic Bluetooth (SPP), vendor-class USB (WinUSB), and BLE. |
| D3 | What if the printer is also installed as a Windows printer? | **Detect it and offer to disable the Windows queue** (§8, Phase 3). |
| D4 | Windows CI available? | Yes. `.github/workflows/ci.yml` has `rust-test-windows` on `windows-latest`, which runs `cargo test`. Windows-only code is compiled and unit-tested there. |

## 3. Current state

| Piece | Today |
|---|---|
| `transport/mod.rs` | `PrinterTransport` trait (`discover`, `test`, `send`). `create_transport` builds one per printer row. |
| `transport/windows_usb.rs`, `windows_bluetooth.rs` | Wrap `WindowsSpooler`. Ignore the stored address. `discover` returns nothing. |
| `create_transport` (Windows) | Passes only `name` to the USB and Bluetooth constructors. |
| `transport/raw_tcp.rs` | Already direct (TCP 9100). No change. |
| `transport/android_usb.rs`, `android_bluetooth.rs` | Already direct on Android. Behavioural reference: preflight status query, deadlines, clear errors, `reach()` that opens and closes without writing. |
| `transport/status.rs` | Transport-agnostic status queries (`dialect_for`, `decode`, `should_probe`, `note_silent`). Reused as is. |
| `commands/print.rs` | Preflight and the "language is PDF on a raw USB/Bluetooth transport" warning already cover `Usb` and `Bluetooth`. `list_bluetooth_devices` (the UI's BT scan) is Android-only. |
| `db/schema.sql` | `printers.type` has `CHECK(type IN ('ipp','raw_tcp','usb','bluetooth','system'))` (also in the P2 backfill in `db/mod.rs`). Adding a type means a table-rebuild migration. |
| `.github/workflows/ci.yml` | `rust-test-windows` job exists (D4). |
| `docs/SIGNING.md` | Builds are internally self-signed. This rules out shipping a driver installer for WinUSB (Phase 5). |

## 4. Architecture

Each transport implements `PrinterTransport` unchanged, so `send_to`,
`test_printer`, `probe`, copies, history, the REST API and deep links need no
changes beyond address plumbing.

```
RenderedJob (bytes + language)
   │
   ▼
create_transport(type, name, address)
   │
   ├─ usb ───► WindowsUsb ─┬─ usbprint interface ─► CreateFileW + WriteFile     (Phase 1)
   │                        └─ WinUSB (vendor class) ─► bulk-OUT via nusb        (Phase 5)
   ├─ bluetooth ► WindowsBt  ─► Winsock AF_BTH RFCOMM (SPP)                      (Phase 4)
   └─ ble ─────► WindowsBle  ─► GATT write characteristic                        (Phase 6)
```

One USB type, two backends: the `usb` transport resolves `usb:VID:PID[:serial]`
by enumeration and picks the backend that can open the device. BLE is a
separate type (`ble`) because its address, discovery and throughput limits
differ from classic Bluetooth.

Shared building blocks, written in Phase 1 and reused by every phase:

- **Deadline helper.** Every open, read and write is bounded; a wedged device
  fails the job with a named reason, never hangs the queue worker.
- **RAII handle wrappers** that cancel pending I/O and close on drop.
- **Error mapper.** Win32/Winsock/WinRT error → operator-facing message.
- **`send_on(handle, job)`** shape copied from `android_bluetooth.rs`: status
  query via `status::dialect_for`, then write. Chunk size is a parameter.

## 5. Address formats

| Type | Address | Notes |
|---|---|---|
| `usb` | `usb:04b8:0e15` or `usb:04b8:0e15:SERIAL` | Resolved by enumeration on every send; never store a device path (its instance ID changes with the port). Two matches without a serial → fail and name both; never print to "whichever came first". |
| `bluetooth` | `AA:BB:CC:DD:EE:FF` | Paired classic device. Same shape the Android transport stores. |
| `ble` | `ble:AA:BB:CC:DD:EE:FF` or `ble:<MAC>/<service-uuid>/<write-char-uuid>[/<notify-char-uuid>]` | The short form auto-selects a writable characteristic (§8, Phase 6); the long form pins one. |

## 6. Hard cut and re-link (D1)

On Windows, a `usb` or `bluetooth` row whose address does not parse as one of
the forms above is **legacy** (it holds a spooler queue name).

- **No schema migration.** "Legacy" is derived when rows are read; the row is
  flagged `needs_relink` in the list response.
- **Printing fails fast** for a legacy row, from every entry point (UI, REST
  API, deep links), with one message: the printer was set up through the
  Windows spooler, which PrintNinja no longer uses for USB/Bluetooth, and
  where to go to fix it.
- **Re-link, not delete.** Printers → the row shows a "Re-link" action that
  opens the device picker. Choosing a device rewrites only `address` (and
  `printer_type` if the user switches USB ↔ BLE). The row id, name, language,
  profile and job history are kept. Pre-select the discovered device whose
  name best matches the old queue name.
- `system` rows and Android/Linux rows are not affected.
- Release notes must lead with this change.

## 7. Windows crate and dependencies

`src-tauri/Cargo.toml` enables only `Win32_System_Threading`, `Win32_Security`
and `Win32_System_Com` today. Add as each phase needs them:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
  "Win32_System_Threading", "Win32_Security", "Win32_System_Com",
  "Win32_Foundation",
  "Win32_Storage_FileSystem",                    # Phase 1: CreateFileW, WriteFile, ReadFile
  "Win32_System_IO",                             # Phase 1: OVERLAPPED, CancelIoEx
  "Win32_Devices_DeviceAndDriverInstallation",   # Phase 1: SetupDi*, Phase 3: ContainerId
  "Win32_Graphics_Printing",                     # Phase 3: EnumPrinters, SetPrinter
  "Win32_Networking_WinSock",                    # Phase 4: sockets
  "Win32_Devices_Bluetooth",                     # Phase 4: SOCKADDR_BTH, device lookup
] }
nusb = "0.1"        # Phase 5: WinUSB bulk transfers (pure Rust)
btleplug = "0.11"   # Phase 6: BLE GATT on Windows (WinRT)
```

Module paths and feature names vary between `windows` versions and the crate
versions above are starting points: confirm every symbol compiles on the
`rust-test-windows` job (or bump the crate) as each phase lands.

## 8. Phases

Total estimate: **about 12–18 working days**, including hardware testing.
Phases 1–4 deliver the common case (USB printer-class and classic Bluetooth)
and can ship before 5 and 6 if needed. Each phase ends with `cargo test`
green on `rust-test-windows`, `pnpm check`, and the listed hardware checks.

### Phase 0 — Spike on real hardware (0.5–1 day)

Verify what the rest of the plan assumes. Nothing is merged; the output is a
short "findings" note appended to this doc.

The tool is `src-tauri/examples/direct_print_spike.rs` — run instructions are
at the top of this doc.

1. **USB access while a queue exists.** With a printer installed as a Windows
   printer, can `CreateFileW` on the `usbprint` interface succeed when idle?
   During a spooler job? Does pausing the queue release it?
2. **Queue ↔ device mapping.** Candidate: the print queue's device node
   (under `SWD\PRINTENUM`) and the USB device share a `ContainerId`.
   Fallback: match by IEEE 1284 ID (manufacturer/model) and ask the user to
   confirm.
3. **A vendor-class printer.** Which USB class does it report, does Windows
   bind WinUSB automatically (Microsoft OS descriptor), and what do users see
   in Device Manager?
4. **A BLE printer.** Record its advertised services and which characteristic
   accepts writes, MTU, and whether it sends notifications.
5. **Throughput.** Time a 100 KB write over classic Bluetooth and BLE to set
   chunk sizes and timeout formulas.

**Exit:** each assumption above is marked confirmed, changed or dropped here.

### Phase 1 — USB printer-class write path (1–1.5 days)

**Scope:** `usb` rows work for devices bound to `usbprint.sys`, write only.

- Enumerate with SetupDi using `GUID_DEVINTERFACE_USBPRINT`
  (`{28D78FAD-5A12-11D1-AE5B-0000F803A8C2}`) and
  `DIGCF_PRESENT | DIGCF_DEVICEINTERFACE`; read device paths and friendly
  names.
- Parse VID, PID and serial from the path; resolve `usb:VID:PID[:serial]`
  (§5), including the ambiguous-match failure.
- `CreateFileW` with `FILE_FLAG_OVERLAPPED`; write in a loop until all bytes
  are accepted; deadline via the event wait; `CancelIoEx` on expiry.
- Build the shared helpers from §4 (deadline, RAII handle, error mapper).
- `create_transport`: pass `address` to the Windows USB constructor. Remove the
  spooler delegation from `windows_usb.rs`.

Error mapping (sketch):

| Win32 error | Message |
|---|---|
| No matching interface | No USB printer with ID `04b8:0e15` found. Is it plugged in and powered on? |
| `ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION` | The USB printer is in use by another program or by a Windows printer queue. (Phase 3 adds the offer to disable the queue.) |
| `ERROR_GEN_FAILURE`, `ERROR_DEVICE_NOT_CONNECTED` | The USB printer stopped responding. Check the cable and power. |
| Deadline | The USB printer did not accept data within N seconds. |

**Tests (CI):** address parsing; device-path → VID/PID/serial from sample
strings; ambiguous match; write loop and short-write handling behind a small
`Write`-style trait with a fake; error table.
**Hardware:** print an ESC/POS receipt and a ZPL/TSPL label over USB.
**Exit:** a printer with no Windows queue prints a raster job end to end.

### Phase 2 — USB discovery, probe, status, UI, re-link (1–1.5 days)

- `discover`: list present `usbprint` devices as `PrinterInfo`
  (`printer_type: Usb`, address `usb:VID:PID[:serial]`), and include them in
  `TransportRegistry::discover_all` on Windows next to the system queues.
- `reach()` and a `TransportRegistry::probe` arm: open and close, no bytes.
- Status over the same handle: `status::dialect_for` → write query → bounded
  read (3 s, like Android) → `status::decode`. Silent printers go through the
  existing `note_silent` / `silence_message` path.
- **Hard cut (§6):** derive `needs_relink`; fail-fast message; Re-link action.
- Frontend: `printerSchema.ts` `addressError` validates `usb:xxxx:xxxx[:serial]`
  on Windows (keep the loose check for Android `/dev/bus/usb/...`);
  `PrinterSetup.tsx` shows a device picker instead of a free-text address;
  new EN/JA strings.
- **Discovery IPC:** the picker needs its own command (e.g. `list_usb_devices`
  in `commands/print.rs`, backed by the `windows_usb.rs` enumeration) —
  there is no USB discovery command today. Per the agent contract
  (REFACTORING.md P18/Q11) it gets a typed entry in
  `src/lib/agent/commands.ts` and a type in `src/lib/agent/types.ts`.

**Tests:** discovery mapping; legacy-row detection (table of old/new
addresses); schema validation cases; probe never writes.
**Hardware:** out-of-paper and cover-open reported before printing; Re-link
keeps history.
**Exit:** a user can add, test, print and re-link a USB printer entirely from
the UI.

### Phase 3 — Windows queue conflict: detect and offer to disable (1–2 days)

Applies when Phase 1 opens fail with access denied / sharing violation, and
proactively in the device picker.

- Enumerate queues with `EnumPrintersW` (level 2) and keep those on the USB
  port monitor.
- Match a queue to the device using the approach confirmed in Phase 0
  (`ContainerId`, else 1284 ID plus user confirmation).
- UI: "This printer is also installed in Windows as *<queue name>*, which can
  block direct printing." Actions:
  - **Disable the Windows printer** (default): pause the queue and set it work
    offline with `SetPrinterW`. Reversible; a **Re-enable** action undoes it.
  - **Not now.**
- Never delete a queue automatically. Removing it is a manual step described
  in the message, because it is destructive and loses the driver settings.
- If `SetPrinterW` returns access denied, say that Windows needs
  administrator rights and describe the manual route (Settings → Printers).
- If Phase 0 shows that pausing does not release the port, change the action to
  a guided "Remove Windows printer" with an explicit confirmation.

**Tests:** queue↔device matching on fixture data; action state machine
(disable → re-enable); access-denied path.
**Hardware:** the conflict is reproduced, detected, disabled, and printing
then succeeds; re-enable restores the queue.
**Exit:** no printing failure from a leftover Windows queue ends without an
actionable next step.

### Phase 4 — Classic Bluetooth RFCOMM (1–2 days)

- Winsock: `WSAStartup` once (`OnceLock`), `socket(AF_BTH, SOCK_STREAM,
  BTHPROTO_RFCOMM)`, `SOCKADDR_BTH` with the MAC and
  `SerialPortServiceClass_UUID` (`00001101-0000-1000-8000-00805F9B34FB`),
  port 0, so Windows resolves the channel through SDP. Then `connect`, `send`
  in chunks (start at 4 KiB, tune from Phase 0), `shutdown`, `closesocket`.
- Run socket work in `spawn_blocking` under a deadline; abort by closing the
  socket from the owning side.
- Discovery lists **paired** devices only (`BluetoothFindFirstDeviceW` /
  `BluetoothFindNextDeviceW`, authenticated and remembered, no inquiry). Show
  every paired device; many printers report a generic class. The user pairs in
  Windows Settings, which does not create a Windows printer.
  The UI's Bluetooth scan button calls the `list_bluetooth_devices` command
  (`commands/print.rs`), which is **Android-only today** — this phase adds a
  Windows arm (the paired-device enumeration above) to the same command, so
  the existing `PrinterSetup.tsx` scan path works unchanged.
- `reach()` and `probe` arms; status query over the socket (RFCOMM replies
  are usually reliable).
- Remove the spooler delegation from `windows_bluetooth.rs`.

| Error | Message |
|---|---|
| `WSAETIMEDOUT`, `WSAEHOSTDOWN` | The Bluetooth printer did not answer. Is it on and in range? |
| `WSAECONNREFUSED` | The device refused the connection. It may not offer a serial (SPP) service, or another program is connected to it. |
| `WSAEADDRNOTAVAIL` | That address is not paired with this PC. Pair it in Windows Settings first. |

If a paired printer was previously added as a Windows printer, the same Phase 3
conflict check applies (the spooler may hold its COM port or connection).

**Tests:** MAC parsing; chunk loop; error table.
**Hardware:** print over a paired SPP printer; printer off and out of range
fail within the deadline.
**Exit:** Bluetooth rows print and report faults like the Android transport.

### Phase 5 — Vendor-class USB via WinUSB (2–3 days)

For printers that do not use USB class `0x07`, so `usbprint` never binds.

- Use `nusb` to enumerate devices and claim the interface, then bulk-OUT (and
  bulk-IN for status). Endpoint selection copies `android_usb.rs`.
- `usb` resolution order: `usbprint` interface first, then a WinUSB-bound
  device with the same VID/PID/serial.
- **Driver binding is the risk.** WinUSB works only when `winusb.sys` is bound
  to the device. Options, in order:
  1. The device already advertises WinUSB through Microsoft OS descriptors, so
     Windows binds it with no user action (confirm per model in Phase 0).
  2. Documented manual step: bind WinUSB with Zadig. Include the warning that
     this replaces the vendor driver and how to revert it (Device Manager →
     Update driver / Roll back).
  3. An in-app driver installer. **Not planned:** it needs a properly signed
     driver package, and releases are only internally signed (`docs/SIGNING.md`).
- When a vendor-class device is present but cannot be opened, name what is
  bound (vendor driver / none) and give remedies 1–2.
- Discovery noise: vendor-class devices include non-printers. Show printer-class
  devices and a seeded list of known printer vendor IDs (Epson, Star, Zebra,
  Bixolon, TSC, Citizen and similar) by default, with a "Show all USB devices"
  toggle.

**Tests:** endpoint selection from fixture descriptors; resolution order;
discovery filter.
**Hardware:** one vendor-class printer prints over WinUSB; unbound device
shows the remedy message.
**Exit:** a vendor-class printer prints after the documented one-time setup.

### Phase 6 — BLE printers (3–4 days)

- New `PrinterType::Ble` (`"ble"`): add to `parse`/`Display` in
  `transport/mod.rs`; Android and Linux return `None` ("not supported on this
  platform"); add to `PRINTER_TYPES`, the type picker, filter tabs and
  strings in the frontend.
- **Schema migration required:** `printers.type` carries
  `CHECK(type IN ('ipp','raw_tcp','usb','bluetooth','system'))` in
  `src-tauri/src/db/schema.sql` and in the P2 backfill in `db/mod.rs`.
  SQLite cannot alter a CHECK in place, so this phase ships a table rebuild
  (create-new → copy → drop → rename) following the P2 backfill pattern, and
  updates both `schema.sql` and the backfill to include `'ble'`.
- `btleplug` (WinRT backend): bounded scan (about 5 s, one-shot), connect,
  discover services, select a characteristic.
- **Characteristic selection.** BLE printers have no standard print service.
  Auto-select a writable characteristic from a table of common
  transparent-UART services (for example Nordic UART and the ISSC family, plus
  the `FFE0`/`FF00`/`FFF0` vendor families); fall back to a picker listing
  writable characteristics, and store the choice in the long address form (§5).
  Grow the table from the printers tested in Phase 0.
- **Writing.** Write-without-response in chunks of `MTU − 3` (use a
  conservative default when the MTU is unknown), with a small inter-chunk delay
  or notify-based flow control where the device provides it.
- **Timeouts scale with payload.** BLE is slow: a 4×6 label at 203 dpi is
  roughly 100+ KB, so the deadline is a function of job size and measured
  throughput, not a fixed 30 s. Show progress in History.
- **Status.** Only when a notify characteristic exists and the printer
  answers; otherwise skip the preflight through `status::note_silent` rather
  than failing.
- Addresses can change for devices using random BLE addresses; if connect
  fails, say so and suggest re-linking.
- `discover`, `reach` and `probe` follow the same contract as the other
  transports (never write bytes to look).

**Tests:** characteristic selection from fixture service lists; chunking by
MTU; timeout formula; address parsing.
**Hardware:** at least two different BLE printer models; a full-width raster
completes; out-of-range fails cleanly.
**Exit:** a BLE printer is added from discovery and prints a label.

### Phase 7 — Docs and release hardening (0.5–1 day)

- Update `docs/architecture/PRINTERS_AND_TRANSPORTS.md` and
  `docs/ARCHITECTURE.md`: Windows USB/Bluetooth no longer go through the
  spooler; add BLE and WinUSB.
- `README.md` → Printers: USB, Bluetooth and BLE on Windows; troubleshooting
  entries for the queue conflict, vendor-class devices and BLE range.
- Release notes lead with the hard cut (§6).
- Metrics for observability, following the pattern in `docs/PLAN.md`:
  `direct_prints_total{transport="usb|usb_winusb|bluetooth|ble",result}` and
  `windows_queue_conflicts_total{action}`. Logs follow the existing redaction
  rules (no full device paths with serials at `info`).
- Final pass: `pnpm check:full`, Windows CI green, hardware matrix recorded
  in this doc.

## 9. Testing summary

| Level | What |
|---|---|
| Unit (CI, Linux and Windows) | Address and device-path parsing, resolution order, chunking and short writes, MTU and timeout maths, error tables, legacy-row detection, characteristic selection, queue↔device matching on fixtures |
| Windows CI (`rust-test-windows`) | The `#[cfg(windows)]` code compiles and its unit tests run |
| Hardware (manual, per phase) | USB printer-class printer; paired SPP printer; vendor-class printer; two BLE printers; a printer with a leftover Windows queue; printer off, unplugged and out of range |

Windows-only code cannot be compiled on Linux without a Windows target, so
treat the `windows-latest` job as the compile check.

## 10. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Spooler holds the device or port | Open fails | Phase 3 detect and disable; Phase 0 confirms how the port is actually held |
| Vendor-class printer has no WinUSB driver | No transport | Remedy messages; Zadig documented; no in-app installer (unsigned releases) |
| BLE printers have no standard service | Wrong characteristic | Table plus picker; stored in the long address |
| BLE throughput | Slow jobs, timeouts | Size-scaled deadline, progress, measured chunk sizes |
| Overlapped I/O and handle leaks | Hangs | RAII wrappers; deadline helper used everywhere |
| Hard cut | Users' existing printers stop printing | Fail-fast message, row-preserving Re-link, release-note headline |
| Identical printers without serials | Wrong device prints | Refuse ambiguous matches |
| Scope (four transports) | Schedule | Phases 1–4 ship the common case independently; 5 and 6 can follow |
