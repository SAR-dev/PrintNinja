# PrintNinja: What's Missing (Plain-English Guide)

A simple rewrite of MISSING\_FEATURES.md. Based on a code review of the `develop` branch in November 2026. Nothing here was measured on a real printer unless it says so.

## The short version

PrintNinja is a label and receipt printing app. This guide lists what it **cannot do yet**, what happens when you try, and what you can do instead.

The biggest things to know:

- **Phone pairing is broken in release builds of the Android app** (item 39). Only debug builds work.
- **Android printing has never been tested on a real printer** (item 7). It has only been tested against a simulated one.
- **Android asks for USB permission every single time** you connect (item 8).
- **Queued jobs on Android do not print after the app is killed** (item 43).
- **Some barcodes show in the preview but print blank** (item 37).
- **Windows printers with GDI-only drivers cannot print PDFs** (item 15).

## How to read the tags

Every item has a tag. The tags are a judgment from reading the code, not from user reports.

**For printer items (1–17):**

- **High**: a common setup prints wrong output, fails with no explanation, or the feature is needed for a printer to work at all.
- **Medium**: a real gap that some setups hit. Usually there is a workaround, or it ends in a clear error.
- **Low**: rare, needs special hardware, is just how the protocol works, or has an easy workaround.

**For app-wide items (18–45):** the tag is the **effort** to fix it.

- **Small**: under one day of work.
- **Medium**: one to five days.

**Marking solved items:** once an item is fixed **and verified**, mark it as solved with a green check (✅) prefixed to its number. `**1. \[Low\] …**` becomes `**✅ 1. \[Low\] …**`. Keep the tag, number and original text intact so the history stays visible, and move the item's row to the bottom of its "Suggested order" table so the open work stays on top.

---

# Part 1: Printers and connections

Every item has its **problem** and its **possible solutions** together. **Recommended** marks the option I would pick first. Note on the repo: the Android project in `src-tauri/gen/android` is generated and not committed, so Android manifest and Gradle changes must go through the `scripts/patch-android-*.mjs` scripts or the plugin's own manifest.

## Bluetooth on Android

**1. \[Low\] No Bluetooth Low Energy (BLE).** *Problem:* the app only supports classic Bluetooth (the older "serial port" kind). A BLE-only printer cannot connect. *Solutions:* (a) **Recommended for now:** say "classic Bluetooth only" in the Add dialog and README, and tell buyers to look for "Bluetooth 2.1 / 3.0 / EDR". (b) Add a BLE path in the Android plugin (GATT writes, chunked to the MTU) as a new transport type. (c) Support only known BLE printer families that use a fixed service UUID.

**2. \[Low\] Cannot search for new Bluetooth devices.** *Problem:* the Add dialog lists only printers already paired in Android settings, and the app never asks for the scan permission. Users must leave the app to pair. *Solutions:* (a) **Recommended:** add an "Open Bluetooth settings" button and a short hint in the Add dialog. (b) Add the `BLUETOOTH_SCAN` permission and a discovery list in the plugin. (c) Do (a) now and (b) only if users ask.

**3. \[Low\] No pacing when sending data.** *Problem:* the whole job goes out in one write. A printer with a tiny buffer might drop or garble a big image. This is a risk seen in the code, not in testing. *Solutions:* (a) Send in chunks (for example 512–4096 bytes) with a short flush between them. (b) **Recommended:** make chunk size and delay a per-printer setting with a safe default, so only affected printers slow down. (c) Reduce the data, for example dither or downscale images before sending.

## Printer languages

Printers "speak" different command languages: ESC/POS (receipts), ZPL and TSPL (labels), CPCL, plus raster images and PDF.

**4. \[Medium\] TSPL has no print tuning.** *Problem:* the app never sets print darkness or speed for TSPL printers and does not handle continuous (gapless) rolls. Prints can be too light or too dark, and gapless rolls fail. *Solutions:* (a) Add `DENSITY` and `SPEED` commands from a printer setting. (b) Add a media type option (gap, black mark, continuous) that emits the matching `GAP` / `BLINE` command. (c) **Recommended:** do both in one change, with defaults that keep today's output.

