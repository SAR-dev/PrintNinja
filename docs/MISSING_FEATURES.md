# Missing features in printer support

> **Who this is for:** anyone choosing a printer, deciding what to build next
> in the print path, or wondering why a printer behaves oddly.
> **What you will know after reading:** which Bluetooth, USB, network and
> printer-language features PrintNinja does not have today, what happens
> instead, the workaround where there is one, and which limits are deliberate.

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

**4. [Medium] TSPL has no print tuning.** The label gap itself is now a
per-printer setting (`label_gap_mm`), but the encoder still never sets
density or speed and still does not handle continuous (gapless) media.
*Code:* `transport/label_langs.rs`.

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

**8. [High] The USB permission dialog is asked on every connect.** The Rust side
already gives opening and probing 90 s (`USB_OPEN_TIMEOUT`), so it outlasts
the plugin's 60 s dialog wait and a slow answer no longer ends as "stopped
responding while opening"; the pure transfers keep the 30 s `USB_TIMEOUT`.
What is still open: the dialog is asked on every connect and the plugin
manifest declares no USB-attached intent filter, so there is no "always open
with PrintNinja" grant to remember the choice. *Code:* `transport/android_usb.rs`
(`USB_OPEN_TIMEOUT`), `AndroidPrintPlugin.kt` (`ensureUsbPermission`).

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
The app already declares the PDF datatype only when the queue offers it and,
when it does not (the stock Windows print processor lists `RAW`, `NT EMF` and
`TEXT`), sends the job as `RAW` and says so on the print response. The limit
that remains is in the driver: a GDI-only driver still cannot rasterize the
PDF, and the app cannot fix that. *Workaround:* add the printer by its
network address as `ipp` or raw TCP if it reads PDF, or choose a queue whose
driver lists `PDF`. *Code:* `transport/windows_spooler.rs` (`choose_datatype`).

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
so it is not in the table.

The items fixed since the last revision of this page are no longer listed:
the insecure RFCOMM fallback, the ESC/POS receipt frame, the TSPL gap
setting, the PDF warning on a USB or Bluetooth wire, the USB list and stable
address, IPP sign-in, self-signed certificates, job status after acceptance,
copies on a raw wire, and the GDI-visible RAW fallback. Items 4, 8 and 15
are the still-open halves of items that were only partly fixed; the rest of
their text is gone with the fixes.
