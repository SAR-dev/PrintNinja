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
- **Multi-page PDF → command-language head printed page 1 with an after-the-fact
  warning** — the product decision was *warn before print, still print page 1*
  (the single-label behavior is deliberate). `commands::print::multi_page_pdf_warning`
  probes the count via the new `pdfium::pdf_page_count` before `begin_job` and
  prepends "The PDF has N pages; only the first page will be printed." to the
  response warnings; the retry path (`run_claimed_job`) gets the same probe.
  Pdf-language printers — and unknown printers, which resolve to Pdf — are
  exempt. The after-the-fact push in `render_pdf_input` is gone, so the warning
  cannot duplicate.
- **GDI-only Windows queue defaulted to `language = pdf`** — the queue's offered
  datatypes are now read (`windows_spooler::offers_pdf_datatype`, cached per
  queue); a system queue that cannot take PDF is flagged on the detected-device
  row and in the printer form before saving (i18n in both locales), and the
  send path keeps its `RAW` fallback for queues that offer no PDF datatype.
- **`data_url` fetch DNS-rebinding window** — `data/fetcher.rs` validates each
  hop and pins the vetted addresses to that hop's client (`resolve_to_addrs`),
  so a DNS answer that changes after validation cannot steer the connect. The
  client is built per hop because redirects are followed manually and each may
  be a different host; fetches are low-frequency (≤ 6 hops per job), so the
  cost is immaterial.

## Not yet fixed

### Correctness

1. **Command-language printers silently truncate overflowing content.**
   `multi_sheet_refusal` only counts statically generated `.pn-sheet` divs; the
   browser-side `PAGINATE_SCRIPT` adds sheets for content taller than the design
   page, which the single-bitmap raster never captures. Needs renderer feedback
   (final sheet count) or a variable-length raster path for receipts — a larger
   change, not done here.

### Security

2. **Printer credentials / pairing tokens stored in plaintext** (SQLite), and
   `printers.password` is returned to the frontend by `list_printers` /
   `get_printer`. Needs a platform keychain (DPAPI / Keychain / libsecret) and
   removing the secret from the `Printer` DTO. Not done here — scope/risk.

3. **`device_id` is client-chosen at pairing** (identity squatting). A device
   holding a valid code/invite can overwrite another device's `paired_devices`
   row by claiming with its `device_id` (`ON CONFLICT(id) DO UPDATE`), and that
   id is stamped on job history. Re-pairing the same phone legitimately reuses
   its id, so the fix is a protocol change (server-minted id returned with the
   token, or proof of the old token on re-pair) that needs phone-app changes
   too — not a PC-only patch.

### Residual / acknowledged

4. **Android PDF page size.** `pdf_page_size_mm` returns `None` on Android (no
   bundled PDFium; the platform plugin renders PDFs), so the A4 fallback remains
   there. The Android plugin would need to report the page size, or the phone
   should send explicit `page_height_mm`.

## Verified on a full build (2026-11-20)

All checks below were run on this branch and are green:

- `tsc -b` — clean.
- `cargo fmt --check` — clean (one `cargo fmt` pass was needed; several branch
  files had landed unformatted).
- `cargo clippy --all-targets -- -D warnings` — clean.
- `pnpm test` (vitest) — green.
- `pnpm test:rust` (Docker) — full suite green, including the pre-existing
  idempotency tests (`duplicate_idempotency_key_does_not_create_a_second_job`,
  `losing_the_insert_race_reports_the_existing_job_…`) and the callback tests
  (IP-literal targets), so the callback pinning left them unaffected.

The verification pass itself surfaced four problems, all fixed on this
branch:

- **The `record_remote_job` upsert was invalidated by the idempotency-scope
  migration.** The phone-side history write targeted
  `ON CONFLICT(idempotency_key)`, but the old key-only unique index is gone
  (replaced by the scoped index on `COALESCE(requested_by_device_id, '')` +
  `idempotency_key`), and SQLite's `ON CONFLICT` target can name columns, not
  expressions — so *every* phone-side via-PC history insert failed with
  "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
  Replaced with an update-then-insert scoped to
  `requested_by_device_id IS NULL` (the phone-side rows under the new index);
  pinned by `retry_with_the_same_key_refreshes_the_history_row`.
- **The multi-page PDF warning test still assumed the old after-the-fact
  path.** `language_dispatch::pdf_jobs_warn_when_only_the_first_page_prints`
  printed a fake `%PDF-1.4` placeholder through a stub renderer that *claimed*
  3 pages; the pre-flight probe reads the document's real page count, which the
  placeholder has none of, so no warning fired. The multi-page case now feeds a
  real minimal three-page PDF (`three_page_pdf` in the test) so the probe sees
  the pages it warns about.
- **Test helpers lagged the branch's new `RemotePrintArgs` fields**
  (`page_width_mm` / `page_height_mm`), and a duplicated `post_claim_from`
  helper — compile errors caught by clippy, fixed in the helpers.
- **Unformatted branch files** — one `cargo fmt` pass.

The open items from the inspection pass are now pinned by new tests:

- **Idempotency scoping** — `the_same_idempotency_key_from_two_devices_creates_two_jobs`:
  two different `requested_by_device_id` values with one key each create and
  run their own job. Note: the migration branch that drops a pre-existing
  `idx_print_jobs_idempotency` is not exercised by a test (every test DB is
  fresh, so the `DROP INDEX IF EXISTS` is a no-op there) — the statement is
  idempotent and the scoped-index semantics are what the tests pin.
- **Claim throttle** — `per_address_claim_budget_throttles_a_guesser`: the
  11th failed claim from one address gets a 429 while a second address still
  gets a 200.
- **Via-PC paper round-trip** — `print_paper_size_flows_into_the_job`: a
  phone-set `settings.paper` override reaches the PC and lands in the job row
  as the resolved paper — both axes overridden, and per-axis fallback to the
  template design size when one axis is absent. The phone-side half was
  already pinned by `phone_and_local_settings_are_identical_for_the_same_options`.
- **Via-PC `records` round-trip** — the phone sends `settings.records`
  (pinned by the same settings-identity test) and the PC's path accepts it
  (`print_margins_and_records_flow_into_the_job`); inline `data` still expands
  client-side via `expand_records`.
- **Multi-page PDF pre-flight** — `multipage_pdf_warns_upfront_for_command_heads_only`
  plus the `pdfium` page-count fixtures.
- **`paper_via_pc` i18n key** was unused (the "not sent via PC" note was
  removed) and has been deleted from `en.ts`/`ja.ts`.
