# Direct printing on Windows (no spooler) — implementation plan

> **Status:** final scope, ready to start with Phase 0. Not yet implemented.
> **Audience:** whoever implements the Windows USB and Bluetooth transports.
> **Platform:** Windows. Android already prints directly; Linux is unchanged
> (see `docs/PLAN.md` §8, F14–F15).
> **Target hardware:** Toshiba TEC B-FP2D (older revision: USB + classic
> Bluetooth, no WLAN). See §3.
> **Supersedes:** the earlier four-transport plan (USB, Bluetooth, WinUSB, BLE).

## Changes from the previous plan

| Area | Before | Now | Why |
|---|---|---|---|
| Launch scope | USB, classic Bluetooth, WinUSB, BLE | **USB printer-class and classic Bluetooth only** | The target printer has USB and Bluetooth 2.1 EDR only. |
| WinUSB (old Phase 5) | Planned | **Removed** | Depends on driver binding we cannot control (releases are self-signed). Not needed for the target printer. |
| BLE (old Phase 6) | Planned | **Removed** | The target printer is classic Bluetooth. Also removes the `ble` type, the `btleplug` dependency and the `printers.type` table-rebuild migration. |
| Existing printers (D1) | Hard cut, re-link required | **Gradual:** existing rows keep printing through the spooler until upgraded | A hard cut breaks every Windows user at once and leaves no way back if a Windows update breaks direct access. |
| Spooler | Removed from the USB/Bluetooth path | **Kept as a per-printer fallback, switched manually** | Stability across Windows releases. |
| Mode storage | Derived from the address | **Explicit `transport_mode` column** (default `spooler`) plus a `spooler_queue` column | Verified in code: `address` is free text on Windows USB/Bluetooth rows and is ignored today, so a legacy row can hold a valid-looking MAC. Deriving the mode would silently switch such rows to direct (§6). |
| Queue conflict (Phase 3) | Detect and auto-disable the queue | **Detect and explain; auto-disable is optional** | How the spooler holds the port is behaviour, not a documented contract. |
| Automatic spooler retry | n/a | **Not in v1** (manual switch only) | Simpler and predictable. Can be added later (§12). |
| Rollout | One release | **Three releases** (opt-in beta, default, cleanup) | Reversible steps. |
| Spike | Five items | Trimmed to this printer, plus Windows version and Protected Print Mode checks, with go/no-go gates | See §8, Phase 0. |
| Estimate | 12–18 days | **~7–10 days plus 30–40% hardware buffer** | Smaller scope. |

