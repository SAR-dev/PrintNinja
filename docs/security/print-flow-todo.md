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

## Not yet fixed

### Correctness

1. **Command-language printers silently truncate overflowing content.**
   `multi_sheet_refusal` only counts statically generated `.pn-sheet` divs; the
   browser-side `PAGINATE_SCRIPT` adds sheets for content taller than the design
   page, which the single-bitmap raster never captures. Needs renderer feedback
   (final sheet count) or a variable-length raster path for receipts — a larger
   change, not done here.

2. **Multi-page PDF → command-language printer prints only page 1**, warned after
   the fact. Could be a pre-flight refusal instead.

3. **Windows driver queues default to `language = PDF`** and a GDI-only driver
   prints the PDF source as garbage (warned only after the send). Would ideally
   surface at printer-add time from the queue's offered datatypes.

### Security

4. **Printer credentials / pairing tokens stored in plaintext** (SQLite), and
   `printers.password` is returned to the frontend by `list_printers` /
   `get_printer`. Needs a platform keychain (DPAPI / Keychain / libsecret) and
   removing the secret from the `Printer` DTO. Not done here — scope/risk.

5. **Idempotency key not scoped to the caller.** A unique index on the bare
   `idempotency_key` lets one authenticated caller suppress or observe another's
   job (via the `duplicate` response returning the winner's `job_id`). Fix: a
   composite unique index on `(requested_by_device_id, idempotency_key)` and only
   returning the existing `job_id` to the same caller. Needs a migration.

6. **Pairing claim endpoint is not rate-limited per source address** (the
   per-window 5-guess lockout is the only guard; a LAN attacker can lock the
   window as a nuisance DoS). Add per-IP throttling like `render_share`'s
   `AUTH_FAILURES` to `pair_routes`.

### Residual / acknowledged

7. **Callback DNS check has the same TOCTOU as `data_url`** — the check runs at
   validation time, the POST re-resolves at dispatch. Closing it fully requires
   pinning the validated address for the outbound connection (see
   `data/fetcher.rs`'s own comment on DNS rebinding).

8. **Android PDF page size.** `pdf_page_size_mm` returns `None` on Android (no
   bundled PDFium; the platform plugin renders PDFs), so the A4 fallback remains
   there. The Android plugin would need to report the page size, or the phone
   should send explicit `page_height_mm`.

## Paper-size option on the Print page — decision (UX/product)

**Decision: keep the paper-size override for all printer types. Do not remove
it and do not hide it for thermal printers.**

An earlier draft of this note proposed hiding the override for command-language
(thermal) printers and always printing at the design size. Implementing that
surfaced two problems that overturn it:

1. **The override is how a design is matched to a different roll width.** For a
   command-language printer the raster size comes from `page_width_mm` /
   `page_height_mm` (`raster_width_dots` / `dots_for_mm` in `render/raster.rs`).
   An 80 mm design on a 58 mm receipt printer must set paper = 58 mm (with
   `fit-width`) so the design is scaled down to the head; forcing paper =
   design size instead sends an 80 mm raster and the head clips the right side.
   So the override has a legitimate thermal use, not just a desktop one.

2. **The existing tests pin the current behaviour on a thermal printer.**
   `src/test/print.test.tsx` uses an `escpos` mock printer and asserts
   "sends an explicit paper size override" (`page_width_mm: 210`) and that the
   Paper-size dropdown can be re-selected. Hiding the field or changing the
   presets for thermal printers breaks those tests.

Conclusion: the paper-size control is a real, output-affecting setting
(confirmed: `usePrintActions.ts` sends `page_width_mm` / `page_height_mm` to
`print_html`, which `resolve_content` → `effective_geometry` applies to size the
layout and raster). It is only preview-only in **Print via PC**, where the API
has no paper field.

If a change is still wanted, the safe improvement is **additive**: add
label-width presets (40 / 58 / 80 / 100 mm) alongside A4 / Letter / Photo, so
thermal users see relevant options without removing A4. This still requires
updating the two `print.test.tsx` cases above if the preset *set* is made
printer-type-aware. Any non-additive change (hiding, or replacing the office
presets for thermal) needs a product decision that thermal roll-width matching
is out of scope, plus test updates.