**5. \[Low\] Printer status is only checked for three languages.** *Problem:* before printing, the app asks "are you ready?" only for ESC/POS, ZPL and TSPL. For CPCL, raster and PDF jobs there is no check, so an out-of-paper or cover-open printer is found out late, if at all. *Solutions:* (a) **Recommended:** add the CPCL status query and read its reply. (b) For raster and PDF, use the printer's own language if known, otherwise skip the check but show "status unknown". (c) Show "not checked" in the UI for those languages so nobody assumes it is fine.

**6. \[Low\] CPCL, raster and PDF cannot print from the phone alone.** *Problem:* on Android these need a paired PC to render. ESC/POS, ZPL and TSPL render on the phone. *Solutions:* (a) Show a clear message in the printer form when the language needs a PC (workaround: Settings → Shared rendering, or choose a printer that speaks one of the three phone-friendly languages). (b) Build an on-device CPCL encoder like the existing ESC/POS, ZPL and TSPL ones. (c) **Recommended:** (a) now and (b) for CPCL only, since it is a text command language and cheap to add. PDF on the phone would need a full PDF engine and is not worth it.

**7. \[High\] Not yet tested on a real print head.** *Problem:* Android's ESC/POS, ZPL and TSPL output was tested only against a simulated printer. There is no guarantee that any specific model works. This is testing work, not code work. *Solutions:* (a) **Recommended:** write a short test checklist (text, barcode, image, long job) and run it on 3–4 popular models. (b) Publish a "tested printers" table in the docs. (c) Let users report results from inside the app.

## USB on Android

**✅ 8. \[High\] USB permission is asked on every connect.** *Problem:* the app does not register for USB-attached events, so Android cannot remember "always allow". The dialog appears every time, which also breaks background printing. *Solutions:* (a) **Recommended:** add a `USB_DEVICE_ATTACHED` intent filter with a `device_filter.xml` that lists printer-class devices, so Android can remember the grant. (b) Reuse the existing device grant without asking again while Android still honors it. (c) Show a one-line explanation before the dialog so it is not a surprise.

**9. \[Low\] The wrong USB interface might get the job.** *Problem:* the app takes the first "output" channel it finds. A device with several functions (for example a printer plus a card reader) may receive the job on the wrong one. This is a risk seen in the code. *Solutions:* (a) **Recommended:** prefer an interface with class 7 (printer) and fall back to the old behavior only if none exists. (b) Let the user pick the interface in advanced settings. (c) Log the chosen interface so problems are easy to diagnose.

## Network printers (IPP, raw TCP, CUPS)

**10. \[Low\] IPP always labels the job as PDF.** *Problem:* if an IPP printer is set to a command language like ZPL, those bytes are still sent labeled "PDF". In practice IPP is for PDF printers only. Workaround today: use raw TCP on port 9100, or a CUPS raw queue added as a `system` printer. *Solutions:* (a) **Recommended:** reject or warn when an IPP printer is set to a non-PDF language, with a message pointing to raw TCP. (b) Send the correct MIME type (for example `application/octet-stream`) when the language is a command language. (c) Hide non-PDF languages for IPP printers in the form.

**11. \[Low\] Almost no IPP job options.** *Problem:* only the number of copies is sent. Paper size, tray, two-sided, colour and quality come from the printer's defaults and the PDF's page size, so a printer may use the wrong tray. Workaround today: set the defaults on the printer's panel or web page. *Solutions:* (a) Add optional attributes (`media`, `sides`, `print-quality`, `print-color-mode`) to the job. (b) Read what the printer supports (see item 12) and show only those choices. (c) **Recommended:** (b) then (a), so the form never offers options the printer rejects.

**12. \[Low\] The app never asks an IPP printer what it supports.** *Problem:* it only asks after something fails, so the form cannot warn that a printer does not accept PDF. *Solutions:* (a) **Recommended:** call Get-Printer-Attributes when the printer is added or tested, and store `document-format-supported` and `media-supported`. (b) Cache the answer and refresh it on demand. (c) Show a clear warning in the form when PDF is missing.

