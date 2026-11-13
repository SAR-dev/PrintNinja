# Changelog

All notable changes to PrintNinja are recorded here, newest first.
The version is kept in sync across `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
(`pnpm version:set`). Add entries to **Unreleased** as work lands;
`pnpm release` then freezes it in the release commit — the section
becomes that version's dated heading and a fresh empty **Unreleased**
opens on top. An entry-less Unreleased is left alone. Style: short,
to-the-point bullets — a bold lead plus at most two lines of detail.

## Unreleased

### Changed

- **Every barcode type now prints.** The five formerly preview-only
  symbologies (UPC-E, ITF-14, Data Matrix, PDF417, Aztec) are drawn by
  the built-in engine; the "preview only" badges and the print-time
  confirmation are gone.
- **Previews render through the print engine.** All six surfaces
  (Designer, Templates, Print, phone screens) call the same engine as
  the print job; the JS render stack (handlebars.js + bwip-js) and the
  `bwip-js` dependency are removed.
- **`{{date}}` no longer uses browser locale formats.** Default
  `YYYY-MM-DD`, `short` = `17 Oct 2026`, `time` = 24-hour `HH:MM`,
  `long`/`datetime` get real formats, any other argument is a strftime
  pattern (previously ignored). Non-ISO (RFC 3339) values print as-is.
- **The Designer error banner shows the engine's message.** It names
  the problem but, unlike the old JS engine's, does not point at a
  source line.
- **One sample dataset per account.** The Designer's Sample data
  section now holds a single shared dataset — no name, no adding or
  deleting; its JSON is edited from one button. Accounts with older
  multi-dataset rows keep them stored and synced; the Designer shows
  "Sample Order" when present, otherwise the first in name order.

### Fixed

- **UPC-A check-digit validation** now matches the built-in encoder;
  UPC-E and ITF-14 check digits are validated the same way.

## [2026.1112.0] - 2026-11-12

### Added

- **Driverless Bluetooth printing on Windows and Linux.** Add a
  printer by MAC (pair in the OS first): Windows writes the device's
  COM port (located from the MAC, or named as `COM7`), Linux dials an
  RFCOMM socket (channel 1 default). SPP only, not BLE; on Windows a
  COM port is accepted as the address too.
- **`via_driver` option for Bluetooth rows (off by default).** The job
  goes to the OS spooler/CUPS queue instead of the raw wire, so PDF
  works; the app never switches paths on its own.
- **Search and sort on My templates.** `GET /v2/templates/mine` takes
  `q` and `sort`; the search box + sort toolbar now covers all three
  tabs.

### Changed

- **"Detected devices" block in the Add-printer dialogue.** OS queues,
  mDNS finds and paired Bluetooth printers collapse to counts behind
  one Rescan button; tapping a header expands its list.
- **Bluetooth addresses validate in the form.** A driverless row must
  be a MAC (or a Windows COM port); plain USB/port names get a
  dedicated message. Driver rows skip the check.
- **PDF is a normal language choice again for driver-mode Bluetooth
  rows** (the raw-wire ESC/POS fallback and its warnings no longer
  apply — the driver is the rasterizer).
- **Bluetooth test print opens the real wire** (COM/RFCOMM, or the OS
  queue status in driver mode) before printing anything.
- **Docs** (README, `PRINTERS_AND_TRANSPORTS.md`, troubleshooting)
  describe the driverless flow instead of the old CUPS-raw-queue
  guidance.

### Fixed

- Windows direct-send timeout message referenced a moved value; it
  keeps its own copy now.
- Stale transport tests for the old "Bluetooth on Linux is a CUPS raw
  queue" behaviour, replaced by direct-dial expectations.
- Connection/Language fields in the Add/Edit printer dialog lost
  vertical alignment when the Detect button showed; both header rows
  are fixed `h-6` now.

## [2026.1110.3] - 2026-11-10

### Added

- **PDF input print jobs.** `POST /v1/print` accepts a base64 `pdf`
  field (5 MiB after decoding; mutually exclusive with
  `template`/`data`). PDF-language printers get the document as-is;
  command-language printers get the first page rasterised to the
  head's dot dimensions; multi-page docs print the first page with a
  warning. The document is stored in `print_jobs.pdf_data` for retry.
- **PDF input on Linux.** Vendored prebuilt `libpdfium.so` (x86-64)
  beside `pdfium.dll`; the loader resolves the filename per OS.
- **PDF input on Android.** Rendered on-device by
  `android.graphics.pdf.PdfRenderer` in the print plugin — no binary
  in the APK.
- **Printer capability probing** (`probe_printer_capabilities`):
  asks the printer for its formats and make-and-model before the row
  is saved and suggests a language; unreachable printers come back
  `detected: false`, never an error.
- **Printer editing** (`update_printer`): edit in place instead of
  delete + re-add, so name-keyed profiles survive.
- **Docker-based Rust test suite:** `pnpm test:rust`
  (`pnpm test:rust:report` for JUnit); the PDFium unit tests now run
  on Linux against the vendored `.so`.

### Changed

- **`pnpm release` freezes the changelog:** a non-empty **Unreleased**
  becomes the version's dated heading and a fresh empty **Unreleased**
  opens, in the same commit as the version bump.
- **Add-printer discovery sections collapse to their count**; tapping
  the header expands the list.
- **Dead render browsers are logged with their exit status** (exit
  code or socket close) before restart, so an unexplained ~8 s cold
  start is visible in the log.
- **Pairing-code placeholder is now `XYZ7K4MP`** (a sample code), not
  `XXXXXXXX`.
- **Schema/API:** `print_jobs.pdf_data BLOB`; a job needs a template
  **or** a `pdf`; the `POST /v1/print` body limit moved 2 MiB →
  10 MiB.

### Fixed

- Three stale test assertions after the content-source change (two in
  `api_routes`, one in `language_dispatch`).
- A latent Android compile break the PDF-input feature introduced:
  `render/pdfium.rs` is now `cfg`-gated to desktop.
- Three Kotlin API errors in the Android plugin's PDF path (descriptor
  via `ParcelFileDescriptor.open`, nested `PdfRenderer.Page`, 4-arg
  `Page.render`).
