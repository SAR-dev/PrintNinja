# Feature Pack Plan — PrintNinja v2.5

> Five features that close the loop between discovery, printing, and integration; §6–§9 add the follow-up work absorbed from the 2026-11 investigation (mobile redesign, documentation, extra features).
> Status: **1–3 and 7 implemented (2026-11-02) · 6 implemented (2026-11-03) · 4 implemented (2026-11-04)** · Target: `v2.5` · Branch strategy: one branch per feature, merge to `develop`

## Overview — sorted easy → hard

| # | Feature | Effort | Problem today | Outcome | Status |
|---|---------|--------|---------------|---------|--------|
| 1 | Starter template packs | ~2–3 days | New template always starts from one shipping-label example | Creator picks Receipt / Delivery Slip / Invoice / Label / Blank before editing | ✅ Implemented |
| 2 | Webhook callbacks (`callback_url`) | ~2–4 days | `POST /v1/print` with `callback_url` is rejected with 400; POS systems poll `/v1/jobs/{id}` instead | Successful/final jobs POST to the caller's URL | ✅ Implemented |
| 3 | Auto discovery (mDNS) | ~4–7 days | "Add printer" requires typing an IP; finding a PC requires a `/24` brute scan | Printers and PCs appear automatically on the same LAN | ✅ Implemented |
| 4 | Direct thermal printing from Android | ~5–8 days | Android offers only PDF — ESC/POS, ZPL, TSPL, CPCL, raster are disabled | An Android phone drives a thermal head directly, no PC needed | ✅ Implemented |
| 5 | Encrypted LAN traffic | ~2–3 weeks | All LAN traffic (pairing, render, print) is plain HTTP | LAN traffic is encrypted with pinned certificates | ⬜ Planned |
| 6 | Mobile redesign (vertical-only, portrait lock) | ~2 weeks | Print page is 2.7 screens of 15 fields; horizontal layouts; Designer is a desktop tool on phones | One-column phone UI, viewer-mode Designer, three-step pairing | ✅ Implemented |
| 7 | Documentation cleanup + restructure | ~1 week | README overloaded, stale version badge; ARCHITECTURE.md hard to enter | Split docs, glossary, diagrams, badge automation | ✅ Implemented |
| 8 | Extra feature backlog (F1, F3, F7–F9, F11–F13) | varies | See §8 backlog | QR pairing, mismatch warnings, Android share target, … | ⬜ Backlog |

Why this order: 1 is frontend-only with no native/Rust/network risk; 2 is a small isolated Rust API addition; 3 adds cross-platform crates and multicast but is well-trodden; 4 needs `WebView` screenshot at exact dot size + device QA on real thermal heads; 5 touches every LAN path plus cert lifecycle and backwards compat. Dependencies are small — 5 benefits from 3 (`tls`+`fp` TXT) and from 4 (one fewer plain-HTTP printer path), otherwise each ships independently.

---

## 1. Starter template packs — ✅ Implemented (2026-11-02)

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

> ✅ **Implemented 2026-11-02** — packs in `src/lib/templates/packs/*`, chooser `src/components/designer/PackChooser.tsx`, `Designer.tsx` two-step dialog with `printninja.last_pack`, i18n in `en.ts`/`ja.ts`, `newTemplateContent(name, packId?)` backwards compatible.

---

## 2. Webhook callbacks (`callback_url`) — ✅ Implemented (2026-11-02)

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

> ✅ **Implemented 2026-11-02** — `src-tauri/src/api/callback.rs` validation/dispatch (SSRF hardening, HMAC `PRINTNINJA_CALLBACK_SECRET`), `routes.rs` fire-and-forget after terminal state (duplicate skips), `openapi.rs`, `Cargo.toml` `hmac`+`url`, tests `api_routes.rs` + unit.

---

## 3. Auto discovery of printers and PCs (mDNS) — ✅ Implemented (2026-11-02)

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

> ✅ **Implemented 2026-11-02** — `src-tauri/src/discovery/*` (`mdns-sd` `browse_printers`/`browse_peers`, `start/stop_advertise` `_printninja._tcp`), `PrinterSetup.tsx`/`DevicesCard.tsx` scan + Nearby PCs, `agent/commands.ts`, `dev-printer/server.cjs` fake PC.

---

## 4. Direct thermal printing from Android (ESC/POS, ZPL, TSPL) — ✅ Implemented (2026-11-04)

### Finalized decisions (2026-11-03)