**13. \[Low\] Raw TCP has no encryption and no sign-in.** *Problem:* that is how port 9100 works. Anyone on the network can send to the printer and jobs travel unprotected, so do not use it for private data. The connection test also always sends an ESC/POS "initialize", whatever language the printer is set to. *Solutions:* (a) **Recommended:** show a visible "not encrypted" note on raw TCP printers. (b) Make the test use the printer's own language, or just open the socket and send nothing. (c) Offer IPP over TLS (IPPS) for printers that support it.

**14. \[Low\] Desktop CUPS only talks to the local computer.** *Problem:* the address is `http://localhost:631`. There is no setting in the app and no sign-in for a CUPS server that needs one. Workaround today: set the `PRINTNINJA_CUPS_URL` environment variable before launching, or add the remote queue as an `ipp` printer. *Solutions:* (a) **Recommended:** add a CUPS URL field in Settings that overrides the environment variable. (b) Add optional username and password, stored securely. (c) Keep telling users to add remote queues as `ipp` printers.

## Platforms

**✅ 15. \[High\] Windows printers with GDI-only drivers cannot print the PDF.** *Problem:* such drivers cannot turn a PDF into a picture, and the app cannot fix that. Workaround today: add the printer by network address as `ipp` or raw TCP if it reads PDF, or choose a queue whose driver lists PDF. *Solutions:* (a) **Recommended:** detect the driver type and warn when a queue looks GDI-only. (b) Render the page to a bitmap in the app and print it through the GDI path for those queues. (c) Keep the `ipp` or raw TCP workaround in the docs.

**16. \[Low\] Android has no system printer type.** *Problem:* `system` printers exist only on Windows and Linux. A printer reached through an Android print service is not available, and a `system` row on Android says it is not supported. *Solutions:* (a) **Recommended:** show a clear message in the form and suggest adding the printer by address as `ipp` or raw TCP. (b) Integrate Android's `PrintManager` through the plugin (large, with limited control over the output). (c) Only build (b) if many users have no other path.

**17. \[Low\] Direct USB and Bluetooth only work on Android.** *Problem:* Windows and Linux do not scan for USB or Bluetooth devices. The Add dialog shows installed spooler or CUPS queues only. This follows from the deliberate limits below. Here is what works where:

| Connection | Windows | Linux | Android | macOS and iOS |
| --- | --- | --- | --- | --- |
| IPP | Yes | Yes | Yes | No |
| Raw TCP (port 9100) | Yes | Yes | Yes | No |
| System queue | Yes (spooler) | Yes (CUPS) | No | No |
| USB | Via spooler only | Via CUPS raw queue | Direct, any USB device | No |
| Bluetooth | Via spooler only | Via CUPS raw queue | Direct, classic only, paired devices only | No |
| Browse the network (mDNS) | Yes | Yes | Yes | No |

*Solutions:* (a) **Recommended:** add a short "how to add a USB or Bluetooth printer" guide for Windows and Linux (install it in the OS first). (b) Tag OS-installed USB and Bluetooth queues in the list so they are easy to find. (c) Direct USB on desktop through a USB library is possible but was deliberately ruled out for Windows.

## Limits that are deliberate

These are **not planned**. They were looked at and accepted.

- **Windows has no direct USB or Bluetooth.** Both go through the Windows spooler, so the printer must be installed as a Windows printer first. A design without the spooler was studied and not built. Side effect: jobs are sent as `RAW`, so a PDF only works if the printer itself reads PDF.
- **Windows printing as administrator is not supported.** Headless Edge quietly does nothing when its parent app is elevated. The app detects this and shows a "restart normally" message. *What to do:* start the app without "Run as administrator", and remove any Compatibility setting that forces it.
- **Linux has no direct USB or Bluetooth.** Use a CUPS raw queue and add it as a `system` printer.
- **iOS and macOS are not supported as print targets.** There is no iOS code, and on macOS both rendering and delivery say "unsupported".
- **Raw TCP stays a plain connection.** No encryption, no sign-in (see item 13).

**Tip: slow Bluetooth printing on Windows?** First check the stage timings in History. A big `send_ms` number points at the Windows spooler. Cheap things to try before changing any code: turn off "Enable bidirectional support" on the queue's Ports tab, and turn on "Print directly to the printer" on its Advanced tab. These are common Windows fixes and were not tested with PrintNinja.

## Suggested order (printer items)