Phases were renumbered: the old Phase 7 (docs and release hardening) is now Phase 5.

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
```

The `ble-scan` and `ble` subcommands are not needed any more (BLE is out of
scope, §1).

Notes:

- A refused open/connect with a win32 code is a **finding**, not a failure —
  paste the full terminal output of every subcommand, successes and failures.
- `usb-wait` is the interactive one: the spooler job must be sent **during**
  the 60 s window so we learn whether the `usbprint` handle opens while the
  spooler owns the device.
- The output becomes the Phase 0 "findings" note (§13).

## 1. Goal

Send ESC/POS, ZPL, TSPL and CPCL bytes from PrintNinja to a USB or classic
Bluetooth printer on Windows **without the Windows print spooler**: no
installed Windows printer, no queue, no driver in the path. The spooler stays
available as an explicit, per-printer fallback that the user switches on
manually (§6).

Non-goals:

- PDF printing to office printers. That stays on IPP, raw TCP or `system`
  (spooler) printers.
- Android and Linux changes.
- Replacing `system` printers. They keep using the spooler by design.
- **Vendor-class USB printers via WinUSB.** Removed from scope. A device that
  is present but is not printer-class gets a clear "not supported" message
  (Phase 2), not silent absence.
- **BLE printers.** Removed from scope. No `ble` printer type is added.

If either is wanted later it needs a new plan. The address format and the
`usb` backend resolution (§5, §6) are written so that adding a backend is
additive, but nothing for them is built or reserved in the schema.

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | What happens to existing Windows USB/Bluetooth printers on upgrade? | **They keep working through the spooler** (`transport_mode = 'spooler'`) until the user upgrades them to direct. Upgrading keeps the row (id, name, profile, history). Removing the spooler path for USB/Bluetooth is a later, evidence-based step (Release 3, §9). |
| D2 | Which printers must work at launch? | **USB printer-class and classic Bluetooth (SPP).** Nothing else. |
| D3 | What if the printer is also installed as a Windows printer? | **Detect it and explain.** Offering to disable the queue is optional and ships only if the spike shows that pausing releases the port (§8, Phase 3). |
| D4 | Windows CI available? | Yes. `.github/workflows/ci.yml` has `rust-test-windows` on `windows-latest`, which runs `cargo test`. Windows-only code is compiled and unit-tested there. |
| D5 | What if direct access breaks (Windows update, driver, hardware quirk)? | **Per-printer `transport_mode` (`direct` or `spooler`) and a per-transport kill switch** (§6). A failure never requires a patch release to keep printing. |
| D6 | Are old Windows queues deleted automatically? | **Never.** Removing a queue is destructive (it loses driver settings), so it is a manual step described in the UI. |
| D7 | Does the spooler fallback trigger automatically? | **No, not in v1.** When direct access is blocked, the error explains why and offers a one-click switch to the spooler mode. Automatic retry may be added later (§12). |
| D8 | Where is the fallback queue name stored? | **A `spooler_queue` column.** It survives renames of the printer row (the name is unique, editable, and is also the job and profile key). |
| D9 | How is the mode stored? | **An explicit `transport_mode` column**, default `spooler`, not derived from `address` (§6). |

## 3. Target printer: Toshiba TEC B-FP2D (older revision)

- Interfaces: USB 2.0 and Bluetooth 2.1 + EDR (classic, not BLE). No WLAN on
  this revision, so raw TCP is not available for it. NFC is for tap-to-pair
  with phones; on Windows the printer is paired in Settings.
- Media: 54 mm (2 in) wide, 203 dpi. A 100 mm-long label is roughly 40–45 KB,
  small enough for classic Bluetooth without special throughput handling.
- Languages: the vendor material lists ZPL II, CPCL, SBPL, TPCL, ESC/POS and a
  basic command interpreter, but sources disagree on which are exposed, and
  older firmware may differ. The language mode set on the printer must match
  the PrintNinja profile. TPCL is not a PrintNinja language. **The language
  currently used for this printer is not known yet; Phase 0 item 6 settles it.**
- Mobile printers sleep and power down. Deadlines and error messages
  ("is it on and in range?") matter more here than for a desktop printer.
- **Unconfirmed, to be settled by the Phase 0 spike:** the USB class the
  device reports (printer class is expected because Toshiba ships a Windows
  driver, but the datasheets do not say), and whether it exposes an SPP
  service.

## 4. Current state (verified against the code)

| Piece | Today |
|---|---|
| `transport/mod.rs` | `PrinterTransport` trait (`discover`, `test`, `send`). `create_transport(type, name, address)` builds one per printer row. Callers go through `TransportRegistry` (`send_to`, `test_printer`, `probe`) from three places: `commands/printer.rs` (test), `commands/print.rs` (preflight probe, send). |
| `transport/windows_usb.rs`, `windows_bluetooth.rs` | Wrap `WindowsSpooler`. The **printer `name` is the Windows queue name**; `address` is ignored. `discover` returns nothing. |
| `create_transport` (Windows) | Passes only `name` to the USB and Bluetooth constructors. |
| `TransportRegistry::probe` (Windows) | The `Usb` and `Bluetooth` arms call `WindowsSpooler::check_ready` directly, bypassing the transport types. They must be replaced, not just the transports. |
| `transport/raw_tcp.rs` | Already direct (TCP 9100). No change. |
| `transport/android_usb.rs`, `android_bluetooth.rs` | Already direct on Android. Behavioural reference: preflight status query, deadlines, clear errors, `reach()` that opens and closes without writing. |
| `transport/status.rs` | Transport-agnostic status queries (`dialect_for`, `decode`, `should_probe`, `note_silent`). Reused as is. |
| `commands/print.rs` | Preflight and the "language is PDF on a raw USB/Bluetooth transport" warning already cover `Usb` and `Bluetooth`. `list_bluetooth_devices` (the UI's BT scan) is Android-only. |
| `db/schema.sql`, `db/mod.rs` | `printers.type` has a `CHECK` list; **no new type is added, so no table rebuild**. `db/mod.rs` already adds columns with guarded `ALTER TABLE ... ADD COLUMN` (a `PRAGMA table_info` check first); new columns follow that pattern. The printer column list is hard-coded in about six places (`commands/printer.rs` selects, `db/mod.rs` backfill). |
| Printer rows | `name` is unique (case-insensitive) and editable via `update_printer`. It is also the key for the print queue permit and for profiles. |
| `.github/workflows/ci.yml` | `rust-test-windows` job exists (D4). |
| `docs/SIGNING.md` | Builds are internally self-signed. |

## 5. Architecture

Each transport implements `PrinterTransport` unchanged, so history, the REST
API and deep links need no changes beyond threading the mode and queue name
through `create_transport`, `TransportRegistry` and the three call sites.

```
RenderedJob (bytes + language)
   │
   ▼
