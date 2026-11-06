# Missing features

> **Who this is for:** anyone choosing a printer, deciding what to build next,
> or wondering why the app behaves oddly.
> **What you will know after reading:** which Bluetooth, USB, network and
> printer-language features PrintNinja does not have today, what happens
> instead, the workaround where there is one, and which limits are deliberate —
> plus the app-wide feature gaps (backend, sync server, UI, Android) that are
> small or medium to build.

Checked against the code on `develop` in November 2026. Everything here was
read from the source. Nothing was measured on a printer, except where an item
says so. The per-OS transport rules are in
[printers and transports](./PRINTERS_AND_TRANSPORTS.md); this page lists only
what is absent.

Each item says what is missing, what happens today, what to do about it, and
where the code is.

## How to read the priorities

Each item carries a tag next to its number.

- **High:** a common setup prints wrong output, or fails with no explanation
  in the app, or the feature is needed for a printer to work at all.
- **Medium:** a real gap that some printers or setups hit, usually with a
  workaround, or one that ends in a clear error.
- **Low:** rare, needs particular hardware, is a property of the protocol, or
  has an easy workaround.

The tags are a judgment from reading the code, not from user reports.

The app-wide sections (from item 18 on) are tagged by **effort** instead:

- **Small:** under a day of work.
- **Medium:** one to five days.

They are listed because they are cheap enough to pick up without a project;
the printer items above are tagged by priority because they are harder or
hardware-dependent.

## Bluetooth on Android

**1. [Low] No BLE (Bluetooth Low Energy).** The Android plugin opens only a classic
serial (SPP) socket, using the serial-port UUID `00001101-…`. A printer that
offers only BLE cannot connect. *Workaround:* none; use a printer with
classic Bluetooth, which the spec sheet lists as "Bluetooth 2.1 / 3.0 / EDR".
*Code:* `transport/android_bluetooth.rs`, `AndroidPrintPlugin.kt`
(`sppUuid`).

**2. [Low] No scanning for unpaired devices.** The Add dialog lists only devices
already bonded in Android settings. The app does not ask for the scan
permission. *Workaround:* pair the printer in Android Bluetooth settings
first. *Code:* `AndroidPrintPlugin.kt` (bonded-device listing),
`AndroidManifest.xml`.

**3. [Low] No pacing on writes.** The whole job goes out in one `write` followed by
one `flush`. A printer with a small receive buffer could drop or garble a
large image. This is a risk read from the code, not something seen in
testing. *Workaround:* none today. *Code:* `AndroidPrintPlugin.kt`
(`socket.outputStream`).

## Printer languages

**4. [Medium] TSPL has no print tuning.** The encoder never sets density
or speed and does not handle continuous (gapless) media. *Code:*
`transport/label_langs.rs`.

**5. [Low] Status checks cover three languages only.** Before a job, the printer is
asked whether it can print only for ESC/POS, ZPL and TSPL. CPCL, raster and
PDF jobs go out without that check, so a printer that is out of paper or has
its cover open is found out later, if at all. *Code:*
`transport/status.rs` (`dialect_for`).

**6. [Low] CPCL, raster and PDF cannot print on the phone alone.** On Android these
need a paired PC to render. ESC/POS, ZPL and TSPL render on the device.
*Workaround:* pair a PC (Settings → Shared rendering), or choose a printer
that speaks one of the three. *Code:* `commands/print.rs` (`need_peer`).

