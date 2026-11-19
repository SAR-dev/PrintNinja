# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Calendar Versioning](YYYY.MMDD.patch) — see the crate version in `src-tauri/Cargo.toml`.

## [Unreleased]

### Fixed

- **Windows USB printers now declare PDF when the queue supports it.** USB sends previously always went out as `RAW`, which garbled PDF-language printers on GDI-only drivers; they now use the same datatype selection as the spooler path.
- **Windows Bluetooth (direct COM) checks the printer before sending.** A Bluetooth printer that is out of paper, jammed or offline now refuses the job with a clear message instead of silently swallowing it — matching the pre-send fault detection the raw-TCP, Linux Bluetooth and Android paths already had.
- **IPP printers declare the correct document format.** Command-language jobs (ESC/POS, ZPL, TSPL, …) sent to an IPP endpoint are now declared `application/octet-stream` instead of being mislabeled as PDF.
- **Android network discovery lists raw-TCP printers.** JetDirect/9100 printers found by the mDNS browse now appear in the add-printer flow instead of being silently dropped.

### Changed

- **Settings page split into section components.** The 1,789-line `Settings.tsx` is now a thin shell composing one component per section in `src/pages/settings/` (General, Background, Share, Data, Retention, Diagnostics + the Windows print-repair card). Each section owns its state, initializes from the local settings cache (no loading gate, no first-paint flicker) and reconciles with the backend on mount. Rendered markup, testids and deep-link behavior are unchanged.
- **Print, Designer and PrinterSetup pages split the same way.** The three remaining 1,700–2,100-line pages are now thin shells (108–287 lines) composing section components and small state hooks in `src/pages/print/`, `src/pages/designer/` and `src/pages/printer-setup/`. Rendered markup, testids and behavior are unchanged.
- Windows USB test/send no longer blocks a tokio worker thread (moved to the blocking pool like the spooler path).
- `IppPrinter::test` is now a connectivity check only; it no longer prints a real test page.
