# PrintNinja: Cross-Platform Silent Print App Plan

**App name:** PrintNinja
Target platforms: **Android + Windows**
Stack: **Tauri 2** (Rust core) + **React + shadcn/ui** (light/dark) + Kotlin plugins for Android

---

## 1. Goals and Scope

PrintNinja is a single app that lets users:

1. **Design** HTML templates with a template engine, with page size and default orientation.
2. **Configure printers** (Wi-Fi/LAN, USB, Bluetooth, system printers) of all types: office (PDF/IPP), thermal receipt (ESC/POS) and thermal label (TSPL/ZPL/CPCL).
3. **Print silently** with data fetched from a URL, with full control over printer, template, orientation, margins, fit mode and copies.
4. **Review history** of successful and failed prints.
5. **Automate**: let other apps trigger prints through a local REST API and deep links.
6. **Print at scale**: batch/bulk print, test data mode, and per-printer profiles.

**Out of scope for v1:** iOS, macOS, cloud sync, multi-user accounts, scheduled/polling triggers (see section 12), UI languages other than English.

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| App shell | Tauri 2 (Windows + Android) | Small, fast, one Rust core shared by both platforms |
| UI | **React + Vite + TypeScript + Tailwind + shadcn/ui** (Radix) | One codebase, accessible components, responsive for phone and desktop |
| Theme | shadcn CSS variables + a `ThemeProvider` (light / dark / system) | Dual mode, persisted in settings |
| i18n | `react-i18next`, English strings only in v1 | Scaffolding so more languages can be added later |
| Forms / data | react-hook-form + zod, TanStack Query, TanStack Table, Zustand | Typed forms, cached DB queries, history tables |
| Local API | `axum` (Rust) | REST endpoint running inside the app |
| Deep links | `tauri-plugin-deep-link` + `tauri-plugin-single-instance` | `printninja://` on Windows and Android |
| Fonts | User-uploaded TTF/OTF/WOFF2 + bundled Noto Sans (Latin), Noto Sans CJK on demand | Latin and CJK out of the box |
| Diff view | `diff` library or Monaco diff editor | Template version comparison |
| Template engine | Handlebars (or LiquidJS) | Safe, logic-light, easy for end users |
| Designer | GrapesJS (visual) + CodeMirror (HTML/CSS tab) | Drag-and-drop plus code editing |
| Local DB | SQLite (`tauri-plugin-sql` or `rusqlite`) | Templates, printers, history |
| Secrets | `keyring` crate (Credential Manager / Android Keystore) | API tokens for data URLs |
| Android native | Kotlin Tauri plugins | WebView-to-PDF, USB host, Bluetooth |
| Barcode / QR | **bwip-js** (50+ symbologies, SVG output) | Code128, Code39, EAN/UPC, ITF, QR, DataMatrix, PDF417, Aztec, GS1 |

---

## 3. Architecture

```
┌──────────────────────── UI (shared web code) ────────────────────────┐
│   Designer  │  Print  │  Printer Setup  │  History                   │
└──────────────┬───────────────────────────────────────────────────────┘
               │ invoke()
┌──────────────▼──────────────── Rust core ────────────────────────────┐
│ Data fetcher → Template renderer → Layout → Render service → Queue   │
│                                                   │                  │
│                                          Transport layer (trait)     │
└───────┬──────────────────────────┬───────────────────────┬───────────┘
        │                          │                       │
   Windows layer              Android plugins          Shared (Rust)
   WebView2 PrintToPdf        WebView→PDF (Kotlin)     IPP, raw TCP 9100,
   Spooler / WinUSB           UsbManager, BT RFCOMM    ESC/POS encoder
```

### Entry points (all feed the same queue)

```
 UI (Print page) ──┐
 REST API (axum) ──┼──►  Job queue  ──►  Fetch → Render → Layout → Transport → History
 Deep link ────────┤
 Batch runner ─────┘
```

Every job records its **source** (`ui`, `api`, `deeplink`, `batch`, `test`), so History shows where it came from.

### Print pipeline

1. **Fetch data**: Rust makes the HTTP request (avoids browser CORS). The data URL must return JSON; ready-made HTML is not supported in v1.
2. **Render HTML**: template + JSON → HTML via Handlebars.
3. **Layout**: apply page size, orientation, margins, fit mode.
4. **Produce output** depending on printer language:
   - Office / laser / inkjet → **PDF**
   - Thermal receipt → **raster bitmap → ESC/POS**
   - Thermal label → **raster bitmap → TSPL / ZPL / CPCL**
