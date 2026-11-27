# What's new in PrintNinja

A plain-English record of what changed, newest first. If you use PrintNinja, this page is for you. 🙂

---

## ✍️ How to write this page (for the team)

This page is read by **customers**, not developers. Write so that anyone can understand it in one pass, without knowing how the app is built.

**The simple rules**

- Say what the person can now **do**, or what got **better for them** — not what code changed.
- One short bullet per change. Start with a **bold headline** in everyday words (2–6 words) that people can scan, then add at most one short sentence of detail.
- Write about "you" and "your". Talk like you're telling a friend what's new.
- Leave out code, file names, settings keys, API fields, database changes, internal tests and build fixes. If a customer would never notice it, don't list it at all.
- Use the app's own words for things — for example "History", "Settings → Profile", "Print". Keep it friendly, not clever.

**Pick one heading per change**

- `### Added` — something new people can use.
- `### Changed` — something works differently or better.
- `### Fixed` — something that was broken now works.

Only use the headings you actually have entries for.

**A good entry looks like this**

- **Print from your phone.** Pair a phone with this PC, then send jobs to it from anywhere in the house.
- **Clearer error messages.** If a print fails, you'll see why — like "out of paper" — right in the app.

**Not like this**

- Refactored the render pipeline to use the new queue adapter.
- Fixed a null pointer in `PrinterSchema::validate`.

**Where new entries go**

- Add new entries under **Unreleased** below as the work lands.
- When we release, that section becomes a dated `## [version] - date` heading and a fresh empty **Unreleased** opens on top. `pnpm release` does this for you.
- Keep the version in sync in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (`pnpm version:set`).
- Once a section is released it is the release notes. Don't go back and rewrite it; at a release `pnpm release` keeps only the five newest dated sections and removes older ones.

---

## Unreleased

## [2026.1127.2] - 2026-11-27

### Changed

- **One workspace for both template kinds.** Label templates now open in the same resizable workspace as documents: page setup, sample data and data fields on the left, Elements / Properties / README / Preview tabs beside a zoomable canvas. The layout toggle works for labels too.
- **Same designer on tablets and phones.** Tablets get the label tabs and settings sheet documents already had; phones get a read-only section picker for the label preview, sample data and README.

### Fixed

- **Prepared label previews keep up.** Choose the printer beside the canvas, turn on Prepared preview and the dots refresh as you edit; pages are labelled, sized in millimetres, and large labels no longer lose their preview.

## [2026.1127.0] - 2026-11-27

### Added

- **Starter label templates.** When you create a label template you can now start from a ready-made layout — Shipping label, Product price, Address, Asset tag or Name badge — or pick Blank, just like document templates. Each starter comes with sample data, so your label looks filled in right away.

## [2026.1126.0] - 2026-11-26

### Added

- **A label designer for thermal printers.** Design receipts and labels on a canvas in millimetres — text, barcodes, QR codes, images, lines and frames — with undo, arrow-key nudging, and a preview that matches what the printer produces.
- **Eleven label models built in.** Models from Zebra, Brother, Citizen, Epson, TSC, Toshiba and friends ship with the app; it picks a sensible default per printer, and you can change the choice in the printer's Advanced section.
- **Templates know their kind.** Each template wears a badge naming it as a label or a document, and both kinds can be created from the Templates page.
- **Refresh when you want.** The Printers, Templates and History lists have refresh buttons, the top-bar badge shows when the last sync happened, and on Android you can pull a page down to refresh it.
- **Android asks once, and explains.** The first time the app needs your local network it shows a short explanation and asks once. Bluetooth and USB printers never need it.
- **A badge for fresh templates.** Community templates published in the last two weeks wear a "New" badge, and your very first finished print earns a one-time congratulations.
- **Phone notices can be closed.** Every notification on the phone now has a close button, instead of waiting for a swipe.

### Changed

- **One place to create templates.** New templates — label or document — are created from the Templates page; the Designer is where you open and edit them.
- **Honest job results.** When the app cannot see the paper (direct printing with no driver), a finished job says "Sent to the printer" instead of "Printed", and the mode is named "Direct printing (no driver)".
- **Test prints you can read.** Receipt and label printers get one plain line of text in their own language — if you can read it, the printer works — and document test pages get a visible border so a blank sheet is obvious.
- **A calmer Bluetooth add.** One-tap adding a Bluetooth printer now shows the paper width (54 mm) and language before you save, so nothing is set blind.
- **Prettier Japanese text.** In the Japanese interface, text uses the platform's own Japanese face, with roomier line spacing and labels that wrap instead of cutting off.
- **PDFs on document printers only.** PDFs can no longer be sent to thermal printers; the app says why and points you to designing a label template instead. Office (document) printers are unaffected.

### Fixed

- **Label templates stay together.** A label you create appears in the Designer right away, keeps the right name, and can always be created from the Templates page — even while a document template is open.
- **No more blank Bluetooth prints.** Some Bluetooth receipt printers dropped a job but were told it had succeeded; the send is now paced to match a slow print head.
- **Out-of-paper Bluetooth printers tell you.** A Bluetooth printer that is out of paper, jammed or offline now refuses the job with a clear message instead of swallowing it.
- **PDFs print over USB on Windows.** USB document printers print PDFs correctly now.
- **More network printers found on Android.** 9100 network printers appear in the add-printer flow instead of being missed.
- **The add sheet closes when done.** A successful one-tap printer add closes the sheet on its own.
- **Phone history shows via-PC jobs.** Printing through a PC shows the job, its outcome and the PC's name in the phone's History again.
- **Server addresses are cleaned up.** A share-service address saved with a slash at the end connects as you expected.
- **Printer passwords stay private.** A printer's password no longer appears in the edit form; leaving the field blank keeps the saved password.

