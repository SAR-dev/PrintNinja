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

