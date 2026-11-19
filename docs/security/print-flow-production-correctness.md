# Print Flow — Production Correctness Review

Companion to `docs/security/print-flow-vulnerabilities.md`. That document covered
security; this one covers *functional* defects that make a print come out wrong —
**truncated output**, **gibberish**, **wrongly-sized labels**, or **silent
successes that did not print what was asked**. The flow was traced end to end
through the render, raster, encoder and transport layers.

The pipeline is, again, unusually careful: layout math is pinned to fixtures in
both Rust and TypeScript (`layout.rs` ↔ `printLayout.ts`), the ESC/POS width
correction is handled, raw printers are pre-flighted with a language-appropriate
status query, IPP rejects are read from the response body rather than the HTTP
status, and the Windows spooler chooses `PDF` vs `RAW` from the queue's offered
datatypes. The findings below are the residual cases where a correct-looking job
still prints wrongly.

---

## Findings

### 1. Command-language printers silently truncate content that overflows the design page — Medium

**Location:** `src-tauri/src/commands/print.rs:653` (`multi_sheet_refusal`),
`src-tauri/src/render/layout.rs:160` (`PAGINATE_SCRIPT`), `src-tauri/src/render/mod.rs:312` (`html_to_raster`)

There are two independent pagination mechanisms:

1. **Static layout pagination** — for `actual`/`fit-width`, a design taller than
   the content box produces several `.pn-sheet` elements at layout time
   (`layout.rs:compute` → `sheets_document`). `multi_sheet_refusal` counts these
   and refuses the job on a command-language printer.
2. **Dynamic content pagination** — the `PAGINATE_SCRIPT` runs in the browser and,
   when a record's rendered *content* is taller than the design page height
   (`data-dh`), clones additional `.pn-sheet` elements below the first
   (`layout.rs:160`).

`multi_sheet_refusal` only ever sees the static HTML (step 1). It counts
`class="pn-sheet"` **before** the browser runs the pagination script, so the
dynamic case (step 2) is invisible to it and the job is *not* refused.

A command-language printer (ESC/POS, ZPL, TSPL, CPCL, raster) receives a **single
bitmap** produced by a screenshot of `w_px × h_px` dots (`render_for_language` →
`html_to_raster`). The screenshot captures the top `h_px` dots, so every
dynamically-added sheet below the first is discarded.

**What the operator sees:** a receipt or label whose content is taller than the
design page (a long `{{#each}}` item list, long text, a table that wraps) prints
**only the first page** on a thermal printer, with no warning and a `success`
status. The same job on a PDF printer paginates into a multi-page PDF correctly.

The code acknowledges the gap in a comment ("a single design that the browser
later paginates onto extra sheets is not visible here"), but nothing surfaces it.

**Recommendation:** detect the dynamic case. The simplest robust fix is to run the
content measurement before the refusal check (or have the renderer report the
final sheet count back to the pipeline) and refuse or warn for command-language
printers when the content paginates. For receipts specifically, support
variable-length output (an unbounded raster) rather than a fixed design height.

---

### 2. PDF input to a command-language printer defaults to A4 paper — Medium

**Location:** `src-tauri/src/commands/print.rs:1095` (`resolve_content`),
`src-tauri/src/render/pdfium.rs:127` (`pdf_to_raster`), `src-tauri/src/api/routes.rs:699`

When a job carries raw PDF bytes and the printer speaks a command language, the
document must be rasterized to the head's dot dimensions. That size comes from
`paper_w_mm` / `paper_h_mm`, which `resolve_content` fills as:

```rust
req.page_width_mm.or(row_w).unwrap_or(DEFAULT_PAPER_W_MM),   // 210 mm
req.page_height_mm.unwrap_or(DEFAULT_PAPER_H_MM),           // 297 mm
```

Only the printer's stored *width* is consulted (`row_w`); there is no stored
height, so the height always falls back to **297 mm (A4)** unless the caller
explicitly sends `page_height_mm`. The REST `POST /v1/print` handler sets both
`page_width_mm` and `page_height_mm` to `None` for PDF jobs (`routes.rs:699`),
so the A4 default is the *only* behavior on the API path.

`pdf_to_raster` then renders the PDF's first page at `w_px × h_px`, scaling it to
fit with aspect preserved and anchoring it top-left on a white canvas.

**What the operator sees:** a small label PDF (say 40 × 30 mm) printed to a ZPL /
TSPL / CPCL / ESC/POS head is scaled to fit a 210 × 297 mm canvas. The resulting
bitmap is far larger than the physical head (the right side is clipped) and/or the
label is printed surrounded by a huge blank area, with the label length (`^LL`,
`SIZE … mm`) declared as ~297 mm. The label comes out at the wrong size — the
classic "printed but not as expected."

**Recommendation:** read the PDF's own `MediaBox`/page size (PDFium already
parses the document; `PdfRenderConfig` can report the page dimensions) and use it
to size the raster when the caller supplied no explicit paper size. Until then,
require/derive `page_height_mm` for the PDF-to-command-language path instead of
silently falling back to A4.

