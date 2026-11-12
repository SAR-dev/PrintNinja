# Changelog

All notable changes to PrintNinja are recorded here, newest first.
The version is kept in sync across `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
(`pnpm version:set`). Add entries to **Unreleased** as work lands;
`pnpm release` then freezes it in the release commit — the section
becomes that version's dated heading and a fresh empty **Unreleased**
opens on top. An entry-less Unreleased is left alone. Released
sections are never edited again; they are the release notes.

## Unreleased

## [2026.1112.0] - 2026-11-12

### Added

- **Driverless Bluetooth printing on Windows and Linux.** Pair the
  printer in the OS's Bluetooth settings and add it in PrintNinja by its
  MAC — no driver, no queue, and (on Linux) no CUPS raw queue. Windows
  writes the job straight to the paired device's own COM port, located
  from the row's MAC or named outright as `COM7`; Linux dials an RFCOMM
  socket from the kernel's Bluetooth stack on channel 1 unless the
  address says otherwise. Classic serial (SPP) printers only — not BLE.
  Pairing itself stays an OS flow.
  - The address accepts a MAC (`:` or `-` separators, any case, an
    optional `:1`–`:30` RFCOMM channel) or, on Windows, the device's
    serial port (`COM7`, `\\.\COM7`). A shared parser
    (`transport/bluetooth_addr.rs`) reads the same stored row on every
    platform, so a row synced from a phone reads the same everywhere.
- **"Print through the OS driver" for Bluetooth printers**
  (`via_driver`, off by default). Flips a Bluetooth row to the *other*
  path and only that path: on Windows the job goes to the spooler queue
  installed under the same name, on Linux to the printer's CUPS queue —
  the driver in between rasterizes, so PDF works there. The app never
  switches paths on its own: a driverless row that names no COM port on
  Windows fails with guidance instead of quietly using the queue, a
  driver row never dials the device, and the option is hidden on
  Android (no driver path yet) where a row carrying it is refused with a
  clear message.
- **Search and sort on My templates.** The owner's own template list
  (`GET /v2/templates/mine`) now takes `q` and `sort` (`updated` /
  `used` / `name`), and the Templates screen gains a shared toolbar — a
  search box over name and summary plus a sort select — used by all three
  tabs (mine, saved, community).

### Changed

- **The Add-printer dialogue gained a "Detected devices" block.** OS
  print queues, mDNS network discoveries and paired Bluetooth printers
  each collapse to their count behind one Rescan button (new
  `DetectedDevices` + `FoldSection` components); tapping a header opens
  its list. A PC full of virtual printers (OneNote, Print to PDF, …) or a
  background mDNS hit no longer resizes the form out from under the
  operator.
- **Bluetooth rows validate their address in the form.** A driverless
  row must be a MAC (or a Windows COM port); an address that is plainly a
  USB or print port (`USB003`, `LPT1:`, `PORTPROMPT:`, a pipe or WSD path
  — what ends up there when the connection type is changed after picking
  a system or USB device) gets its own message instead of a generic
  "invalid". A driver-mode row skips the check, since the queue is
  addressed by the printer's name, not the address.
- **PDF is a normal language choice again for a driver-mode Bluetooth
  row.** The raw-wire default that drops USB/Bluetooth rows from PDF to
  ESC/POS no longer applies when the row prints through its OS driver —
  there the driver *is* the rasterizer the warning is about. The same
  exemption applies to the "raw wire" and "GDI-only queue" warnings.
- **A Bluetooth test print opens the real wire.** The connectivity check
  that precedes a test print now dials the COM port or RFCOMM socket and
  closes it again (or checks the OS queue's status for a driver-mode
  row) — still without putting anything on paper.
- Docs: the README, `docs/architecture/PRINTERS_AND_TRANSPORTS.md` and
  the troubleshooting notes now describe driverless Bluetooth instead of
  the old "install a Windows printer (USB *and* Bluetooth) / a CUPS raw
  queue on Linux" guidance.

### Fixed

- A moved value in the Windows direct-send timeout message: the
  `spawn_blocking` closure takes the port name by `move`, leaving the
  error string with a moved value — the message now keeps its own copy.
- Stale transport tests for the old "Bluetooth on Linux is a CUPS raw
  queue" behaviour, replaced by the direct-dial expectations: a valid MAC
  constructs a transport, a non-address fails with the address-format
  message (never "unsupported" and never queue advice), and a driver-mode
  row resolves to the CUPS queue by name and never dials the MAC.
- The **Connection** and **Language** fields in the Add/Edit printer
  dialog were no longer vertically aligned whenever the Detect button
  showed: the `h-6` button made the Language column's header row taller
  than the Connection column's label, pushing the Language select down.
  Both header rows now sit in a fixed `h-6` row, so the two selects start
  at the same height for every connection type.

## [2026.1110.3] - 2026-11-10

### Added

- **PDF input print jobs.** `POST /v1/print` accepts a base64 `pdf`
  field — mutually exclusive with `template`/`template_server_id`,
  `data` and `data_url`; capped at 5 MiB after decoding, 10 MiB total
  body. PDF-language printers (IPP / system spooler) receive the
  document as-is; command-language printers (ESC/POS, TSPL, ZPL, CPCL)
  get the first page rasterised to the head's dot dimensions.
  Multi-page documents print the first page and the job carries a
  warning. The document is stored as `print_jobs.pdf_data` (BLOB) so
  retry/reprint can re-run the job; it is never exposed through
  `PrintJob`.
- **PDF input on Linux.** A prebuilt `libpdfium.so` (x86-64, Apache-2.0)
  is vendored beside the existing `pdfium.dll` in
  `src-tauri/resources/pdfium/`; the loader's `candidate_paths()`
  resolves the right filename per OS, so no Rust code change.
- **PDF input on Android.** Rendered on-device by the platform's own
  PDFium port (`android.graphics.pdf.PdfRenderer`) in the Android
  print plugin — no binary in the APK. Mirrors the on-device WebView
  raster path (cache-file handoff, same dot threshold), so a PDF to a
  thermal head now works unpaired.
- **Printer capability probing** (`probe_printer_capabilities`): asks
  the printer what it understands (IPP document formats, make-and-model)
  *before* its row is saved and suggests a language. Read-only by
  contract and graceful — an unreachable, refusing or silent printer
  comes back as `detected: false`, never as an error.
- **Printer editing** (`update_printer`): edit a printer in place. The
  UI used to require delete + re-add, which lost profiles keyed by
  name.
- **Docker-based Rust test suite**: `src-tauri/Dockerfile.test` +
  `src-tauri/docker-compose.test.yml`; run with `pnpm test:rust` (or
  `pnpm test:rust:report` for a JUnit file). The suite runs on Linux,
  where the PDFium unit tests now run for real against the vendored
  `.so` instead of self-skipping.

### Changed

- **`pnpm release` freezes the changelog.** The release script now
  renames a non-empty **Unreleased** section to the new version's dated
  heading in the same commit as the version bump and opens a fresh
  empty **Unreleased** — so each released section is ready to use as
  that release's notes.
- **Add-printer discovered sections collapse to their count.** In the
  Add printer sheet, "Found on this network" and "Paired Bluetooth
  printers" now show only their count by default — background
  discoveries no longer resize the dialog out from under the form.
  Tapping the header (with a rotating chevron) expands the list for
  selection. Same behaviour on desktop and Android.
- **A dead render browser is logged with its exit status.** When the
  persistent Edge/Chromium process died while the app sat idle, the next
  print silently paid the full cold start (~8 s) with nothing in the log
  to explain it. The CDP layer now records how the process went before
  restarting it — exit code (crash / OS kill) or "socket closed but the
  process is still alive" — and a non-zero exit after a polite
  `Browser.close` is logged too.
- **Pairing-code placeholder shows an example combination.** The
  8-character pairing input placeholder changed from `XXXXXXXX` to
  `XYZ7K4MP`, so it reads as a sample code (all characters from the
  pairing alphabet) instead of a length hint.
- `print_jobs` schema gains `pdf_data BLOB` (run-input for PDF jobs).
- OpenAPI: a job needs a template **or** a `pdf` (`template` is no
  longer unconditionally `required`); the `POST /v1/print` body limit
  moved 2 MiB → 10 MiB to carry the base64 field.

### Fixed

- Three stale test assertions after the content-source change: two in
  `api_routes` (required-field and body-cap probes) and one in
  `language_dispatch` — the Pdf-language branch passes the bytes
  straight through and never consults the renderer.
- A latent Android compile break the PDF-input feature introduced:
  `render/pdfium.rs` (and its `Pdfium` engine) is now `cfg`-gated to
  desktop — dispatch moved into `PdfRenderer::pdf_to_raster` — and the
  redundant inner `#[cfg(not(target_os = "android"))]` attributes were
  removed.
- Three Kotlin API errors in the Android plugin's new PDF path, caught
  by the gradle build: `PdfRenderer` now gets its descriptor from
  `ParcelFileDescriptor.open(...)` (there is no `fromFile`), the page
  type is the nested `PdfRenderer.Page` (there is no top-level
  `PdfPage`), and `Page.render` is the 4-arg overload with
  `RENDER_MODE_FOR_DISPLAY`.