| # | Decision |
|---|---|
| D4.1 | **No real thermal head available yet** — v1 QA runs on an Android emulator against the fake raw-TCP head (`dev-printer`). A real-device pass on a real head is an open sign-off, same pattern as the mobile redesign's device pass. |
| D4.2 | **Device tests are local-only** — CI `android-check` stays compile + unit; `connectedCheck` runs on a dev machine with an emulator. No emulator in CI. |
| D4.3 | **Multi-sheet: first sheet only** — matches desktop raster. Per-sheet bitmaps + label-gap handling is a follow-up with its own QA. |
| D4.4 | **Printer form opens only QA'd languages** — two tiers: (1) fake-head framing test (automated), (2) real-head pass (manual sign-off). In v1, with no head: languages passing tier 1 (ESC/POS, ZPL, TSPL per the device tests below) are enabled and documented as "unverified on a real head"; flipping a language after its real-head pass is a one-line change in the per-language gate. |

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

- `src/pages/PrinterSetup.tsx` + `src/lib/printerSchema.ts`: allow `escpos`/`tspl`/`zpl`/`cpcl`/`raster` when `isAndroid()`, behind the per-language QA gate (D4.4 — v1: ESC/POS, ZPL, TSPL). Replace the "PDF only on Android" notice accordingly.
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
- Device test (local-only, no emulator in CI — D4.2): Android emulator (`./gradlew connectedCheck`) prints a 40 mm receipt to a fake raw-TCP listener (assert `ESC @` + `GS v 0` framing), and a 102×152 mm label to assert TSPL/ZPL headers. Use `dev-printer` raw-TCP mode as the fake head. This test is the tier-1 gate for D4.4.
- Frontend: form shows thermal options on Android UA, hides them nowhere else.

### Rollout

Shippable after discovery (or before — no hard dependency). No schema migration. Gate by capability: `canRaster = Android && webViewScreenshotAvailable`. If the probe says no, the UI still shows PDF only and `need_peer` keeps borrowing a PC — no behaviour change for unsupported devices.

### Implementation notes (2026-11-04)

Shipped as Path A, with one deviation from the sketch: instead of `capturePicture`, the WebView is created from `context.createConfigurationContext(config)` with `densityDpi = 160` — at that density 1 CSS px = 1 device px, so the page measures exactly `w_px × h_px` and is drawn 1:1 into an ARGB bitmap. Thresholding runs on-device in Kotlin (`dotsFromArgb`: luminance `0.299R + 0.587G + 0.114B`, dot where the rounded value is `< 128`, MSB-first, 8 dots per byte); the packed dots go to a cache-dir file that `android_webview_raster` (render/mod.rs) reads into `RasterImage::from_packed`, which validates the size. Rust's 75 s deadline sits above Kotlin's 60 s watchdog, mirroring the USB path's layering.

- `need_peer` (print.rs) is now `is_android && language == Pdf`: PDF still borrows the paired PC, thermal jobs render locally.
- The printer form offers only the QA'd languages (D4.4): `ANDROID_THERMAL_QA_GATE` in `src/lib/platform.ts` = {escpos, zpl, tspl}, labeled "unverified on a real head". CPCL and raster still need the PC.
- First sheet only (D4.3).
- Tests: `RasterDotsTest.kt` (6 unit tests; the 8×1 golden row packs to `0xAD`, pinned against Rust's `raster_threshold_matches_the_kotlin_contract`), `RasterDotsInstrumentedTest.kt` (device-only, D4.2 — full-bleed and half-bleed pages assert 1 CSS px = 1 dot; **not yet run** on this branch's machine — run it with an emulator via `./gradlew connectedDebugAndroidTest` from the generated Android project), `platform.test.ts` and `androidPrinterTypes.test.tsx` (the gate and the form gating), plus the Rust round-trip tests in `render/`.
- `dev-printer` gained `--raw`: a fake JetDirect head (default port 9100) that answers the three dialect status queries "healthy" with the exact bytes `status.rs` expects, logs the two-byte ESC-@ connectivity test, and saves jobs named by detected framing (`.escpos`/`.zpl`/`.tspl`/`.bin`) — the D4.4 tier-1 gate target.
- Open: real-head sign-off per language (D4.1); CI `android-check` stays compile + unit only (D4.2).

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

## 6. Mobile redesign — vertical-only, portrait-locked — ✅ Implemented (2026-11-03)