| Order | Item | Priority | Size | Why |
| --- | --- | --- | --- | --- |
| 1 | 7. Test on real printers | High | Testing, no code | Nothing else matters if real printers do not work |
| 2 | 4. TSPL density, speed, gapless media | Medium | Medium | Common label printers print too light or fail on gapless rolls |
| 3 | 10. IPP always labeled PDF | Low | Small | Warn or refuse when the language is not PDF |
| 4 | 16. No system printer on Android | Low | Small | Clear message and a pointer to `ipp` or raw TCP |
| 5 | 2. Cannot scan for unpaired Bluetooth | Low | Small | Add an "Open Bluetooth settings" button |
| 6 | 13. Raw TCP unencrypted, test command | Low | Small | Add a note and fix the test command |
| 7 | 14. CUPS URL only by environment variable | Low | Small | Add a setting in the app |
| 8 | 17. USB and Bluetooth on desktop | Low | Small | A short how-to guide is enough |
| 9 | 9. Wrong USB interface | Low | Small | Prefer the printer class (7) interface |
| 10 | 6. CPCL, raster, PDF need a PC | Low | Small to medium | Message is small; a CPCL encoder is medium |
| 11 | 12. IPP capabilities never read | Low | Medium | Needed before item 11 |
| 12 | 11. Few IPP job options | Low | Medium | Do after item 12 so options match the printer |
| 13 | 5. Status checks for more languages | Low | Medium | Needs each language's documented status reply |
| 14 | 3. No write pacing | Low | Small to medium | Only if a printer is seen dropping data; needs hardware |
| 15 | 1. No BLE | Low | Large | New plugin code, permissions and screens; only if a printer needs it |
| 16 | ✅ 8. USB permission on every connect | High | Small | Solved: USB_DEVICE_ATTACHED receiver + device_filter.xml, so Android remembers the grant |
| 17 | ✅ 15. Windows GDI-only drivers | High | Small to medium | Solved: warning when the queue's datatype list offers no PDF (the same signal the RAW fallback uses); rendering through GDI (option b) stays open |

The order goes by priority first (High, Medium, Low), then by how cheap the fix is. Sizes are estimates, not measurements.

---

# Part 2: App-wide gaps

These are small or medium jobs that can be picked up without a big project. The tag is the **effort**: **Small** is under a day, **Medium** is one to five days.

## Backend (the Rust app)

**18. \[Medium\] Batch printing is half-built.** *Problem:* the database table, the worker, the metrics and the History screen (a "batch" column and filter) all exist, but **nothing ever creates a batch**. The column is always empty, the filter matches nothing, and the metric always reads 0. *Solutions:* (a) **Recommended:** add `POST /v1/batches` (and a matching app command) that takes a list of print requests, inserts one `batches` row and queues each job with its `batch_id`. (b) Add a "Print selected" button in History or on a template's data list that calls it. (c) If batches are not wanted soon, hide the column, filter and metric until they are.

**✅ 19. \[Small\] The job list has no paging or filters.** *Problem:* `GET /v1/jobs` returns at most 200 jobs with no way to ask for older ones and no filters for status, source, printer, template or date. Older jobs are unreachable through the API. *Solutions:* (a) **Recommended:** add `limit`, `offset` (or a `before_id` cursor) and filters `status`, `source`, `printer_id`, `template_id`, `from`, `to`. (b) Keep the default of 200 so old clients still work. (c) Update the OpenAPI spec and tests together.

**✅ 20. \[Small\] Job API replies leave out useful details.** *Problem:* they return only IDs and status, not the printer name, template name, settings or data. Yet the `print.succeeded` webhook for the same job does include names, and the data is already in the database. *Solutions:* (a) **Recommended:** join the printer and template tables and return names, ids and settings. (b) Return a small `details` object so existing fields do not change. (c) Reuse the webhook's serializer so both stay in sync.

**✅ 21. \[Small\] `POST /v1/print` is weaker than the app's own screens.** *Problem:* it cannot set margins or print per-record runs (label runs), and it does not check values for orientation, fit, page range or grayscale, even though the API docs list allowed values. *Solutions:* (a) **Recommended:** add the four margins and `records` to the request and pass them into the same `PrintRequest` the UI uses. (b) Validate the setting values and return a clear 400 error. (c) Share one validation function with items 23 and 24.