create_transport(type, name, address, mode, spooler_queue)
   │
   ├─ mode = spooler ─► WindowsSpooler(queue = spooler_queue or name)   (existing path, unchanged)
   │
   └─ mode = direct
        ├─ usb ───────► WindowsUsb ─► usbprint interface ─► CreateFileW + WriteFile   (Phase 1)
        └─ bluetooth ─► WindowsBt  ─► Winsock AF_BTH RFCOMM (SPP)                     (Phase 4)
```

Shared building blocks, written in Phase 1 and reused by Phase 4:

- **OS-I/O trait.** A thin boundary under each transport (open, write with
  deadline, read with deadline, close). Windows API details and behaviour
  changes stay inside one module, and unit tests use a fake.
- **Deadline helper.** Every open, read and write is bounded; a wedged device
  fails the job with a named reason, never hangs the queue worker.
- **RAII handle wrappers** that cancel pending I/O and close on drop.
- **Error mapper.** Win32/Winsock error → operator-facing message. The raw
  error code is always kept alongside the friendly text in logs and in the
  details shown in the UI, so regressions after a Windows update can be
  diagnosed.
- **`send_on(handle, job)`** shape copied from `android_bluetooth.rs`: status
  query via `status::dialect_for`, then write. Chunk size is a parameter.
- **Capability probe.** On first use of a device, check that it can be opened
  and cache the outcome for diagnostics.

## 6. Addresses, mode and upgrade

### Address formats

| Type | Address | Notes |
|---|---|---|
| `usb` | `usb:04b8:0e15` or `usb:04b8:0e15:SERIAL` | Resolved by enumeration on every send; never store a device path (its instance ID changes with the port). Two matches without a serial → fail and name both; never print to "whichever came first". The backend is chosen at resolution time, so another backend could be added later. |
| `bluetooth` | `AA:BB:CC:DD:EE:FF` | Paired classic device. Same shape the Android transport stores. |

### Columns (additive, guarded `ALTER TABLE`, no `CHECK` rebuild of `printers`)

| Column | Definition | Meaning |
|---|---|---|
| `transport_mode` | `TEXT NOT NULL DEFAULT 'spooler' CHECK(transport_mode IN ('spooler','direct'))` | Only read on Windows for `usb` and `bluetooth` rows. Ignored for other types and platforms (Android is already direct). |
| `spooler_queue` | `TEXT` (nullable) | The Windows queue name used in `spooler` mode. NULL means "use the printer `name`", which is today's behaviour. |

Existing rows get `transport_mode = 'spooler'` and `spooler_queue = NULL`, so
they print exactly as before after the upgrade. **The mode is never derived
from `address`**: on today's Windows rows that field is free text and is
ignored, so a legacy Bluetooth row may well contain a real MAC.

The column list is hard-coded in about six places. Add the columns to the
`Printer` struct, `AddPrinterRequest`, every `SELECT` in
`commands/printer.rs`, the P2 backfill in `db/mod.rs`, the REST API types, and
`src/lib/agent/types.ts`.

### Upgrade to direct (not delete)

Printers → a Windows `usb` or `bluetooth` row in `spooler` mode shows
"Upgrade to direct printing", which opens the device picker. Choosing a device:

1. sets `spooler_queue` to the row's current `name` (if it is still NULL),
2. rewrites `address` to the device (`usb:...` or the MAC),
3. sets `transport_mode = 'direct'`.

The row id, name, language, profile and job history are kept. Pre-select the
discovered device whose name best matches the old queue name.

### Switch back to spooler (the supported escape hatch)

In the printer's settings, "Use Windows printer (spooler)" sets
`transport_mode = 'spooler'`. The queue used is `spooler_queue`, or `name` if
that is NULL. `address` is left as it is, so upgrading again is one click.

If the row has no known queue (a printer added directly, never on the
spooler), the switch opens a picker of installed Windows queues. When Phase 3
has matched a queue to the device, it is pre-selected and also stored in
`spooler_queue` when the direct printer is added.

### Kill switch

Settings `windows_direct_usb_enabled` and `windows_direct_bluetooth_enabled`
(default on once direct is the default). When off, direct rows fail with one
clear message that points to switching the printer to the spooler mode. This
turns a broken path off without a code change.

### No automatic fallback in v1

When direct access is blocked, the error explains why and offers the one-click
switch above. Nothing retries through the spooler on its own (D7).

`system` rows and Android/Linux rows are not affected by any of this.

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
  "Win32_Graphics_Printing",                     # Phase 3: EnumPrinters (SetPrinter only if auto-disable ships)
  "Win32_Networking_WinSock",                    # Phase 4: sockets
  "Win32_Devices_Bluetooth",                     # Phase 4: SOCKADDR_BTH, device lookup
] }
```

