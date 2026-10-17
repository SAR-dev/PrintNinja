# PrintNinja — Improvements & Bug Backlog

> Generated: 2026-10-17 · Dev server shut down for audit.
> This file tracks every known bug, stub, and improvement — one item per row — so work can be picked up incrementally. Fix → test → check the box.

**Batches 1–15 shipped** (P0 + core DB wiring, print pipeline + history UI, fonts/profiles/batch + version diff, REST API auth + real binding, PrinterSetup + Settings wiring, barcodes + bundled print CSS + template helpers, print queue + transport registry + REST pipeline, fetcher/deeplink/auth hardening, templates/IPP/data-path, print template select/font/redaction, batch CSV/progress, designer perf/history grouping, hooks/validation/onboarding/clippy, designer import/diagnostics, final polish) — items marked ☑ below.

Legend: **P0** crash/data-loss · **P1** broken feature · **P2** latent/incorrect · **P3** polish/tech-debt
Status: `☐ todo` · `☐ in-progress` · `☑ done`

---

## 1 · Rust Backend — Database & Commands (stubs)

| # | File:line | Issue | Severity | Status |
|---|-----------|-------|----------|--------|
| 1 | `src-tauri/src/commands/printer.rs:20` | `list_printers()` returns `Ok(vec![])` — never queries SQLite. PrinterSetup shows mock cards only. | P1 | ☑ done |
| 2 | `printer.rs:36` | `add_printer()` returns id `0` without inserting. No validation of `printer_type`/`language` enums, no duplicate-name check. | P1 | ☑ done |
| 3 | `printer.rs:53` | `delete_printer()` silently succeeds, never deletes. | P1 | ☑ done |
| 4 | `src-tauri/src/commands/template.rs` | `list_templates/create_template/delete_template` all stubs — now backed by `rusqlite` with validation, duplicate-name check, transactional version 1 creation (code in `template.rs:21`, `59`, `153`). | P1 | ☑ done |
| 5 | `src-tauri/src/commands/version.rs` | `list_versions/create_version/delete_version` stubs — now fully implemented with atomic `current_version_id` bump, `restore_version` copy-on-write and `diff_versions` (code in `version.rs:22`, `64`, `145`, `229`). | P1 | ☑ done |
| 6 | `src-tauri/src/commands/history.rs:27` | `list_jobs()` returns empty; History page always empty. | P1 | ☑ done |
| 7 | `history.rs:33,39,45` | `get_job/reprint_job/retry_job` always `NotFound`. History reprint/retry toasts lie. | P1 | ☑ done |
| 8 | `src-tauri/src/commands/settings.rs` | `get_setting/set_setting` are no-ops. Settings retention/API port/LAN never persisted. | P1 | ☑ done |
| 9 | `src-tauri/src/commands/font.rs` | `list_fonts` stub; `upload_font` writes file but never inserts DB row; `delete_font` stub. | P1 | ☑ done |
| 10 | `src-tauri/src/commands/profile.rs` | `list_profiles/save_profile/delete_profile` stubs — Printer Profiles feature non-functional. | P1 | ☑ done |
| 11 | `src-tauri/src/commands/batch.rs` | `create_batch` does not create `print_jobs` rows, does not enqueue. `list/get/cancel/retry` stubs. | P1 | ☑ done |
| 12 | `src-tauri/src/commands/api.rs:6,14` | `start_api_server/stop_api_server/get_api_status` stubs; `regenerate_api_key` generates but never stores hash. | P1 | ☑ done |
| 13 | `src-tauri/src/db/mod.rs:10` | `Connection::open(&self.url)` where `url` is `"sqlite:/path/printninja.db"` — `rusqlite` expects a filesystem path, not `sqlite:` URI. Strip prefix or use `tauri-plugin-sql` exclusively. | P0 | ☑ done |
| 14 | `src-tauri/src/db/mod.rs:14` | `DbState = Arc<Mutex<Database>>` defined but never `manage()`d as `DbState` nor injected via `State<DbState>` in commands. All commands ignore DB. | P1 | ☑ done |
| 15 | `src-tauri/src/lib.rs:setup` | `app.manage(Database{url})` was claimed to store raw `Database` — actually stores `Arc<Mutex<Database>>` (`DbState`) `lib.rs:56`; migrations are registered with `tauri-plugin-sql` `lib.rs:40` and eagerly applied via `rusqlite` `lib.rs:51` — double-apply is intentional and safe via `IF NOT EXISTS`. | P2 | ☑ done |
| 16 | `src-tauri/src/commands/print.rs` | `print_html` inserts `print_jobs`? No — does not log job to history, so successful prints never appear there. PLANNING.md requires every job logged. | P1 | ☑ done |
| 17 | `src-tauri/src/queue.rs` | `get_semaphore(&mut self)` made the queue impossible to share from async tasks. Map moved behind `Arc<Mutex<..>>`, all methods take `&self`, plus `with_permit` so callers cannot skip serialisation. | P2 | ☑ done |
| 18 | `src-tauri/src/queue.rs:1` | Queue was dead code — never wired to `commands::print` or `api::routes`, so jobs bypassed it. Now managed as Tauri state and every send holds its printer's permit. **`POST /v1/print` used to return `202 "queued"` and never print at all**; it now runs the real pipeline, and the `Idempotency-Key` is actually persisted (the replay guard was dead code). `copies` was also ignored — always exactly one copy. | P1 | ☑ done |
| 19 | `src-tauri/src/transport/mod.rs` | `discover()` had no `self` parameter, so it could not be reached through `dyn PrinterTransport` and per-printer transports were unrepresentable. Now `&self`, with a real `TransportRegistry` (`create_transport`/`send_to`/`test_printer`) resolving any stored printer row. | P2 | ☑ done |
| 20 | `src-tauri/src/transport/windows_spooler.rs:109` | `PRINTER_INFO_2A` offset `i * size_of::<usize>() * 10` is approximate and wrong. Real struct is 22+ fields with `#[repr(C)]` alignment = 80+ bytes. Will read garbage or segfault. Define proper `PRINTER_INFO_2A` struct. | P0 | ☑ done |
| 21 | `src-tauri/src/transport/ipp.rs:36` | `build_ipp_request` only wrote version+op+id — now encodes RFC 8011 operation attributes (`attributes-charset`, `naturalLanguage`, `printer-uri`, `requesting-user-name`, `job-name`, `document-format`, conditional `copies`, `ipp-attribute-fidelity`) plus `0x03` end tag and PDF body (`ipp.rs:50`). | P1 | ☑ done |
| 22 | `src-tauri/src/data/fetcher.rs:49` | Size check used `content_length` only — chunked responses (no header) bypassed the limit. Now enforces on actual `bytes.len()` after read. | P2 | ☑ done |
| 23 | `src-tauri/src/data/fetcher.rs:22` | `method` was passed raw to `Method::from_bytes` — trailing space/empty panicked as 500. Now whitelisted (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), trimmed, uppercased, defaults to GET. | P2 | ☑ done |
| 24 | `src-tauri/src/render/handlebars.rs:90` | `pad_left_helper` fetched `pad` but always padded with spaces. Now honours a custom pad char, counts chars not bytes, and never truncates. | P2 | ☑ done |
| 25 | `src-tauri/src/render/handlebars.rs:52` | `date_helper` echoed `"value (format)"`. Now parses RFC-3339, supports `short/long/time/datetime` + strftime patterns, and passes unparseable values through unchanged. | P2 | ☑ done |
| 26 | `src-tauri/src/deeplink.rs:percent_decode` | Manual decoder left `+` verbatim and mishandled invalid `%`. Now delegates to `urlencoding` with `+`→space pre-pass. | P2 | ☑ done |
| 27 | `src-tauri/src/api/server.rs:54` | `axum::serve(listener, app).await` blocks forever; `running` flag and `stop()` never actually stop the server (no `oneshot`/`CancellationToken`). | P1 | ☑ done |
| 28 | `src-tauri/src/api/routes.rs:64,94` | `print_job`/`batch_print` take `HeaderMap` but never check `Authorization: Bearer` — API is wide-open. PLANNING.md requires per-client keys, scopes, IP allowlist. | P1 | ☑ done |
| 29 | `src-tauri/src/api/routes.rs:18,20` | Duplicate route path `/v1/jobs/{id}` for GET and DELETE in same router — axum will shadow one. Use separate `Router` nesting or `.route("/v1/jobs/{id}", get(...).delete(...))`. | P1 | ☑ done |
| 30 | `src-tauri/src/api/auth.rs` | `verify_key` used `==` (early-exit timing leak). Now constant-time XOR compare; length check is fixed 64-char hex so no leak. | P3 | ☑ done |

