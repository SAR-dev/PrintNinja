# PrintNinja: What's Missing (Plain-English Guide)

A simple rewrite of MISSING\_FEATURES.md. Based on a code review of the `develop` branch in November 2026, re-checked item by item against the code on 14 November 2026, and re-checked again against the printing pipeline on 17 November 2026. Nothing here was measured on a real printer unless it says so.

## The short version

PrintNinja is a label and receipt printing app. This guide lists what it **cannot do yet**, what happens when you try, and what you can do instead.

The biggest things to know:

- **No printer has been tested on real hardware** (item 7). Output has only been checked against simulated printers. Several of the items below (49, 50, 52) are exactly the kind of thing only a real print head would reveal.
- **The "Page range" option does nothing** (item 48). It is accepted, validated and recorded, but every page prints regardless.
- **Thermal printers print only one page per job** (item 49). A long receipt or a design that continues onto a second sheet is cut off after the first sheet on ESC/POS, ZPL, TSPL, CPCL and raster printers.

## Open work, in priority order

This is the main list: everything still open, highest priority first. Printer items go by priority (High, Medium, Low) and app-wide items by effort (Small under a day, Medium one to five days), cheapest and most visible first. The details for each item are further down under its number. Numbers are kept from the original file, so gaps are normal: solved items are deleted, and items 1, 3, 5, 11, 26 and 27 were reviewed and dropped as not needed in practice. New items found in the November 2026 printing-pipeline review start at 48.

| Order | Item | Area | Tag | Why |
| --- | --- | --- | --- | --- |
| 1 | 7. Test on real printers | Printers | High | Nothing else matters if real printers do not work; the checklist is in `docs/TEST_CHECKLIST.md`, not yet run on hardware |
| 2 | 49. Thermal printers print one page per job | Printers | High | Long receipts and multi-sheet designs are cut off after the first sheet on every command-language printer |
| 3 | 50. Raster width overruns the print head | Printers | High | The common 58 mm and 80 mm presets produce dots wider than the head, so the right edge clips or wraps |
| 4 | 4. TSPL density, speed, gapless media | Printers | Medium | Common label printers print too light or fail on gapless rolls |
| 5 | 51. ZPL carries no size, darkness or speed | Printers | Medium | Zebra labels rely entirely on the printer's stored settings; nothing in the job tunes or sizes them |
| 6 | 52. CPCL encoder is unverified | Printers | Low | Gated off on Android, never tested on a head, and its graphic header looks wrong |
| 7 | 48. Page range is accepted but never applied | App-wide | Small | The option is in the UI and API, but every page prints regardless |
| 8 | 47. Phone-to-PC traffic is not encrypted | Android | Medium | Plain HTTP on the local network; the architecture doc calls pinned encryption a planned hardening |

## How to read the tags

Every item has a tag. The tags are a judgment from reading the code, not from user reports.

**For printer items (4, 7, 49, 50, 51, 52):**

- **High**: a common setup prints wrong output, fails with no explanation, or the feature is needed for a printer to work at all.
- **Medium**: a real gap that some setups hit. Usually there is a workaround, or it ends in a clear error.
- **Low**: rare, needs special hardware, is just how the protocol works, or has an easy workaround.

**For app-wide items (47 and up):** the tag is the **effort** to fix it.

- **Small**: under one day of work.
- **Medium**: one to five days.

**When an item is done:** once it is fixed **and verified**, delete its section and its row in "Open work, in priority order". This file lists only what is still missing, so there is no solved list. Item numbers are never reused, so gaps are normal.

---

# Part 1: Printers and connections

Every item has its **problem** and its **possible solutions** together. **Recommended** marks the option I would pick first. Note on the repo: the Android project in `src-tauri/gen/android` is generated and not committed, so Android manifest and Gradle changes must go through the `scripts/patch-android-*.mjs` scripts or the plugin's own manifest.

## Printer languages

Printers "speak" different command languages: ESC/POS (receipts), ZPL and TSPL (labels), CPCL, plus raster images and PDF.

**4. \[Medium\] TSPL has no print tuning.** *Problem:* the app never sets print darkness or speed for TSPL printers and does not handle continuous (gapless) rolls. Prints can be too light or too dark, and gapless rolls fail. *Solutions:* (a) Add `DENSITY` and `SPEED` commands from a printer setting. (b) Add a media type option (gap, black mark, continuous) that emits the matching `GAP` / `BLINE` command. (c) **Recommended:** do both in one change, with defaults that keep today's output.

