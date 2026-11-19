# Print Flow — Cross-Path Consistency (Mismatches)

A review of whether every print option produces the same output across the three
entry points:

- **Local** — `print_html` Tauri command (the desktop/phone's own pipeline).
- **Via PC** — `remote_print` command → the PC's `POST /v1/print`.
- **API** — `POST /v1/print` directly (paired phone / loopback).

A "mismatch" is a setting that is honoured on one path and dropped or changed on
another. The paper-size override was the first one found; this documents it and
the remaining ones.

---

## 1. Paper size dropped on the via-PC path — FIXED

`page_width_mm` / `page_height_mm` were honoured locally (sent to `print_html`,
feeding `resolve_content` → `effective_geometry` → the raster/PDF size) but the
via-PC path had no field for them: the phone sent nothing and the PC printed at
the template's design size.

Fixed on this branch: `RemotePrintArgs` now carries `page_width_mm` /
`page_height_mm`, `remote_settings` emits a `paper` object, and `POST /v1/print`
reads `settings.paper` into `PrintRequest`. The paper field is shown in via-PC
mode like the local path.

---

## 2. `records` (Pages) ignored via PC when `data_url` is used — open

The "Pages" count (`records`) is communicated differently per path:

- **Local / API** — the raw `records` value is sent (top-level, or
  `settings.records`), and the pipeline repeats one fetched object `records`
  times (or prints an array's own length).
- **Via PC** — the phone *expands* `records` into the inline `data` array up
  front (`remote_print_inner` → `expand_records`), and `records` is **not** in
  `settings`.

When a `data_url` is used, the inline `data` is empty (`None`), so
`expand_records(None, records)` produces `records` blank objects. The PC's
pipeline then fetches `data_url` and **overwrites** that array with the fetched
value (`run_stages`: `fetched = fetch(url)`). The expansion is lost, and because
`records` was never in `settings`, the PC prints the fetched value's own length —
one page for a single object — instead of `records` pages.

Consequence: with **Pages = 5** and a **data URL**, a local print yields 5 pages
and a via-PC print yields 1. Inline `data` (test data) is unaffected because the
expansion lands on real data there.

Root cause: `records` is expressed only as an expanded array, and `data_url`
overrides `data` on the PC. Fix options: send `records` through `settings` (the
PC already reads `settings.records`), or apply the expansion to the fetched
value on the PC. The `records` field comment in `remote_print.rs` notes the
expansion was kept for backward compatibility with older PCs.

---

## 3. `records` expansion can hit the inline-data size cap via PC — minor

Because via-PC expands a single object into an array client-side, a large
`records` × a moderately sized object can exceed `MAX_API_DATA_BYTES` (1 MiB) and
be refused ("use `data_url`"), where the local path (which expands server-side)
prints the same job without issue. Edge case, but a direct consequence of the
expansion strategy above.

---

## 4. `source` recorded differently per path — cosmetic

- Local: `source` is `"ui"` (or `"test"` for the test-data run).
- Via PC: the PC records the job with `source: "api"` (the phone's own history
  row is `"ui"`).

History-only; does not change output. Worth noting only if history filtering by
source is used to tell local prints from remote ones.

---

## 5. `pdf` input unavailable via `remote_print` — informational

`RemotePrintArgs` has no `pdf` field, so a raw PDF cannot be printed through a
paired PC. This is **not** a UI mismatch — the print page never sends `pdf` on
any path (PDF input is API-only, `POST /v1/print` with a base64 `pdf` body). Not
flagged as a defect, just a boundary worth knowing.

---

## Checked and consistent

For completeness, these were verified to behave the same on all three paths:
orientation, fit mode, page range, grayscale, copies, margins, `http_method`,
`data` (inline), `test`/test-data, and the `data_url` fetch itself (same
`DataFetcher` SSRF guard on whichever device renders).