**✅ 22. \[Small\] A wrong `json_path` prints blank fields.** *Problem:* if the path in a dataset has a typo or an out-of-range index, the job still "succeeds" and prints a page with every field empty, with no hint why. *Solutions:* (a) **Recommended:** make an unresolved path an error ("path `x.y` not found") that fails the job with a clear message. (b) Let a template mark a field optional and allow blanks only for those. (c) Add a "test path" check in the dataset form that shows the value found.

**✅ 23. \[Small\] Deep links cannot carry several print options.** *Problem:* a `printninja://print` link supports preset, template, printer, url, copies, orientation, fit, test, confirm and callback, but not page range, grayscale, margins or inline data. Links must rely on a preset or template default for anything else. *Solutions:* (a) **Recommended:** add `page_range`, `grayscale` and the four margins to `DeepLinkPrint`, validated with the shared validator. (b) Allow inline data only as a small, size-limited encoded parameter, or through `url` (already supported). (c) Keep the trusted-sources check unchanged.

**✅ 24. \[Small\] Bad `orientation` or `fit` values are accepted silently.** *Problem:* anything other than exactly `"landscape"` becomes portrait, and an unknown `fit` acts like `fit-width`. So `"LandScape"` or `fit: "actual"` gives a wrong-looking result with no warning, while creating a template does validate these. *Solutions:* (a) **Recommended:** reuse `VALID_ORIENTATIONS`, add `VALID_FITS`, and reject unknown values on every print path. (b) If friendliness matters, compare case-insensitively and then normalize. (c) Update the test that locks in the old fallback.

**✅ 25. \[Small\] "Print via PC" cannot set margins.** *Problem:* `RemotePrintArgs` has every print option except the four margins, so a phone printing through a paired PC always gets the PC's default margins. That is weaker than a local job. *Solutions:* (a) **Recommended:** add the four margins to `RemotePrintArgs` and include them in the settings JSON. (b) Do this together with item 21, since the PC endpoint must accept them. (c) Add a test that a phone job and a local job give the same page.

## Sync server

**26. \[Medium\] No export or backup of account data.** *Problem:* there is no single download of everything an account owns (templates, versions, datasets, profiles, settings, fonts). The only route is walking the whole change feed from the start and fetching each font separately, so someone leaving has no one-click backup. *Solutions:* (a) **Recommended:** add an export endpoint that returns a ZIP or JSON with all of it; the repo queries already exist. (b) Return signed font download links instead of embedding fonts. (c) Add an "Export my data" button in Settings.

**27. \[Medium\] No account deletion.** *Problem:* you can register, log in and out, change your password and manage sessions, but not delete your account. Data stays forever. Most per-user data already deletes with the user, so this is mostly free; `SavedTemplate` and `TemplateUseDaily` need explicit handling. *Solutions:* (a) **Recommended:** add `DELETE /v2/auth/me` that asks for the password and deletes the user in one transaction. (b) Use a short grace period (soft delete, purge later). (c) Delete font files from storage too and add a "Delete account" button with a confirmation.

**28. \[Medium\] Datasets, profiles, fonts and settings cannot be read or listed directly.** *Problem:* their API only supports writing and deleting. Reads work only through the sync stream, so "list my datasets" needs a full sync cache. *Solutions:* (a) **Recommended:** add paged `GET` list and `GET /{id}` endpoints, copying the `pageSchema` pattern from templates. (b) Add ETag support so clients can cache cheaply. (c) Update the OpenAPI document.

**29. \[Small\] Your own template list has no search or sort.** *Problem:* the community list accepts `q` and `sort=updated|used|name`; `GET /v2/templates/mine` only pages, newest first, so a large library can only be paged. *Solutions:* (a) **Recommended:** accept `q` and `sort` and reuse the `LIKE` search from `listPublished`. (b) Add an index on the name column if it gets slow. (c) Use it for the screen fix in item 35.