`nusb` and `btleplug` are no longer needed. Pin the `windows` crate version and
bump it deliberately, with the `rust-test-windows` job as the gate. Module
paths and feature names vary between `windows` versions: confirm every symbol
compiles on `rust-test-windows` as each phase lands.

## 8. Phases

Total estimate: **about 7–10 working days plus a 30–40% buffer for hardware
debugging.** Each phase ends with `cargo test` green on `rust-test-windows`,
`pnpm check`, and the listed hardware checks. Phase 4 does not depend on
Phases 1–3 apart from the shared building blocks and the mode/column plumbing
from Phase 2, so if Bluetooth is the main way the printer is used, build the
plumbing first, then Phase 4.

### Phase 0 — Spike on real hardware (0.5–1 day)

Verify what the rest of the plan assumes. Nothing is merged; the output is a
short "findings" note appended to this doc (§13).

Run on the target printer (Toshiba B-FP2D, USB + Bluetooth). Where possible,
repeat on two Windows versions.

1. **USB access while a queue exists.** With the printer installed as a
   Windows printer (Toshiba driver), can `CreateFileW` on the `usbprint`
   interface succeed when idle? During a spooler job? Does pausing the queue
   release it?
2. **Queue ↔ device mapping.** Candidate: the print queue's device node
   (under `SWD\PRINTENUM`) and the USB device share a `ContainerId`.
   Fallback: match by IEEE 1284 ID (manufacturer/model) and ask the user to
   confirm.
3. **USB class of the target printer.** Does it bind to `usbprint.sys`? Check
   Device Manager and the `usb` subcommand output. If it is not printer-class,
   stop and re-plan: this plan has no vendor-class path.
4. **Bluetooth.** Does the paired printer accept an RFCOMM connection through
   SDP resolution of the SPP service? Record open behaviour, whether a PIN is
   needed, and behaviour when the printer sleeps or is out of range.
5. **Throughput.** Time a 100 KB write over USB and over classic Bluetooth to
   set chunk sizes and timeout formulas.
6. **Language mode.** The language in use today is not known. Look at the
   Language field of the existing printer row in PrintNinja, and the printer's
   own language/emulation setting (its menu or configuration/self-test
   report, per the Toshiba manual). Then print a small ESC/POS, ZPL and CPCL
   job and record which PrintNinja profile prints correctly.
