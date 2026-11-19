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

**Decision: keep it, but scope it to printer type — do not remove it.**

- **Command-language (thermal) printers** (`escpos` / `zpl` / `tspl` / `cpcl` /
  `raster`): hide the paper-size override and always print at the template's
  design size. The physical size is fixed by the roll/head, already represented
  by the printer's registered `paper_width_mm`, so the override only invites
  mis-scaling (see correctness finding #2) and shows irrelevant presets
  (A4/Letter/Photo) on a label printer.
- **Paper-based printers** (`pdf` / `system` / `ipp`): keep the override and the
  fit modes — this is where "print a small design onto A4/Letter" and
  `fit-width` / `fit-page` / `fill` are meaningful.

Rationale for not deleting it outright: the fit modes are defined as the
design→paper mapping (`layout.rs::compute`), so locking paper to the design size
everywhere collapses them to scale ≈ 1. Desktop/office printing (Windows
spooler / CUPS / IPP) is a first-class path and genuinely needs the decoupling.

For reference, the paper size **is** used in local printing (not preview-only):
`usePrintActions.ts` sends `page_width_mm` / `page_height_mm` to `print_html`,
which `resolve_content` → `effective_geometry` applies to override the template
design size and size the layout/raster. It is preview-only in **Print via PC**,
where the API has no paper field — a minor inconsistency worth closing if this
scoping work is done (either send `paper` through the API or leave it and keep
the UI honest about it being ignored).

Implementation sketch: in `usePrintPaper.tsx`, treat command-language printers
like the via-PC path (force `reqPaperW`/`reqPaperH` to `null` and drop the paper
field from the summary), and gate `PaperSizeFields` visibility on
`selectedPrinter.language === "pdf"` (or `printer_type` being `system`/`ipp`).
