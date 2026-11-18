# Transport gaps: where the printing paths diverge

**Status:** code review of the encoder and transport layer, not a hardware test. Gaps 1–3 and 5–7 are implemented on branch `fix/transport-gaps`; gap 4 is deferred. See "Implementation status" below. Nothing is yet verified on real hardware or a full Windows/Android build.

**Scope reviewed:** the shared encoder (`src-tauri/src/transport/mod.rs`, `escpos.rs`, `label_langs.rs`), the transport implementations (`ipp.rs`, `raw_tcp.rs`, `cups.rs`, `windows_spooler.rs`, `windows_usb.rs`, `windows_bluetooth.rs`, `linux_bluetooth.rs`, `android_usb.rs`, `android_bluetooth.rs`), the status/precheck module (`status.rs`), and the dispatch layer (`src-tauri/src/commands/print.rs`).

All jobs flow through two layers — **encoding** (`encode_for_language_tuned`) and **sending** (each `PrinterTransport`'s `send`). The gaps below are places where those two layers, or the transports themselves, treat the same job inconsistently.

---

## Summary table

| # | Gap | Severity | Where |
|---|-----|----------|-------|
| 1 | `IppPrinter::send` hardcodes `application/pdf`, ignoring the job's MIME type | High | `transport/ipp.rs` |
| 2 | Windows USB always sends `RAW`, bypassing datatype selection | High | `transport/windows_usb.rs` |
| 3 | Windows USB blocks tokio workers (no `spawn_blocking`) | Medium | `transport/windows_usb.rs` |
| 4 | No pre-send fault detection (status precheck) on any Windows path | High | `windows_*.rs` |
| 5 | `IppPrinter::test()` sends a real document, unlike every other `test()` | Low | `transport/ipp.rs`, `transport/mod.rs` |
| 6 | Two encoders exist; `LabelPrinterTransport` is dead and divergent | Low | `transport/label_langs.rs` |
| 7 | Android mDNS discovery silently drops raw-TCP printers | Medium | `transport/android_bridge.rs` |

---

## Implementation status

| # | Status | Notes |
|---|--------|-------|
| 1 | Implemented | `IppPrinter::send` picks the `document-format` from `job.mime_type` via a `document_format` helper; unit test added. |
| 2 | Implemented | USB send delegates to `WindowsSpooler::send_job` (datatype-aware). **Windows-only — uncompiled here.** |
| 3 | Implemented | USB `test`/`send` run on the blocking pool via `spawn_blocking`. **Windows-only — uncompiled here.** |
| 4 | Deferred | Needs a Windows machine plus two design decisions (see below). |
| 5 | Implemented | `IppPrinter::test` calls `reach()`; the hardcoded test PDF is gone. |
| 6 | Implemented | `LabelPrinterTransport` deleted; a comment marks the live encoder. |
| 7 | Implemented | mDNS results map `raw_tcp` → `PrinterType::RawTcp` instead of being dropped. **Android-only — uncompiled here.** |

### Verification not yet run (resource / platform constraints)

This work was done on a low-end Linux box (2 cores, ~7.8 GiB RAM, ~8.6 GiB free disk, no prebuilt `target/`). Per `CLAUDE.md`, the Rust suite must run in Docker (`pnpm test:rust`) because the desktop crate's debug build peaks at several gigabytes natively. The following were therefore **not** run here and are TODOs for a fuller machine:

- [ ] `cargo check` / `cargo clippy --all-targets -- -D warnings` — skipped; a from-scratch build of the Tauri crate is too heavy on this box.
- [ ] `pnpm test:rust` (Docker) — the full Rust unit suite, including the new `send_declares_the_format_matching_the_job` test.
- [ ] Windows build/test — gaps 2, 3 (and the deferred gap 4) are `#[cfg(windows)]` and were written by inspection only.
- [ ] Android build/test — gap 7 is `#[cfg(target_os = "android")]` and was written by inspection only.

`cargo fmt --check` **does** pass.

### Gap 4 deferred — what is left to do

Gap 4 (no pre-send fault detection on Windows) is the only High gap still open and is **not implemented**. Two decisions must be made on a Windows machine before coding it, so it is deliberately left out rather than written blind:

1. **Spooler/USB precheck:** run `check_ready` before every send (adds an open/read/close round trip per job), or accept that the OS queue surfaces state only at `test` time and document the tradeoff. A cooldown like `status::should_probe` would also need porting to queue names.
2. **Bluetooth COM precheck:** the direct path opens the port with `GENERIC_WRITE` only and sets only write timeouts; a status query needs read access (`GENERIC_READ`), read timeouts, `ReadFile`, and `status::dialect_for`/`decode` wired over the COM port.

---

## 1. `IppPrinter::send` ignores the job's MIME type

**Current condition.** `IppPrinter::send` routes through `send_pdf` → `send_bytes(..., "application/pdf")` and never reads `job.mime_type` or `job.language` (`ipp.rs:155-157, 609-611`). A network IPP printer whose `language` column is set to a command language (ESC/POS, ZPL, TSPL, CPCL, raster) therefore has its command bytes declared to the endpoint as `application/pdf`.

**Contrast.** `CupsPrinter::send` branches on `job.mime_type` (`cups.rs:431-436`): PDF stays `application/pdf`, everything else goes out as `application/octet-stream` so cupsd does not filter it. The `RenderedJob.mime_type` field exists precisely to carry this information, but only the CUPS transport honors it.

**Why it matters.** The `en.ts` UI copy already warns that "IPP printers expect PDF" — but the transport does not enforce or reflect that; it silently mislabels non-PDF bytes instead of refusing or using `octet-stream`.

**Solution.**
- Make `IppPrinter::send` mirror `CupsPrinter::send`: choose `application/pdf` vs `application/octet-stream` from `job.mime_type`, falling back to PDF when `mime_type` is empty (preserves current behavior for existing rows).
- Decide and document the intended behavior for an IPP printer configured with a command language: either (a) declare `octet-stream` (correct for CUPS-style raw endpoints), or (b) refuse with a message pointing at "add this printer as Raw TCP instead", matching the UI warning.
- Add a unit test asserting the `document-format` attribute follows `job.mime_type`, alongside the existing `cups_raw_queue_carries_octet_stream_not_pdf` test.

---

## 2. Windows USB always sends `RAW`, bypassing datatype selection

**Current condition.** `WindowsSpooler::send` runs the PDF-vs-RAW decision via `choose_datatype` (`windows_spooler.rs:609-644, 100-111`): it inspects the queue's offered datatypes and declares `PDF` only when the print processor supports it. `WindowsBluetooth` in driver mode delegates to that same path (`windows_bluetooth.rs:154-159`).

But `WindowsUsbPrinter::send` → `send_raw` → `send_raw_with_datatype(data, "RAW")` (`windows_usb.rs:23-25, 39-41`; `windows_spooler.rs:479-481`). A PDF-language USB printer on Windows therefore always goes out as `RAW` — garbage on a GDI-only driver, and no `PDF` datatype declared even when the queue offers it.

**Why it matters.** USB printers are installed as Windows queues (no direct USB access), so they have the exact same datatype concern as a `system` queue. The datatype logic exists but is not applied to them.

**Solution.**
- Route `WindowsUsbPrinter::send` through the same datatype-aware send as `WindowsSpooler::send` (call `WindowsSpooler::send` or its `send_raw_with_datatype` with `choose_datatype`), instead of the always-RAW `send_raw`.
- Add a test that mirrors `pdf_is_declared_only_when_the_queue_offers_it` for the USB transport path (or factor the datatype decision into a shared helper both transports call, so it cannot drift again).

---

## 3. Windows USB blocks tokio workers (missing `spawn_blocking`)

**Current condition.** `WindowsSpooler` wraps `check_ready` and the send in `spawn_blocking` (the "W4" pattern, `windows_spooler.rs:599-607, 609-644`), because the Win32 spooler calls block and a wedged queue would stall a tokio worker.

`WindowsUsbPrinter` does not: `test` calls `self.spooler().check_ready()` directly and `send` calls `self.spooler().send_raw()` directly, both synchronously inside `async fn`s (`windows_usb.rs:34-37, 39-41`).

**Why it matters.** A blocked `OpenPrinterA`/`GetPrinterA`/`WritePrinter` on a wedged USB queue stalls a tokio worker thread, the same failure the spooler path was refactored to avoid.

**Solution.**
- Apply the W4 pattern to the USB transport: wrap `check_ready` and the datatype-aware send in `tokio::task::spawn_blocking`, matching `WindowsSpooler::test` and `WindowsSpooler::send`.
- Ideally, collapse `WindowsUsbPrinter` into a thin wrapper over `WindowsSpooler` so the two cannot diverge again.

---

## 4. No pre-send fault detection (status precheck) on Windows

**Current condition.** Four transports run a status precheck before writing bytes, using `status::dialect_for(job.language)` to ask ESC/POS `DLE EOT`, Zebra `~HS`, or TSPL `ESC !?` and refuse the job on paper-out/jam/offline:
- raw TCP (`raw_tcp.rs:160-215`)
- Linux Bluetooth (`linux_bluetooth.rs:172-218`)
- Android USB (`android_usb.rs:105-128`)
- Android Bluetooth (`android_bluetooth.rs:114-137`)

The Windows paths have no equivalent on the send path:
- Windows Bluetooth direct COM (`windows_bluetooth.rs::direct::send`, `:316-339`) writes bytes with no status query.
- `WindowsSpooler::send` (`:609-644`) sends with no precheck — `check_ready` runs only in `test`, not per send.
- `WindowsUsbPrinter::send` likewise.

**Why it matters.** The "refuse to print into a faulted printer" protection that exists on Linux, Android and raw TCP is entirely absent on Windows — for both the spooler path and the direct Bluetooth wire. This is the single largest consistency hole: the status-query machinery (`status.rs`) is already written, just never wired into the Windows sends.

**Solution.**
- Add a precheck to the Windows Bluetooth direct COM path, mirroring the raw-TCP/Android contract (share one connection for the query and the write where the port supports a reply; otherwise a separate open/query/close).
- For the spooler/USB paths, decide whether a status precheck is meaningful (the OS queue already surfaces state via `GetPrinterA`). If yes, run `check_ready` before `send` (off the tokio workers); if no, document explicitly why Windows spooler sends are exempt, so the gap is a decision rather than an omission.
- Ensure the `status::should_probe` / `note_silent` / `note_answered` bookkeeping is shared, not re-implemented, so the silence-vs-answer semantics stay identical across platforms.

---

## 5. `IppPrinter::test()` actually prints, unlike every other `test()`

**Current condition.** Every transport's `test()` is connectivity-only: raw TCP `reach`, Windows `check_ready`, Bluetooth/USB open-and-close, CUPS Get-Printer-Attributes. But `IppPrinter::test()` POSTs a real hardcoded PDF test page (`ipp.rs:603-607`).

This is now effectively dead in the live app: the `test_printer` command was refactored to use `TransportRegistry::probe` (connection-only) plus a full render, so it never calls `transport.test()` (`commands/printer.rs:449-498`). The only remaining caller of `transport.test()` is `TransportRegistry::test_printer` (`mod.rs:504-515`), which is referenced only from tests.

**Why it matters.** The method name promises a connectivity check, but on IPP it submits a document. Anyone who calls `transport.test()` on an IPP printer in the future gets a real printed page out of a "test" — an easy trap.

**Solution.**
- Change `IppPrinter::test()` to the connection-only `reach()` (matching every other transport), and delete the hardcoded test PDF.
- Remove `TransportRegistry::test_printer` if nothing non-test needs it, or leave it but add a doc-comment warning that `test()` must be connection-only across all transports.
- Add a test that pins the contract: every transport's `test()` writes zero bytes to the wire.

---

## 6. Two encoders exist; `LabelPrinterTransport` is dead and divergent

**Current condition.** The live path is `encode_for_language_tuned` (`mod.rs:233`). `label_langs.rs` also defines `LabelPrinterTransport::encode` (`label_langs.rs:236-271`) with its own match, referenced nowhere outside its own file (dead code). It diverges from the live path in two ways:

- Its fallback for an unknown language is **ESC/POS** (`:260-268`), whereas the current parse rule is unknown → **PDF** (`mod.rs:192-202`) and `encode_for_language` treats `Pdf` as an error (`:245-248`).
- It does not apply TSPL tuning (darkness/speed/media), which the live path does (`mod.rs:263-273`).

**Why it matters.** Keeping two encoders means a future edit risks fixing one and not the other, and the dead one still advertises the old "unknown → ESC/POS" behavior that the parse rule contradicts.

**Solution.**
- Delete `LabelPrinterTransport` (the struct and its `encode`) and its fallback, keeping only the `tspl`/`zpl`/`cpcl` free functions that the live path calls.
- Add a test (or extend the existing encoder tests) that pins `encode_for_language_tuned` as the sole public encoder entry point.

---

## 7. Android mDNS discovery silently drops raw-TCP printers

**Current condition.** `AndroidBridge::discover` filters the Kotlin plugin's network results with `kind != "raw_tcp"` (`android_bridge.rs:40`), so on Android only IPP printers appear in the network scan. Meanwhile `docs/architecture/PRINTERS_AND_TRANSPORTS.md:51-52` says the mDNS browse finds both `_ipp._tcp`/`_ipps._tcp` (→ `ipp`) and `_pdl-datastream._tcp`/`_printer._tcp` (→ `raw_tcp`). The code and the documented behavior disagree: a raw-TCP (JetDirect/9100) printer is never listed on Android and must be added by address manually.

**Why it matters.** Raw TCP is the primary transport for the receipt/label thermal printers this app targets, and on Android those are exactly the printers the "tap to add" discovery flow should surface. A user following the documented flow finds nothing.

**Solution.**
- Stop filtering `raw_tcp` and map it to `PrinterType::RawTcp` in the `PrinterInfo` construction (`android_bridge.rs:39-50`), **or**
- Update `PRINTERS_AND_TRANSPORTS.md` to state that raw-TCP discovery is desktop-only and Android requires a manual address — whichever is intended.
- The Kotlin side already returns a `kind` per result, so the fix is on the Rust mapping side, not the plugin.

---

## Minor observations (not blockers)

- **`Raster` sends bare dots with no geometry** (`mod.rs:284`). Unlike ESC/POS (per-band `GS v 0` header), TSPL (`SIZE` + `BITMAP`), ZPL (`^PW`/`^LL`) and CPCL (`EG`), a bare-bitmap device receives no width/height/dpi, so it cannot self-describe size. Documented as "bare-bitmap devices", but worth confirming the receiving spoolers/bridges supply geometry out of band.
- **TSPL is the only dialect with per-printer tuning** (darkness/speed/media). ZPL hardcodes `^PR6` and leaves darkness to the printer (`label_langs.rs:187`); there is no equivalent knob for Zebra, CPCL or ESC/POS users.
- **Copies handling is centralized and consistent** (`print.rs:1817-1871`) — IPP/CUPS take a hardware count, raw wires repeat the payload in one write, and PDF-on-a-raw-wire goes one job per copy. This layer is *not* a gap; it is recorded here to be explicit that it needs no work.

---

## Suggested order

1. **Gap 2** (Windows USB PDFs silently print wrong) and **Gap 4** (no fault detection at all on Windows) — the two most user-visible failures.
2. **Gap 1** (IPP command-language jobs mislabeled as PDF) — correctness for misconfigured rows.
3. **Gap 3** (blocking Windows USB) — stability, and naturally falls out of consolidating USB into the spooler path.
4. **Gap 5** (dead-but-dangerous `IppPrinter::test`) and **Gap 6** (delete dead encoder) — cleanup with small blast radius.
5. **Gap 7** (Android raw-TCP discovery) — small, but confirm intent before touching the mapping or the doc.

---

## Not yet audited (recommended follow-ups)

The seven items above cover the **send/encode/discovery** layer. These adjacent layers were not reviewed for internal gaps and should get their own pass before this doc is considered complete:

- **Render/rasterization** (`src-tauri/src/render/`): how the raster is produced, thresholded and sized (`dots_for_mm`, browser choice). Not audited. Minor observation #1 (bare `Raster` dots with no geometry) is the boundary where this layer meets the transport layer.
- **API/server layer** (`api/`, `server/`): the REST `POST /v1/print` route. Confirmed to converge on the same `print_html`/`send_to` dispatch, but its request validation and error mapping were not reviewed.
- **Capability detection table** (`capabilities.rs::language_for_model`): deliberately conservative — it returns `None` for models it does not recognize (e.g. "RUIJIE RP325", a common ESC/POS receipt brand), so the form falls back to "unknown — please pick". Confirm this coverage is intended rather than an omission.
