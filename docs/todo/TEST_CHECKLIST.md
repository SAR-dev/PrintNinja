# Real-printer test checklist

PrintNinja's ESC/POS, ZPL, TSPL and CPCL output has been tested against simulated printers (the bundled `dev-printer` and the e2e `virtualprinter`). This checklist covers the gap: running real jobs on real hardware to confirm the output is correct.

**Status: not yet run on a real printer.** This checklist is the plan; results should be filled in as printers are tested. The "implemented, not yet verified" items below are already in code but have only been checked against simulated printers.

## What to test

For each printer, run all four jobs below and note pass/fail plus any anomalies (garbled characters, wrong size, missing sections, blank output).

### 1. Text job

- A template with plain text fields (name, date, line items, total).
- Verify: text is legible, line breaks are correct, no character corruption.
- For ESC/POS: check that accented characters and multi-byte characters (CJK, emoji) render correctly or degrade gracefully.

### 2. Barcode / QR job

- A template with at least one barcode (Code 128 or QR) and one QR code.
- Verify: the barcode is scannable by a phone camera or scanner; the QR code encodes the correct data.
- Note: every barcode type prints now. If you add a Data Matrix, PDF417, Aztec, UPC-E or ITF-14, verify it with a scanner that supports that symbology — a phone camera usually cannot read them.

### 3. Image job

- A template with a logo or small image.
- Verify: the image prints at the expected size and is not corrupted or stretched.
- For thermal printers: check that the image is not too light or too dark (TSPL density tuning is implemented — see the "Implemented, not yet verified" table below for what to check on the head).

### 4. Long job

- A template with many lines (e.g. 50+ line items) to produce a multi-page or very long single-page job.
- Verify: all pages/lines print, no data is dropped mid-job, the printer does not jam or stop early.
- Note: on Bluetooth, large jobs may hit buffer limits; if a printer drops or garbles data, note it here.

## Implemented, not yet verified on a real printer

These were previously listed as missing in `docs/MISSING_FEATURES.md` but are now implemented in code (with unit tests). They have only been exercised against simulated printers, so run the jobs above on a real head for each language and record the result in the table below. Their former item numbers are kept for reference.

| Former item | What the code now does | What to verify on the head |
| --- | --- | --- |
| 4. TSPL density, speed, gapless media | `TsplTuning` emits `DENSITY` and `SPEED` commands and selects the media type (`GAP`, `BLINE` or `GAP 0,0` for continuous rolls) from the printer's saved settings; unit tests added. | Print with density and speed set, and on a continuous (gapless) roll. Confirm darkness, speed and label separation follow the settings. There is no dedicated UI field yet — values are saved by the `set_printer_tspl_tuning` command. |
| 51. ZPL carries no size, darkness or speed | The ZPL job now emits `^PW` (print width in dots), `^LL` (label length in dots) and `^LH0,0` from the paper size; darkness is deliberately left to the printer and the print rate stays `^PR6`. | Print a label sized in PrintNinja on a Zebra whose stored size is wrong, and confirm size/home follow the job. Confirm too-light output is still a printer-setting issue. |
| 52. CPCL encoder is unverified | The graphic header is now `EG <width-bytes> <height-dot-rows> 0 0 <hex data>` (hex, not `CG` binary), with a round-trip test asserting header and data agree. | Run the image job on a real CPCL printer and confirm the graphic is whole, correctly sized and not garbled. CPCL is still gated off on Android — test from desktop or a paired PC. |
| 50. Raster width overruns the print head | ESC/POS at 203 dpi now uses the head's real dot count via `raster_width_dots` (58 mm → 384, 80 mm → 576) and scales the layout onto it; new presets label this "Printable width" (48/72 mm). | Print the text and barcode jobs on a 58 mm and an 80 mm receipt printer; confirm right-edge text/barcodes no longer clip or wrap. |
| 49. Thermal printers print one page per job | A command-language job that lays out more than one sheet is now refused with a clear message, and the preview warns before printing; PDF printers are unaffected. | Run the long job with several records on ESC/POS, ZPL, TSPL and CPCL printers; confirm the job is refused with the message instead of silently printing only the first sheet. Note: the refusal counts sheets the layout wrote, not extra sheets a browser might paginate from a single design. |
| 48. Page range is accepted but never applied | The "Page range" input was removed from the desktop and phone print flows; a job still carrying one (API or deep link) now gets an explicit "not supported" warning instead of silently printing every page. Slicing itself is still not implemented. | Send a deep link / API print with `page_range=1-3` and confirm the warning appears in the job result. |

## Suggested printers to test

Pick 3–4 models that cover the main printer languages and connection types:

| Printer | Language | Connection | Why |
| --- | --- | --- | --- |
| Epson TM-T82 (or similar) | ESC/POS | USB or raw TCP | Most common receipt printer |
| Zebra ZT411 (or similar) | ZPL | USB or raw TCP | Most common label printer |
| TSC TE244 (or similar) | TSPL | USB or raw TCP | Popular in Asia; TSPL-specific quirks |
| A CPCL-capable receipt printer | CPCL | USB or raw TCP | CPCL is less common; renders on the device but is not offered on Android yet (QA gate), so test it on desktop or through a paired PC |

## How to run the test

1. Add the printer in PrintNinja (see README "How to add a USB or Bluetooth printer" for Windows/Linux; on Android use direct USB or paired Bluetooth).
2. Run a **test print** from the Add dialog to confirm the connection works.
3. Create one template per job type (text, barcode, image, long job), or use a single template that includes all four.
4. Print each job and inspect the output against the checklist above.
5. Record results in the table below.

## Results

| Printer | Model | Language | Connection | Text | Barcode | Image | Long job | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |
| | | | | | | | | |
| | | | | | | | | |
| | | | | | | | | |