> Absorbed from the 2026-11 investigation. Scope: phone UI only; desktop stays unchanged.

### Confirmed design decisions

| # | Decision |
|---|---|
| D1 | **Vertical-only**: one column, no side-by-side fields, no horizontal tab strips, no sideways scrolling |
| D2 | **Keep the bottom navigation** (Print, History, Templates, Printers, More) — the one deliberate horizontal element; at most five items, extras behind **More** |
| D3 | **Portrait lock** on phones (tablets/Chromebooks rotate freely) |
| D4 | **Phone Designer = viewer**: view + sample data only; editing happens on a computer |
| D5 | README in English for now; Japanese README later |
| D6 | Screenshots generated from the web preview with the fake agent; replaced with real-device captures later |

### The vertical-only rule (enforced by tests)

1. One field per row, full width.
2. No horizontally scrolling strips — tab bars, chip rows and filter rows are replaced (table below).
3. No horizontal pan — previews, the Designer canvas and the code editor fit the screen width.
4. Wide content reflows — tables are already card lists; any remaining multi-column grid collapses to one column.
5. Stacked actions — full-width buttons, primary first.
6. Portrait only (D3).
7. Enforced in `e2e/tests/mobile.mobile.e2e.ts` (already checks sideways scroll and 44 px targets) with two new assertions per route: (a) no element inside `main` with computed `overflow-x: auto/scroll` and `scrollWidth > clientWidth`; (b) no two visible form controls in the same form share the same vertical position. Add the rule to `docs/UI_GUIDE.md` under "Responsive and touch".

Replacements for the horizontal patterns:

| Today (horizontal) | Vertical replacement |
|---|---|
| Templates tab strip (Mine/Saved/Community) | Full-width view picker (bottom sheet) or three stacked choices; current view in the page subtitle |
| Printers filter tabs (All/Network/USB/Bluetooth) | One full-width "Show: All printers" picker |
| Automation tab row | A vertical list of sections that opens each one (Settings-list style) |
| Designer tab row + Save | Section picker at top, Save as a sticky bottom bar |
| History search + filters side by side | Search on one row, Filters full-width below |
| Data URL beside GET/POST selector | Method on its own row under the URL |
| Copies beside Pages · Orientation beside Fit · four margins across | Stacked, one per row (or one "Margins" screen in the options sheet) |
| Wrapping pill buttons · truncated sort label | Full-width stacked buttons; label above a full-width select |

Prefer one shared primitive (e.g. `ResponsiveTabs` — tabs on desktop, picker/section list on phones) over per-page ad-hoc layouts.

Horizontal code to convert (line numbers at v2.4.0, will shift): `Print.tsx` ~769/~1116/~1223 `grid-cols-2`, ~1281 `grid-cols-4` (margins); `PrinterSetup.tsx` ~859/~952 `grid-cols-2`, ~681 filter tab list; `Automation.tsx` ~87 tab list; `Designer.tsx` ~1283 `overflow-x-auto` tabs; `Settings.tsx` ~504 `flex-row overflow-x-auto`; `History.tsx` ~1213 `grid-cols-2`; `src/mobile.css` `tabs-list` horizontal flex row.

### Portrait lock implementation (D3)

1. **Manifest patch step** — `src-tauri/gen/android/` is git-ignored and generated in CI (`tauri android init --ci`), so a script in `scripts/` (called by both CI jobs and the local release script) sets `android:screenOrientation="portrait"` on the main activity after `init` and fails loudly if the attribute is missing afterwards.
2. **Phone-only lock** — `sensorPortrait` on small screens only (resource qualifier or runtime screen-width check) so tablets keep rotating.
3. **Remove dead code** — `LANDSCAPE_QUERY` in `src/lib/hooks/useMediaQuery.ts` and the `shortLandscape` branches in `src/components/Layout.tsx`; delete the landscape cases from the phone e2e project and `UI_GUIDE.md`.
4. **Web preview** — browsers can't be locked; show a "Rotate your phone" hint when a narrow window is wider than tall, or just keep the single column.

**Accessibility (needs explicit sign-off):** the portrait lock is a documented exception to WCAG 2.1 AA **1.3.4 Orientation** (the README promises AA). Mitigations: tablets rotate freely; record the exception in `docs/UI_GUIDE.md` under "Accessibility"; keep every screen usable with large text and zoom. Fallback if not accepted: keep rotation enabled and render the same single column in landscape.

### Print page rebuild (task-first, vertical)

