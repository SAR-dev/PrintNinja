# PrintNinja — Improvements & Bug Backlog

> Generated: 2026-10-17 · Dev server shut down for audit.
> This file tracks every known bug, stub, and improvement — one item per row — so work can be picked up incrementally. Fix → test → check the box.

**Batches 1–9 shipped** (P0 + core DB wiring, print pipeline + history UI, fonts/profiles/batch + version diff, REST API auth + real binding, PrinterSetup + Settings wiring, barcodes + bundled print CSS + template helpers, print queue + transport registry + REST pipeline, fetcher/deeplink/auth hardening, templates/IPP/data-path) — items marked ☑ below.

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
| 32 | `fileInputRef` is `any`-typed via `useRef<HTMLInputElement>(null)`? Check `ref` is correctly typed. Previously unused, now wired — but `<input>` is hidden via `className="hidden"` not `display:none` — Playwright `input.first()` matched it; now fixed to `input[type="number"]` but still fragile. | P3 | ☐ |
| 33 | Versions panel: both buttons call `handleRestoreVersion(v)` — second should open diff view, not restore again. | P1 | ☑ done |
| 34 | `showDiffDialog`/`diffVersion` were declared then removed, but diff view feature from PLANNING.md 7.3 still missing (side-by-side HTML/CSS diff with Monaco/`diff` lib). | P1 | ☑ done |
| 35 | Templates loaded Tailwind from `cdn.tailwindcss.com` (GrapesJS was never implemented; Visual tab is hand-rolled). Replaced with a real bundled Tailwind build — see #81. | P2 | ☑ done |
| 36 | GrapesJS → CodeMirror sync uses `syncDirection` state toggle inside `useEffect` deps — causes stale closure and double-render loop. | P2 | ☐ |
| 37 | Canvas preview iframe `srcDoc` re-renders on every keystroke without debounce — causes typing lag on large templates. Debounce `htmlCode`/`cssCode` → 300ms. | P2 | ☐ |
| 38 | Barcode insert wrote `<img src>` from `canvas.toDataURL("image/svg+xml")` — PNG pixels labelled as SVG, so the image never rendered. Also **4 of 14 symbologies threw** (`itf`, `codabar`, `aztec`, `qr` are not bwip-js encoder names). Now emits inline SVG via `toSVG()` with a friendly-id → encoder map. | P1 | ☑ done |
| 39 | Font button in Designer has no `onClick` — dead button. Should open font manager or upload dialog. | P1 | ☐ |
| 40 | `Save & Preview` opens a new tab with `window.open` — blocked by popup blocker in Tauri WebView. Should reuse preview tab or show modal. | P2 | ☐ |
| 41 | Variables tab: JSON textarea uses raw `<textarea>` not CodeMirror — inconsistent UX, no JSON validation highlighting. | P3 | ☐ |
| 42 | Variables tab: `copy-to-clipboard` uses `navigator.clipboard` which requires secure context; fallback not handled in Tauri (http). Add fallback to `execCommand`. | P2 | ☐ |
| 43 | Template import accepts `text/html` but JSON parse will fail on raw HTML — should detect `.html` vs `.json` and handle both. | P2 | ☐ |

---