**7. \[High\] Not yet tested on a real print head.** *Problem:* Android's ESC/POS, ZPL and TSPL output was tested only against a simulated printer. There is no guarantee that any specific model works. This is testing work, not code work. *Solutions:* (a) **Recommended:** write a short test checklist (text, barcode, image, long job) and run it on 3–4 popular models. (b) Publish a "tested printers" table in the docs. (c) Let users report results from inside the app.

**49. \[High\] Thermal printers print only one page per job.** *Problem:* the bitmap path (`render_for_language` in `src-tauri/src/commands/print.rs`) rasterizes exactly one bitmap, `paper_height_mm` tall, and sends it once. A design that paginates onto several sheets — a long receipt, or a label taller than the paper — has every sheet after the first dropped, because the renderer produces a single fixed-height screenshot and there is no loop that sends one bitmap per sheet. PDF-language printers do not have this problem: the layout's `break-before:page` turns each sheet into its own PDF page. But ESC/POS, ZPL, TSPL, CPCL and raster get only the first sheet. This is precisely what the "Long job" row of `docs/TEST_CHECKLIST.md` was written to catch, and it has not been run yet. *Solutions:* (a) **Recommended:** for command-language printers, render the *whole* laid-out document at its full content height (or one bitmap per sheet) and send the sheets back to back — for ESC/POS this is one continuous raster, for TSPL/ZPL/CPCL it is one label per sheet. (b) Refuse the job with a clear message when a command-language printer is asked to print more than one sheet, instead of silently printing a truncated receipt. (c) Leave as-is but warn in the preview when the design will paginate on a thermal printer.

**50. \[High\] Raster width overruns the print head.** *Problem:* the number of dots across is computed as `dots_for_mm(paper_width_mm, dpi)` — millimetres times dots-per-inch. At the default 203 dpi this gives 464 dots for 58 mm paper and 640 dots for 80 mm paper. Real 58 mm and 80 mm heads have 384 and 576 dots respectively (their printable width is narrower than the roll: about 48 mm and 72 mm). The app already contains the correct mapping — `dot_width_for_paper` in `src-tauri/src/render/raster.rs` (58 → 384, 80 → 576, 100 → 820) — but that function is dead code: nothing calls it. A raster wider than the head is clipped or wrapped at the right edge, so text and barcodes near the right margin print wrong. This bites on the two most common receipt presets. *Solutions:* (a) **Recommended:** wire the head's real dot count in — add a per-printer "printable width / dot width" that defaults from `dot_width_for_paper`, and clamp or pad the raster to it. (b) Document that `paper_width_mm` means the *printable* width, not the roll width, and change the presets to 72 mm / 48 mm. (c) Keep millimetres but verify and warn when the computed dot width exceeds the head.

**51. \[Medium\] ZPL carries no size, darkness or speed.** *Problem:* the ZPL encoder (`label_langs::zpl::print_bitmap`) emits only `^XA ^MMT ^PR6 ^FO0,0^GFA… ^FS ^XZ`. It never sets the label length (`^LL`), print width (`^PW`) or label home (`^LH`), and never sends darkness (`~SD`) or a real print rate (`^PR`). The result is entirely dependent on the label dimensions and darkness already stored in the printer itself; a mismatch there means mis-sized or too-light labels with no way to correct them from PrintNinja. TSPL does better — its job carries `SIZE` and `GAP` — so this is the ZPL counterpart of item 4. *Solutions:* (a) **Recommended:** emit `^PW`/`^LL`/`^LH` from the paper size, and add a per-printer darkness and speed setting that maps to `~SD` and `^PR`. (b) Do the size commands only, and leave darkness to the printer. (c) Document that Zebra labels must be sized on the printer.