5. **Send** through the printer's transport.
6. **Log** the result and any error in history.

---

## 4. Data Model (SQLite)

```
printers          id, name, type(ipp|raw_tcp|usb|bluetooth|system), address,
                  language(pdf|escpos|tspl|zpl|cpcl|raster), paper_width_mm, dpi,
                  default_settings_json

templates         id, name, current_version_id, page_w_mm, page_h_mm,
                  orientation, created_at, updated_at

template_versions id, template_id, version_no, html, css, label, note,
                  created_at, created_by(manual|autosave|restore)

sample_datasets   id, template_id, name, json, is_default

fonts             id, family, style, weight, file_path, format, created_at

printer_profiles  id, printer_id, template_id, settings_json
                  (margins, fit mode, scale, orientation, offsets, density, copies)

presets           id, name, printer_id, template_id, url, settings_json

batches           id, template_id, printer_id, total, done, failed,
                  mode(single_job|per_record), status, created_at

print_jobs        id, batch_id, record_index, template_id, template_version_id,
                  printer_id, source(ui|api|deeplink|batch|test), source_url,
                  status(queued|printing|success|failed|cancelled), error, copies,
                  settings_json, rendered_html, idempotency_key, is_test,
                  started_at, finished_at, duration_ms

api_clients       id, name, key_hash, scopes, allowed_ips, created_at, last_used_at

settings          key, value
```

API tokens are stored in the keyring and referenced by id, never in the DB.

---

## 5. Project Structure

```
printninja/
src/                         # Web UI
  pages/  Designer  Print  PrinterSetup  History  Settings
  components/ui/      # shadcn/ui generated components
  components/         # app components (PageCanvas, FitPreview, BatchTable ...)
  lib/  store/  theme/  # ThemeProvider, tokens, i18n

src-tauri/src/
  commands/    print.rs  printers.rs  templates.rs  history.rs
               versions.rs  fonts.rs  profiles.rs  batch.rs
  api/         server.rs  routes.rs  auth.rs  openapi.rs   # REST endpoint
  deeplink.rs  # printninja:// parser + confirmation flow
  render/      handlebars.rs  layout.rs  pdf.rs  raster.rs  barcode.rs  fonts.rs
  transport/   mod.rs  ipp.rs  raw_tcp.rs  escpos.rs  label_langs.rs
               windows_spooler.rs  windows_usb.rs  android_bridge.rs
  data/        fetcher.rs  secrets.rs
  db/          schema.sql  migrations.rs  models.rs
  queue.rs     # sequential per-printer queue with retry/backoff

plugins/
  tauri-plugin-android-print/   # Kotlin: PDF export, USB, Bluetooth,
                                # foreground service for API + queue
```

```rust
#[async_trait]
trait PrinterTransport {
    async fn discover() -> Vec<PrinterInfo>;
    async fn test(&self) -> Result<()>;
    async fn send(&self, job: RenderedJob) -> Result<()>;
}
```

---

# 6. Phase-by-Phase Plan

**Total estimate: about 20 weeks for one developer** (Phase 6 grew by one week to cover label printers).
Phases 1 and 5 are the riskiest, so they are done as spikes before the UI is built around them.

| Phase | Name | Duration | Platform |
|---|---|---|---|
| 0 | Foundation (React + shadcn, dual theme) | 1 wk | Both |
| 1 | Windows silent-print spike | 1 wk | Windows |
| 2 | Template engine, Designer, versioning, fonts, barcodes | 3 wks | Both |
| 3 | Print page, profiles, test data mode, batch print | 2.5 wks | Both |
| 4 | History + job queue | 1 wk | Both |
| 5 | Android printing (Wi-Fi) | 2 wks | Android |
| 6 | Thermal pipeline: receipt + label (ESC/POS, TSPL/ZPL/CPCL, USB, Bluetooth) | 3 wks | Android first |
| 7 | Windows USB/Bluetooth + visual designer | 2 wks | Windows |
| 8 | Automation: local REST API + deep links | 2 wks | Both |
| 9 | Polish, packaging, QA | 2 wks | Both |

---

## Phase 0: Foundation (1 week)

**Goal:** a running skeleton on both platforms.

