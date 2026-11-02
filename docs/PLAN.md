# Feature Pack Plan — PrintNinja v2.5

> Five features that close the loop between discovery, printing, and integration.
> Status: **planning** · Target: `v2.5` · Branch strategy: one branch per feature, merge to `develop`

## Overview — sorted easy → hard

| # | Feature | Effort | Problem today | Outcome |
|---|---------|--------|---------------|---------|
| 1 | Starter template packs | ~2–3 days | New template always starts from one shipping-label example | Creator picks Receipt / Delivery Slip / Invoice / Label / Blank before editing |
| 2 | Webhook callbacks (`callback_url`) | ~2–4 days | `POST /v1/print` with `callback_url` is rejected with 400; POS systems poll `/v1/jobs/{id}` instead | Successful/final jobs POST to the caller's URL |
| 3 | Auto discovery (mDNS) | ~4–7 days | "Add printer" requires typing an IP; finding a PC requires a `/24` brute scan | Printers and PCs appear automatically on the same LAN |
| 4 | Direct thermal printing from Android | ~5–8 days | Android offers only PDF — ESC/POS, ZPL, TSPL, CPCL, raster are disabled | An Android phone drives a thermal head directly, no PC needed |
| 5 | Encrypted LAN traffic | ~2–3 weeks | All LAN traffic (pairing, render, print) is plain HTTP | LAN traffic is encrypted with pinned certificates |

Why this order: 1 is frontend-only with no native/Rust/network risk; 2 is a small isolated Rust API addition; 3 adds cross-platform crates and multicast but is well-trodden; 4 needs `WebView` screenshot at exact dot size + device QA on real thermal heads; 5 touches every LAN path plus cert lifecycle and backwards compat. Dependencies are small — 5 benefits from 3 (`tls`+`fp` TXT) and from 4 (one fewer plain-HTTP printer path), otherwise each ships independently.

---

## 1. Starter template packs

### Current state

- Every new template starts from one example: `src/lib/templates/defaultTemplate.ts` — `DEFAULT_TEMPLATE_HTML` (shipping label 4×6, 102×152 mm) + `DEFAULT_TEMPLATE_CSS` + `DEFAULT_MOCK_DATA` + `defaultTemplateReadme`. Created via `newTemplateContent(name)` in `Designer.tsx:createNewTemplate` (server-first `createTemplateOnServer`, local fallback). No choice is offered.
- `docs/ARCHITECTURE.md` §2 mentions templates as HTML+placeholders; `docs/UI_GUIDE.md` Templates row describes Mine/Saved/Community.

### Design

#### Pack catalogue

Add a new module `src/lib/templates/packs/` — one file per pack, each exporting `{ id, name, description, icon, page_w_mm, page_h_mm, html, css, readme, mockData }`. Packs are **bundled code**, not server rows — they work offline and need no migration.

Proposed packs for v1 (5 + blank):

| Pack | Page | Preview | Data shape |
|------|------|---------|------------|
| **Receipt** (80 mm roll) | 80×200 mm | Header, items table with `{{#each order.items}}`, subtotal/tax/total, footer | `order.{id,date,cashier,items:{name,qty,price,total},subtotal,tax,discount,total,payment}` |
| **Delivery Slip** | 80×200 mm or 102×152 mm | From/To blocks, contents list, barcode | Variant of current shipping label, tuned for courier use |
| **Invoice** (A4) | 210×297 mm | Seller/buyer blocks, line table with totals, due date, payment ref | `seller`, `buyer`, `invoice.{number,date,due,items,subtotal,tax,total,notes}` |
| **Shipping Label** (4×6) | 102×152 mm | Current `DEFAULT_TEMPLATE_HTML` as-is | `store`, `customer`, `order.{id,tracking,items}` |
| **Kitchen Ticket** (80 mm) | 80×150 mm | Large order number, items with modifiers, notes, timestamp | `ticket.{number,table,items:{name,qty,mods,note},createdAt}` |
| **Blank** | 80×200 mm | Minimal body with one `{{message}}` placeholder | `{ message: "Hello" }` |

Each pack's `html` uses Tailwind classes and the same helpers (`{{barcode}}`, `{{currency}}`, `{{date}}`) as real templates — the Designer preview renders them identically. `css` stays `DEFAULT_TEMPLATE_CSS`. `readme` follows `defaultTemplateReadme` shape (What it prints / Data contract / Placeholders / Printer requirements / Changelog) with the pack's own table.

Selection is **exclusive**: one pack per new template. No multi-pack merge.

#### Creator flow

Replace the current "New template" dialog (single name field) with a two-step chooser:

1. **Step 1 — Pick a pack.** Grid of 6 cards (5 packs + Blank), each showing a `PaperThumb`-style thumbnail (scaled HTML preview or a static SVG illustration), name, and one-line description. Cards are keyboard-navigable, `aria-selected`. Default selection: Receipt (most common POS case) or the last-used pack remembered in `localStorage` (`printninja.last_pack`).
2. **Step 2 — Name it.** Same name field as today (unique check, offline guard). The name default can be hinted from the pack (e.g., "Receipt" → "Receipt", but the user still types it).

