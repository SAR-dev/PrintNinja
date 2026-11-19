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

## 2. `records` (Pages) ignored via PC when `data_url` is used — FIXED

The "Pages" count (`records`) is communicated differently per path:

- **Local / API** — the raw `records` value is sent (top-level, or
  `settings.records`), and the pipeline repeats one fetched object `records`
  times (or prints an array's own length).
- **Via PC** — the phone *expanded* `records` into the inline `data` array up
  front (`remote_print_inner` → `expand_records`), and `records` was **not** in
  `settings`.

With a `data_url`, the inline `data` is empty (`None`), so the expansion produced
blank objects that the PC then overwrote with the fetched URL value, and the page
count was lost.

Fixed on this branch: `remote_settings` now also emits `settings.records` (when
`> 1`), and `POST /v1/print` already read `settings.records`, so the PC repeats
a fetched `data_url` object `records` times — matching the local path. The
client-side `expand_records` fallback is retained for older PCs (it only covers
inline `data`); see finding 3 for its residual size cap.

---

## 3. `records` expansion can hit the inline-data size cap via PC — minor (open)

Because the via-PC path still expands a single inline object into an array
client-side (retained for older PCs), a large `records` × a moderately sized
object can exceed `MAX_API_DATA_BYTES` (1 MiB) and be refused ("use `data_url`"),
where the local path (which expands server-side) prints the same job without
issue. With finding 2 fixed, the workaround is sound: use a `data_url` (which now
repeats `records` correctly). Edge case.

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