7. **Windows version matrix.** Repeat items 1 and 2 on Windows 10 22H2 and
   Windows 11 (current), and on Windows 11 with Windows Protected Print Mode
   enabled if available. Confirm direct writes and the queue behaviour are the
   same.
8. **Two identical printers without serials** (only if available): confirm the
   ambiguous-match refusal in §6 behaves as designed.

**Exit:** each assumption above is marked confirmed, changed or dropped in
§13, and the go/no-go gates below are decided.

| Finding | Decision |
|---|---|
| `usbprint` open fails on an idle device | Stop. Re-plan Phase 1. |
| The printer is not printer-class USB | Stop USB work. Bluetooth (Phase 4) still proceeds; USB stays on the spooler. |
| Pausing the queue does not release the port | Auto-disable is dropped (Phase 3 is guidance only). |
| No `ContainerId` match | Match by 1284 ID with user confirmation. |
| Windows Protected Print Mode breaks direct writes or queue handling | The spooler stays the default; direct is opt-in. |
| The printer refuses RFCOMM / has no SPP service | Stop Bluetooth work. Re-plan Phase 4. |

### Phase 1 — USB printer-class write path (1–1.5 days)

**Scope:** `usb` rows work for devices bound to `usbprint.sys`, write only.

- Enumerate with SetupDi using `GUID_DEVINTERFACE_USBPRINT`
  (`{28D78FAD-5A12-11D1-AE5B-0000F803A8C2}`) and
  `DIGCF_PRESENT | DIGCF_DEVICEINTERFACE`; read device paths and friendly
  names.
- Parse VID, PID and serial from the path; resolve `usb:VID:PID[:serial]`
  (§6), including the ambiguous-match failure.
- `CreateFileW` with `FILE_FLAG_OVERLAPPED`; write in a loop until all bytes
  are accepted; deadline via the event wait; `CancelIoEx` on expiry.
- Build the shared helpers from §5 (OS-I/O trait, deadline, RAII handle, error
  mapper, capability probe).
- Direct transport lives next to the existing spooler wrapper; `spooler` mode
  keeps today's behaviour unchanged.

Error mapping (sketch):

| Win32 error | Message |
|---|---|
| No matching interface | No USB printer with ID `04b8:0e15` found. Is it plugged in and powered on? |
| `ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION` | The USB printer is in use by another program or by a Windows printer queue. (Phase 3 adds the explanation and the one-click switch to spooler mode.) |
| `ERROR_GEN_FAILURE`, `ERROR_DEVICE_NOT_CONNECTED` | The USB printer stopped responding. Check the cable and power. |
| Deadline | The USB printer did not accept data within N seconds. |

**Tests (CI):** address parsing; device-path → VID/PID/serial from sample
strings; ambiguous match; write loop and short-write handling behind the
OS-I/O trait with a fake; error table.
**Hardware:** print a receipt and a label over USB.
**Exit:** a printer with no Windows queue prints a raster job end to end.

### Phase 2 — Plumbing, USB discovery, probe, status, UI, upgrade (2–2.5 days)

- **Schema and plumbing (§6):** the two guarded `ALTER TABLE` columns; extend
  `Printer`, `AddPrinterRequest`, every printer `SELECT`, the P2 backfill and
  the REST and agent types. Thread `transport_mode` and `spooler_queue`
  through `create_transport`, `TransportRegistry::{send_to, test_printer,
  probe}` and the three call sites (`commands/printer.rs` test,
  `commands/print.rs` preflight probe and send).
- **Replace the Windows `probe` arms** for `Usb` and `Bluetooth`, which call
  `WindowsSpooler::check_ready` directly today, with mode-aware arms.
- `discover`: list present `usbprint` devices as `PrinterInfo`
  (`printer_type: Usb`, address `usb:VID:PID[:serial]`), and include them in
  `TransportRegistry::discover_all` on Windows next to the system queues.
  Devices that are present but not printer-class are reported as "not
  supported" rather than omitted.
- `reach()` and the probe: open and close, no bytes.
- Status over the same handle: `status::dialect_for` → write query → bounded
  read (3 s, like Android) → `status::decode`. Silent printers go through the
  existing `note_silent` / `silence_message` path.