**✅ 30. \[Small\] docker-compose ignores most documented settings.** *Problem:* it passes along only a few (such as `DATABASE_URL`, `CORS_ORIGINS`, `LOG_LEVEL` and the rate limit settings). `TRUST_PROXY`, `SESSION_TTL_DAYS`, `CRON_SECRET` and `ARGON2_*` do nothing in Docker. Behind a reverse proxy every client looks like one IP, so one busy client can get everyone rate-limited. *Solutions:* (a) **Recommended:** list every variable from `env.example` in compose with defaults, for example `TRUST_PROXY: ${TRUST_PROXY:-0}`. (b) Use `env_file: .env` so new variables are never missed. (c) Add a check script that fails when `env.example` and compose differ.

**✅ 31. \[Small\] `CRON_SECRET` is missing from `env.example`.** *Problem:* on Vercel the daily cleanup is the only way old data is purged, and it returns 404 when `CRON_SECRET` is not set. Expired sessions and sync tombstones pile up forever, which slows syncing over time. *Solutions:* (a) **Recommended:** add `CRON_SECRET` to `env.example` with a note on how to generate it. (b) Log a loud warning at start-up on Vercel when it is missing. (c) Return 401 or 503 (not 404) so the cause is obvious.

**32. \[Small\] Sessions cannot be listed or revoked one by one.** *Problem:* the only option is "log out everywhere". Someone who lost a laptop cannot see which devices are signed in and has to sign out every good device too. *Solutions:* (a) **Recommended:** store a device label and last-used time per session, then add `GET /v2/auth/sessions` and `DELETE /v2/auth/sessions/{id}`. (b) Mark the current session in the list. (c) Add a "Signed-in devices" section in Settings.

**33. \[Small\] No per-user limits on templates, datasets and profiles.** *Problem:* fonts, saved templates and sessions already have limits, but `putTemplate`, `putDataset` and `putProfile` do not, and manual template versions are kept forever. A buggy or malicious client could grow the database without bound. *Solutions:* (a) **Recommended:** add count limits using the existing `quota_exceeded` error. (b) Also prune manual versions beyond a number per template, like autosaves. (c) Make limits configurable through environment variables for self-hosters.

## Frontend (the screens)

**34. \[Medium\] Version history has no screen.** *Problem:* the README promises "version history with diff and restore". The server already has endpoints to list, view and restore versions, but nothing in the app can show them. *Solutions:* (a) **Recommended:** add a "History" side panel in the designer that lists versions from `GET /v2/templates/{id}/versions`, with a Restore button. (b) Add a diff view (two versions side by side or as changed fields). (c) Ship list and restore first and the diff later. (d) If it will not be built soon, remove the claim from the README.

**35. \[Small\] "Mine" and "Saved" template tabs have no search or sort.** *Problem:* only the Community tab has them. With more than a few templates you have to scroll to find one. *Solutions:* (a) **Recommended:** turn the Community search box and sort control into a shared component and use it on all three tabs. (b) For small lists filter in the browser; for large ones use item 29 on the server.

**36. \[Small\] Print History cannot filter by template.** *Problem:* the README promises filtering by status, source, printer, template and date, but the text search only matches the numeric ID, so you cannot find jobs by template name. *Solutions:* (a) **Recommended:** extend the search to match template and printer names. (b) Add a template dropdown next to the existing filters. (c) Do (a) now and (b) together with item 19 if filtering moves to the server.

**✅ 37. \[Small\] Three barcode types preview fine but print blank.** *Problem:* `datamatrix`, `pdf417` and `aztec` show in the preview, but the printing code does not support them. The page prints an empty space and nothing warns you. *Solutions:* (a) **Recommended short term:** hide these types or mark them "preview only" in the Helpers panel, and warn at design and print time. (b) Add Rust support through a barcode library that covers them. (c) Render these types in the JS preview engine and send the image into the print pipeline.

**✅ 38. \[Small\] English text in the Japanese UI.** *Problem:* several strings are hardcoded: designer save messages, printer setup table headings and dialogs, Settings font messages, the default "Cancel" on confirm dialogs, two API Explorer messages and the sample dataset name "Sample Order". Workaround today: switch the app to English. *Solutions:* (a) **Recommended:** move each string into `en.ts` and `ja.ts` and call the translation function. (b) Change the `ConfirmDialog` default `cancelLabel` to the translated "Cancel", which fixes every call site at once. (c) Add a lint or test that fails on obvious hardcoded UI text. (d) Translate only the display of the sample dataset name; keep the stored name stable.