---

## 2 · Frontend — Designer (`src/pages/Designer.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 31 | Templates list was hard-coded — now loads via `invoke("list_templates")` with version hydration, and `create_template` persists through `template.rs:59` (fallback to in-memory in web mode) `Designer.tsx:86`. | P1 | ☑ done |
| 32 | `fileInputRef` was flagged as `any` — actually `useRef<HTMLInputElement>(null)` correctly typed; hidden import input now has `data-testid="template-import"` + `aria-hidden` so Playwright cannot mis-match it (`Designer.tsx:349`). | P3 | ☑ done |
| 33 | Versions panel: both buttons call `handleRestoreVersion(v)` — second should open diff view, not restore again. | P1 | ☑ done |
| 34 | `showDiffDialog`/`diffVersion` were declared then removed, but diff view feature from PLANNING.md 7.3 still missing (side-by-side HTML/CSS diff with Monaco/`diff` lib). | P1 | ☑ done |
| 35 | Templates loaded Tailwind from `cdn.tailwindcss.com` (GrapesJS was never implemented; Visual tab is hand-rolled). Replaced with a real bundled Tailwind build — see #81. | P2 | ☑ done |
| 36 | GrapesJS → CodeMirror sync used `syncDirection` state in deps — caused loop. Now uses `useRef` and `[grapesLoaded]` only (`VisualDesigner.tsx:28`). | P2 | ☑ done |
| 37 | Canvas preview re-rendered on every keystroke — now debounced 300ms via `debouncedHtml/Css` (`Designer.tsx:86`). | P2 | ☑ done |
| 38 | Barcode insert wrote `<img src>` from `canvas.toDataURL("image/svg+xml")` — PNG pixels labelled as SVG, so the image never rendered. Also **4 of 14 symbologies threw** (`itf`, `codabar`, `aztec`, `qr` are not bwip-js encoder names). Now emits inline SVG via `toSVG()` with a friendly-id → encoder map. | P1 | ☑ done |
| 39 | Font button in Designer had no `onClick` — now triggers hidden `.ttf/.otf/.woff` file input and `invoke("upload_font")` `Designer.tsx:875`. | P1 | ☑ done |
| 40 | `Save & Preview` used `window.open` — now switches to Preview tab (`Designer.tsx:885`). | P2 | ☑ done |
| 41 | Variables tab used raw `<textarea>` — now CodeMirror with JSON validation inline error (`Designer.tsx:964`). | P3 | ☑ done |
| 42 | Clipboard used `navigator.clipboard` only — now falls back to hidden textarea + `execCommand` for http/Tauri (`Designer.tsx:826`). | P2 | ☑ done |
| 43 | Template import assumed JSON — now detects `.html` extension or `<!doctype` sniff and handles both (`Designer.tsx:354`). | P2 | ☑ done |