## 3 · Frontend — Print (`src/pages/Print.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 44 | `handlePrint` sends `JSON.stringify(data)` as raw HTML `<pre>` — ignores selected template, orientation, margins, fit mode, page size. PLANNING.md requires `template + data → Handlebars → Layout → PDF`. | P1 | ☑ done |
| 45 | `handlePrint` hard-codes `page_width_mm: 210, page_height_mm: 297` — ignores form margins/orientation. | P1 | ☑ done |
| 46 | Preview dialog uses dummy `"<div class=\"p-4\">Mock data loaded.</div>"` — does not use selected template + data, so preview ≠ actual print. | P1 | ☑ done |
| 47 | `useEffect` auto-load printers disables `react-hooks/exhaustive-deps` globally — masks stale closure of `store.printerId`. Should list `store` in deps or use `useRef`. | P2 | ☐ |
| 48 | Template `<Select>` options are hard-coded strings (`receipt-80`, `label-4x6`, `invoice-a4`) not fetched from `list_templates`. | P1 | ☐ |
| 49 | `copies` Input allows `0` or negative — should clamp to `>=1` via `zod` validation. | P2 | ☐ |
| 50 | Batch dialog: no CSV upload, no column mapping (PLANNING.md 7.8). Only JSON array textarea. | P1 | ☐ |
| 51 | Batch `Start Batch` sends `template_id: 1, printer_id: 1` hard-coded — not using form selection. | P1 | ☑ done |
| 52 | No progress UI for batch (pause/resume/cancel/retry per record) per PLANNING.md 7.8. | P1 | ☐ |
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
| 64 | No date-range filter UI despite `historyStore.filter.dateFrom/dateTo` fields and PLANNING.md requirement. | P2 | ☐ |
| 65 | No batch grouping (expandable row per PLANNING.md 8) — `batch_id` exists but not grouped. | P2 | ☐ |

---

## 6 · Frontend — Settings (`src/pages/Settings.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 66 | `apiPort` / `lanAccess` local `useState` not persisted to SQLite — resets on reload. Should call `set_setting` / `get_setting`. | P1 | ☑ done |
| 67 | `Start Server` calls `start_api_server` but never checks `get_api_status` — badge always “Disabled”, no loading state, no error handling if port in use. | P1 | ☑ done |
| 68 | API Key shown as `type="password"` with no reveal toggle — users cannot copy it after regenerate. | P2 | ☑ done |
| 69 | Diagnostics export is a no-op spinner? Actually works, but not redacting secrets per PLANNING.md — `diagnostics.download()` dumps raw store which may contain tokens. | P2 | ☐ |
| 70 | Deep Links “Trusted Sources” card shows hard-coded `pos.local` entry — not fetched from `deeplink_trusted_sources` table (which doesn’t exist yet). | P1 | ☑ done |
| 71 | Retention inputs (`days`, `maxRecords`) not wired — no `onChange` persists. | P1 | ☑ done |
| 72 | Font tab “Download CJK” / “Upload” are toast-only — `font.rs` commands not invoked. | P1 | ☑ done |

---

## 7 · Frontend — Layout & Shell (`src/components/Layout.tsx`, `src/App.tsx`)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 73 | Bottom nav used a fixed `w-16` per item. **Filed premise was wrong** — 5 × 64 = 320px, and flex items shrink by default, so nothing was clipped; the bar just left up to 110px unused and squeezed items unevenly. Now `flex-1 min-w-0` with `truncate` on the label. | P2 | ☑ done |
| 74 | Bottom nav `type="button"` added, but active vs inactive color contrast WCAG AA on `text-primary` vs `bg-card` not verified (likely fails on yellow-ish themes). | P3 | ☐ |
| 75 | `Onboarding` stores `localStorage("printninja-onboarding-complete")` but never checks DB — reinstall loses DB but keeps flag. Should derive from `settings` row `onboarding_done`. | P2 | ☐ |
| 76 | `Onboarding` progress `value={progress}` prop typed `number|undefined` but `Progress` renders `style.width: "${value}%"` without clamp — 100% overflow if rounding >100. | P3 | ☐ |
| 77 | `App.tsx` `useEffect` for `diagnostics.info("App started")` has missing deps array? Actually `[onboardingComplete]` — will log twice if user toggles. Should use `[]`. | P3 | ☐ |
| 78 | `Layout` `cn()` imports `clsx`+`twMerge` but `Sheet` overlay class `bg-black/50` is duplicated — Sheet’s own overlay uses `bg-black/80` in dialog, inconsistent opacity. | P3 | ☐ |

---