### Tasks
- Create the Tauri 2 project named `printninja` (bundle id e.g. `com.yourcompany.printninja`); confirm `tauri android init` and `tauri android dev` work.
- Set up **React + Vite + TypeScript + Tailwind** and initialize **shadcn/ui** (`npx shadcn@latest init`).
- Add core shadcn components: Button, Input, Select, Tabs, Dialog, Sheet, Sidebar, Table, Form, Badge, Skeleton, Sonner (toasts), Command, Resizable.
- Build the **ThemeProvider** (light / dark / system) on shadcn CSS variables; persist the choice in `settings`.
- Build the navigation shell: sidebar on desktop, bottom tabs and Sheet menus on mobile (Tailwind breakpoints, 44 px touch targets).
- Add SQLite with a migration system and the schema from section 4.
- Add logging (`tracing`) and a global error type.
- Set up CI: lint, test, Windows build, Android debug build.
- Define the `PrinterTransport` trait and stub implementations.
- Add `react-i18next` scaffolding with English strings only.

### Deliverables
- App launches on Windows and an Android device/emulator with the empty pages, in light and dark mode.
- DB created on first run with migrations.

### Acceptance criteria
- `invoke('ping')` round-trips from UI to Rust on both platforms.
- CI produces installable artifacts.

---

## Phase 1: Windows Silent-Print Spike (1 week)

**Goal:** prove HTML to silent print on Windows, the core technical risk.

### Tasks
- Hard-code a sample HTML page.
- Render to PDF using WebView2 `PrintToPdf` through Tauri's `with_webview` (fallback: headless Edge).
- Print the PDF silently to a chosen system printer (bundle SumatraPDF as a sidecar, or send via the spooler).
- Enumerate system printers (`EnumPrinters` through the `windows` crate).
- Measure latency: render time and send time.

### Deliverables
- A button that prints a hard-coded page with no dialog.
- A short spike report with timings and chosen approach.

### Acceptance criteria
- Prints correctly sized A4 with no dialog on Windows 10 and 11.
- Render and send overhead under 1 second warm.

### Risks
- WebView2 print options differing from expectations; fall back to headless Edge or Chromium via `chromiumoxide`.

---

## Phase 2: Template Engine, Designer, Versioning, Fonts, Barcodes (3 weeks)

**Goal:** users can create, version and preview templates with international text and real-world barcodes.

### Tasks
**Week 1: engine and storage**
- Integrate Handlebars with one shared helper set: `currency`, `date`, `upper`, `lower`, `padLeft`, `number`, `barcode`, `qr`.
- Golden-file tests so preview output and printed output stay identical.
- Template CRUD (create, duplicate, delete, rename) and import/export as `.json` (including versions and embedded fonts, optional).

**Week 2: designer UI (shadcn)**
- Page setup panel: presets (A4, A5, Letter, 80 mm roll, 58 mm roll, 4x6 label), custom width/height in mm, default orientation.
- Canvas sized to real page dimensions (mm to CSS px) with zoom and page-boundary guides. The canvas stays **white in dark mode** because it represents paper.
- Code tab (CodeMirror) for HTML + CSS with Handlebars syntax highlighting.
- Variables panel with **named sample datasets** (add, rename, switch) and click-to-insert `{{field}}`.
- Auto-inject `@page { size; margin }`; autosave with undo/redo.
- Panels built with shadcn Resizable on desktop and Tabs/Sheet on mobile.

**Week 3: versioning, fonts, barcodes**
- **Template versioning** (see section 7.3): snapshots, labels, restore, diff view.
- **Custom fonts and Unicode** (see section 7.4): upload fonts, bundled Noto Sans (Latin), on-demand Noto CJK, Latin and CJK test pages.
- **Barcode variety** (see section 7.5): bwip-js helper, symbology picker, validation, scan test sheet.

### Deliverables
- Fully working designer with live preview, version history, custom fonts and many barcode types.

### Acceptance criteria
- A template with a `{{#each items}}` loop renders identically in preview and in printed output.
- Restoring version N brings back exactly the HTML/CSS of version N.
- Latin and CJK (Japanese, Chinese, Korean) text renders correctly in preview and PDF.
- Each supported barcode type scans correctly from a printed test sheet.

---

## Phase 3: Print Page, Profiles, Test Data Mode, Batch Print (2.5 weeks)

**Goal:** end-to-end print from the UI with all options, repeatable per-printer settings, safe testing, and bulk jobs.

### Tasks
**Week 1: print form and pipeline**
- Form fields (shadcn Form + zod validation):
  - Printer and template selectors
  - Data URL, HTTP method, headers/auth (token stored in keyring), optional JSON path to the payload
  - Orientation, margins (top/right/bottom/left in mm), copies
  - **Fit mode:** Actual size, Fit to width, Fit to page, Shrink only, Fill
  - Optional page range and grayscale
