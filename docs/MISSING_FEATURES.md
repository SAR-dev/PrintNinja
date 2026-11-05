# Missing features in printer support

> **Who this is for:** anyone choosing a printer, deciding what to build next
> in the print path, or wondering why a printer behaves oddly.
> **What you will know after reading:** which Bluetooth and printer-language
> features PrintNinja does not have today, what happens instead, the workaround
> where there is one, and which limits are deliberate.

Checked against the code on `develop` in November 2026. Everything here was
read from the source. Nothing was measured on a printer, except where an item
says so. The per-OS transport rules are in
[printers and transports](./PRINTERS_AND_TRANSPORTS.md); this page lists only
what is absent.

Each item says what is missing, what happens today, what to do about it, and
where the code is.

## Bluetooth on Android

**1. No BLE (Bluetooth Low Energy).** The Android plugin opens only a classic
serial (SPP) socket, using the serial-port UUID `00001101-…`. A printer that
offers only BLE cannot connect. *Workaround:* none; use a printer with
classic Bluetooth, which the spec sheet lists as "Bluetooth 2.1 / 3.0 / EDR".
*Code:* `transport/android_bluetooth.rs`, `AndroidPrintPlugin.kt`
(`sppUuid`).

**2. No scanning for unpaired devices.** The Add dialog lists only devices
already bonded in Android settings. The app does not ask for the scan
permission. *Workaround:* pair the printer in Android Bluetooth settings
first. *Code:* `AndroidPrintPlugin.kt` (bonded-device listing),
`AndroidManifest.xml`.

**3. Secure RFCOMM socket only.** The plugin calls
`createRfcommSocketToServiceRecord` and nothing else: no insecure-socket
fallback, and no fallback for a printer that does not advertise an SPP
service record. A printer that needs either one is refused. *Workaround:*
none. *Code:* `AndroidPrintPlugin.kt`.

**4. No pacing on writes.** The whole job goes out in one `write` followed by
one `flush`. A printer with a small receive buffer could drop or garble a
large image. This is a risk read from the code, not something seen in
testing. *Workaround:* none today. *Code:* `AndroidPrintPlugin.kt`
(`socket.outputStream`).

## Printer languages

**5. ESC/POS sends the image and nothing else.** The job is the initialize
command plus one raster block. There is no paper feed, no cut and no
cash-drawer command, and no native text or code page, so everything prints as
a bitmap. The helpers exist in `transport/escpos.rs` (`feed`, `cut`,
`open_drawer`, `set_codepage`, `build_receipt`) but nothing in the print path
calls them. A printer may stop short of the tear bar or not cut.
*Workaround:* leave blank space at the bottom of the template, and use the
printer's own auto-feed or auto-cut setting if it has one. *Code:*
`transport/mod.rs` (`encode_for_language`), `transport/escpos.rs`.

**6. TSPL has a fixed label gap and no print tuning.** The encoder always
emits a 2 mm gap (`DEFAULT_GAP_MM`) because the printers table has no gap
column. It never sets density or speed, and it does not handle continuous
(gapless) media. *Workaround:* none in the app. *Code:*
`transport/mod.rs`, `transport/label_langs.rs`.

**7. Status checks cover three languages only.** Before a job, the printer is
asked whether it can print only for ESC/POS, ZPL and TSPL. CPCL, raster and
PDF jobs go out without that check, so a printer that is out of paper or has
its cover open is found out later, if at all. *Code:*
`transport/status.rs` (`dialect_for`).

**8. CPCL, raster and PDF cannot print on the phone alone.** On Android these
need a paired PC to render. ESC/POS, ZPL and TSPL render on the device.
*Workaround:* pair a PC (Settings → Shared rendering), or choose a printer
that speaks one of the three. *Code:* `commands/print.rs` (`need_peer`).

**9. Not yet verified on a real print head.** The project's own architecture
notes say Android's ESC/POS, ZPL and TSPL output has been tested against a
simulated printer but not on physical hardware. A given model working is not
guaranteed. See [printers and transports](./PRINTERS_AND_TRANSPORTS.md#per-operating-system).

## Setup and feedback

**10. A PDF printer on a USB or Bluetooth wire only logs a warning.** A
receipt or label printer saved with language PDF gets the raw PDF file and
prints pages of random characters. The backend notices and writes a log line;
the app shows nothing. New desktop USB and Bluetooth printers now start at
ESC/POS, but rows saved earlier keep PDF until someone edits them. An error
or a banner in the app would close this. The warning is logged rather than
refused on purpose, so that an unusual printer that really reads PDF over
these wires keeps working. *Code:* `commands/print.rs` ("language is PDF on
a raw USB/Bluetooth transport").

## Limits that are deliberate

These are not planned. They were looked at and accepted.

- **Windows has no direct USB or Bluetooth.** Both go through the Windows
  spooler, so the printer must be installed as a Windows printer first. A
  spooler-free design was evaluated and not built; its plan and spike tool
  were removed. A side effect: the Windows USB and Bluetooth transports send
  every job as `RAW` and ignore the job's type, so a PDF reaches such a
  printer only if the printer reads PDF itself.
- **Linux has no direct USB or Bluetooth.** Use a CUPS raw queue and add it as
  a `system` printer.
- **iOS and macOS are not print targets.**

If a Windows Bluetooth print feels slow, read the stage timings in History
first. A large `send_ms` points at the spooler. Turning off "Enable
bidirectional support" on the queue's Ports tab, and "Print directly to the
printer" on its Advanced tab, are the cheap things to try before any code
change. These are common Windows fixes and were not tested for PrintNinja.

## Suggested order

A rough order if these are picked up. The sizes are estimates, not
measurements.

| Item | Why first | Size |
|---|---|---|
| 5. ESC/POS feed and cut | Affects every receipt printer; the encoder code already exists | Small |
| 10. Visible PDF-on-raw-wire warning | Stops a confusing failure at the source | Small |
| 6. TSPL gap setting | Needs a new column, the form field and the encoder change | Small to medium |
| 3. Insecure RFCOMM fallback | Fixes printers that refuse the connection; needs a real device to test | Small |
| 4. Write pacing | Only if a printer is seen dropping data; needs hardware | Small to medium |
| 7. Status checks for more languages | Needs each language's documented status reply | Medium |
| 1–2. BLE and scanning | New plugin code, permissions and UI; only worth it if a printer needs it | Large |