Goal: a first-time user prints in **three taps** after pairing, a returning user in **one**. Top to bottom:

1. Title + status chip ("● Connected: Front Desk PC", links to pairing).
2. **Template** — picker with thumbnail.
3. **Printer** — picker + mismatch warning (e.g. "Template is 210×297 mm; this printer uses 80 mm").
4. **Data** — Sample data / From a link (full-width URL input).
5. **Copies** stepper.
6. **Preview** inline directly under the inputs (today it is last — move it up).
7. **Layout options** → bottom sheet: Paper size, Orientation, Fit mode, Margins (four stacked), Page range, Grayscale, Send test page. Summary line on the main page when anything is non-default ("Fit to width · Portrait · 5 mm margins").
8. Sticky **Print** button.

Also: remember the last template and printer; plain-language "Pages" label + one sentence of help; on failure show a non-technical error with a single **Retry** or **Open History** action. This supersedes the contradictory "advanced fields" comments in `Print.tsx` (~1092/~1114).

### Pairing and first-run

Replace the jargon paragraph with three numbered steps, one visible at a time: (1) "On your computer, open **PrintNinja → Phones** and turn on sharing." (2) "Type the 8-letter code shown there." — large single input, auto-capitalize, auto-advance. (3) "Connected to *Front Desk PC*." + Print. Always-on status line ("Connected to …" / "PC not found, check Wi-Fi") with **Try again**.

### Designer viewer mode (D4)

Sections chosen from a picker (no tab strip): **Preview** (full-width, fit, vertical scroll only), **Sample data** (editable — the one thing a phone user may adjust; sticky bottom **Save**), **README** (read-only), **Code** (read-only, line-wrapped, no horizontal scroll), **Details** (template **name** in the header instead of the raw ID fragment, size, sync state, last saved).

Not offered on phones: HTML/CSS editing, page setup, version restore, publishing — replaced by the notice *"Templates are edited on a computer. Changes sync to this phone automatically."*

Knock-on changes:
- Templates page: hide/disable **New template** and **Clone** on phones (show the notice); keep **Open** and **Use**.
- Command palette: remove "New template" on phones.
- Print page: add **Preview** access to the selected template.
- Sync: show "Updated 2 min ago" on cards; offer **Sync** for a stale copy.
- Code reduction: phones no longer need the code editor's touch handling or canvas editing controls (simplifies `Designer.tsx`).
- Tests: phone Designer e2e asserts read-only behavior and the absence of editing controls.
- Later follow-up: an optional "Send me the link" action.

### Other mobile fixes

- **Naming:** on phones "Automation" → **"Connect to PC"** (or "PC & sharing"); "Printer Setup" → **"Printers"**; "Print via PC" gets a plain sentence ("Print on the PC's printers instead of this phone's").
- **History:** stacked search and filters; job cards show status (icon, color, word), template, printer, time; **Reprint** as the primary action.
- **Errors:** map low-level errors to human sentences at the IPC layer; clear toasts on route change; fix the sign-in subtitle shown on phones ("Printing still works from this PC").

### Constraints

- One deliberate refresh of the phone e2e screenshot baselines after the redesign (not on unrelated PRs).
- Every new string needs `en.ts` + `ja.ts` entries (key-drift test fails otherwise).
- Colors stay on existing tokens (`src/test/tokens.test.ts`).
- Scope changes to the phone query; desktop unchanged.
- Remove (not leave untested) the landscape-phone code paths.
- Extract new pieces from `Print.tsx`/`Designer.tsx` into components rather than growing those files.