- Rust data fetcher with timeout, size limit, redirect policy and optional allowed-domains list; responses that are not valid JSON are rejected with a clear error.
- Layout module computing the scale factor from content size vs printable area.
- **Preview** in an isolated, script-disabled webview.
- Copies: send the IPP `copies` attribute when supported, otherwise loop.
- Live status: queued, rendering, sending, done or failed.

**Week 2: profiles and test data mode**
- **Printer-specific profiles** (section 7.7): save and auto-apply settings per printer + template pair.
- **Test data mode** (section 7.6): print or preview with a sample dataset instead of the live URL.
- Presets: save the full form for one-tap reprint.

**Week 2.5: batch / bulk print**
- **Batch print** (section 7.8): JSON array, CSV, or URL input; record mapping; progress, pause, cancel, retry failed.

### Deliverables
- Complete Print page with profiles, test mode and batch printing on Windows.

### Acceptance criteria
- Every fit mode produces the expected scale on a test page with a known grid.
- A failed fetch (timeout, 404, invalid JSON) shows a clear error and is logged.
- Selecting a printer + template that has a profile pre-fills the form, and any manual change overrides it.
- A 200-record batch prints with correct per-record data, and one bad record does not stop the rest.

---

## Phase 4: History and Job Queue (1 week)

**Goal:** reliable queued printing and a useful history page.

### Tasks
- Sequential per-printer job queue with retry and exponential backoff; the status machine is `queued → printing → success | failed`.
- Persist every job with settings, error text, duration and rendered HTML.
- History UI:
  - List: time, template, printer, status, duration, copies
  - Filters: status, printer, date range; search
  - Detail view: settings, source URL (tokens redacted), error, rendered preview
  - Actions: **Reprint**, **Retry failed**, delete, export CSV
- Retention setting (keep N days or N rows) with a cleanup job on startup.
- Show job **source** (UI, API, deep link, batch, test) and template **version** used; group batch jobs under one expandable row.
- Reprint uses the exact template version stored on the job.
- Crash recovery: jobs left in `printing` are marked `failed` on next launch.

### Deliverables
- Working history page and queue on Windows.

### Acceptance criteria
- Killing the app mid-print leaves no stuck jobs.
- Reprint reproduces the original job's settings exactly.

---

## Phase 5: Android Printing over Wi-Fi (2 weeks)

**Goal:** the same pipeline running on Android with network printers.

### Tasks
**Week 1: PDF rendering on Android**
- Kotlin plugin `tauri-plugin-android-print` with a command `htmlToPdf(html, pageSize, orientation, margins)`.
- Offscreen `WebView` loads the HTML, waits for `onPageFinished`, then exports through the `PrintDocumentAdapter` trick (helper in the `android.print` package).
- Return the PDF path to Rust.

**Week 2: network transport**
- Rust IPP Print-Job sender (shared with Windows) with response status parsing.
- Raw TCP 9100 sender.
- mDNS discovery (`_ipp._tcp`, `_pdl-datastream._tcp`) via `NsdManager`, plus manual IP entry.
- Scoped network security config for cleartext LAN traffic on port 631/9100.
- Foreground service so queued jobs complete while the app is backgrounded.

### Deliverables
- Android prints a template to a Wi-Fi printer silently.

### Acceptance criteria
- Same template prints with matching layout on Windows and Android.
- Works on Android 10 to 14 with at least two printer brands.

### Risks
- Printer rejects PDF over IPP. Mitigation: per-printer language setting, with raster (PWG/JPEG) fallback or vendor SDK.

---

## Phase 6: Thermal Pipeline: Receipt and Label (3 weeks)

**Goal:** receipt and label printers over USB, Bluetooth and network.

### Tasks
**Week 1: raster and ESC/POS**
- PDF → bitmap (`PdfRenderer` on Android, `pdfium-render` on Windows).
- Scale to printer dot width (384 for 58 mm, 576 for 80 mm), grayscale, threshold or dither to 1-bit.
- ESC/POS encoder in Rust: init, raster bitmap (`GS v 0`), feed, cut, cash drawer, codepage.
- Chunked sending with flow control for slow links.

**Week 2: label printers**
- Raster-first: reuse the 1-bit bitmap pipeline at the label printer's DPI (203 or 300) and wrap it in the printer's command language.
- Command encoders in Rust: TSPL/TSPL2 (`BITMAP`), ZPL (`^GF`) and CPCL (`CG`), each with golden-byte tests.
- Label options per printer: label width and height, gap or black-mark sensing, darkness, speed, tear-off or cut, calibration command.
- The per-printer `language` setting selects the encoder (pdf, escpos, tspl, zpl, cpcl, raster).