---

### 3. Multi-page PDF prints only the first page on command-language printers — Low (acknowledged)

**Location:** `src-tauri/src/commands/print.rs:1984` (`render_pdf_input`),
`src-tauri/src/render/pdfium.rs:116`

`pdf_to_raster` rasterizes only the first page; `render_pdf_input` appends a
warning ("The PDF has N pages; only the first page was printed") when the page
count is > 1. This is correct for the single-label use case and *is* surfaced to
the user, but the warning arrives **after** the print already went out with the
wrong output. There is no pre-flight refusal.

**Recommendation:** optional — warn in the print dialog before sending, or refuse
multi-page PDFs to single-page command-language printers.

---

### 4. Windows driver queues default to `language = PDF`; a GDI-only driver prints the PDF source — Low (footgun)

**Location:** `src-tauri/src/transport/windows_spooler.rs:100` (`choose_datatype`),
`src-tauri/src/transport/windows_spooler.rs:361` (`language: PrinterLanguage::Pdf`),
`src-tauri/src/commands/print.rs:1907` (the `pdf_sent_as_raw` warning)

`enumerate_printers` reports every Windows queue as `language: Pdf`, and a
`system`/USB/Bluetooth-via-driver row defaults to PDF. For a PDF job, the spooler
declares `PDF` only when the queue's print processor offers it; otherwise it falls
back to `RAW` (`choose_datatype`). A GDI-only driver receives `RAW` bytes that are
actually a PDF and prints the PDF **source text** (gibberish). The send path logs
the fallback, and `pdf_sent_as_raw` surfaces a warning on the response — but the
job has already gone out garbled.

A thermal/label printer installed as a Windows queue with a driver (the common
setup) is the classic case: it is discovered as PDF, the driver is GDI-only, and
the first label prints as raw PDF text until someone changes the row's language
to the native command language.

**Recommendation:** at printer-add time, when a Windows queue's processor offers
no PDF datatype, proactively suggest setting the language (or warn that PDF jobs
will print as RAW), rather than discovering it from a garbled first print.

---

## Verified non-issues (checked, no defect found)

For completeness, these were specifically checked and are correct:

- **Rust ↔ TypeScript layout drift.** `compute` (`layout.rs`) and
  `computePrintLayout` (`printLayout.ts`) produce identical placements, both
  pinned to `src-tauri/tests/fixtures/layout_cases.json`. No preview/print
  divergence.
- **ESC/POS 58/80 mm width correction.** `raster_width_dots` maps a 58 mm roll to
  384 dots (the physical head), and `fit_to_dots` scales the whole sheet uniformly
  to that width — no horizontal squish or wrap, and the aspect ratio is preserved.
- **Raster bit packing / luminance threshold.** MSB-first packing, and the
  `0.299/0.587/0.114` luminance with a `< 128` threshold, are pinned to a golden
  `0xAD` byte matching the Android `RasterDotsTest` — no inversion or drift.
- **Label encoder geometry.** ZPL `^GFA` (total-bytes, field-count, bytes-per-row),
  TSPL `BITMAP` raw bytes, and CPCL `EG` (bytes-per-row, rows, hex) headers all
  agree with the packed data that follows them.
- **IPP `document-format` selection.** `application/pdf` for PDF jobs,
  `application/octet-stream` for command languages so cupsd / raw IPP pass the
  bytes through unchanged — no `PDF`-declared-ESC/POS filtering.
- **Copies handling.** IPP/CUPS get a hardware `copies` attribute; raw transports
  repeat the payload once per copy; a PDF on a raw wire is sent as one job per
  copy (a PDF reader would otherwise print only the first).
- **`records` expansion.** A single object repeats `records` times, an array
  prints its own length; the via-PC path expands client-side and sends an array,
  the local/API path lets the pipeline expand — no double-counting.
- **`escape_srcdoc`.** Only `&` and `"` are escaped, which is sufficient to keep
  template content from breaking out of the `srcdoc` attribute; the (sanitized)
  HTML cannot inject sibling `.pn-sheet` nodes, so the `multi_sheet_refusal` count
  is not corruptible by user data.