On confirm: `newTemplateContent(name, packId)` returns the pack's content instead of the single default. The rest of `createNewTemplate` (server-first `createTemplateOnServer` + local fallback) is untouched — only the content source changes. The mock data for the chosen pack can be auto-inserted as a dataset if the user has no datasets yet (optional, not required for v1).

Backwards compatible: `newTemplateContent(name)` with no `packId` keeps returning the shipping label (existing tests and deep links that call it without a pack still work).

#### Where packs live vs Community

Packs are **starters**, not community templates — they are not published, saved, or synced. They only affect the `New template` action. The Templates → Community tab is unchanged. A future "Save as starter" (team-shared packs) is out of scope.

### Files to touch

- New: `src/lib/templates/packs/index.ts` (catalogue, `getPack(id)`, `PACKS` list), `src/lib/templates/packs/receipt.ts`, `deliverySlip.ts`, `invoice.ts`, `shippingLabel.ts` (refactor existing `DEFAULT_TEMPLATE_HTML` here), `kitchenTicket.ts`, `blank.ts`, plus `packs/__tests__/` if the pack contract is tested.
- Modify: `src/lib/templates/defaultTemplate.ts` (re-export from packs, keep `DEFAULT_TEMPLATE_HTML` for backwards compat), `src/pages/Designer.tsx` (new chooser dialog, `createNewTemplate(packId)`), `src/components/designer/` maybe new `PackChooser.tsx`, `src/lib/i18n/locales/en.ts`+`ja.ts` (pack names, descriptions, chooser strings), `src/test/` (update the default-template drift test to cover every pack's placeholder-vs-data-contract table).
- Thumbnails: `src/components/PaperThumb.tsx` already renders a scaled preview — reuse it for pack cards, or use static SVGs if live render is too heavy for the grid.

### Tests

- Unit: every pack's HTML renders without Handlebars errors against its mock data; `compileTemplateCss(pack.html)` succeeds; readme's placeholder table covers every `{{…}}` in the HTML (same drift guard as today, per pack).
- Frontend: chooser shows 6 cards, selects one, creates a template with that pack's HTML; Blank creates a minimal template; cancelling the chooser creates nothing.
- e2e: Designer → New → pick Invoice → name → Save → assert the created template's HTML contains the invoice markers.

### Rollout

Independent. No Rust, no server, no schema change. Docs: `docs/UI_GUIDE.md` Designer row and `README.md` "Make a template" section. Add a screenshot of the chooser to the README if desired.

---

## 2. Webhook callbacks (`callback_url`)

### Current state

- `POST /v1/print` accepts `callback_url?: string` in `PrintJobRequest` (`src-tauri/src/api/routes.rs:266`) but **unconditionally rejects it with 400** before any DB work (`routes.rs:383`). Rationale in the comment (P12): *"there is no callback runner, so a caller that relied on one would never learn the outcome."* Test `src-tauri/tests/api_routes.rs:403 callback_url_is_refused_with_400_before_anything_runs` pins this.
- Polling (`GET /v1/jobs/{id}`, `GET /v1/jobs`, `POST /v1/jobs/{id}/retry`, `DELETE /v1/jobs/{id}`) is the only async completion path. `docs/ARCHITECTURE.md` never mentions webhooks.
- No `webhooks` table, no runner, no signing.
- OpenAPI (`src-tauri/src/api/openapi.rs:88/126`) documents `callback_url` as 400.

### Design

Turn `400` into a **best-effort POST** after the job reaches a terminal state. POS systems need "printed" notifications, not another poll loop.

#### Contract

- **Request:** `POST /v1/print` with `callback_url: "https://pos.example.com/hooks/printninja"` (HTTPS only by default; see SSRF below). Any other fields unchanged. `Idempotency-Key` semantics unchanged — a duplicate still returns `duplicate` and **does not** fire a second callback.
- **Validation (before any DB work, same place the 400 lives today):**
  - Must be `https://` (configurable strict flag; `http://` allowed only when `PRINTNINJA_CALLBACK_ALLOW_HTTP=1` for on-prem POS inside the LAN).
  - Host must not be private/loopback/link-local unless `PRINTNINJA_CALLBACK_ALLOW_PRIVATE=1`. Default: **block private** (reuse `is_private_host` from `peer_consume.rs`).
  - URL length ≤ 2048, scheme+host parse must succeed, no credentials (`user:pass@` rejected).
  - On validation failure: `400` with `code: callback_url_invalid` and a message naming the reason (same shape as `template_missing` 409).
- **Delivery:** after `run_print` finishes and the job row is in `success` **or** `failed` (not `queued`/`printing` — `run_print` is synchronous today, so there is no intermediate state to notify about; if a queued worker path is added later, the same dispatch runs on the `printing → terminal` transition in `worker.rs`):
  - `POST callback_url` with `Content-Type: application/json`, body:
    ```json
    {
      "event": "print.succeeded" | "print.failed",
      "job_id": "123",
      "status": "success" | "failed",
      "printer": "Front Desk",
      "template": "Receipt",
      "error": null | "…",
      "duration_ms": 842,
      "timestamp": "2026-05-01T12:34:56.789Z",
      "idempotency_key": "order-1042" | null
    }
    ```
  - Headers: `X-PrintNinja-Event: print.succeeded|print.failed`, `X-PrintNinja-Job-Id: 123`, `User-Agent: PrintNinja/2.5`.
  - **Signing (recommended):** `X-PrintNinja-Signature: sha256=<hex(hmac_sha256(secret, raw_body))>` where `secret` is per-callback or a global `PRINTNINJA_CALLBACK_SECRET`. POS verifies HMAC to prove the POST came from this PrintNinja. Secret is optional; when absent the header is omitted. Document both.
- **Reliability:**
  - **Retries:** 3 attempts with exponential backoff (e.g., 5 s, 25 s, 125 s). Each attempt has a 10 s connect+read timeout. Failures are logged (`warn`) with `job_id`, `callback_url` host (not full URL in logs), `status`, `attempt`, `error`. No infinite retry — a dead POS should not fill the log.
  - **Execution:** fire-and-forget `tokio::spawn` after the job row is committed, so the `POST /v1/print` response is **not** delayed. The API response still reports `success`/`failed` synchronously as today — the callback is additive, not a replacement.
  - **No DB queue for v1:** retries live in memory (the spawned task). If the app restarts between attempts, the remaining retries are lost. Acceptable for LAN POS: the POS can still poll `GET /v1/jobs/{id}`. A durable retry table (`callback_deliveries`) is a follow-up if operators ask for it — design leaves room (job row can carry `callback_url`, `callback_attempts`, `callback_last_error`).
- **Loopback vs LAN:** same auth gate as the print itself (`require_paired_or_local` already ran). A LAN caller that was allowed to print is allowed to set a callback — no extra permission. Loopback callers are always allowed.
- **OpenAPI:** update `src-tauri/src/api/openapi.rs` — `callback_url` 400 becomes 400 only for invalid URLs; valid URLs produce a job plus a best-effort callback (documented under `POST /v1/print` responses). Add `X-PrintNinja-*` headers to the spec.

#### SSRF hardening

Callbacks make the app fetch an attacker-controlled URL if the POS is compromised or the print was triggered via a deep link / paired phone. Defences:

- Private-IP block by default (above).
- `http://` blocked by default.
- URL length cap, no credentials, host allowlist optional (`PRINTNINJA_CALLBACK_ALLOWLIST=pos.example.com,hooks.internal` — when set, only those hosts are allowed).
- Body size of the callback **response** is ignored (cap 64 KiB, never rendered). The app never follows redirects from the callback POST automatically (single hop only, or 0 with `redirect: manual`).
- Log redaction: never log the full callback URL with query params (log `host` + `path` truncated).

### Files to touch

- Rust: `src-tauri/src/api/routes.rs` (replace the 400 with validation + dispatch), new `src-tauri/src/api/callback.rs` (validate, sign, `dispatch_callback(job, url)` with retry loop), `src-tauri/src/commands/print.rs` if the worker path needs the same dispatch, `src-tauri/src/api/openapi.rs` (spec), `Cargo.toml` maybe `hmac`+`sha2` if not already present (sha2 already is).
- Tests: `src-tauri/tests/api_routes.rs` (update the 400 test to assert valid URL succeeds, invalid URL still 400; add `callback_is_dispatched_on_success` with a `wiremock`/`httptest` fake POS that asserts the POST body and optional HMAC), `src-tauri/src/api/callback.rs` unit tests (private-IP block, http block, allowlist, HMAC).
- Frontend: optional — `src/pages/Automation.tsx` or `ApiExplorer.tsx` show the callback example in the Try-the-API panel. Not required for POS callers (they use `curl`).
- Docs: `docs/ARCHITECTURE.md` §3 step 8 or §9 (new "Webhooks" subsection), `README.md` Automate it section.

### Rollout

Independent of other features. No schema migration for v1 (in-memory retries). If retries need durability later, migration adds `print_jobs.callback_url`, `callback_attempts`, `callback_last_error` columns. Backwards compatible: omitting `callback_url` behaves exactly as today.

---

## 3. Auto discovery of printers and PCs (mDNS)

### Current state

- Network printers: **no discovery on any platform** (`docs/ARCHITECTURE.md` §4, `src-tauri/src/transport/mod.rs:350`). The user types `host:port` by hand. On Android the Kotlin `MdnsDiscovery` already exists and is wired through `discover_network_printers` → `AndroidBridge::discover`, but it is only called from the Add-printer sheet on Android (`src/pages/PrinterSetup.tsx:250`). Windows/Linux callers hit the empty branch.
- PCs (render peers): **no mDNS at all**. Discovery is the `/24` hello probe (`src-tauri/src/commands/api.rs:1207 probe_subnet` — 254 hosts, 64 concurrent, ~1–2 s) plus a typed `host:port` fallback. `GET /v1/pair/hello` already answers when sharing is on (with `protocol`, `provider_id`, `window_open`).

### Design

#### 1a. Advertise — the PC / printer as a service

Each desktop that has **Sharing on** (or the API on LAN) advertises a service:

- Type: `_printninja._tcp` (new, not `_ipp._tcp` — that type belongs to printers). PTR → `PrintNinja-<hostname>._printninja._tcp`.
- TXT records: `prot=1` (wire protocol version), `id=<provider_id>` (stable per install, from `ensure_provider_id`), `port=<api_port>`, `plat=windows|linux`, `ver=2.5.0`. TXT stays short (< 200 bytes) so it fits in one DNS response.
- Lifetime: started when sharing (or LAN API) comes up, stopped when it goes down. Restarted on port change.

Separate advertising for **printers provided by this PC** is out of scope — those printers already advertise via IPP/CUPS/Windows spooler. Discovery of *other printers* (1b) covers them.

#### 1b. Browse — find printers on the LAN

Add a native browse path on each desktop platform (reuse the Android one where it exists):

| Platform | Mechanism | Service types browsed | Where |
|----------|-----------|-----------------------|-------|
| Android  | `NsdManager` (`MdnsDiscovery.kt:69 discoverOnce`) — already exists | `_ipp._tcp`, `_ipps._tcp`, `_pdl-datastream._tcp`, `_printer._tcp` | Keep, extend timeout to 8 s, surface in Printers UI |
| Windows  | `windows-dns` crate or raw `DNSServiceBrowse` via `windows` crate | Same four printer types | New `src-tauri/src/discovery/mdns_windows.rs` |
| Linux    | `mdns-sd` crate (pure Rust, no Avahi dependency) | Same four printer types | New `src-tauri/src/discovery/mdns_linux.rs` |

Browse is **on-demand** (button "Scan network") plus one background browse for **30 s after the Printers page mounts** — not continuous, to avoid steady multicast chatter and Android battery cost. Results are deduped by `host:port` (same key `MdnsDiscovery` already uses), shown as "Discovered" rows with name, host, port, kind (`ipp`/`raw_tcp`), and a one-click "Add". Adding still writes a normal `printers` row; discovery is not a separate printer kind.

`TransportRegistry::discover_all` remains the spooler/CUPS path; mDNS results are merged in the Tauri command that the PrinterSetup page calls (new `discover_network_printers_mdns` command, or extended `discover_printers`).

`dev-printer/server.cjs --mdns` already advertises `_ipp._tcp` via `bonjour` for development — keep it and add a second fake `_printninja._tcp` advertisement for the PC flow so CI can test without real hardware.

#### 1c. Browse — find PCs (peers) on the LAN

Same browse loop, but for `_printninja._tcp`:

- Browser collects `{ host, port, provider_id, platform, protocol, version, name }` from each PTR+SRV+TXT. Dedupe by `provider_id`.
- Pairing dialog (`DevicesCard` / `pair_with_code` flow) shows "Nearby PCs" above the manual code field. Tapping a row fills `host:port` (or directly probes `hello_at` for that host — the 8-char code is still required).
- The existing `/24` probe in `pair_with_code` stays as **fallback** — mDNS can be blocked by AP isolation or VLANs, so a direct probe must still work. Order: mDNS hits first (they are already resolved), then `/24` sweep for anything mDNS missed.
- `GET /v1/pair/hello` does **not** need to change: it already answers 200 when sharing is on. The mDNS TXT just caches what a `hello` would have returned, saving one HTTP round-trip per candidate.

### Security and scope

- mDNS is link-local multicast — no internet exposure. Still: browsed addresses are validated by `is_private_host` before use (same gate as typed addresses). A spoofed mDNS response that points at a public IP is discarded.
- TXT `provider_id` is not a secret (it is already returned by `hello` unauthenticated). The per-device token remains the credential; mDNS only helps find the host.
- Rate: one browse burst per user action, not continuous. No cache longer than the browse window plus 60 s for the peer caps cache (`CAPS_TTL`) that already exists.

### Files to touch

- New: `src-tauri/src/discovery/mod.rs`, `discovery/mdns_windows.rs`, `discovery/mdns_linux.rs` (Linux uses `mdns-sd`, Windows uses `windows` DNS-SD). Shared helpers: `discovery/types.rs` (`DiscoveredPrinter`, `DiscoveredPeer`).
- Modify: `src-tauri/src/commands/printer.rs` (merge mDNS results into `discover_printers`), `src-tauri/src/commands/api.rs` (start/stop advertiser alongside `launch_server` / `stop_api_server`), `src/lib/agent/commands.ts` (new `discover_network_*` agents), `src/pages/PrinterSetup.tsx` + `src/components/DevicesCard.tsx` (UI: "Scan" button + "Nearby PCs" list), `plugins/tauri-plugin-android-print` (reuse `MdnsDiscovery` for printer scan; advertise `_printninja._tcp` via `NsdManager.registerService`).
- Dev: `dev-printer/server.cjs` (second advertisement), `Cargo.toml` (new deps: `mdns-sd` on Linux, `windows` DNS-SD feature on Windows).

### Tests

- Rust unit: TXT parse/encode, dedupe by `host:port` / `provider_id`, `is_private_host` rejection of a poisoned TXT host.
- Integration: `dev-printer --mdns` + `discover_network_printers_mdns` in `src-tauri/tests/` (bind ephemeral port, assert the fake printer and fake PC appear).
- Frontend: PrinterSetup shows Discovered rows after scan; DevicesCard shows Nearby PCs; Scan button is inert in web preview (no Tauri backend).
- e2e: Playwright with fake mDNS (dev-printer) asserts Add from discovered row creates a printer row.

### Rollout

Shippable independently. No migration, no schema change. Feature-flagged by `lan_access && sharing` — when both are off there is nothing to advertise or browse. Docs update: `docs/ARCHITECTURE.md` §4 "Discovery" paragraph and §9 "finding PCs" paragraph.

---

## 4. Direct thermal printing from Android (ESC/POS, ZPL, TSPL)

### Current state

- Android transports exist (`src-tauri/src/transport/android_usb.rs`, `android_bluetooth.rs`, file-handoff > 256 KiB, bulk-OUT / RFCOMM) but are only wired for **PDF**. `src-tauri/src/render/mod.rs` and `docs/ARCHITECTURE.md` §6 say explicitly: *"The receipt and label languages (ESC/POS, ZPL, TSPL, CPCL, raster) need a raster Android cannot produce yet, so the printer form offers only PDF there."*
- Desktop has two render paths in `render/mod.rs`: `html_to_pdf` (Edge/Chromium/WebView) and `html_to_raster` / `png_to_raster` (Edge screenshot → threshold). Android's `AndroidPrintPlugin.kt:HtmlToPdf` uses `WebView`+`PdfDocument`. The missing piece is the screenshot/raster path on Android.
- Encoding already exists and is platform-agnostic: `transport/escpos.rs`, `transport/label_langs/{tspl,zpl,cpcl}.rs`, `transport/mod.rs:encode_for_language` → `RasterImage::to_bytes`.

### Design

Unlock the existing thermal pipeline on Android by producing a `RasterImage` on the device. Two viable paths; evaluate in order and ship the first that passes quality gates.

#### Path A — WebView screenshot (preferred, no new native deps)

1. **Render** the `sheets_document` HTML (same `render/layout.rs` output already used on desktop) in a `WebView` at the paper size in px (`dots_for_mm(paper_w_mm, dpi)`). Use `WebView.capturePicture` / `draw` to a `Bitmap` of exactly `dot_width × dot_height` — mirrors `html_to_raster`'s "1 px = 1 dot" invariant so nothing is resampled.
2. **Threshold** to 1-bit with luminance `0.299R+0.587G+0.114B ≥ 128` (same as `render/mod.rs:png_to_raster`). Pack to `RasterImage`.
3. **Encode** via the existing `encode_for_language` (callable from Kotlin or via a Rust bridge that receives the raster bytes).
4. **Send** through the existing `AndroidUsbPrinter` / `AndroidBluetoothPrinter` bulk paths (unchanged).

Requires: `WebView` measured at the exact dot size (not the screen density), `onPageFinished` + `await fonts` (same `PAGINATE_SCRIPT` wait as the PDF path), and handling of multi-sheet documents (one bitmap per sheet, concatenated sends — currently desktop raster sends first sheet only; decide whether to support multi-sheet thermal on Android as follow-up).

#### Path B — Headless Chromium on Android (fallback)

If WebView screenshot cannot hit print-quality (e.g., density scaling artifacts, `capturePicture` deprecation), bundle a minimal headless renderer via `android-pdf` or cross-compile the existing `render/mod.rs` `html_to_raster` path with `cargo-ndk` to run Chromium headless inside the app sandbox. Higher cost, so only if Path A fails QA.

#### Language enablement

Once a `RasterImage` is available, every thermal language already works — just stop gating the printer form:

- `src/pages/PrinterSetup.tsx` + `src/lib/printerSchema.ts`: allow `escpos`/`tspl`/`zpl`/`cpcl`/`raster` when `isAndroid()`. Remove the "PDF only on Android" notice.
- `src-tauri/src/commands/print.rs:need_peer` — today Android always borrows a PC for thermal jobs (`need_peer` returns true when `is_android && language != Pdf`). With local raster, that guard becomes `need_peer = is_android && language != Pdf && !local_raster_available` — or removed entirely if Path A ships.
- `src-tauri/src/transport/mod.rs:create_transport` — Android arms already exist; no change needed once the raster path exists.

#### Resolution and DPI

Thermal heads are typically 203 dpi (8 dots/mm). Reuse `dots_for_mm` and the `PrinterLanguage`-specific sizing in `encode_for_language` (TSPL `SIZE`, ZPL `^XA`, etc. already use `paper_w_mm`/`paper_h_mm` + `dpi`). Default 203 dpi, overridable per printer row if a `dpi` column is added later (not required for v1).

### Files to touch

- Kotlin: `plugins/tauri-plugin-android-print/android/src/main/java/com/printninja/android_print/AndroidPrintPlugin.kt` (new `htmlToRaster` method beside `htmlToPdf`, bitmap threshold, per-sheet loop), `RasterImage.kt` helper if not bridging Rust `raster.rs`.
- Rust: `src-tauri/src/render/mod.rs` (expose `png_to_raster` helpers or add `raster_from_bitmap` for the bridge), `src-tauri/src/commands/print.rs` (relax `need_peer` gate), `src-tauri/Cargo.toml` (no new deps if Path A; `png` already present for decode).
- Frontend: `src/pages/PrinterSetup.tsx`, `src/lib/printerSchema.ts`, `src/lib/i18n/locales/en.ts`+`ja.ts` (strings for thermal languages on Android), `src/components/PrinterForm.tsx` if the language selector is there.
- Docs: `docs/ARCHITECTURE.md` §6 Android paragraph, `README.md` Features → Printers line.

### Tests

- Kotlin unit: `RasterImage` threshold matches Rust `png_to_raster` (golden PNG → bit-identical raster).
- Rust unit: `encode_for_language` already covered — add Android raster round-trip (HTML → bitmap → raster → ZPL/ESC/POS framing).
- Device test: Android emulator (`./gradlew connectedCheck`) prints a 40 mm receipt to a fake raw-TCP listener (assert `ESC @` + `GS v 0` framing), and a 102×152 mm label to assert TSPL/ZPL headers. Use `dev-printer` raw-TCP mode as the fake head.
- Frontend: form shows thermal options on Android UA, hides them nowhere else.

### Rollout

Shippable after discovery (or before — no hard dependency). No schema migration. Gate by capability: `canRaster = Android && webViewScreenshotAvailable`. If the probe says no, the UI still shows PDF only and `need_peer` keeps borrowing a PC — no behaviour change for unsupported devices.

---

## 5. Encrypted LAN traffic

### Current state

- All LAN traffic — `/v1/print`, `/v1/render`, `/v1/capabilities`, `/v1/pair/*`, printer bytes on 9100/631 — is **plain HTTP/TCP** (`docs/ARCHITECTURE.md` §9: *"traffic is plain HTTP on the local network. Pinned encryption is a planned hardening, not part of this design."*). `reqwest` is built with `rustls-tls` but the axum server never uses TLS.
- Pairing establishes a per-device Bearer token (sha256 stored, 32 random bytes). The token is sent in cleartext on the LAN.
- Printer transports: IPP (`http://host:631`) and raw TCP (`host:9100`) are cleartext. No TLS wrapping.
- The share service (`server/`) is expected to run behind a TLS reverse proxy in production (`docs/RELEASE.md` §7) — that part is not LAN.

### Threat model

- **Passive eavesdropper** on the Wi-Fi (open or WPA2-Personal with known PSK) can read tokens, print data, and templates.
- **Active MITM** on the LAN can intercept `pair/claim` and steal the token, or modify the `render` document.
- **Not in scope:** internet attacker (LAN-only), compromised OS, physical access to the printer. Pairing code brute force is already mitigated (90 s, 5 guesses, 40 bits).

### Design

#### Option A — Self-signed TLS with TOFU pinning (recommended for v1)

No CA, no provisioning service — each desktop mints its own identity and phones pin it.

1. **Identity generation (desktop, first run with LAN on):**
   - Generate an Ed25519 keypair and a self-signed X.509 certificate (CN = `PrintNinja-<hostname>`, SAN = `IP:<lan-ip>` + `DNS:printninja.local`, validity 10 years). Store `cert.pem` + `key.pem` under the app data dir (`app_data/cert/`, beside `printninja.db`), `0400` on Unix. Never overwrite if it exists — rotation is explicit.
   - Existing installs generate on next launch after upgrade; no migration prompt.

2. **Server (desktop axum):**
   - When `cert.pem` exists and LAN is on, `axum-server` (or `axum` with `rustls`) serves on **two ports**: loopback stays plain `http://127.0.0.1:17717` (local scripts, UI `api_request` — no change), LAN serves `https://0.0.0.0:17718` with the self-signed cert. Alternatively, upgrade the existing `0.0.0.0:17717` to TLS when a cert exists (loopback TLS is harmless but requires the loopback client to trust it — so the two-port split is simpler).
   - Advertised mDNS TXT adds `tls=1` + `fp=<sha256(cert DER) hex>` (SPKI pin) so the browser knows before connecting.
   - `cargo` deps: `axum-server` + `rustls` (already pulled by `reqwest/rustls-tls`) + `rcgen` (cert generation).

3. **Client (phone / peer desktop):**
   - First connection to a new `provider_id` fetches the cert (or reads `fp` from mDNS) and prompts: *"Trust PrintNinja on <hostname>? Fingerprint: ab:cd:… (SHA-256)"* with the fingerprint rendered as 16×2 hex bytes. Accept → store `pinned_fps[provider_id] = fp` in settings (same place `render_pairs` lives). Reject → abort.
   - Subsequent connections: `reqwest` with `danger_accept_invalid_certs(true)` **plus** a custom `ServerCertVerifier` that accepts only if `sha256(spki) == pinned_fp` for that `provider_id`. No CA validation, no hostname check beyond the pin — the pin *is* the identity.
   - Loopback callers bypass pinning (plain HTTP).

4. **Printer TLS (optional, v1.1):**
   - `ipps://host:631` (IPP over TLS) when the printer advertises `_ipps._tcp` — wrap the existing `IppPrinter` `reqwest` call with `https://` and the same TOFU store if the printer uses a self-signed cert (common on enterprise MFPs). Raw TCP (`9100`) has no standard TLS wrapper — leave it cleartext and document that raw-TCP printers should be on a trusted segment or behind a stunnel sidecar.

5. **Pairing under TLS:**
   - `POST /v1/pair/claim` now travels over the pinned TLS channel, so the fresh token is never cleartext. The 8-char code is still 90 s / 5 guesses — TLS adds confidentiality, not a new code scheme.
   - If TLS is not yet available (first run, cert not generated), claim falls back to plain HTTP inside the `/24` probe — still safe for the 90 s window, but the phone shows a warning *"Not encrypted — move to a trusted network"*.

6. **Rotation:**
   - `Settings → Automation → Encryption` shows the fingerprint and a "Regenerate certificate" button (requires confirmation, revokes all pins — paired phones must re-trust). Rotation also bumps `provider_id` or not? Keep `provider_id` stable — the pin is per `provider_id`, so rotation just updates the stored `fp`.

#### Option B — WireGuard / Noise tunnel (alternative, heavier)

Bundle a Noise_IK handshake (or `snow` crate) between the desktop and phone, with the 8-char pairing code as the PSK for the first handshake. Subsequent sessions use the derived session key. Pure Rust, no X.509, smaller cert story, but requires a custom framing layer over TCP and more Kotlin bridging. Prefer Option A unless X.509 generation on Android is blocked.

#### What is NOT encrypted in v1

- Raw TCP printer bytes (`9100`) — no standard. Document as cleartext.
- CUPS spooler path (`localhost:631` on Linux) — already loopback.
- Share service traffic — already expected to be behind a TLS proxy; unchanged.

### Configuration

- **Auto:** TLS on when `lan_access` is on and a cert exists. No user toggle to "disable encryption" — once a cert exists the LAN port is TLS-only. Loopback stays HTTP.
- **Env overrides:** `PRINTNINJA_TLS=0` disables cert generation (for constrained networks or debugging). `PRINTNINJA_TLS_PORT=17718` overrides the LAN TLS port.
- **Settings UI:** read-only fingerprint display + regenerate action. No "enable TLS" switch — it is automatic when LAN is on.

### Files to touch

- Rust: `src-tauri/src/api/mod.rs` (cert store, `ensure_cert`), `src-tauri/src/commands/api.rs` (`launch_server` builds `axum_server::bind_rustls` for LAN, plain `axum::serve` for loopback), `src-tauri/src/api/peer_consume.rs` (`RenderPair` client with pinned verifier, TOFU store in settings), `src-tauri/src/api/pair_routes.rs` (no change, but now over TLS), `src-tauri/Cargo.toml` (add `axum-server`, `rcgen`, `rustls-pemfile` if needed), `src-tauri/src/db/schema.sql` maybe `pinned_fps` table or reuse `settings` JSON.
- Kotlin: `plugins/tauri-plugin-android-print/android/src/main/java/com/printninja/android_print/AndroidPrintPlugin.kt` (pin store, `TrustManager` that checks SPKI pin), `src/lib/agent/commands.ts` + `src/lib/pairing.ts` (TOFU prompt), `src/pages/Automation.tsx` (fingerprint UI).
- Frontend: `src/components/DevicesCard.tsx` (TOFU dialog: fingerprint + Trust/Deny), `src/lib/i18n/locales/en.ts`+`ja.ts`.
- mDNS: `src-tauri/src/discovery/*` TXT `tls`+`fp` fields.
- Docs: `docs/ARCHITECTURE.md` §9 "Pinned encryption is a planned hardening" → concrete design, `docs/ENV.md` (`PRINTNINJA_TLS*` vars), `README.md` Security note.

### Tests

- Unit: cert generation (CN, SAN, validity, key type), SPKI pin computation (known DER → known hex), pin verifier accepts pinned / rejects wrong / rejects expired.
- Integration: ephemeral cert → launch `https://127.0.0.1:<port>/v1/health` with pinned client succeeds, unpinned client fails, wrong pin fails.
- Frontend: TOFU dialog shows fingerprint, Accept stores pin, second connect skips dialog.
- e2e: two fake desktops with different certs, phone pairs with first — assert second's pin is not accepted without re-trust.

### Rollout and compatibility

- **Backwards compatible:** old phones (no TLS code) still reach `http://host:17717` if the desktop keeps the plain LAN port open during a transition window. Plan: for one release keep **both** ports (plain + TLS) when a cert exists, with a deprecation log. Next release closes the plain LAN port.
- **No flag day:** a desktop without a cert (first run before generation, or `PRINTNINJA_TLS=0`) still serves plain HTTP — old phones work, new phones warn.
- **Migration:** no DB migration for the cert (filesystem). Pin store is `settings` JSON or a new `pinned_fps` table — add via `ensure_encryption_schema` migration.

---

## Cross-cutting concerns

### Ordering

```
1. Starter template packs        — ~2–3d, frontend-only, no native/Rust/network  → ship first
2. Webhook callbacks             — ~2–4d, small isolated Rust API (SSRF hardening is the risk)
3. Auto discovery (mDNS)         — ~4–7d, cross-platform crates + multicast, LAN QA
4. Direct thermal from Android   — ~5–8d, WebView screenshot at exact dot size, device QA
5. Encrypted LAN traffic         — ~2–3w, every LAN path + cert lifecycle + backwards compat (hardest)
```

5 benefits from 3 (`tls`+`fp` TXT) and from 4 (one fewer plain-HTTP printer path); otherwise each ships independently. If the POS webhook is urgent, ship 2 first. If the template chooser is needed for a demo, ship 1 first — it has no dependencies.

### Versioning and branching

- One branch per feature off `develop`: `feat/mdns-discovery`, `feat/android-thermal`, `feat/webhook-callback`, `feat/template-packs`, `feat/lan-tls`.
- Each branch bumps `package.json` prerelease (`2.5.0-alpha.<feature>`) and `Cargo.toml` independently; the final `2.5.0` merge resolves to one version.
- Server (`server/`) is untouched by all five except (3) webhook docs — no server deploy needed.

### Observability

- New metrics (all on `/v1/metrics` + Prometheus):
  - `mdns_discoveries_total{type="printer"|"peer", status="found"|"error"}` and `mdns_advertised{active=0|1}`
  - `android_rasters_total{language="escpos"|"zpl"|…}` and `android_raster_fallbacks_total`
  - `callback_deliveries_total{event="succeeded"|"failed", outcome="delivered"|"retry"|"dropped"}`
  - `tls_handshakes_total{result="pinned"|"unpinned"|"rejected"|"plain_fallback"}`
- Logs: every new path logs at `info` on success and `warn` on failure with the same redaction rules as existing routes (no tokens, no full URLs with query, `host` only for callbacks, `provider_id` truncated).

### Documentation updates (per feature)

| Feature | `docs/ARCHITECTURE.md` | `docs/UI_GUIDE.md` | `docs/ENV.md` | `README.md` |
|---------|------------------------|--------------------|---------------|-------------|
| 1 mDNS | §4 discovery, §9 peer finding | Printers + Automation pages | — | Install / Troubleshooting |
| 2 Android thermal | §6 Android | Printers form | — | Features → Printers |
| 3 Webhooks | §3 step 8 or §9 new subsection | Automation → Try the API example | `PRINTNINJA_CALLBACK_*` vars | Automate it |
| 4 Template packs | §2 template creation | Designer → New template | — | Your first print / Design a template |
| 5 LAN TLS | §9 "Pinned encryption" → concrete | Automation → Encryption card | `PRINTNINJA_TLS*` vars | Security note |

### Open questions (resolve before coding)

1. **mDNS crate choice on Windows** — `windows` crate DNS-SD vs `mdns-sd` cross-platform? `mdns-sd` works on Windows too and avoids `windows` feature churn. Prototype both; pick the one that sees `dev-printer --mdns` on a Windows VM.
2. **TLS port** — second port (`17718`) vs upgrading `17717` to TLS? Second port avoids breaking `is_private_host` + `pair_base` URL parsing that assumes `http://host:17717`. Keep `http://` on loopback, `https://` on LAN.
3. **Webhook allowlist UX** — env var only, or a Settings UI field? Start with env var (`PRINTNINJA_CALLBACK_ALLOWLIST`); add a Settings field if operators ask.
4. **Template pack thumbnails** — live `PaperThumb` render vs static SVG? Live is accurate but 6 renders on dialog open may jank on low-end Android. Use static SVG for v1, swap to live if perf is fine.
5. **Android raster multi-sheet** — first-sheet-only (like desktop raster today) or all sheets? Start with first sheet; multi-sheet thermal is a follow-up with its own QA (label gap handling).

---

## Appendix: file map

```
docs/PLAN.md                         ← this plan

src-tauri/
  src/
    discovery/
      mod.rs
      mdns_windows.rs              (3)
      mdns_linux.rs                (3)
      types.rs                     (3)
    api/
      callback.rs                  (2)
      routes.rs                    (2)
      openapi.rs                   (2)
      mod.rs                       (5 cert store)
    commands/
      api.rs                       (3,5)
      printer.rs                   (3)
      print.rs                     (4 gate)
    render/
      mod.rs                       (4)
    transport/
      mod.rs                       (5 ipps)
    db/
      schema.sql                   (5 pins)
  Cargo.toml                       (2,3,5)

plugins/tauri-plugin-android-print/
  android/src/main/java/…/
    AndroidPrintPlugin.kt          (2,5)
    MdnsDiscovery.kt               (3 reuse)
  src/mobile.rs                    (3,4)

src/
  lib/
    templates/
      packs/
        index.ts                   (1)
        receipt.ts                 (1)
        deliverySlip.ts            (1)
        invoice.ts                 (1)
        shippingLabel.ts           (1)
        kitchenTicket.ts           (1)
        blank.ts                   (1)
      defaultTemplate.ts           (1 refactor)
    agent/commands.ts              (3,5)
    pairing.ts                     (5)
  pages/
    Designer.tsx                   (1)
    PrinterSetup.tsx               (3,4)
    Automation.tsx                 (2,5)
  components/
    DevicesCard.tsx                (3,5)
    designer/PackChooser.tsx       (1)

dev-printer/server.cjs             (3)
```

