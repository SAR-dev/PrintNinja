# Print Flow — Fix Follow-ups (TODO)

Companion to `print-flow-vulnerabilities.md` and
`print-flow-production-correctness.md`. This lists the findings from those two
reviews that were **not** addressed in the `fix/print-flow-correctness-security`
branch, with a short note on why and what a fix would look like.

## Fixed on this branch

- **Callback SSRF (string-only private-host check)** — `callback.rs` now resolves
  the host and refuses any private / loopback / link-local answer
  (`data::fetcher::is_forbidden_addr`).
- **Template CSS not sanitized at print time** — `handlebars::sanitize_css` scrubs
  remote `@import` / `url()` and `build_template_css` applies it.
- **PDF input rasterized at A4 default** — `pdfium::pdf_page_size_mm` reads the
  PDF's own page size; `resolve_content` uses it when no explicit paper size is
  supplied.
- **Idempotency key not scoped to the caller** — the unique index is now
  `(COALESCE(requested_by_device_id, ''), idempotency_key)`
  (`db::ensure_idempotency_scope`, replaces `idx_print_jobs_idempotency`), and
  `begin_job` only reports an existing `job_id` for the same caller's key. Local
  callers share the empty scope. No data rewrite: the old key-only unique index
  implies the new one.
- **Pairing claim not rate-limited per source address** — `pair_routes::claim`
  now has its own per-IP `FailureTracker` (10 failures / 60 s → `429`), counting
  wrong codes, malformed codes with an open window, invite misses, and locked
  windows. It is separate from the bearer-token budget, so code guessing cannot
  block a paired phone and vice versa. The tracker is now a reusable type in
  `render_share.rs`.
- **Callback DNS TOCTOU** — `dispatch_callback` resolves the host once at send
  time, refuses any private answer, and pins the vetted addresses to the client
  (`resolve_to_addrs`), so the POST (and its retries) cannot be rebound to an
  internal address. IP-literal hosts and `PRINTNINJA_CALLBACK_ALLOW_PRIVATE=1`
  are unchanged.

## Not yet fixed

### Correctness

1. **Command-language printers silently truncate overflowing content.**
   `multi_sheet_refusal` only counts statically generated `.pn-sheet` divs; the
   browser-side `PAGINATE_SCRIPT` adds sheets for content taller than the design
   page, which the single-bitmap raster never captures. Needs renderer feedback
   (final sheet count) or a variable-length raster path for receipts — a larger
   change, not done here.

2. **Multi-page PDF → command-language printer prints only page 1**, warned after
   the fact. A pre-flight refusal is a behavior change (today it is a deliberate
   warn-and-print for the single-label case, and the page count only comes back
   from the rasterizer after the job row exists), so it needs a product decision
   plus a cheap page-count probe before `begin_job` — not changed here.

3. **Windows driver queues default to `language = PDF`** and a GDI-only driver
   prints the PDF source as garbage (warned only after the send). Would ideally
   surface at printer-add time from the queue's offered datatypes.

### Security

4. **Printer credentials / pairing tokens stored in plaintext** (SQLite), and
   `printers.password` is returned to the frontend by `list_printers` /
   `get_printer`. Needs a platform keychain (DPAPI / Keychain / libsecret) and
   removing the secret from the `Printer` DTO. Not done here — scope/risk.

5. **`device_id` is client-chosen at pairing** (identity squatting). A device
   holding a valid code/invite can overwrite another device's `paired_devices`
   row by claiming with its `device_id` (`ON CONFLICT(id) DO UPDATE`), and that
   id is stamped on job history. Re-pairing the same phone legitimately reuses
   its id, so the fix is a protocol change (server-minted id returned with the
   token, or proof of the old token on re-pair) that needs phone-app changes
   too — not a PC-only patch.

### Residual / acknowledged

6. **`data_url` fetch has the same DNS-rebinding window.** The callback is now
   pinned (see above), but `data/fetcher.rs` validates each redirect hop and
   then lets reqwest re-resolve. Pinning there means building a client per hop
   (redirects are followed manually) with `resolve_to_addrs` — doable, but it
   touches the fetch loop that every print path shares, so it was left for a
   change that can be run against the fetcher test suite.

7. **Android PDF page size.** `pdf_page_size_mm` returns `None` on Android (no
   bundled PDFium; the platform plugin renders PDFs), so the A4 fallback remains
   there. The Android plugin would need to report the page size, or the phone
   should send explicit `page_height_mm`.

## Verification needed on a full build (not run here — low-resource PC)

These fixes were written by inspection and **not** compiled or tested. Before
merging, run on a machine with the toolchain:

- `pnpm build` (or `tsc -b`) — type-checks the TS changes: the via-PC paper-size
  wiring (`usePrintActions`, `usePrintPaper`, `AdvancedOptions`,
  `PhonePrintFlow`, `agent/types.ts`) and the added label-size presets + locale
  keys.
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` in
  `src-tauri/` — checks the Rust changes.
- `pnpm test` — especially `src/test/print.test.tsx` (paper override / preset
  re-selection) and any via-PC test, now that the paper field is shown in
  via-PC mode.
- `pnpm test:rust` (Docker) — `remote_print`'s
  `phone_and_local_settings_are_identical_for_the_same_options` now also pins the
  new `paper` settings key.

Also written by inspection in the latest pass (no Rust toolchain available):

- **Idempotency migration.** `db::init` now ends with `ensure_idempotency_scope`;
  the old global index is no longer created by `schema.sql` or the legacy table
  rebuilds. Check on (a) a fresh DB, (b) a DB carrying the old
  `idx_print_jobs_idempotency` (it must be dropped and the scoped index
  created), and that `losing_the_insert_race_reports_the_existing_job_…` and
  `duplicate_idempotency_key_does_not_create_a_second_job` still pass. Worth
  adding a test: two different `requested_by_device_id` values with one key must
  both print.
- **`FailureTracker` refactor** (`render_share.rs`) — `const fn new()` over a
  `LazyLock`; confirm it compiles as a `static`, and add a `pairing_api` test
  that 11 wrong claims from one address return `429`.
- **Callback pinning** — `resolve_and_pin` / `resolve_to_addrs` in
  `callback.rs`; confirm the existing callback tests (IP-literal targets) are
  unaffected, and that a name resolving to a private address is refused at
  dispatch.

Worth a careful look:

- **Via-PC paper round-trip.** Confirm a phone-set paper override reaches the PC
  and changes the output: phone `remote_print` → PC `POST /v1/print`
  `settings.paper` → `PrintRequest.page_width_mm`/`page_height_mm`.
- **Via-PC `records` round-trip.** Confirm a Pages > 1 job with a `data_url`
  prints that many pages through the PC (the phone now sends `settings.records`
  and the PC repeats the fetched object), and that inline `data` still prints the
  right count via the retained `expand_records` fallback.
- **`paper_via_pc` i18n key** is now unused (the "not sent via PC" note was
  removed); safe to delete from `en.ts`/`ja.ts` if desired.