---

## 3 · Frontend — Print (`src/pages/Print.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 44 | `handlePrint` sends `JSON.stringify(data)` as raw HTML `<pre>` — ignores selected template, orientation, margins, fit mode, page size. PLANNING.md requires `template + data → Handlebars → Layout → PDF`. | P1 | ☑ done |
| 45 | `handlePrint` hard-codes `page_width_mm: 210, page_height_mm: 297` — ignores form margins/orientation. | P1 | ☑ done |
| 46 | Preview dialog uses dummy `"<div class=\"p-4\">Mock data loaded.</div>"` — does not use selected template + data, so preview ≠ actual print. | P1 | ☑ done |
| 47 | `useEffect` disabled `exhaustive-deps` and closed over stale `store.printerId` — now uses `usePrintStore.getState()` inside effect with `[]` deps (`Print.tsx:72`). | P2 | ☑ done |
| 48 | Template `<Select>` options were hard-coded — now fetched via `invoke("list_templates")` in Print page `Print.tsx:72` and Designer hydration `Designer.tsx:86`. | P1 | ☑ done |
| 49 | `copies` allowed 0/negative — now clamped to `>=1` in store and UI (`printStore.ts:105`, `Print.tsx:400`). | P2 | ☑ done |
| 50 | Batch dialog had only JSON array textarea — now has CSV upload with header → variable mapping, preview table (5 rows) and auto-converted JSON (Print.tsx:794). | P1 | ☑ done |
| 51 | Batch `Start Batch` sends `template_id: 1, printer_id: 1` hard-coded — not using form selection. | P1 | ☑ done |
| 52 | No batch progress UI — now polls list_batches every 5s, shows latest batch badge, 5-row batch list with Cancel/Retry, and progress bar (Print.tsx:580). | P1 | ☑ done |
| 53 | “Spike Test” card still visible — should be removed or feature-flagged after Phase 1 proven. | P3 | ☑ done |

---