**Week 3: Android connectivity**
- USB: `UsbManager` device listing, runtime permission prompt, bulk transfer endpoint.
- Bluetooth Classic: pairing check, RFCOMM SPP socket, `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` permission flow.
- Printer Setup wizard with a **Test print** button and per-printer options (paper width, DPI, cut, drawer, codepage).

### Deliverables
- 58 mm and 80 mm thermal printing from Android over USB and Bluetooth.
- Label printing (for example 4x6 in / 100x150 mm) in at least one of TSPL, ZPL or CPCL.

### Acceptance criteria
- Barcode and QR printed from a template scan correctly.
- A 30 cm receipt prints without dropped chunks or garbage characters.
- A label prints at the correct size, with gap alignment and a scannable barcode.

---

## Phase 7: Windows USB/Bluetooth and Visual Designer (2 weeks)

**Goal:** feature parity on Windows and a friendlier designer.

### Tasks
**Week 1: Windows connectivity**
- Raw USB via WinUSB (`rusb`) for thermal receipt and label printers, with spooler-based fallback.
- Bluetooth printers via paired system printers or virtual COM port (`serialport` crate).
- Unified Printer Setup UI across both platforms.

**Week 2: designer upgrade**
- Integrate GrapesJS with blocks: text, image, table (looping), line, page break, and a barcode block exposing every symbology from Phase 2.
- Two-way sync between visual canvas and the code tab.
- Image upload stored as embedded data URIs.

### Deliverables
- Thermal printing on Windows; visual designer.

### Acceptance criteria
- A template built visually prints the same as its exported HTML.
- A USB thermal printer prints on Windows without a system driver installed.

---

## Phase 8: Automation: Local REST API and Deep Links (2 weeks)

**Goal:** other apps, POS systems and web pages can trigger prints without touching the UI.

### Tasks
**Week 1: local REST API** (spec in section 7.1)
- Embed an `axum` server inside the Rust core, started and stopped from Settings > API.
- Endpoints for health, printers, templates, print, batch print, job status, retry and cancel.
- API key auth, IP allowlist, CORS allowlist, body size limit, rate limit, idempotency keys.
- Settings > API screen: enable toggle, port, key management, LAN access toggle, ready-to-copy `curl` examples, request log.
- Android: run the server inside a **foreground service** with a persistent notification; guide the user on battery optimization.
- Windows: handle the firewall prompt when LAN access is enabled; optional run-at-login and start-minimized-to-tray.

**Week 2: deep links** (spec in section 7.2)
- Register `printninja://` on Windows (installer) and Android (intent filter).
- Single-instance forwarding so a link opens in the running app on Windows.
- Parser and validator for `print`, `open` and `template` actions.
- Confirmation sheet (shadcn Dialog/Sheet) with a "trust this source" option.
- Optional `callback` URL to report success or failure to the calling app.

### Deliverables
- A script or POS system can print through `POST /v1/print`.
- A web page link can launch a print with a preset on Android and Windows.

### Acceptance criteria
- `POST /v1/print` returns a job id in under 200 ms and the job appears in History with source `api`.
- Requests without a valid key are rejected, and the server is not reachable from the LAN unless enabled.
- Repeating a request with the same idempotency key does not print twice.
- The API keeps accepting jobs while the Android app is in the background.
- A deep link opens the correct preset and asks for confirmation unless the source is trusted.

---

## Phase 9: Polish, Packaging and QA (2 weeks)

**Goal:** production-ready release.

### Tasks
- First-run onboarding (add printer, load sample template, test print).
- Friendly error messages and a diagnostics export (logs with secrets redacted).
- Settings page: theme (light / dark / system), retention, allowed domains, default printer, API.
- Windows: signed installer (NSIS or MSIX) with `printninja://` registration, auto-update via the Tauri updater.
- Android: signed AAB, Play Store listing, permission rationale text, Data Safety form (declare local network server and foreground service).
- Accessibility pass (keyboard, focus rings, contrast in both themes) and i18n scaffolding (English only in v1).
- Full QA run (section 9).

### Deliverables
- Release candidates for Windows and Android.

### Acceptance criteria
- All items in the QA matrix pass.
- No known critical or high bugs.

---

## 7. Feature Specifications

### 7.1 Local webhook / REST API

Runs inside the app (`axum`). Default: **disabled**, bound to `127.0.0.1`, port `17717` (configurable).

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | Version and status |
| GET | `/v1/printers` | List configured printers and state |
| GET | `/v1/templates` | List templates (id, name, variables) |
| POST | `/v1/print` | Create a print job |
| POST | `/v1/print/batch` | Create a batch (array of records) |
| GET | `/v1/jobs/{id}` | Job status and error |
| GET | `/v1/jobs?status=failed` | List jobs |
| POST | `/v1/jobs/{id}/retry` | Retry a failed job |
| DELETE | `/v1/jobs/{id}` | Cancel a queued job |

