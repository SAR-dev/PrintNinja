# Changelog

All notable changes to PrintNinja are recorded here, newest first.
The version is kept in sync across `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
(`pnpm version:set`). Add entries to **Unreleased** as work lands;
when a release bumps the version, the section becomes that version's
heading.

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