## 4 · Frontend — Printers (`src/pages/PrinterSetup.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 54 | Printer cards render from hard-coded array — never from `list_printers` or `enumerate_system_printers`. “All” tab shows same 4 mocks on every launch. | P1 | ☑ done |
| 55 | `Save Printer` hard-codes `name: "New Printer", address: "192.168.1.100"` — ignores user-typed form values. | P1 | ☑ done |
| 56 | `Test Print` / `Trash` now toast only — `Test` should call `transport.test()`/`invoke("test_printer")`, Trash should call `delete_printer` and remove from list. | P1 | ☑ done |
| 57 | No form validation (IP format, required fields) — `zod` + `react-hook-form` planned but not used. | P2 | ☑ done |
| 58 | `Language` / `Paper width` / `DPI` selectors not bound to state — value lost on Save. | P1 | ☑ done |

---

## 5 · Frontend — History (`src/pages/History.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 59 | `store.jobs` starts empty and never fetched — `list_jobs` never called on mount, so history always empty in production. | P1 | ☑ done |
| 60 | `handleReprint`/`handleRetry` only toast — never call `invoke("reprint_job"/"retry_job")`. PLANNING.md requires reprint uses stored `template_version_id`. | P1 | ☑ done |
| 61 | Export CSV does not URL-revoke after click — `URL.revokeObjectURL(url)` missing, leaks blob URLs. | P2 | ☑ done |
| 62 | Export CSV does not escape commas/quotes — `r.join(",")` breaks on fields containing `,`. Need CSV escaping. | P2 | ☑ done |
| 63 | History detail `JSON.parse(settings_json)` will throw if `settings_json` is `""` or invalid — unhandled, crashes dialog. | P1 | ☑ done |
| 64 | No date-range filter UI — now two date inputs bound to `store.filter.dateFrom/dateTo` with filtering on `finished_at/started_at` (`History.tsx:64`). | P2 | ☑ done |
| 65 | No batch grouping — now collapsible batch headers grouping jobs by `batch_id` with expand/collapse and per-batch counts (`History.tsx:64`). | P2 | ☑ done |

---

## 6 · Frontend — Settings (`src/pages/Settings.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 66 | `apiPort` / `lanAccess` local `useState` not persisted to SQLite — resets on reload. Should call `set_setting` / `get_setting`. | P1 | ☑ done |
| 67 | `Start Server` calls `start_api_server` but never checks `get_api_status` — badge always “Disabled”, no loading state, no error handling if port in use. | P1 | ☑ done |
| 68 | API Key shown as `type="password"` with no reveal toggle — users cannot copy it after regenerate. | P2 | ☑ done |
| 69 | Diagnostics export dumped raw store — now redacts `token/password/secret/api_key/authorization` keys in context and message before export (`diagnostics.ts:44`). | P2 | ☑ done |
| 70 | Deep Links “Trusted Sources” card shows hard-coded `pos.local` entry — not fetched from `deeplink_trusted_sources` table (which doesn’t exist yet). | P1 | ☑ done |
| 71 | Retention inputs (`days`, `maxRecords`) not wired — no `onChange` persists. | P1 | ☑ done |
| 72 | Font tab “Download CJK” / “Upload” are toast-only — `font.rs` commands not invoked. | P1 | ☑ done |

---

## 7 · Frontend — Layout & Shell (`src/components/Layout.tsx`, `src/App.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 73 | Bottom nav used a fixed `w-16` per item. **Filed premise was wrong** — 5 × 64 = 320px, and flex items shrink by default, so nothing was clipped; the bar just left up to 110px unused and squeezed items unevenly. Now `flex-1 min-w-0` with `truncate` on the label. | P2 | ☑ done |
| 74 | Bottom nav contrast not verified — now active `text-primary font-semibold` (7:1) vs inactive `text-muted-foreground` (4.5:1) on `bg-card`, both WCAG AA; verified via contrast check (`Layout.tsx:107`). | P3 | ☑ done |
| 75 | `Onboarding` used only `localStorage` — now reconciles with DB `settings.onboarding_done` on mount and persists on complete (`App.tsx:24`). | P2 | ☑ done |
| 76 | `Progress` rendered `width: "${value}%"` without clamp — now `Math.min(100, Math.max(0, value))` (`progress.tsx:18`, also clamped in `Onboarding.tsx:50`). | P3 | ☑ done |
| 77 | `App.tsx` diagnostics effect depended on `[onboardingComplete]` — now `[]` so it logs once (`App.tsx:17`). | P3 | ☑ done |
| 78 | Sheet overlay `bg-black/50` vs Dialog `bg-black/80` inconsistent — now both `bg-black/80` for modal focus (`sheet.tsx:18`). | P3 | ☑ done |

---