**7. [High] Not yet verified on a real print head.** The project's own architecture
notes say Android's ESC/POS, ZPL and TSPL output has been tested against a
simulated printer but not on physical hardware. A given model working is not
guaranteed. See [printers and transports](./PRINTERS_AND_TRANSPORTS.md#per-operating-system).

## USB on Android

**8. [High] The USB permission dialog is asked on every connect.** The
plugin manifest declares no USB-attached intent filter, so there is no
"always open with PrintNinja" grant to remember the choice, and the
dialog comes back on every connect. *Code:* `AndroidPrintPlugin.kt`
(`ensureUsbPermission`).

**9. [Low] The first bulk-OUT endpoint is used, whatever interface it is on.** A
device that exposes more than one interface (a printer with a card reader or
a network port, say) may get the job on the wrong one. The code does not look
for the printer class (7). This is a risk read from the code, not something
seen in testing. *Workaround:* none today. *Code:* `AndroidPrintPlugin.kt`
(`bulkEndpoints`).

## Network printers (IPP, raw TCP and CUPS)

**10. [Low] IPP always labels the job as PDF.** `send` calls `send_pdf` for every
job, so an IPP row set to a command language (ZPL, say) would send those
bytes declared as `application/pdf`. In practice the IPP path is for PDF
printers only. *Workaround:* for a label printer, use raw TCP on port 9100,
or a CUPS raw queue added as a `system` printer. *Code:* `transport/ipp.rs`
(`impl PrinterTransport`).

**11. [Low] No paper size, tray, duplex, colour or quality options over IPP.** The
only job attribute besides the document format is `copies`. Everything else
comes from the printer's defaults and from the page size inside the PDF. A
printer that picks media by its own setting rather than by the PDF may use
the wrong tray. *Workaround:* set the printer's defaults on its panel or web
page. *Code:* `transport/ipp.rs` (`build_ipp_request_with_format`).

**12. [Low] The app never asks an IPP printer what it supports.** Get-Printer-Attributes
is sent only after a failure, to find out why. Supported document formats and
media sizes are never read, so the form cannot warn that a printer does not
take PDF. *Code:* `transport/ipp.rs`.

**13. [Low] Raw TCP has no encryption and no sign-in.** That is how port 9100
works, so it is a property of the protocol and not a gap to close in the
app. Anyone on the network can send to the printer, and the job travels in
the clear. It is listed here so nobody relies on it for anything private.
The connectivity test on a raw TCP printer also sends an ESC/POS initialize
whatever language the row says. *Code:* `transport/raw_tcp.rs` (`test`).

**14. [Low] Desktop CUPS is the local daemon only.** The address is
`http://localhost:631` unless the `PRINTNINJA_CUPS_URL` environment variable
says otherwise; there is no setting in the app, and no sign-in for a CUPS
server that needs one. *Workaround:* set the variable before launching, or
add the remote queue as an `ipp` printer. *Code:* `transport/cups.rs`
(`cups_base_url`).

## Platforms

**15. [High] Windows system printers with a GDI-only driver cannot print the PDF.**
A GDI-only driver cannot rasterize a PDF, and the app cannot fix that.
*Workaround:* add the printer by its network address as `ipp` or raw TCP
if it reads PDF, or choose a queue whose driver lists `PDF`. *Code:*
`transport/windows_spooler.rs`.

**16. [Low] Android has no system printer type.** `system` printers exist only on
Windows and Linux, so a printer that Android reaches through a print service
is not available. A `system` row on Android reports that it is not supported
on this platform. *Workaround:* add the printer by address as `ipp` or raw
TCP. *Code:* `transport/mod.rs` (`create_transport`).

**17. [Low] Direct USB and Bluetooth are Android only, and neither desktop system
lists them.** Windows and Linux have no scan for USB or Bluetooth devices;
the Add dialog shows installed spooler or CUPS queues only. That follows from
the deliberate limits below, and is listed so the table of platforms is
complete:

| Connection | Windows | Linux | Android | macOS and iOS |
|---|---|---|---|---|
| IPP | Yes | Yes | Yes | No |
| Raw TCP (9100) | Yes | Yes | Yes | No |
| System queue | Yes (spooler) | Yes (CUPS) | No | No |
| USB | Via spooler only | Via CUPS raw queue | Direct, any USB device | No |
| Bluetooth | Via spooler only | Via CUPS raw queue | Direct, classic SPP, bonded only | No |
| Browse the LAN (mDNS) | Yes | Yes | Yes | No |

## Limits that are deliberate

These are not planned. They were looked at and accepted.

- **Windows has no direct USB or Bluetooth.** Both go through the Windows
  spooler, so the printer must be installed as a Windows printer first. A
  spooler-free design was evaluated and not built; its plan and spike tool
  were removed. A side effect: the Windows USB and Bluetooth transports send
  every job as `RAW` and ignore the job's type, so a PDF reaches such a
  printer only if the printer reads PDF itself.
- **Windows printing while elevated is not supported.** Headless Edge
  exits 0 without printing when its parent process is elevated, so an
  app started "as administrator" cannot print at all. The app detects
  the elevation and says so instead of guessing (`render/elevation.rs`),
  but deliberately does not launch Edge de-elevated — the owner decided
  PrintNinja does not need to run elevated, so the behaviour is an
  actionable "restart normally" message. *Workaround:* launch without
  "Run as administrator" (and remove any Compatibility setting that
  forces it).
- **Linux has no direct USB or Bluetooth.** Use a CUPS raw queue and add it as
  a `system` printer.
- **iOS and macOS are not print targets.** There is no code for iOS, and on
  macOS both rendering and delivery report "unsupported".
- **Raw TCP stays a plain socket.** No TLS and no sign-in; see item 13.

If a Windows Bluetooth print feels slow, read the stage timings in History
first. A large `send_ms` points at the spooler. Turning off "Enable
bidirectional support" on the queue's Ports tab, and "Print directly to the
printer" on its Advanced tab, are the cheap things to try before any code
change. These are common Windows fixes and were not tested for PrintNinja.

## Suggested order

A rough order if these are picked up, highest priority first. The sizes are
estimates, not measurements.

| Item | Priority | Why | Size |
|---|---|---|---|
| 3. Write pacing | Low | Only if a printer is seen dropping data; needs hardware | Small to medium |
| 10. IPP declared as PDF only | Low | Refuse or warn when an IPP row has a command language | Small |
| 5. Status checks for more languages | Low | Needs each language's documented status reply | Medium |
| 1–2. BLE and scanning | Low | New plugin code, permissions and UI; only worth it if a printer needs it | Large |

Item 7 (checking on a real print head) is High but is testing work, not code,
so it is not included in the table.

## App-wide: backend (Rust)

**18. [Medium] Batch printing is half-built: nothing ever creates a batch.**
The `batches` table exists, the worker updates batch progress and flips the
batch status on claim, metrics report `batches_active`, and History renders a
"batch" column and a "Batch" source filter — but no REST endpoint or Tauri
command ever inserts a batch row. *Today:* every job's `batch_id` is NULL; the
History column is permanently empty, its filter matches nothing, and the metric
reads 0 forever. *Workaround:* none. *Code:* `db/schema.sql` (batches),
`worker.rs` (`update_batch_progress`), `metrics.rs` (`batches_active`),
`api/routes.rs` (no batch endpoint), `src/pages/History.tsx`.

**19. [Small] `GET /v1/jobs` has no pagination or filters.** The endpoint is
hard-capped at `LIMIT 200` with no `offset`/`limit` and no status, source,
printer, template or date filters. *Today:* after ~200 jobs the older ones are
unreachable via the API, and "the failed jobs on printer X" means pulling 200
rows and filtering client-side. *Code:* `api/routes.rs` (`list_jobs`).

**20. [Small] The job API responses omit what a job actually printed.**
`GET /v1/jobs` and `GET /v1/jobs/{id}` do not return the printer name, template
id/name, settings or data — only ids and status. *Today:* the `print.succeeded`
webhook carries printer and template names for the same job, so the job
endpoints are weaker than their own callback; the columns are already in the
table. *Code:* `api/routes.rs` (`list_jobs`, `get_job`).

**21. [Small] `POST /v1/print` cannot set margins or per-record runs, and
validates no setting values.** `print_job` always builds the request with all
four margins `None` and `records: None`, and reads `orientation`, `fit`,
`page_range`, `grayscale` out of free-form `settings` JSON without value
validation, even though the OpenAPI spec documents enums. *Today:* API jobs can
never use per-record (label runs) or per-side margins that the UI pipeline
has. *Code:* `api/routes.rs` (`print_job`); the full field set is
`commands/print.rs` (`PrintRequest`).

**22. [Small] A bad dataset `json_path` silently prints blank fields.**
`extract_json_path` returns `Value::Null` when the path does not resolve
(typo, out-of-range array index). *Today:* the job succeeds and prints a page
with every field empty — a "successful" print of garbage with nothing to
indicate why. *Code:* `data/fetcher.rs` (`extract_json_path`).

**23. [Small] Deep links cannot carry several print options.**
`printninja://print` has preset, template, printer, url, copies, orientation,
fit, test, confirm and callback — but no `page_range`, `grayscale`, margins or
inline data. *Today:* an external print link must rely on a preset or template
default for anything else. *Code:* `deeplink.rs` (`DeepLinkPrint`) versus the
full set in `commands/print.rs` (`PrintRequest`).

**24. [Small] Invalid `orientation` and `fit` values are accepted
silently.** Any orientation string other than exactly `"landscape"` becomes
portrait geometry; an unknown `fit` silently behaves like `fit-width` (a test
locks in that fallback). *Today:* a caller sending `"LandScape"` or
`fit: "actual"` gets a plausible-looking wrong result with no warning — while
the template-create path *does* validate (`VALID_ORIENTATIONS`). *Code:*
`commands/print.rs` (`run_print_with`), `render/layout.rs` (`scale_for`).

**25. [Small] Print via PC cannot set margins.** `RemotePrintArgs` has every
print option except the four margins, so the settings JSON it builds for the
PC's `POST /v1/print` omits them. *Today:* a phone printing through a paired PC
always gets the PC's default margins, a weaker print than a local job on the
same pipeline. *Code:* `commands/remote_print.rs`.

## App-wide: sync server

**26. [Medium] No export/backup of an account's data.** There is no endpoint
to download everything an account owns — templates and versions, datasets,
profiles, settings, font files. *Today:* the only path is walking
`GET /v2/sync/changes` from cursor 0 and then fetching each font file through a
separate endpoint per font. A POS operator leaving PrintNinja has no one-click
backup. *Code:* `server/src/http/routes/sync.ts`, `account.ts`, `library.ts`;
the repos in `server/src/infra/db/*` already have the queries.

**27. [Medium] No account deletion.** Auth has register, login, logout,
sessions (revoke-all), password change and me — but no `DELETE /v2/auth/me`.
*Today:* a user who wants to go cannot; templates, datasets, fonts and settings
remain in the database forever, deletable only entity by entity. Most per-user
rows already `onDelete: Cascade` from `User` in the schema, so the delete is
mostly free (the bare `templateId` rows like `SavedTemplate` and
`TemplateUseDaily` need explicit handling). *Code:*
`server/src/http/routes/auth.ts`, `server/src/domain/auth/`,
`server/prisma/schema.prisma`.

**28. [Medium] Datasets, profiles, fonts and settings have no read/list
endpoints.** Their OpenAPI surface is write/delete only. *Today:* reads are
possible only through the delta-sync stream, so any integration or client
feature that wants "list my datasets" or "give me dataset X" must maintain a
full sync cache or page the whole change log from `since=0`. *Code:*
`server/src/http/routes/library.ts`, `account.ts`; the `pageSchema` pattern in
`server/src/http/schemas/templates.ts` is the template to copy.

**29. [Small] `GET /v2/templates/mine` has no search or sort.** The community
list accepts `q` and `sort=updated|used|name`; the owner's own list accepts
only `page`/`page_size` and is fixed newest-first. *Today:* a large personal
library can only be paged; the search that exists for community does not work
on one's own templates. *Code:* `server/src/http/routes/templates.ts`,
`server/src/http/schemas/templates.ts` (`pageQuery` vs `communityQuery`),
`server/src/domain/templates/templates.ts` (`listMine`); the community `LIKE`
search in `listPublished` is the reference implementation.

**30. [Small] docker-compose ignores most documented env vars.** Compose
forwards only `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `CORS_ORIGINS`,
`LOG_LEVEL`, `DOCS_ENABLED` and the `RATE_LIMIT_*` set — not `TRUST_PROXY`,
`SESSION_TTL_DAYS`, `SESSION_CLEANUP_MINUTES`, `SYNC_TOMBSTONE_DAYS`,
`SYNC_PAGE_BYTES`, `CRON_SECRET` or `ARGON2_*`, all of which `env.example`
documents. *Today:* setting them in `.env` does nothing in Docker; with
`TRUST_PROXY` stuck at 0 behind a reverse proxy (the usual self-host setup)
every client shares one IP, so the 120/min global limiter is a deployment-wide
bucket — one busy POS client can 429 everyone. *Code:*
`server/docker-compose.yml`, `server/env.example`, `server/src/app.ts`.

**31. [Small] `CRON_SECRET` is absent from `env.example`.** On Vercel the
in-process cleanup timer never runs (serverless), so the daily cron on
`/v2/internal/cleanup` is the only purge path — and that endpoint answers 404
every day when `CRON_SECRET` is not set. *Today:* expired sessions and sync
tombstones accumulate forever, and tombstone growth degrades sync (stale
cursors force full re-syncs). The file operators copy from never mentions the
secret. *Code:* `server/env.example`, `server/vercel.json` (`crons`),
`server/src/http/routes/internal.ts`.

**32. [Small] Sessions cannot be listed or individually revoked.** Only
`DELETE /v2/auth/sessions` exists — the revoke-everything hammer. *Today:* with
up to 20 concurrent sessions per user, someone with a stolen laptop or an old
tablet cannot see which devices are signed in (a session stores only a token
hash, created and expiry) and can only log out everywhere, bouncing every
legitimate device. *Code:* `server/src/http/routes/auth.ts`,
`server/src/domain/auth/session.ts`, `server/src/infra/db/sessions.ts`.

**33. [Small] No per-user quotas for templates, datasets and profiles.** The
codebase has an established quota pattern — fonts capped at 50, saved templates
at 1000, sessions at 20 — but `putTemplate`, `putDataset` and `putProfile`
perform no count check, and manual/restore template versions are kept forever
(only autosaves are pruned, at 50). *Today:* a buggy or malicious integration
can grow the database unbounded (templates 768 KiB each plus a version row per
change; datasets 256 KiB each); only the IP rate limit slows it. The
`quota_exceeded` error code already exists and is used for exactly this on
fonts/saved. *Code:* `server/src/domain/templates/put.ts`, `datasets.ts`,
`profiles.ts`, `errors.ts`.

## App-wide: frontend

**34. [Medium] Version history is promised but has no UI.** The README lists
"version history with diff and restore" under the designer. *Today:* nothing in
the frontend can view, diff or restore a saved version, even though the share
service already has `GET /v2/templates/{id}/versions`, `GET /versions/{n}` and
`POST /versions/{n}/restore` (typed in `src-tauri/src/share/schema.d.ts`) and a
local DB migration deliberately *drops* the old `template_versions` table —
the backend contract is wired, the UI is missing. *Code:*
`src/pages/Designer.tsx`, `src-tauri/src/share/schema.d.ts`,
`src-tauri/src/db/mod.rs` (migration 8 drops the table).

**35. [Small] The Mine and Saved template tabs have no search or sort.** The
README promises "Mine, Saved and Community tabs with search and sort"; only
Community has a search box and sort control. *Today:* more than a handful of
own or saved templates means scrolling to find one. *Code:*
`src/pages/Templates.tsx` (Community's input ~line 973 and sort ~line 611 are
the pattern to reuse; Mine and Saved render plain lists).

**36. [Small] Print History has no template filter.** The README promises
filtering by "status, source, printer, template and date". *Today:* the text
search only matches the numeric id, so a user who knows the template *name*
cannot narrow history to it at all. *Code:* `src/pages/History.tsx` (search
predicate ~lines 205–215).

**37. [Small] Three barcode symbologies print blank while the preview shows a
code.** `datamatrix`, `pdf417` and `aztec` render in the JS preview (bwip-js)
but the Rust renderer returns `None` for them, and nothing in the UI says so.
*Today:* a hand-typed `{{barcode "datamatrix" …}}` — or one added through the
Helpers panel — previews a code and prints a blank space in its place. An
in-code comment marks them "preview-only in Rust"; the user never sees it.
*Code:* `src/lib/utils/barcode.ts` (`BARCODE_TYPES`),
`src/components/designer/HelpersPanel.tsx`, `src-tauri/src/render/barcode.rs`
(the `None` assertion at line 256).

**38. [Small] Hardcoded English in the Japanese UI, in several places.**
Japanese users see English on: the designer's save toasts ("Saved to the
server" / "Saved — the published copy is updated") and the offline save hint
(`Designer.tsx` 576–579, 1138); PrinterSetup table headers "Printer"/"Status",
the add-printers toast, the phone caption and a dialog "Cancel"
(`PrinterSetup.tsx` 507, 534, 386, 773, 1258); the Settings font states
("Downloading…", "Download failed — will retry"), the allowed-domains
validation message and the reset dialog's "Cancel" (`Settings.tsx` 605–606,
353, 1259); the `ConfirmDialog` default `cancelLabel = "Cancel"`
(`components/ConfirmDialog.tsx` 33), which hits every call site that omits the
prop; ApiExplorer's "live: {baseUrl}" and "(empty body — e.g. a 204 cancel)"
(`ApiExplorer.tsx` 363, 600); and the built-in starter dataset name "Sample
Order" (`Designer.tsx` 342, 829 — keep the stored name stable, localize
display only). *Workaround:* switch the UI language to English. *Code:* as
listed; keys go into both `src/lib/i18n/locales/en.ts` and `ja.ts`.

## App-wide: Android

**39. [Small] Release builds block all cleartext HTTP — phone pairing cannot
work.** The Android manifest placeholder `usesCleartextTraffic` defaults to
`"false"` and is `"true"` only in debug builds, and no `network_security_config`
exists. *Today:* pairing, shared rendering and Print-via-PC all talk plain HTTP
to the PC's LAN API by design, so in a release/sideloader APK Android kills
every phone→PC call with a confusing network error; a debug build works fine.
The whole paired-phone feature set is therefore release-broken. *Workaround:*
use a debug build. *Code:* `src-tauri/gen/android/app/build.gradle.kts`
(lines 21, 30).

**40. [Small] The battery-optimization toggle silently fails.**
`BatteryExemption.request()` fires
`Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, but that intent
requires the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission, which no
manifest declares. *Today:* `startActivity` throws a `SecurityException`, the
Kotlin error is swallowed by a catch in `background.ts`, and the Settings page
shows a *success* toast anyway — the README's instruction to allow battery
exemption leads to a toggle that never opens the system screen. *Workaround:*
set it manually in Android settings (the README does say this, but the in-app
toggle is the documented path). *Code:*
`plugins/tauri-plugin-android-print/android` (`BatteryExemption.kt`,
`AndroidManifest.xml`), `src/lib/android/background.ts` (~48–55),
`src/pages/Settings.tsx` (~701–712).

**41. [Medium] No notification when a background job succeeds or fails.** The
only Android notification is the pinned foreground-service status line, which
reports API-server state only. *Today:* the README's headline flow is "the print
queue keeps draining after you swipe the app away" — so a job that fails in the
background (printer offline, paired PC asleep, render timeout) is invisible
until the user reopens the app and reads History. *Code:*
`plugins/.../android_print/PrintNinjaService.kt` (`buildNotification`),
`src-tauri/src/worker.rs` (no notification hook; no notification plugin in
`Cargo.toml`).

**42. [Small] Deep links cannot reach the app on Android at all.** The parse
contract, the trusted-sources UI and the README promise all exist — but the
merged Android manifest has no `printninja://` intent-filter, no
`onNewIntent`/`RunEvent::Opened` handling, and no deep-link config in
`tauri.conf.json`. *Today:* tapping a `printninja://print?…` link in a phone
browser cannot launch or deliver to the app (the e2e suite notes "There is no
OS handoff in the harness"). Desktop deep links work. *Workaround:* none on
the phone. *Code:* `src-tauri/src/deeplink.rs`, `src-tauri/src/lib.rs`
(111–117), `src-tauri/tauri.conf.json`.

**43. [Medium] After process death the service comes back as a zombie —
queued jobs do not drain.** `PrintNinjaService.onStartCommand` returns
`START_STICKY` and its comment claims the queue resumes "where it stopped",
but the queue worker is spawned only in the Tauri `setup()`. *Today:* when
Android kills the process (memory pressure, Doze), the platform recreates only
the service — a fresh process with no webview and no Rust worker. The pinned
notification reappears claiming "the print queue stays available in the
background" while queued jobs sit untouched. *Workaround:* reopen the app.
*Code:* `plugins/.../android_print/PrintNinjaService.kt` (63–65, 236–262),
`src-tauri/src/lib.rs` (277).

**44. [Small] The notification permission is asked once per process and never
re-offered.** The Android 13+ prompt is gated by a per-process flag and fires
only at plugin load and API-server start. *Today:* a user who declines gets an
invisible foreground-service notification forever — the service runs, but its
"Open/Close" actions are unreachable and no settings screen re-offers the
permission (Settings → Background has only the service toggle and battery
exemption). *Code:* `AndroidPrintPlugin.kt` (`ensureNotificationPermission`,
~1691–1720).

**45. [Small] The update badge on a phone can point at a release with no
Android artifact.** The check compares the running version against
`/releases/latest` without inspecting assets, and "updating" on a phone means
downloading an APK in an external browser and sideloading it. *Today:* the
badge can light up when there is nothing to install on the phone, with no hint
that the flow is sideloading. *Workaround:* open the release page and check
assets. *Code:* `src/lib/appUpdate.ts`, `src/components/UpdateBadge.tsx`.

## App-wide: suggested order

A rough order if the app-wide items are picked up, cheapest-and-most-visible
first. The sizes echo the effort tags.

| Item | Effort | Why |
|---|---|---|
| 39. Cleartext block in release builds | Small | The entire paired-phone feature set is broken in release APKs |
| 40. Battery toggle with false success | Small | A documented flow silently fails and toasts success |
| 22. Bad `json_path` prints blanks | Small | "Successful" prints of empty fields |
| 37. Preview-only barcodes print blank | Small | Preview/print mismatch with no warning |
| 24. Invalid orientation/fit accepted silently | Small | Plausible-looking wrong geometry |
| 21. `/v1/print` margins, records, validation | Small | The POS-facing API is weaker than its own UI |
| 26–27. Account export and deletion | Medium | Basic account lifecycle, mostly free (cascades exist) |
| 18. Batch printing entry point | Medium | Worker, metrics and History column already exist |
| 34. Version history UI | Medium | Promised in the README; the API is already there |