- **Upgrade and switch back (§6):** "Upgrade to direct printing", "Use Windows
  printer (spooler)", the queue picker for rows with no known queue, and the
  kill-switch settings.
- Frontend: `printerSchema.ts` `addressError` validates `usb:xxxx:xxxx[:serial]`
  on Windows in direct mode (keep the loose check for Android
  `/dev/bus/usb/...` and for spooler-mode rows); `PrinterSetup.tsx` shows a
  device picker instead of a free-text address and the mode control; new
  EN/JA strings.
- **Discovery IPC:** the picker needs its own command (e.g. `list_usb_devices`
  in `commands/print.rs`, backed by the `windows_usb.rs` enumeration) —
  there is no USB discovery command today. Per the agent contract
  (REFACTORING.md P18/Q11) it gets a typed entry in
  `src/lib/agent/commands.ts` and a type in `src/lib/agent/types.ts`.

**Tests:** migration (existing rows become `spooler`/NULL and print as before);
discovery mapping; mode switching (upgrade stores `spooler_queue`, switch back
uses it, rename does not break it); kill switch; schema validation cases; probe
never writes.
**Hardware:** out-of-paper and cover-open reported before printing; upgrade to
direct keeps history; switching back to spooler prints.
**Exit:** a user can add, test, print, upgrade and switch back a USB printer
entirely from the UI.

### Phase 3 — Windows queue conflict: detect and explain (1 day; +0.5–1 if auto-disable ships)

Applies when Phase 1 opens fail with access denied / sharing violation, and
proactively in the device picker.

- Enumerate queues with `EnumPrintersW` (level 2) and keep those on the USB
  port monitor.
- Match a queue to the device using the approach confirmed in Phase 0
  (`ContainerId`, else 1284 ID plus user confirmation). Store the matched queue
  in `spooler_queue` when a direct printer is added.
- UI: "This printer is also installed in Windows as *<queue name>*, which can
  block direct printing." Offer:
  - **Switch this printer to Windows printing (spooler)** (one click, always
    available).
  - **How to remove the Windows printer** (manual steps, Settings → Printers).
- **Optional, only if Phase 0 item 1 shows that pausing releases the port:**
  **Disable the Windows printer** (pause the queue and set it work offline
  with `SetPrinterW`), with a **Re-enable** action. If `SetPrinterW` returns
  access denied, say that Windows needs administrator rights and describe the
  manual route.
- Never delete a queue automatically (D6). No automatic retry (D7).

**Tests:** queue↔device matching on fixture data; access-denied path; if
auto-disable ships, its state machine (disable → re-enable).
**Hardware:** the conflict is reproduced and detected; the one-click switch to
spooler mode prints; if auto-disable ships, disable → print → re-enable works.
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
- `reach()` and the mode-aware probe; status query over the socket (RFCOMM
  replies are usually reliable). A sleeping printer must fail within the
  deadline with a message that says to wake it, not hang.
- In `direct` mode do not delegate to the spooler; `spooler` mode keeps
  today's behaviour (`windows_bluetooth.rs`).

| Error | Message |
|---|---|
| `WSAETIMEDOUT`, `WSAEHOSTDOWN` | The Bluetooth printer did not answer. Is it on, awake and in range? |
| `WSAECONNREFUSED` | The device refused the connection. It may not offer a serial (SPP) service, or another program is connected to it. |
| `WSAEADDRNOTAVAIL` | That address is not paired with this PC. Pair it in Windows Settings first. |

If a paired printer was previously added as a Windows printer, the same Phase 3
conflict check applies (the spooler may hold its COM port or connection).

**Tests:** MAC parsing; chunk loop; error table; kill switch.
**Hardware:** print over a paired SPP printer; printer off, asleep and out of
range fail within the deadline.
**Exit:** Bluetooth rows print and report faults like the Android transport.

### Phase 5 — Docs, rollout and release hardening (0.5–1 day)

- Update `docs/architecture/PRINTERS_AND_TRANSPORTS.md` and
  `docs/ARCHITECTURE.md`: Windows USB/Bluetooth can go direct, and the spooler
  remains a per-printer mode.