> ✅ **Implemented 2026-11-03** (PR #37) — `src/components/print/PhonePrintFlow.tsx` (task-first vertical Print page) and `src/components/designer/PhoneDesignerViewer.tsx` (D4 viewer: section picker, read-only code, name in header, computer-editing notice); three-step pairing in `DevicesCard.tsx`; vertical-only rule in `docs/UI_GUIDE.md` "Responsive and touch" with both e2e assertions in `e2e/tests/mobile.mobile.e2e.ts` (no horizontal-overflow container in `main`, no side-by-side data-entry controls) and one deliberate refresh of the seven phone baselines; portrait lock via `scripts/patch-android-orientation.mjs` (string-resource `app_orientation`: phones `portrait`, tablets/Chromebooks free; wired into CI and `release-local.mjs`, tested by `src/test/android-orientation.test.ts`); WCAG 1.3.4 recorded as the one declared exception in `UI_GUIDE.md`; "Connect to PC" / "Printers" naming in `en.ts`/`ja.ts`; `CommandPalette.tsx` drops phone "New template"; landscape dead code (`LANDSCAPE_QUERY`, `shortLandscape`) removed; per-page pickers/section lists used in place of a shared `ResponsiveTabs` primitive.

---

## 7. Documentation cleanup and restructure — ✅ Implemented (2026-11-02)

> Absorbed from the 2026-11 investigation. Baseline: `tsc`, Biome (356 files) and 922 Vitest tests all pass on a fresh clone; 0 px horizontal overflow and no sub-44 px targets on the seven main routes; all internal doc links resolve.

### Repository hygiene

- Delete `TODO.md` (all four items already marked implemented).
- Fix the dangling `REFACTORING.md` references in `server/src/boot.ts`, `server/src/server.ts`, `server/src/http/mappers.ts`.
- Delete merged remote branches `guest-pairing-ux` and `pair-guest-automation-ux` (0 commits ahead of `develop`).

### README (findings R1–R6)

- Bump the version badge (says 2.2.0, project is 2.4.0) — and **automate it in the release script** instead of by hand.
- Add screenshots: Designer with live canvas, Print page, History with a failure message, phone pairing, phone Print (D6: generated from the web preview + fake agent).
- Split the three audiences: end users (what, screenshots, install, first print, phone, automate, troubleshoot) stay in README; developer quick start/layout/commands/tech stack move to `docs/DEVELOPMENT.md`; the integrator `curl` example stays.
- Add `docs/GLOSSARY.md` (IPP, ESC/POS, CUPS, design page, sheet, pairing, shared rendering, "Print via PC").
- Group the ~45 flat feature bullets by value; add a phone walkthrough with visuals.
- Keep: the "Why PrintNinja" 3-step pitch, the worked parcel-tag example, the `curl` example, the badge table, and the symptom-then-fix troubleshooting.

### ARCHITECTURE.md (findings A1–A7)

Today: ~5,850 words, ~74 inline identifiers despite the "no code" claim, one ASCII diagram for a 9-stage pipeline, §9 "Borrowing a faster device" is ~40% of the file, changelog/decision-log text mixed in, placement math before the backend pipeline, no role-based entry. Proposed structure:

```
README.md                      end users: what, screenshots, install, first print, phone, automate, troubleshoot
docs/
  GLOSSARY.md                  plain-language terms
  ARCHITECTURE.md              ~1,200 words: system map, pipeline, phone↔PC diagram, "read next" by role
  architecture/
    RENDERING_AND_LAYOUT.md    design size vs paper size, fit modes, pagination
    PRINTERS_AND_TRANSPORTS.md network, system, USB, Bluetooth; printer languages; per-OS notes
    QUEUE_AND_HISTORY.md       queue, retention, timings, metrics, logs
    PHONE_AND_PC_SHARING.md    pairing, tokens, guests, Print via PC, failure behavior, security, design decisions
  DEVELOPMENT.md               quick start, layout, commands, tech stack (moved out of README)
```

Documentation rules to adopt:
1. Every doc starts with "Who this is for" and "What you will know after reading".
2. Overview docs contain no code identifiers; deep dives may.
3. Every system gets a Mermaid diagram: system map (phone, PC, printers, share service); the pipeline with the one stage that can run elsewhere highlighted; phone↔PC sequence (pair → render request → bytes back → print → history); a "Where does my print fail?" decision tree.
4. Plain word first, technical term second ("the PC that renders for your phone (shared rendering)").
5. No version history inside explanatory text — history goes to `CHANGELOG.md`.
6. The README version badge is updated by the release script, not by hand.

Keep the clear sentence-by-sentence writing and the "why" behind the rules (never re-layout a design; phones ask PCs and never the reverse).

---

## 8. Extra feature backlog

From the investigation's F1–F13. Already covered by this plan: F2 starter packs = feature 1, F6 webhooks = feature 2, F4 discovery = feature 3, F5 Android thermal = feature 4, F10 encrypted LAN = feature 5. Remaining:

| # | Feature | Why now | Effort | Value |
|---|---|---|---|---|
| F1 | **QR-code pairing** — scan the PC's screen instead of typing 8 characters | Pairing is the main phone friction; fits the vertical three-step flow | Small–Med | Very high |
| F3 | **Smart printer/template matching** — paper-size mismatch warning, per-printer default template and paper | Prevents wasted paper; no new concepts | Small | High |
| F7 | **Android share target + camera scan** — share a PDF/photo to print; scan a barcode to fill a field | Makes the phone a real input device, not just a remote | Med | High |
| F8 | **Printer alerts and routing rules** — low-paper/offline notification, template→printer defaults, failover printer | Builds on existing status checks | Med | Med–High |
| F9 | **CSV column-mapping UI** for bulk prints | Users shape JSON by hand today | Med | Medium |
| F11 | **Visual or block template builder** (optional AI-assisted template from a photo or sample) | Lowers the HTML/CSS barrier for non-developers | Large | High |
| F12 | **Dark mode and more languages** (one light theme, EN+JA today) | Warehouses/outdoors; broader reach | Med | Medium |
| F13 | **Per-template guest permissions and roles** | Explicitly excluded in the current design; revisit if teams grow | Med | Situational |

Suggested order: F3 quick win first, then F1 alongside the mobile redesign, then F7/F8/F9 as integration work, F11 as a larger project, F12/F13 when there is demand.

---

## 9. Follow-up roadmap and risks

### Ordering (after features 1–5)

1. **Documentation cleanup + restructure** (~1 week) — repo hygiene, README restructure with screenshots/glossary/badge automation, ARCHITECTURE.md split per §7, design decisions recorded in `PHONE_AND_PC_SHARING.md`.
2. **Mobile redesign** (~2 weeks) — ✅ Done 2026-11-03 (see §6).
3. **Quick-win features** (~1 week) — F3 mismatch warnings, F1 QR pairing.
4. **Larger features** — F7, F8, F9, F11, F12, F13 as demand dictates.

Each change lands on `develop` in small conventional-commit PRs with a regression test, as `CONTRIBUTING.md` requires.

### Risks and open items

1. **WCAG 1.3.4 (Orientation):** accept the portrait-lock exception explicitly or fall back to a rotatable single column.
2. **Phone template authoring is removed** — revisit with a minimal "edit text only" mode if usage shows it matters.
3. **Generated Android project** — the orientation patch must run on every `tauri android init`; CI must verify it.
4. **Browser-preview limits** — the investigation saw the phone UI in a desktop browser with a fake backend; at least one real Android device pass is needed before sign-off on the redesign.
5. **Snapshot churn** — one deliberate refresh of the phone e2e baselines after the redesign.
6. **Android thermal real-head pass** — no real thermal head was available at decision time (D4.1). v1 ships emulator + fake-head QA; each enabled language carries an open real-head sign-off, and the printer form stays gated per-language (D4.4) until one lands.

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

5 benefits from 3 (`tls`+`fp` TXT) and from 4 (one fewer plain-HTTP printer path); otherwise each ships independently. Workstreams 6–8 (investigation follow-ups) are sequenced in §9. If the POS webhook is urgent, ship 2 first. If the template chooser is needed for a demo, ship 1 first — it has no dependencies.

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
| 6 Mobile redesign | — | "Responsive and touch" vertical-only rule, portrait exception, Designer viewer, test table | — | — |

### Open questions (resolve before coding)

1. **mDNS crate choice on Windows** — `windows` crate DNS-SD vs `mdns-sd` cross-platform? `mdns-sd` works on Windows too and avoids `windows` feature churn. Prototype both; pick the one that sees `dev-printer --mdns` on a Windows VM.
2. **TLS port** — second port (`17718`) vs upgrading `17717` to TLS? Second port avoids breaking `is_private_host` + `pair_base` URL parsing that assumes `http://host:17717`. Keep `http://` on loopback, `https://` on LAN.
3. **Webhook allowlist UX** — env var only, or a Settings UI field? Start with env var (`PRINTNINJA_CALLBACK_ALLOWLIST`); add a Settings field if operators ask.
4. **Template pack thumbnails** — live `PaperThumb` render vs static SVG? Live is accurate but 6 renders on dialog open may jank on low-end Android. Use static SVG for v1, swap to live if perf is fine.
5. **Android raster multi-sheet** — resolved 2026-11-03: first sheet only (D4.3); multi-sheet thermal is a follow-up with its own QA (label gap handling).

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
    DevicesCard.tsx                (3,5,6)
    designer/PackChooser.tsx       (1)
    designer/PhoneDesignerViewer.tsx (6)
    print/PhonePrintFlow.tsx       (6)

dev-printer/server.cjs             (3)
scripts/patch-android-orientation.mjs (6)
```