## 8 · Cross-cutting — Types, i18n, Perf, Security

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 79 | Many pages mix `t("print.fit_actual")` with hard-coded English fallbacks (`"Wi-Fi / LAN"` tab label literal). Incomplete i18n coverage — run `biome` i18n lint. | P3 | ☐ |
| 80 | `PrintStore` / `HistoryStore` / `TemplateStore` all use `zustand` without `persist` middleware — all user work lost on refresh before DB wiring. Should persist to SQLite via invoke or `zustand/middleware`. | P2 | ☑ done |
| 81 | `Designer` canvas `iframe` loaded `https://cdn.tailwindcss.com` per render — offline-hostile, outside our CSP, recompiled Tailwind on every job. Now a committed, minified Tailwind build (`pnpm build:templates:css`) inlined into every document. Also fixed Rust `apply_layout` silently discarding template CSS for full-document templates. | P2 | ☑ done |
| 82 | `Designer` `renderTemplate` re-registers Handlebars helpers on every call (`Handlebars.registerHelper`) without dedupe — leaks helpers, global singleton polluted across renders. Should reuse single `Handlebars` instance. | P2 | ☐ |
| 83 | `PrinterSetup` and `Print` both call `enumerate_system_printers` — no caching, every navigation re-scans. Should memoize with `TanStack Query`. | P3 | ☐ |
| 84 | `DataFetcher` was claimed unused — actually wired end-to-end: Print page forwards `data_url` via `print_html` `Print.tsx:212` → backend `DataFetcher::fetch` `commands/print.rs:248` → Handlebars render. Verified in Batch 9. | P1 | ☑ done |
| 85 | `webGuard.ts` / `tauriGuard.ts` defined but never imported anywhere — dead code. Web-mode guards not actually protecting `invoke` calls. | P2 | ☐ |
| 86 | `src/lib/store/templateStore.ts` stores `isDefault` flag but Designer never sets it — always true by default, delete disabled always? Inconsistent. | P2 | ☐ |
| 87 | CORS in `api/server.rs` is `CorsLayer::new().allow_origin(Any).allow_headers(Any).allow_methods(Any)` — wide-open in local mode, contradicts “LAN access off by default” security posture. Should restrict to `127.0.0.1` origins when LAN off. | P2 | ☑ done |
| 88 | Secrets (tokens) flow through `api/routes.rs` `PrintJobRequest.data` as plain JSON — PLANNING.md says tokens live in `keyring` and are redacted from logs/history. No redaction implemented. | P1 | ☐ |
| 89 | `Cargo.toml` enables `reqwest` default features pulling `h2`, `hyper` etc. but `windows = "0.58"` is pinned behind outdated `windows-future` breakage (already worked around). Should audit feature set for minimal build size. | P3 | ☐ |
| 90 | `src-tauri/Cargo.lock` committed — Tauri best practice is to commit, but pnpm `pnpm-workspace.yaml` generated artefact not gitignored check. | P3 | ☐ |

---

## 9 · Testing

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 91 | Vitest: 26 tests but **0 tests** for Designer variables tab, Print batch flow, History filters, Settings API controls. Add unit tests for `extract_json_path`, `percent_decode`, `parse_deep_link`, `validateBarcode` edge cases. | P2 | ☐ |
| 92 | Playwright: 50+ tests but none exercise error paths (invalid JSON, empty template name, duplicate name already covered — extend). Missing: unsaved-changes guard, version restore correctness, print without printer error toast. | P2 | ☐ |
| 93 | Rust: `tests/unit_tests.rs` name `test_floyd_steinberg` had wrong expected bytes (was `0xFF` for 4px width → corrected to `0xF0`); golden-byte tests for `escpos`/`tspl`/`zpl`/`cpcl` encoders missing (PLANNING.md 9). | P2 | ☐ |
| 94 | CI `rust-check` runs `cargo clippy -- -D warnings || true` — swallows warnings, should fail on warnings for real quality gate. | P2 | ☐ |

---

## 10 · Priority Order (suggested)

1. **P0 crash fixes** — #13 (rusqlite path), #20 (PRINTER_INFO_2A), #29 (duplicate route).
2. **P1 backend stubs** — wire #1–#12 to real rusqlite queries so frontend lists are not mocks.
3. **P1 print path** — #44–#46 (Print uses template engine + respects layout).
4. **P1 history** — #59–#63 (persist + fetch + reprint/retry).
5. **Then** P2 latent + P3 polish, one PR per row with an added regression test so bugs don’t return (you asked for “tests so they don’t happen again”).