## Android

**✅ 39. \[Small\] Release builds block plain HTTP, so phone pairing cannot work.** *Problem:* pairing, shared rendering and Print via PC all use plain HTTP on the local network, by design. In a release APK Android blocks that and shows a confusing network error, so the whole paired-phone feature set is broken. Debug builds work. *Solutions:* (a) **Recommended:** extend `scripts/patch-android-signing.mjs` (or add a new patch script) so release builds also allow cleartext traffic. The Android project is generated, so the fix must live in the patch scripts. The test in `src/test/android-signing.test.ts` currently expects release builds not to have it and needs updating. (b) Add a `network_security_config` that allows cleartext only for the paired PC's address. Android configs cannot match IP ranges, so this is hard for local networks. (c) Allow cleartext in the app but only ever connect to private addresses in the app's own code. (d) Longer term, use TLS with a pinned certificate between phone and PC.

**✅ 40. \[Small\] The battery-optimization toggle fails silently.** *Problem:* the app is missing the permission Android requires, so opening the system screen throws an error. The error is swallowed and the app shows a **success** message anyway. Workaround today: set it by hand in Android settings. *Solutions:* (a) **Recommended:** declare `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` in the plugin manifest and show an error toast when the call fails. (b) If store policy is a concern, open the general battery settings screen (`ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS`), which needs no permission. (c) Show the real state afterwards (exempt or not) instead of a blind success message.

**41. \[Medium\] No notification when a background job succeeds or fails.** *Problem:* the only notification is the pinned "service is running" line. A job that fails in the background (printer offline, PC asleep, render timeout) is invisible until you reopen the app and read History. *Solutions:* (a) **Recommended:** post a notification on failure (and optionally success) from the worker, through the Android plugin or a Tauri notification plugin. (b) Add a setting: "Notify on: failures only / all / never". (c) Show the count of waiting jobs in the pinned notification. (d) Tapping a notification opens History on that job.

**42. \[Small\] Deep links do not work on Android.** *Problem:* the link format, trusted-sources screen and README all exist, but the Android app is not registered to open `printninja://` links, so tapping one in a phone browser does nothing. Desktop deep links work. *Solutions:* (a) **Recommended:** add the Tauri deep-link plugin config for the `printninja` scheme and the matching intent filter, and handle the opened URL at start-up and when the app is already running. As with item 39, put manifest changes in the patch scripts or the plugin manifest. (b) Add `https` app links later for a more reliable handoff from browsers. (c) Add an end-to-end test using `adb shell am start -d printninja://...`.

**✅ 43. \[Medium\] After Android kills the app, the queue stops draining.** *Problem:* the service uses `START_STICKY`, so Android restarts only the service, not the part of the app that prints. The notification comes back saying the queue stays available, but queued jobs just sit there. Workaround today: reopen the app. *Solutions:* (a) **Recommended:** start the Rust queue worker from the service's `onStartCommand`, not only from the Tauri `setup()`, so a restarted process resumes work. (b) If that is not possible, stop claiming the queue resumes, and change the notification text when the worker is not running. (c) Use WorkManager to relaunch the worker when jobs are waiting.

**44. \[Small\] The notification permission is only asked once.** *Problem:* if you decline the Android 13+ prompt, the service notification becomes invisible, its Open/Close buttons are unreachable, and no screen in Settings offers the permission again. *Solutions:* (a) **Recommended:** add a row in Settings → Background showing the permission state with a button that asks again, or opens the app's notification settings if Android will not prompt again. (b) Ask again when the user turns the background service on. (c) Replace the per-process flag with a check of the real permission state.

**45. \[Small\] The update badge can point to a release with no Android file.** *Problem:* the check compares versions only and never looks at the release's files. On a phone, updating also means downloading an APK in a browser and installing it by hand, with no hint of that. Workaround today: open the release page and check that an APK is attached. *Solutions:* (a) **Recommended:** read the release's asset list and show the badge on Android only when an APK is attached. (b) Show the real next step: "Download APK, then open it to install". (c) Link directly to the APK asset. (d) Longer term, publish through an app store or F-Droid so the OS handles updates.

## Suggested order (app-wide items)