Example request:

```http
POST /v1/print
Authorization: Bearer pn_live_xxxxxxxx
Idempotency-Key: order-1042

{
  "template": "receipt-80mm",
  "printer": "Front Desk",
  "data": { "order": 1042, "items": [ { "name": "Tea", "qty": 2, "price": 3.5 } ] },
  "settings": { "copies": 2, "fit": "fit-width" },
  "callback_url": "https://pos.local/print-status"
}
```

- **Data source:** inline `data`, or `data_url` (fetched by the app, subject to the allowed-domains list), or `test: true` to use the template's sample dataset.
- **Response:** `202 Accepted` with `{ "job_id": "...", "status": "queued" }`. Add `?wait=true` to block until done (with timeout).
- **Callback:** optional outgoing webhook with the final job status.
- **Security:** API key per client (stored hashed, shown once), scopes (`print`, `read`), IP allowlist, CORS allowlist, rate limit, 5 MB body limit, LAN access off by default, optional HTTPS with a self-signed certificate later.
- **Android:** foreground service with a persistent notification, LAN only when connected to Wi-Fi, battery-optimization guidance.
- **Docs:** OpenAPI JSON served at `/v1/openapi.json` and shown in Settings > API.

### 7.2 Deep links / URL scheme

Scheme: `printninja://`

| Link | Action |
|---|---|
| `printninja://print?preset=Lunch%20Receipt` | Run a saved preset (recommended) |
| `printninja://print?template=receipt-80mm&printer=Front%20Desk&url=https://...&copies=2` | Print with explicit parameters |
| `printninja://print?preset=X&test=1` | Print using test data |
| `printninja://open/history` | Open a page |
| `printninja://template/{id}` | Open a template in the Designer |

- Supported parameters: `preset`, `template`, `printer`, `url`, `copies`, `orientation`, `fit`, `test`, `confirm`, `callback`.
- **Never accept tokens or headers in the link.** Auth comes from the preset or keyring.
- Default behavior shows a **confirmation sheet** before printing; users can mark a source (calling app or domain) as trusted to skip it.
- The allowed-domains list applies to `url`.
- Windows: protocol registered by the installer, `single-instance` plugin forwards the link to the running app.
- Android: custom-scheme intent filter now, verified HTTPS App Links optional later.
- `callback=https://...` or `callback=myapp://done` receives `status=success|failed&job_id=...`.

### 7.3 Template versioning

- A **snapshot** is created on explicit Save, on restore, and by autosave at most once every few minutes when content changed.
- Each version has a number, timestamp, optional label and note (for example "Added logo").
- **Version panel:** list, preview thumbnail, label/rename, restore, delete.
- **Diff view:** side-by-side HTML and CSS comparison between any two versions.
- **Restore** creates a new version (nothing is overwritten), so history is never lost.
- Print jobs store `template_version_id`; History reprints use that exact version.
- Retention: keep the last N autosaves (default 50) and every labeled version.
- Export/import includes version history as an option.

### 7.4 Custom fonts and Unicode (Latin + CJK)

- **Font manager** (Settings or Designer): upload TTF, OTF or WOFF2; preview; delete. Files are stored in the app data folder.
- Fonts are exposed as `@font-face` in the designer, in the render webview, and in PDF export (embedded automatically by the engine).
- **Bundled fallback stack (v1):** Noto Sans (Latin) in the installer, plus Noto Sans CJK (JP, SC, TC, KR) downloaded on demand to keep the installer small. Other scripts are out of scope for v1.
- Check **font licenses** before bundling; show a license reminder on upload.
- Thermal printers: because pages are rasterized, any script prints correctly regardless of the printer's built-in codepages.
- Test pages: Latin, CJK (Japanese, Chinese, Korean) and emoji.

### 7.5 Barcode variety

- Library: **bwip-js**, generating **inline SVG** at render time so the final HTML needs no scripts.
- Supported: Code 128, Code 39, Code 93, EAN-13, EAN-8, UPC-A, UPC-E, ITF/ITF-14, Codabar, QR, Micro QR, DataMatrix, PDF417, Aztec, GS1-128, GS1 DataMatrix.
- Template helper: `{{barcode type="code128" value=order.id height=12 text=true}}` and `{{qr value=url size=25}}` (sizes in mm).
- Designer: symbology picker, live preview, **input validation** (EAN digit count, check digit auto-calculation, charset limits).
- Print quality: render at the printer DPI, keep module widths on whole dots to avoid blurry bars on thermal output.
- Include a **barcode test sheet** template for scanner verification.