**52. \[Low\] CPCL encoder is unverified.** *Problem:* the CPCL path (`label_langs::cpcl::print_bitmap`) builds its graphic header as `CG <width_dots> <bytes_per_row> 0 0`, which appears to pass the width in dots and the bytes-per-row in the height position — the CPCL `CG` command expects width in bytes and height in dot rows. CPCL is gated off on Android (the printer form only offers the QA'd languages) and has never been run on a real head, so this has not shown up as broken output yet. *Solutions:* (a) **Recommended:** correct the header against the CPCL manual and add a round-trip test like the barcode decoders have. (b) Keep CPCL gated and drop it if no tester can be found. (c) Document it as untested in the Add-printer dialog.

## Limits that are deliberate

These are **not planned**. They were looked at and accepted.

- **Windows has no direct USB.** USB goes through the Windows spooler, so the printer must be installed as a Windows printer first. A design without the spooler was studied and not built for USB. Side effect: jobs are sent as `RAW`, so a PDF only works if the printer itself reads PDF. Bluetooth does have a direct path: the paired device's COM port. The spooler queue is no longer a fallback — it is the row's own manual "Print through the OS driver" option, and a driverless row whose address names no port errors with guidance instead of silently printing another way.
- **Windows printing as administrator is not supported.** Headless Edge quietly does nothing when its parent app is elevated. The app detects this and shows a "restart normally" message. *What to do:* start the app without "Run as administrator", and remove any Compatibility setting that forces it.
- **Linux has no direct USB.** Use a CUPS raw queue and add it as a `system` printer. Bluetooth dials the paired device's RFCOMM socket directly instead; its "Print through the OS driver" option prints through a CUPS queue of the same name when you want the driver in between.
- **iOS and macOS are not supported as print targets.** There is no iOS code, and on macOS both rendering and delivery say "unsupported".
- **Raw TCP stays a plain connection.** No encryption, no sign-in; the app shows a visible "not encrypted" note on these printers.
- **CPCL and raster have no status query.** ESC/POS, ZPL and TSPL are asked "can you print?" before a raw job is sent; CPCL and raster have no query with a documented answer, so no question is sent and those printers behave as if they always can.

**Tip: slow Bluetooth printing on Windows?** First check the stage timings in History. A big `send_ms` number points at the Windows spooler. Cheap things to try before changing any code: turn off "Enable bidirectional support" on the queue's Ports tab, and turn on "Print directly to the printer" on its Advanced tab. These are common Windows fixes and were not tested with PrintNinja. Better still: give the row the printer's COM port as its address — the direct path bypasses the spooler entirely.

# Part 2: App-wide gaps

These are small or medium jobs that can be picked up without a big project. The tag is the **effort**: **Small** is under a day, **Medium** is one to five days.

**48. \[Small\] Page range is accepted but never applied.** *Problem:* the Print page, the phone flow, the REST API (`settings.page_range`) and deep links (`printninja://print?page_range=1-3`) all expose a "Page range" option. It is validated syntactically (`validate_page_range` in `src-tauri/src/commands/print.rs`) and stored on the job's `settings_json`, but nothing ever reads it back to slice the document: the pipeline renders every record and sends every page, and no transport sets an IPP `page-ranges` attribute. A user who asks for pages 1–3 gets the whole job. This is a feature that silently does nothing, which is worse than not offering it. *Solutions:* (a) **Recommended:** either implement slicing (PDF via `page-ranges` on IPP/CUPS, and a per-sheet loop for command-language printers) or remove the field from the UI and API until it is real. (b) Implement it for the PDF path only and hide it for thermal printers. (c) Leave the field but show an explicit "not yet supported" note next to it.

## Android

**47. \[Medium\] Phone-to-PC traffic is not encrypted.** *Problem:* pairing, shared rendering and Print via PC use plain HTTP on the local network, and the pairing code is an introduction, not proof of identity (`docs/architecture/PHONE_AND_PC_SHARING.md`). Anyone on the same network who can read the traffic can see print data and the device token. Release builds already allow this on purpose (see the cleartext patch in `scripts/patch-android-signing.mjs`). *Solutions:* (a) **Recommended:** TLS with a self-signed certificate made on the PC and pinned by the phone during pairing, so the pairing code also vouches for the certificate. (b) Keep plain HTTP but sign each request with a key exchanged at pairing, which stops tampering but not reading. (c) Document that pairing should only be used on a trusted network, and keep (a) for later.

---

---

*Source: MISSING\_FEATURES.md, with solutions added after checking the repo. Code paths were mostly left out to keep this easy to read; see the original file for exact locations.*