Cheapest and most visible first.

| Order | Item | Effort | Why |
| --- | --- | --- | --- |
| 1 | 42. Deep links on Android | Small | Documented feature that cannot work on the phone |
| 2 | 44. Notification permission asked once | Small | Declining hides the service notification forever |
| 3 | 45. Update badge without an Android file | Small | Misleading badge |
| 4 | 36. History cannot filter by template | Small | README promises it |
| 5 | 29. Own template list has no search or sort | Small | Server side of item 35 |
| 6 | 35. Mine and Saved tabs have no search or sort | Small | Do after item 29 |
| 7 | 32. Sessions cannot be revoked one by one | Small | Lost device means logging out everywhere |
| 8 | 33. No limits on templates, datasets, profiles | Small | Protects self-hosted servers from unbounded growth |
| 9 | 41. No background job notification | Medium | Failures are invisible |
| 10 | 26. Account export and backup | Medium | Basic account lifecycle, mostly cheap to build |
| 11 | 27. Account deletion | Medium | Basic account lifecycle, mostly cheap to build |
| 12 | 28. No read or list endpoints | Medium | Integrations need a full sync cache without it |
| 13 | 18. Batch printing entry point | Medium | Worker, metrics and History column already exist |
| 14 | 34. Version history screen | Medium | Promised in the README, and the API is ready |
| 15 | ✅ 22. Bad `json_path` prints blanks | Small | Solved: an unresolvable path now fails the job with a clear message; an explicit `null` still resolves |
| 16 | ✅ 24. Invalid orientation and fit accepted | Small | Solved: one shared validator normalizes case and rejects unknown values on every print path |
| 17 | ✅ 37. Preview-only barcodes print blank | Small | Solved: "preview only" badge, design-time hint, print-time confirm |
| 18 | ✅ 39. Plain HTTP blocked in release builds | Small | Solved: cleartext patching already existed; the real bug was the patch script failing on CRLF build files (Windows) |
| 19 | ✅ 40. Battery toggle shows false success | Small | Solved: permission declared, rejections surfaced, real state shown after the dialog |
| 20 | ✅ 43. Queue stops after Android kills the app | Medium | Solved (option b): a restarted service has no Tauri core, so the worker can't run there — the notification now honestly says the queue is paused, and reopening the app resumes it with a visible toast |
| 21 | ✅ 21. `/v1/print` margins, records, validation | Small | Solved: the API now takes the four margins and `records`, runs them through the shared validator, and returns a clear 400 (like orientation/fit in item 24) instead of silently ignoring them |
| 22 | ✅ 25. Print via PC has no margins | Small | Solved: the phone now sends the four margins over to the PC, which runs them through the same shared validator — a phone job and a local job lay out identically |
| 23 | ✅ 23. Deep links miss options | Small | Solved: `printninja://print` now carries `page_range`, `grayscale` and the four margins, each run through the shared validator (a bad value drops to "unset", the deep-link convention) |
| 24 | ✅ 30. docker-compose ignores env vars | Small | Solved: compose now passes through every env.example var with a default, so self-hosted settings (TRUST_PROXY, SESSION_TTL_DAYS, CRON_SECRET, ARGON2_*) actually take effect |
| 25 | ✅ 31. `CRON_SECRET` missing from `env.example` | Small | Solved: CRON_SECRET added to env.example, a loud start-up warning fires on Vercel when it's unset, and the cleanup endpoint returns 503 instead of 404 |
| 26 | ✅ 19. Job list has no paging or filters | Small | Solved: GET /v1/jobs now takes limit/offset plus status, source, printer_id, template_id, from and to filters (OpenAPI and tests updated) |
| 27 | ✅ 20. Job replies omit printer and template | Small | Solved: job replies now carry a details object with printer_id, printer, template_id, template and settings via LEFT JOINs |
| 28 | ✅ 38. English text in the Japanese UI | Small | Solved: remaining hardcoded English strings moved to en/ja locales; the ConfirmDialog default cancel and the "Sample Order" display are translated while its stored name stays stable |

---

*Source: MISSING\_FEATURES.md, with solutions added after checking the repo. Code paths were mostly left out to keep this easy to read; see the original file for exact locations.*