### 7.6 Test data mode

- Designer: multiple named **sample datasets** per template, with a generator for repeated rows.
- Print page: a **Use test data** switch that replaces the data URL with the chosen sample dataset.
- Options: **Preview only** (no printing) or print with an optional "TEST" watermark.
- Test jobs are flagged `is_test` in History and can be filtered out.
- API and deep links support `test=true` for integration testing.

### 7.7 Printer-specific profiles

- A profile stores settings for one printer + template pair: margins, fit mode, scale, orientation, x/y offset, density/darkness, copies, cut mode.
- Priority order (highest wins):
  1. Values typed on the Print page for this job
  2. Preset
  3. Printer + template profile
  4. Printer defaults
  5. Template defaults
- "Save as profile" button on the Print page; profile manager in Printer Setup.
- Includes **calibration helper**: print a ruler/grid test page and adjust offsets until it aligns.

### 7.8 Batch / bulk print

- **Input:** JSON array (pasted or from URL with JSON path), CSV upload with column-to-variable mapping.
- **Modes:** *Single job* (all records as pages of one PDF, best for office printers) or *One job per record* (best for thermal receipts and labels with a cut between).
- **Progress UI:** table with per-record status, pause, resume, cancel, and "retry failed only".
- A bad record is logged and skipped by default; an option stops the batch on first error.
- Safety limits: configurable max records per batch (default 5,000), render in chunks to keep memory low, confirm dialog showing record count and page estimate.
- History groups the batch under one row with per-record detail, and failed records can be exported to CSV.

### 7.9 UI: shadcn/ui with dual mode (light / dark)