- `README.md` → Printers: USB and classic Bluetooth on Windows; troubleshooting
  entries for the queue conflict, sleeping or out-of-range Bluetooth printers,
  and switching a printer back to the Windows printer (spooler) mode.
- Release notes follow the rollout in §9.
- Metrics for observability, following the pattern in `docs/PLAN.md`:
  `direct_prints_total{transport="usb|bluetooth",result}` and
  `windows_queue_conflicts_total{action}`. Logs follow the existing redaction
  rules (no full device paths with serials at `info`).
- Final pass: `pnpm check:full`, Windows CI green, hardware and Windows
  version matrix recorded in this doc.

## 9. Rollout

| Release | What ships | Existing printers | New printers |
|---|---|---|---|
| 1 | Direct printing as an opt-in beta ("Upgrade to direct printing"). | Unchanged (`spooler`). | `spooler`, with the direct option offered. |
| 2 | Direct becomes the default. Upgrade banner for existing rows. | Unchanged until the user upgrades. | `direct`. |
| 3 | Consider removing the spooler path for USB/Bluetooth. | Only if reports from Release 2 show direct is solid. | `direct`. |

Release notes lead with the opt-in in Release 1 and the new default in
Release 2. Nothing is forced.

## 10. Testing summary

| Level | What |
|---|---|
| Unit (CI, Linux and Windows) | Address and device-path parsing, resolution order, chunking and short writes, timeout maths, error tables, migration defaults, mode switching and `spooler_queue` handling, kill switch, queue↔device matching on fixtures |
| Windows CI (`rust-test-windows`) | The `#[cfg(windows)]` code compiles and its unit tests run |
| Hardware (manual, per phase) | The Toshiba B-FP2D over USB and over paired Bluetooth; a printer with a leftover Windows queue; printer off, asleep, unplugged and out of range |
| Windows versions | Windows 10 22H2, Windows 11 current, Windows 11 with Protected Print Mode if available |

Windows-only code cannot be compiled on Linux without a Windows target, so
treat the `windows-latest` job as the compile check.

## 11. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Spooler holds the device or port | Open fails | Phase 3 detect and explain; one-click switch to spooler mode; Phase 0 confirms how the port is held |
| Windows changes break direct access (updates, Protected Print Mode, hardening) | Direct printing fails after an update | Per-printer spooler mode, kill switch, raw error codes in logs, Windows version matrix, `windows-latest` CI |
| Target printer is not printer-class USB | No direct USB path | Phase 0 item 3 gate; USB stays on the spooler, Bluetooth proceeds |
| Printer lacks an SPP service or is flaky over Bluetooth | No direct Bluetooth path | Phase 0 item 4 gate; spooler mode remains |
| Printer sleeps or goes out of range | Hung or slow jobs | Deadlines on every open, read and write; clear messages |
| Language mode mismatch (printer firmware vs PrintNinja profile) | Garbage or no output | Phase 0 item 6; document the mode to use |
| Schema/plumbing touches many hard-coded column lists | A missed `SELECT` returns wrong or missing fields | Update all sites in one change; migration and round-trip tests in Phase 2 |
| Existing rows mistaken for direct rows | Silent behaviour change on upgrade | Explicit `transport_mode`, default `spooler`; never derived from `address` |
| Overlapped I/O and handle leaks | Hangs | RAII wrappers; deadline helper used everywhere |
| Identical printers without serials | Wrong device prints | Refuse ambiguous matches |

## 12. Possible later work (not scheduled)

- Automatic retry through the spooler when direct access is blocked and a queue
  match is known (D7). Needs a reliable Phase 0 item 2 result.
- Optional auto-disable of the Windows queue (Phase 3 extra).
- Removing the spooler path for USB/Bluetooth (Release 3).
- WinUSB and BLE: out of scope. They would need a new plan with a named
  printer model and hardware to test on.

## 13. Phase 0 findings

_To be filled in after the spike. For each item in §8, Phase 0: confirmed,
changed or dropped, with the terminal output attached. Record the Windows
version and printer firmware, and the language that printed correctly._

## 14. Hardware matrix

_To be filled in per phase: printer model and firmware, connection (USB /
Bluetooth), Windows version, Protected Print Mode on/off, result._
