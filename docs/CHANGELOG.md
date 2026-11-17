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
- Once a section is released it is the release notes. Don't go back and rewrite it.

---

## Unreleased

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

## [2026.1115.0] - 2026-11-15

### Added

- **See where you're signed in.** Settings → Profile lists every device using your account and lets you end one — a lost laptop, say — without signing out your other devices.

### Changed

- **Fewer printers need a paired PC.** Most labels now print straight from your phone. Only PDF printing still needs a computer, so you no longer pair one you don't need.
- **New limits for busy accounts.** Each template keeps its 100 newest saved versions (autosaves keep 50), and an account can hold 1,000 templates, 500 sample datasets and 500 printer profiles.

### Fixed

- **Notification settings that stick.** If you turned notifications off, Settings now shows that and lets you turn them back on — or opens Android's settings when the prompt won't appear again.
- **A truthful update badge on Android.** It now shows only when the update has an Android app to download, links straight to it and tells you to open it to install.

## [2026.1113.4] - 2026-11-13

### Fixed

- **Previews that show your template.** If your sample data has none of a template's fields — a kitchen ticket opened with shipping-label data, say — the preview now shows the template's own sample data instead of a blank page, and tells you so.

## [2026.1113.3] - 2026-11-13

### Changed

- **A clearer Bluetooth address field.** When a printer uses your computer's own printer driver, the address is dimmed and explained: it isn't used for those jobs, but the value is kept for the day you switch back to direct printing.

## [2026.1113.2] - 2026-11-13

### Changed

- **Fix paper width in one tap.** If a label is wider than a printer's saved paper width, the warning now offers to update the saved width with one click. A printer without a saved width gets a one-time offer to set it from the template.
- **A steadier Print screen.** Ready, sending, sent and failed now share one line, so the form stops jumping when a print starts or ends. Timings, the full error and warnings open under "Details".

## [2026.1113.1] - 2026-11-13

### Changed

- **A simpler Print page.** The main card now holds just the printer, template, test data and copies. Paper size, margins and other fine-tuning sit in an "Advanced options" section that stays folded until you open it, and remembers your choice.
- **Fewer pop-ups.** Saved settings, removed rows and copied text no longer show a confirmation message — the screen already shows the result. Errors and updates you can't see otherwise still notify you.
- **Errors next to the field.** Invalid printer details or paper sizes now explain themselves right where you typed them, instead of in a pop-up.

## [2026.1113.0] - 2026-11-13

### Changed

- **Every barcode type prints.** UPC-E, ITF-14, Data Matrix, PDF417 and Aztec used to be preview only. Now they print like the rest.
- **What you see is what prints.** Every screen now shows the label exactly as it will come out of the printer.
- **Consistent dates.** Dates no longer change with your browser's region. The default is `2026-11-13`, and you can pick styles like `short` (17 Oct 2026) or `time` (24-hour).
- **Clearer Designer errors.** The banner tells you what went wrong without pointing at a specific line.
- **One sample data set.** The Designer now uses a single shared sample data set per account, edited with one button. Older sets are kept safe and still sync.

### Fixed

- **Correct check digits.** UPC-A, UPC-E and ITF-14 barcodes are now checked properly.

## [2026.1112.0] - 2026-11-12

### Added

- **Bluetooth printing on Windows and Linux, no driver needed.** Pair the printer with your computer, then add it using its Bluetooth address. Classic Bluetooth only (not BLE).
- **Optional driver mode for Bluetooth printers.** Print through your computer's usual printer system instead — this also allows PDFs. Off unless you turn it on.
- **Search and sort templates.** Now available on all three My templates tabs.

### Changed

- **A tidier Add Printer screen.** Printers found on your computer, on the network and over Bluetooth are grouped into short lists with one Rescan button. Tap a group to expand it.
- **Bluetooth addresses checked as you type.** You'll see right away if one doesn't look right.
- **PDF printing works again** on Bluetooth printers in driver mode.
- **More reliable Bluetooth test prints.** The test confirms the printer connection before printing.
- **Updated help guides** for the new Bluetooth setup.

### Fixed

- **The right timeout message on Windows.**
- **Tidier printer window fields.** Misaligned fields in Add/Edit Printer line up again.

## [2026.1110.3] - 2026-11-10

### Added

- **Print a PDF directly.** Send a PDF instead of a template (up to 5 MB). PDF printers get the whole file; other printers print the first page, with a warning if there are more.
- **PDF printing on Linux and Android.**
- **Printers suggest their own settings.** When you add a printer, PrintNinja asks what it supports and suggests the right language. If it can't be reached, you can still add it.
- **Edit printers without re-adding.** Change settings in place, so your saved profiles stay linked.

### Changed

- **Easier-to-read printer lists.** Sections in Add Printer collapse to a count; tap to expand.
- **A clearer example pairing code.** The sample is now `XYZ7K4MP`.
- **Larger print requests accepted**, up to 10 MB.

### Fixed

- **Android app fixes.** Problems that could stop the app building or running properly.