- **Framework:** React + Vite + TypeScript (Tauri's recommended setup, no SSR needed).
- **Theme:** `ThemeProvider` with light, dark and system options, using shadcn CSS variables. The choice is persisted and applied before first paint to avoid a flash.
- Designer canvas and print preview always render as white paper, in both themes.
- Component mapping: Sidebar and Sheet for navigation, Resizable for designer panels, Table + TanStack Table for History, Form + zod for the Print page and printer wizard, Command for quick template/printer search, Sonner for toasts, Dialog for confirmations, Badge for job status.
- Mobile layout: bottom navigation, full-screen Sheets instead of side panels, large touch targets.
- Accessibility: keyboard navigation, visible focus, WCAG AA contrast checked in both themes.

---

## 8. Page Reference

### Designer
Page setup, canvas, visual blocks, code editor, variables panel with sample datasets, helpers, barcodes, custom fonts, version history and diff, import/export, autosave.

### Printer Setup

| Type | Android | Windows |
|---|---|---|
| Wi-Fi/LAN | mDNS or manual IP; IPP or raw 9100 | Same via Rust |
| USB | `UsbManager` + permission, bulk transfer | System spooler; WinUSB for thermal |
| Bluetooth | Classic SPP (BLE later) | Paired system printer or virtual COM |
| System | n/a | Spooler list |

### Print
Printer, template, URL, orientation, margins, fit mode, copies, test data switch, preview, presets, printer-template profiles, batch print.

### History
List, filters (including source and test jobs), details with template version, batch grouping, reprint, retry, export, retention.

### Settings
Theme (light / dark / system), fonts, API (key, port, LAN access, request log), deep link trust list, allowed domains, retention.

---

## 9. Testing Strategy

- **Unit tests:** template rendering, fit-scale math, IPP encoder, ESC/POS and label-language (TSPL/ZPL/CPCL) encoders (golden byte comparisons).
- **Integration tests:** mock IPP server and a TCP 9100 sink in CI.
- **Device matrix:**
  - One laser/inkjet over IPP
  - One 58 mm and one 80 mm thermal over USB and Bluetooth
  - One thermal label printer (TSPL, ZPL or CPCL) over USB and Bluetooth
  - Windows 10 and 11; Android 10 to 14
- **Print fidelity checklist:** margins, orientation, each fit mode, multi-page, non-Latin fonts, barcode scan.
- **Failure tests:** printer off, out of paper, network drop mid-job, app killed mid-job.
- **API tests:** auth failures, rate limiting, idempotency replay, large bodies, concurrent requests, LAN access on/off, Android background operation.
- **Deep link tests:** malformed links, untrusted source confirmation, callback delivery, link while the app is closed or already running.
- **Versioning tests:** restore correctness, diff accuracy, reprint uses the stored version.
- **Fonts tests:** Latin and CJK pages in preview, PDF and thermal raster.
- **Barcode tests:** scan every symbology at each printer DPI.
- **Batch tests:** 1, 200 and 5,000 records, a bad record mid-batch, cancel and resume.
- **Theme tests:** every page in light and dark mode on both platforms; paper preview stays white.

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Printer rejects PDF over IPP | Per-printer language; raster fallback or vendor SDK |
| Tauri Android has a younger ecosystem | Thin Kotlin plugins behind the Rust trait; spike early |
| Android Bluetooth/USB permission friction | Guided setup flow, clear messages |
| Thermal output blurry or slow | 1-bit dither at native width, chunked sends |
| Cleartext LAN traffic blocked | Scoped network security config |
| Untrusted templates or data (XSS, SSRF) | Handlebars escaping, sandboxed render webview, domain allowlist |
| Android kills background jobs | Foreground service during queue processing |
| Windows SmartScreen warnings | Code-signing certificate |
| Local API exposed to the network or other apps | Disabled by default, localhost only, API keys, IP allowlist, rate limit |
| Android kills the API server in the background | Foreground service, battery-optimization guidance, visible status |
| Malicious deep links triggering prints | Confirmation sheet, trusted-source list, no secrets in links, allowed-domains check |
| Font licensing and installer size | License reminder on upload, download CJK fonts on demand |
| CJK rendering differs across WebViews | Test Latin and CJK on target WebView versions; bundle Noto Sans, download Noto CJK on demand |
| Barcodes unscannable at low DPI | Whole-dot module widths, minimum size validation, scan test sheet |
| Large batches exhaust memory | Chunked rendering, per-record jobs for thermal, configurable limits |
| Label printer command languages differ by vendor | Raster-first output wrapped in TSPL/ZPL/CPCL; per-printer language setting; test one printer per language |

---

## 11. Security Notes

- Tokens live in the keyring only and are redacted from history and logs.
- Render in an isolated webview with scripts and network disabled.
- Allowed-domains setting for data URLs; block private IP ranges optionally.
- All data stays local in v1; include a clear privacy statement.
- REST API: off by default, `127.0.0.1` only unless LAN access is enabled, per-client keys stored hashed, request log without payload secrets.
- Deep links: treat every link as untrusted input, validate and confirm, never carry credentials.
- Uploaded fonts are parsed only by the rendering engine and never executed or served externally.

---

## 12. Decisions

All open decisions have been answered and applied to this plan.

| # | Decision | Answer | Applied in |
|---|---|---|---|
| 0 | App name | Keep "PrintNinja"; no name check needed | Header |
| 1 | Target printers | All types: office (PDF/IPP), thermal receipt (ESC/POS), thermal label (TSPL/ZPL/CPCL) | Data model, Phase 6 (now 3 wks), Phase 7, testing, risks |
| 2 | Data URL format | JSON; ready-made HTML is not supported in v1 | Print pipeline, Phase 3 fetcher |
| 3 | Scheduled and polling triggers | Not in v1 | Scope, post-v1 backlog |
| 4 | UI language | English only in v1, i18n scaffolding kept | Phase 0, Phase 9 |
| 5 | Dual mode | Light and dark theme | 7.9, Phase 0 |
| 6 | Fonts and scripts | Latin + CJK only; other scripts out of scope | 7.4, Phase 2, testing, risks |

### Post-v1 backlog
- Scheduled and polling triggers (timers, folder watch, URL polling).
- Additional UI languages.
- Ready-made HTML as a data source.

---

## 13. Definition of Done (v1)

PrintNinja v1 is done when a user can:

- Create a template, set page size and orientation, and preview it with sample data.
- Add Wi-Fi, USB and Bluetooth printers on Android, and Wi-Fi, USB and system printers on Windows, covering office, thermal receipt and thermal label printers.
- Print with fetched JSON data, silently, with all options honored.
- Every job, successful or failed, appears in History with reprint support.
- Version a template, compare versions and restore an older one.
- Use custom fonts and Latin and CJK text in templates, with correct output on paper and on thermal printers.
- Place any supported barcode type and scan it from the printout.
- Print a batch of records from JSON or CSV with progress and retry of failed records.
- Test layouts with sample data without touching the live data source.
- Save per-printer profiles that apply automatically.
- Trigger prints from another app through the REST API or a `printninja://` deep link.
- Use the whole app in light or dark mode, built with React and shadcn/ui.
- Signed builds ready for distribution on both platforms.
