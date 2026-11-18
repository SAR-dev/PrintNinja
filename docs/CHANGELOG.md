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

