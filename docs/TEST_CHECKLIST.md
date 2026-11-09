# Real-printer test checklist

PrintNinja's ESC/POS, ZPL, TSPL and CPCL output has been tested against simulated printers (the bundled `dev-printer` and the e2e `virtualprinter`). This checklist covers the gap: running real jobs on real hardware to confirm the output is correct.

**Status: not yet run on a real printer.** This checklist is the plan; results should be filled in as printers are tested.

## What to test

For each printer, run all four jobs below and note pass/fail plus any anomalies (garbled characters, wrong size, missing sections, blank output).

### 1. Text job

- A template with plain text fields (name, date, line items, total).
- Verify: text is legible, line breaks are correct, no character corruption.
- For ESC/POS: check that accented characters and multi-byte characters (CJK, emoji) render correctly or degrade gracefully.

### 2. Barcode / QR job

- A template with at least one barcode (Code 128 or QR) and one QR code.
- Verify: the barcode is scannable by a phone camera or scanner; the QR code encodes the correct data.
- Note: `datamatrix`, `pdf417` and `aztec` are preview-only and will not print (see MISSING_FEATURES item 37, solved).

### 3. Image job

- A template with a logo or small image.
- Verify: the image prints at the expected size and is not corrupted or stretched.
- For thermal printers: check that the image is not too light or too dark (may need density tuning, see MISSING_FEATURES item 4).

### 4. Long job

- A template with many lines (e.g. 50+ line items) to produce a multi-page or very long single-page job.
- Verify: all pages/lines print, no data is dropped mid-job, the printer does not jam or stop early.
- Note: on Bluetooth, large jobs may hit buffer limits (see MISSING_FEATURES item 3).

## Suggested printers to test

Pick 3–4 models that cover the main printer languages and connection types:

| Printer | Language | Connection | Why |
| --- | --- | --- | --- |
| Epson TM-T82 (or similar) | ESC/POS | USB or raw TCP | Most common receipt printer |
| Zebra ZT411 (or similar) | ZPL | USB or raw TCP | Most common label printer |
| TSC TE244 (or similar) | TSPL | USB or raw TCP | Popular in Asia; TSPL-specific quirks |
| A CPCL-capable receipt printer | CPCL | USB or raw TCP | CPCL is less common; needs a PC to render on Android |

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