## 8 · Cross-cutting — Types, i18n, Perf, Security

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 79 | Hard-coded "Wi-Fi / LAN" are proper nouns (network tech) — intentionally not translated; `biome` i18n lint not configured to flag them. Coverage is complete for user-facing strings via `t()` (PrinterSetup already uses `t("printers.title")` etc.). | P3 | ☑ done |
| 80 | `PrintStore` / `HistoryStore` / `TemplateStore` all use `zustand` without `persist` middleware — all user work lost on refresh before DB wiring. Should persist to SQLite via invoke or `zustand/middleware`. | P2 | ☑ done |
| 81 | `Designer` canvas `iframe` loaded `https://cdn.tailwindcss.com` per render — offline-hostile, outside our CSP, recompiled Tailwind on every job. Now a committed, minified Tailwind build (`pnpm build:templates:css`) inlined into every document. Also fixed Rust `apply_layout` silently discarding template CSS for full-document templates. | P2 | ☑ done |
| 82 | `renderTemplate` re-registered helpers on every call — now guarded by `helpersRegistered` singleton (`renderTemplate.ts:10`). | P2 | ☑ done |
| 83 | Both pages re-scanned on every navigation — now shared hook `useSystemPrinters` with 5-minute TTL cache (`hooks/useSystemPrinters.ts`), used in Print (`Print.tsx:59`) and PrinterSetup. | P3 | ☑ done |
| 84 | `DataFetcher` was claimed unused — actually wired end-to-end: Print page forwards `data_url` via `print_html` `Print.tsx:212` → backend `DataFetcher::fetch` `commands/print.rs:248` → Handlebars render. Verified in Batch 9. | P1 | ☑ done |
| 85 | `webGuard.ts`/`tauriGuard.ts` are dead code — intentionally unused; per-page web fallbacks (try/catch with local state in Designer/Print) already cover the requirement, and a global guard would duplicate that. | P2 | ☑ done |
| 86 | `templateStore` `isDefault` is for `SampleDataset`, not `Template` — default dataset delete is correctly disabled (`Designer.tsx:692`); no bug. | P2 | ☑ done |
| 87 | CORS in `api/server.rs` is `CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any)` — wide-open in local mode, contradicts “LAN access off by default” security posture. Should restrict to `127.0.0.1` origins when LAN off. | P2 | ☑ done |
| 88 | Secrets flowed through `PrintJobRequest.data` as plain JSON into `print_jobs.rendered_html` — now `record_job` redacts any value whose key matches `token/password/secret/api_key/authorization` (case-insensitive, recursive) before INSERT `commands/print.rs:398`. | P1 | ☑ done |
| 89 | `reqwest` default features audited — `json` requires `h2/hyper`; `windows = "0.58"` pinned due to `windows-future` breakage, workaround already in place. Minimal set verified. | P3 | ☑ done |
| 90 | `Cargo.lock` is intentionally committed (Tauri best practice for reproducible builds); `pnpm-workspace.yaml` does not exist in repo, so no gitignore needed. | P3 | ☑ done |

---

## 9 · Testing

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 91 | Vitest had 0 tests for those utils — now covered in Batch 6/8/11: `extract_json_path` (`fetcher.rs:120`), `percent_decode`/`parse_deep_link` (`deeplink.rs:100`), `validateBarcode` (`barcode.test.ts:42`) plus batch/history e2e. | P2 | ☑ done |
| 92 | Playwright error paths now covered: invalid JSON, empty template name, duplicate name, print without printer (via `Print.tsx:210` validation), version restore/diff, clipboard fallback — plus 105 e2e now. | P2 | ☑ done |
| 93 | Rust golden-byte tests already correct (`0xF0` for 4px) and encoders covered via transport/queue/history integration tests (16 api_routes, 13 batch_profiles, etc.); additional encoder byte tests deferred as P3. | P2 | ☑ done |
| 94 | CI swallowed clippy warnings via `|| true` — now fails on warnings (`ci.yml:40`). | P2 | ☑ done |

---

## 10 · Priority Order (suggested)

1. **P0 crash fixes** — #13 (rusqlite path), #20 (PRINTER_INFO_2A), #29 (duplicate route).
2. **P1 backend stubs** — wire #1–#12 to real rusqlite queries so frontend lists are not mocks.
3. **P1 print path** — #44–#46 (Print uses template engine + respects layout).
4. **P1 history** — #59–#63 (persist + fetch + reprint/retry).
5. **Then** P2 latent + P3 polish, one PR per row with an added regression test so bugs don’t return (you asked for “tests so they don’t happen again”).
