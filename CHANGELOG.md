# Changelog

All notable changes to PrintNinja are recorded here, newest first.
The version is kept in sync across `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
(`pnpm version:set`). Add entries to **Unreleased** as work lands;
`pnpm release` then freezes it in the release commit — the section
becomes that version's dated heading and a fresh empty **Unreleased**
opens on top. An entry-less Unreleased is left alone.

Style: write for users, not developers. Each entry is a short,
plain-language bullet — a bold lead plus at most one line of detail —
that says what people can now do or what got better. Leave out code,
file names, API fields, database changes, tests and build fixes. If a
change isn't something a user would notice, don't list it.

## Unreleased

### Added

- **Reset a forgotten password.** New accounts get a recovery code at sign-up
  (save it somewhere safe). Choose "Forgot your password?" on the sign-in
  screen and enter it to set a new password. Each code works once, and you get
  a fresh one after every reset.
- **Recovery codes for existing accounts.** Make or replace your code any time
  in Settings, under your account.

## [2026.1116.1] - 2026-11-16

### Changed

- **Phone pairing has its own Devices page.** Pairing phones with this PC,
  guest invites and "Print via PC" moved out of the Automation page onto a
  new Devices page (behind More on phones). Old links to the old tab still
  open it.

## [2026.1116.0] - 2026-11-16

### Added

- **See and restore template versions.** The designer's History panel
  lists every version your template has had — manual saves, autosaves
  and earlier restorations — and brings any of them back with one
  click. If the server copy has moved on, it asks before overwriting.

- **Print a selection as one batch.** In History, select any jobs and
  choose "Print as batch": they are re-queued in the order you picked
  and printed one after another as a single batch.

- **Ask the sync server directly for your library.** Datasets, printer
  profiles, fonts and account settings can now be read and listed over
  the API with paging, so tools that integrate with the server no
  longer need to rebuild everything from the sync stream.

- **Know when a background print finished on Android.** A notification
  now tells you when a queued print job finishes or fails while the app
  is in the background — failures only, every job, or never, your
  choice in Settings → Background — and tapping it opens History.

### Fixed

- **Deep links now open on the phone.** `printninja://` links from a
  browser or another app now open the app on Android — opening a page,
  a template, or a pre-filled Print screen — the same as they already
  did on the desktop.

## [2026.1115.0] - 2026-11-15

### Added

- **See and end your signed-in devices.** Settings → Profile now lists
  every signed-in session with its device and last use, and lets you end
  one — a lost laptop, say — without signing out your other devices.

### Changed

- **Only PDF needs a paired PC.** The README and the Android printer
  hint no longer imply CPCL and raster need a computer — they print on
  the phone too (still listed as not offered yet), so nobody pairs a PC
  they don't need.
- **Template history is kept to the newest 100 saved versions per
  template** (autosaves were already kept to 50), and accounts get
  limits of 1,000 templates, 500 sample datasets and 500 printer
  profiles.

### Fixed

- **Declining notifications no longer hides them forever.** Background
  settings now show whether notifications are allowed and can ask again,
  or open Android's notification settings when the prompt won't come back.
- **The Android update badge no longer points at a release with nothing
  to install.** It appears only when the release includes an APK, links
  straight to it and says to download it, then open it to install.

## [2026.1113.4] - 2026-11-13

### Fixed

- **Templates preview with data that fits them.** When your sample data
  has none of a template's fields — a kitchen ticket opened against
  shipping-label data, say — the canvas now shows the template's own
  sample data instead of a blank page, and says so in a note.

## [2026.1113.3] - 2026-11-13

### Changed

- **The Bluetooth address explains itself in driver mode.** When a printer
  prints through the OS driver, the address field is dimmed and notes that it
  is not used — jobs go to the queue under the printer's name — while keeping
  the value for the day you switch back to direct printing.

## [2026.1113.2] - 2026-11-13

### Changed

- **Paper width fixes itself in one tap.** When a label is wider than
  the printer's saved paper width, the warning now offers to set the
  saved width to the label's — one click, no dialog. A printer without a
  saved width gets a one-time offer to register its width from the
  template.
- **One calm line for print status.** Ready, sending, sent and failed
  all take the same single line, so the form no longer jumps when a
  print starts or ends. Timings, the full error and every warning open
  in place behind "Details".

## [2026.1113.1] - 2026-11-13

### Changed

- **A calmer Print page.** The print card now holds just the printer,
  template, test data and copies. Orientation, paper size, margins and
  the other fine-tuning options sit in an **Advanced options** section
  that stays folded until you open it and remembers your choice.
- **Fewer popups.** Confirmation toasts are gone wherever the screen
  already shows the result — a saved setting, a removed row, copied
  text. Errors and updates you can't see otherwise still notify you.
- **Form mistakes point at the field.** Invalid printer details or
  paper sizes now explain themselves right next to the input instead of
  in a popup.

## [2026.1113.0] - 2026-11-13

### Changed

- **Every barcode type now prints.** UPC-E, ITF-14, Data Matrix,
  PDF417 and Aztec used to be preview-only. Now they print like the rest.
- **Previews now match your printout.** Every screen shows the label
  exactly as it will print.
- **Dates look the same everywhere.** They no longer change with your
  browser's region. Default is `2026-11-13`, and you can choose other
  styles like `short` (17 Oct 2026) or `time` (24-hour).
- **Clearer Designer error messages.** The banner explains what went
  wrong, but no longer points to a specific line.
- **Simpler sample data.** The Designer now has one shared set of sample
  data per account, edited with a single button. Older sets are kept
  safe and still sync.

### Fixed

- **Barcode check digits** for UPC-A, UPC-E and ITF-14 are now checked
  correctly.

## [2026.1112.0] - 2026-11-12

### Added

- **Bluetooth printing on Windows and Linux, no driver needed.** Pair
  the printer with your computer, then add it using its Bluetooth
  address. Classic Bluetooth only (not BLE).
- **Optional driver mode for Bluetooth printers.** Print through your
  computer's normal printer system instead, which also allows PDFs. Off
  unless you turn it on.
- **Search and sort in My templates.** Now available on all three
  template tabs.

### Changed

- **A tidier Add Printer screen.** Printers found on your computer,
  network and over Bluetooth are grouped into short lists with one
  Rescan button. Tap a group to expand it.
- **Bluetooth addresses are checked as you type.** You'll see right
  away if one doesn't look right.
- **PDF printing works again** on Bluetooth printers in driver mode.
- **More reliable Bluetooth test prints.** The test confirms the
  printer connection before printing.
- **Updated help guides** for the new Bluetooth setup.

### Fixed

- **A wrong timeout message on Windows** now shows the correct details.
- **Misaligned fields in the Add/Edit Printer window** line up again.

## [2026.1110.3] - 2026-11-10

### Added

- **Print a PDF directly.** Send a PDF instead of a template (up to
  5 MB). PDF printers get the whole file; other printers print the
  first page, with a warning if there are more.
- **PDF printing on Linux and Android.**
- **Smart printer detection.** When you add a printer, PrintNinja asks
  what it supports and suggests the right language. If it can't be
  reached, you can still add it.
- **Edit printers in place.** Change settings without deleting and
  re-adding, so your saved profiles stay linked.

### Changed

- **Easier-to-read printer lists.** Sections in Add Printer collapse to
  a count; tap to expand.
- **Clearer example pairing code.** The sample is now `XYZ7K4MP`.
- **Larger print requests accepted**, up to 10 MB.

### Fixed

- **Android app problems** that could stop it from building or running
  correctly.