## [2026.1118.2] - 2026-11-18

### Changed

- **A broken page no longer takes the whole app down.** If a page runs into a problem or its files fail to load, you get a short message with "Try again" or "Back to Print" instead of a blank window — and you can copy the diagnostics to share with the team.
- **The Print page settles down.** A ready printer is now marked with a small "Ready" chip next to the printer name instead of a full-width banner, so the page focuses on the job.
- **Clearer paper-size warning.** When a sheet is wider than the printer's paper, the warning now says exactly what the button changes — "Set printer paper to … mm" — and the "Other…" button reads "Choose a different paper size…".
- **A calmer template list.** Each template now shows a small preview of its page, a Print button and an Edit link; saving, refreshing and deleting live in a small menu behind the ⋯ button, and the technical sync ID is tucked away behind the status badge.
- **A calmer History on phones.** Job rows give the printer name its own line and show two lines of the error — tap the error to read the whole thing — and checkboxes only appear after you tap "Select".
- **Tabs that don't fit stay findable.** When a row of tabs overflows, it now fades out at the edge so you know there are more to scroll to, and the active tab is kept in view.
- **Consistent text sizes.** Small helper text and captions now follow one set of sizes with a 12px minimum, so the app reads more evenly, and popups and preview panels cap their height the same way.
- **Handle examples look like names.** The example in the handle field on sign-in and sign-up now uses the same name style as the Suggest picks, so it shows what your handle will actually look like.
- **Fits tablets and narrow windows.** On a tablet or a narrow desktop window, lists like Templates and History now show as cards and the side menu folds to just its icons, so buttons and details are never cut off.
- **Less chrome, more content.** On phones the page title and its buttons now share one row and the subtitle stays out of the way, and notices like "Templates are edited on a computer" can be closed and stay closed. On desktops the page header sticks to the top and shrinks while you scroll a long list.
- **The designer shows where your template stands.** Next to the Save button it now says "Saved" or "Unsaved changes", the canvas takes a bigger share of the window, and the note about offline printing tucks into a small icon once you've read it.
- **The phone pages fit their screens.** On the Automation page the three sections sit in one row instead of stacking, the pairing page keeps one name — "Devices" — everywhere, and its explanation starts with the short version and a "Learn more" for the rest.
- **Clearer selection in Settings.** The chosen language, theme, or density card now carries a check mark and a darker border, so you can see at a glance which one is active.
- **Easier with a keyboard or screen reader.** The designer's layout switch moves with the arrow keys, and the app now announces when a template is saved or has unsaved changes.

### Fixed

- **Small buttons are easier to tap.** The notice close button and the sync chip now have a 44 px touch area on touch screens.
- **Clearer sync status for screen readers.** The sync chip now announces "Synced" or "Syncing" — the same word you see — so its spoken name matches its visible label.
- **Automation tabs fit small phones.** The three section tabs stay on one line at 360 px instead of making the strip scroll sideways.

## [2026.1118.1] - 2026-11-18

### Added

- **Encrypted phone-to-PC printing.** When your phone sends a print to your PC over Wi-Fi, everything between the two is now encrypted, so other devices on the same network can no longer read what you print.

## [2026.1118.0] - 2026-11-17

### Changed

- **Receipts use the full print area.** On 58 mm and 80 mm receipt printers, text and barcodes near the right margin no longer get clipped or wrapped.
- **Zebra labels get the right size.** Label size now comes from your print job instead of whatever is stored on the printer, so a stale setting no longer makes labels come out the wrong size.
- **A heads-up for long thermal jobs.** If a job spans more than one sheet on a receipt or label printer, you're told before it prints instead of getting only the first sheet. PDF printers still print every page.
- **Honest page-range messages.** If a print job carries a page range, you now get a clear "not supported" warning instead of silently printing every page.
- **Server images only move when the server changes.** If you run the share service yourself, app-only updates no longer publish a new server image tag.

### Fixed

- **CPCL images print properly.** Logos and graphics on CPCL label printers now use the right format, so they no longer come out garbled or the wrong size.

## [2026.1117.1] - 2026-11-16

### Added

- **Reset your password.** New accounts come with a recovery code at sign-up — keep it somewhere safe. Choose "Forgot your password?" at sign-in and enter the code to set a new one. Each code works once, and you get a fresh one after every reset.
- **Get a recovery code any time.** In Settings, under your account, you can make or replace your code whenever you like.

## [2026.1116.1] - 2026-11-16

### Changed

- **A new Devices page.** Pairing a phone with this PC, inviting guests and "Print via PC" have moved from the Automation page to a Devices page (under More on phones). Old links still take you there.

## [2026.1116.0] - 2026-11-16

### Added

- **Bring back an older template.** The designer's History panel lists every version your template has had — saves, autosaves and earlier restores — and brings any of them back with one click. It asks before overwriting newer changes.
- **Reprint several jobs together.** In History, select some jobs and choose "Print as batch" to print them one after another, in the order you picked.
- **Your library works with other tools.** Tools connected to your PrintNinja server can now read and list your datasets, printer profiles, fonts and account settings.
- **Print updates on Android.** A notification now tells you when a background print finishes or fails. You can choose failures only, every job, or never, in Settings → Background. Tap it to open History.

### Fixed

- **Links open the app on Android.** Tapping a PrintNinja link in a browser or another app now opens the app on your phone — a page, a template or a ready-to-go Print screen — just like it already did on a computer.

