# PrintNinja: What's Missing (Plain-English Guide)

A simple rewrite of MISSING\_FEATURES.md. Based on a code review of the `develop` branch in November 2026, re-checked item by item against the code on 14 November 2026. Nothing here was measured on a real printer unless it says so.

## The short version

PrintNinja is a label and receipt printing app. This guide lists what it **cannot do yet**, what happens when you try, and what you can do instead.

The biggest things to know:

- **No printer has been tested on real hardware** (item 7). Output has only been checked against simulated printers.
- **Background print failures on Android are silent** (item 41). Nothing tells you a job failed until you open History.
- **The server has no read or list endpoints for datasets, profiles, fonts and settings** (item 28).
- **Batch printing is half-built** (item 18): the table, worker and History column exist, but nothing creates a batch.
- **The version-history screen does not exist** (item 34), although the README promises it.

## Open work, in priority order

This is the main list: everything still open, highest priority first. Printer items go by priority (High, Medium, Low) and app-wide items by effort (Small under a day, Medium one to five days), cheapest and most visible first. The details for each item are further down under its number. Numbers are kept from the original file, so gaps are normal: solved items are deleted, and items 1, 3, 5, 11, 26 and 27 were reviewed and dropped as not needed in practice.

| Order | Item | Area | Tag | Why |
| --- | --- | --- | --- | --- |
| 1 | 7. Test on real printers | Printers | High | Nothing else matters if real printers do not work; the checklist is in `docs/TEST_CHECKLIST.md`, not yet run on hardware |
| 2 | 4. TSPL density, speed, gapless media | Printers | Medium | Common label printers print too light or fail on gapless rolls |
| 3 | 41. No background job notification | Android | Medium | Failures are invisible |
| 4 | 47. Phone-to-PC traffic is not encrypted | Android | Medium | Plain HTTP on the local network; the architecture doc calls pinned encryption a planned hardening |
| 5 | 28. No read or list endpoints | Server | Medium | Integrations need a full sync cache without it |
| 6 | 18. Batch printing entry point | Backend | Medium | Worker, metrics and History column already exist |
| 7 | 34. Version history screen | Screens | Medium | Promised in the README, and the API is ready |

## How to read the tags

Every item has a tag. The tags are a judgment from reading the code, not from user reports.

**For printer items (4 and 7):**

- **High**: a common setup prints wrong output, fails with no explanation, or the feature is needed for a printer to work at all.
- **Medium**: a real gap that some setups hit. Usually there is a workaround, or it ends in a clear error.
- **Low**: rare, needs special hardware, is just how the protocol works, or has an easy workaround.

**For app-wide items (18 and up):** the tag is the **effort** to fix it.

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

## Limits that are deliberate

These are **not planned**. They were looked at and accepted.

- **Windows has no direct USB.** USB goes through the Windows spooler, so the printer must be installed as a Windows printer first. A design without the spooler was studied and not built for USB. Side effect: jobs are sent as `RAW`, so a PDF only works if the printer itself reads PDF. Bluetooth does have a direct path: the paired device's COM port. The spooler queue is no longer a fallback — it is the row's own manual "Print through the OS driver" option, and a driverless row whose address names no port errors with guidance instead of silently printing another way.
- **Windows printing as administrator is not supported.** Headless Edge quietly does nothing when its parent app is elevated. The app detects this and shows a "restart normally" message. *What to do:* start the app without "Run as administrator", and remove any Compatibility setting that forces it.
- **Linux has no direct USB.** Use a CUPS raw queue and add it as a `system` printer. Bluetooth dials the paired device's RFCOMM socket directly instead; its "Print through the OS driver" option prints through a CUPS queue of the same name when you want the driver in between.
- **iOS and macOS are not supported as print targets.** There is no iOS code, and on macOS both rendering and delivery say "unsupported".
- **Raw TCP stays a plain connection.** No encryption, no sign-in; the app shows a visible "not encrypted" note on these printers.

**Tip: slow Bluetooth printing on Windows?** First check the stage timings in History. A big `send_ms` number points at the Windows spooler. Cheap things to try before changing any code: turn off "Enable bidirectional support" on the queue's Ports tab, and turn on "Print directly to the printer" on its Advanced tab. These are common Windows fixes and were not tested with PrintNinja. Better still: give the row the printer's COM port as its address — the direct path bypasses the spooler entirely.

# Part 2: App-wide gaps

These are small or medium jobs that can be picked up without a big project. The tag is the **effort**: **Small** is under a day, **Medium** is one to five days.

## Backend (the Rust app)

**18. \[Medium\] Batch printing is half-built.** *Problem:* the database table, the worker, the metrics and the History screen (a "batch" column and filter) all exist, but **nothing ever creates a batch**. The column is always empty, the filter matches nothing, and the metric always reads 0. *Solutions:* (a) **Recommended:** add `POST /v1/batches` (and a matching app command) that takes a list of print requests, inserts one `batches` row and queues each job with its `batch_id`. (b) Add a "Print selected" button in History or on a template's data list that calls it. (c) If batches are not wanted soon, hide the column, filter and metric until they are.

## Sync server

**28. \[Medium\] Datasets, profiles, fonts and settings cannot be read or listed directly.** *Problem:* their API only supports writing and deleting. Reads work only through the sync stream, so "list my datasets" needs a full sync cache. *Solutions:* (a) **Recommended:** add paged `GET` list and `GET /{id}` endpoints, copying the `pageSchema` pattern from templates. (b) Add ETag support so clients can cache cheaply. (c) Update the OpenAPI document.

## Frontend (the screens)

**34. \[Medium\] Version history has no screen.** *Problem:* the README promises "version history with diff and restore". The server already has endpoints to list, view and restore versions, but nothing in the app can show them. *Solutions:* (a) **Recommended:** add a "History" side panel in the designer that lists versions from `GET /v2/templates/{id}/versions`, with a Restore button. (b) Add a diff view (two versions side by side or as changed fields). (c) Ship list and restore first and the diff later. (d) If it will not be built soon, remove the claim from the README.

## Android

**41. \[Medium\] No notification when a background job succeeds or fails.** *Problem:* the only notification is the pinned "service is running" line. A job that fails in the background (printer offline, PC asleep, render timeout) is invisible until you reopen the app and read History. *Solutions:* (a) **Recommended:** post a notification on failure (and optionally success) from the worker, through the Android plugin or a Tauri notification plugin. (b) Add a setting: "Notify on: failures only / all / never". (c) Show the count of waiting jobs in the pinned notification. (d) Tapping a notification opens History on that job.

**47. \[Medium\] Phone-to-PC traffic is not encrypted.** *Problem:* pairing, shared rendering and Print via PC use plain HTTP on the local network, and the pairing code is an introduction, not proof of identity (`docs/architecture/PHONE_AND_PC_SHARING.md`). Anyone on the same network who can read the traffic can see print data and the device token. Release builds already allow this on purpose (see the cleartext patch in `scripts/patch-android-signing.mjs`). *Solutions:* (a) **Recommended:** TLS with a self-signed certificate made on the PC and pinned by the phone during pairing, so the pairing code also vouches for the certificate. (b) Keep plain HTTP but sign each request with a key exchanged at pairing, which stops tampering but not reading. (c) Document that pairing should only be used on a trusted network, and keep (a) for later.

---

---

*Source: MISSING\_FEATURES.md, with solutions added after checking the repo. Code paths were mostly left out to keep this easy to read; see the original file for exact locations.*
