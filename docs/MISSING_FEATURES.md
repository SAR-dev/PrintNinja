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

**3. [Medium] Secure RFCOMM socket only.** The plugin calls
`createRfcommSocketToServiceRecord` and nothing else: no insecure-socket
fallback, and no fallback for a printer that does not advertise an SPP
service record. A printer that needs either one is refused. *Workaround:*
none. *Code:* `AndroidPrintPlugin.kt`.

**4. [Low] No pacing on writes.** The whole job goes out in one `write` followed by
one `flush`. A printer with a small receive buffer could drop or garble a
large image. This is a risk read from the code, not something seen in
testing. *Workaround:* none today. *Code:* `AndroidPrintPlugin.kt`
(`socket.outputStream`).

## Printer languages

**5. [High] ESC/POS sends the image and nothing else.** The job is the initialize
command plus one raster block. There is no paper feed, no cut and no
cash-drawer command, and no native text or code page, so everything prints as
a bitmap. The helpers exist in `transport/escpos.rs` (`feed`, `cut`,
`open_drawer`, `set_codepage`, `build_receipt`) but nothing in the print path
calls them. A printer may stop short of the tear bar or not cut.
*Workaround:* leave blank space at the bottom of the template, and use the
printer's own auto-feed or auto-cut setting if it has one. *Code:*
`transport/mod.rs` (`encode_for_language`), `transport/escpos.rs`.

**6. [Medium] TSPL has a fixed label gap and no print tuning.** The encoder always
emits a 2 mm gap (`DEFAULT_GAP_MM`) because the printers table has no gap
column. It never sets density or speed, and it does not handle continuous
(gapless) media. *Workaround:* none in the app. *Code:*
`transport/mod.rs`, `transport/label_langs.rs`.

**7. [Low] Status checks cover three languages only.** Before a job, the printer is
asked whether it can print only for ESC/POS, ZPL and TSPL. CPCL, raster and
PDF jobs go out without that check, so a printer that is out of paper or has
its cover open is found out later, if at all. *Code:*
`transport/status.rs` (`dialect_for`).

**8. [Low] CPCL, raster and PDF cannot print on the phone alone.** On Android these
need a paired PC to render. ESC/POS, ZPL and TSPL render on the device.
*Workaround:* pair a PC (Settings → Shared rendering), or choose a printer
that speaks one of the three. *Code:* `commands/print.rs` (`need_peer`).

**9. [High] Not yet verified on a real print head.** The project's own architecture
notes say Android's ESC/POS, ZPL and TSPL output has been tested against a
simulated printer but not on physical hardware. A given model working is not
guaranteed. See [printers and transports](./PRINTERS_AND_TRANSPORTS.md#per-operating-system).

## Setup and feedback

**10. [High] A PDF printer on a USB or Bluetooth wire only logs a warning.** A
receipt or label printer saved with language PDF gets the raw PDF file and
prints pages of random characters. The backend notices and writes a log line;
the app shows nothing. New desktop USB and Bluetooth printers now start at
ESC/POS, but rows saved earlier keep PDF until someone edits them. An error
or a banner in the app would close this. The warning is logged rather than
refused on purpose, so that an unusual printer that really reads PDF over
these wires keeps working. *Code:* `commands/print.rs` ("language is PDF on
a raw USB/Bluetooth transport").

## USB on Android

**11. [Medium] The USB list shows every USB device, not only printers.** The plugin
returns everything `UsbManager` reports, with no check for the printer device
class, and the name shown is the device path (for example
`/dev/bus/usb/001/002`), not the product name. The vendor and product IDs are
read but not passed on. *Workaround:* unplug the printer, open the list, plug
it in, and pick the entry that appeared. *Code:* `AndroidPrintPlugin.kt`
(`enumerateUsbPrinters`), `transport/android_usb.rs` (`discover`).

**12. [Medium] A saved USB printer is tied to the device path.** The row stores
`UsbDevice.deviceName`, and the plugin finds the device by that exact string.
That path comes from the bus and device numbers the phone gave at plug-in, so
after unplugging, using another port or a hub, or a reboot, the row can report
"USB device not found" or, less likely, point at a different device. This is
read from the code; the numbers were not watched changing. *Workaround:* add
the printer again from the list. *Code:* `AndroidPrintPlugin.kt`
(`findUsbDevice`).

**13. [High] The USB permission prompt can outlast the app's timeout, and it is asked
again.** The plugin waits up to 60 s for the answer to the system dialog, but
the Rust side gives opening and probing 30 s (`USB_TIMEOUT`), so a slow answer
ends as "stopped responding while opening". The plugin manifest declares no
USB-attached intent filter, so there is no "always open with PrintNinja"
grant to remember the choice. *Workaround:* answer the dialog quickly and
retry. *Code:* `transport/android_usb.rs`, `AndroidPrintPlugin.kt`
(`ensureUsbPermission`).

**14. [Low] The first bulk-OUT endpoint is used, whatever interface it is on.** A
device that exposes more than one interface (a printer with a card reader or
a network port, say) may get the job on the wrong one. The code does not look
for the printer class (7). This is a risk read from the code, not something
seen in testing. *Workaround:* none today. *Code:* `AndroidPrintPlugin.kt`
(`bulkEndpoints`).

## Network printers (IPP, raw TCP and CUPS)

**15. [Medium] No sign-in for IPP.** The request carries a fixed user name
(`PrintNinja`) and no password, token or other credential. A printer or CUPS
server that demands authentication answers with an HTTP error, which is
shown as "IPP server returned HTTP …". *Workaround:* allow anonymous printing
for this machine, or print through a queue that does. *Code:*
`transport/ipp.rs` (`send_bytes`, `build_ipp_request_with_format`).

**16. [Medium] Self-signed printer certificates are refused.** The shared HTTP client
is built with default settings and has no option to trust a certificate of
the user's choosing or to skip the check. Many `ipps://` printers ship a
self-signed certificate, so the job fails at connect. Also, the reachability
check on an HTTPS address only opens a TCP connection and never does the TLS
handshake, so it can say "reachable" for a printer whose jobs then fail.
*Workaround:* use plain `ipp://` on a trusted network, or a raw TCP port.
*Code:* `transport/mod.rs` (`shared_http_client`), `transport/ipp.rs`
(`reach`).

**17. [Medium] "Printed" means "the printer accepted the job".** After the Print-Job
reply, the app does not ask the printer about the job again. A jam or paper
out that happens later is not seen, and History shows success. The reply
itself is read: a rejected job, or one the printer reports as stopped or
aborted, is reported as a failure. *Workaround:* none; check the printer's
own panel. *Code:* `transport/ipp.rs` (`parse_job_outcome`).

**18. [Low] IPP always labels the job as PDF.** `send` calls `send_pdf` for every
job, so an IPP row set to a command language (ZPL, say) would send those
bytes declared as `application/pdf`. In practice the IPP path is for PDF
printers only. *Workaround:* for a label printer, use raw TCP on port 9100,
or a CUPS raw queue added as a `system` printer. *Code:* `transport/ipp.rs`
(`impl PrinterTransport`).

**19. [Low] No paper size, tray, duplex, colour or quality options over IPP.** The
only job attribute besides the document format is `copies`. Everything else
comes from the printer's defaults and from the page size inside the PDF. A
printer that picks media by its own setting rather than by the PDF may use
the wrong tray. *Workaround:* set the printer's defaults on its panel or web
page. *Code:* `transport/ipp.rs` (`build_ipp_request_with_format`).

**20. [Low] The app never asks an IPP printer what it supports.** Get-Printer-Attributes
is sent only after a failure, to find out why. Supported document formats and
media sizes are never read, so the form cannot warn that a printer does not
take PDF. *Code:* `transport/ipp.rs`.

**21. [High] Copies of a PDF on a raw wire are the file repeated.** Only IPP, and
CUPS on Linux, take a hardware copies count. For raw TCP, the Windows spooler,
USB and Bluetooth, the payload is written N times in one job. For ESC/POS,
ZPL, TSPL and CPCL that is N labels, which is the intent. For a PDF it is N
PDF files joined end to end, and a PDF reader may print only the first.
Not tested on a printer. *Workaround:* for a PDF printer that is not on IPP,
print once per copy. *Code:* `commands/print.rs` (`honors_copies`).

**22. [Low] Raw TCP has no encryption and no sign-in.** That is how port 9100
works, so it is a property of the protocol and not a gap to close in the
app. Anyone on the network can send to the printer, and the job travels in
the clear. It is listed here so nobody relies on it for anything private.
The connectivity test on a raw TCP printer also sends an ESC/POS initialize
whatever language the row says. *Code:* `transport/raw_tcp.rs` (`test`).

**23. [Low] Desktop CUPS is the local daemon only.** The address is
`http://localhost:631` unless the `PRINTNINJA_CUPS_URL` environment variable
says otherwise; there is no setting in the app, and no sign-in for a CUPS
server that needs one. *Workaround:* set the variable before launching, or
add the remote queue as an `ipp` printer. *Code:* `transport/cups.rs`
(`cups_base_url`).

## Platforms

**24. [High] Windows system printers with a GDI-only driver cannot print the PDF.**
The app declares the PDF datatype only when the queue offers it. When it does
not (the stock Windows print processor lists `RAW`, `NT EMF` and `TEXT`), the
job is sent as `RAW`, and a driver that understands only GDI prints the PDF
source or nothing. The backend writes a warning to the log; the app shows
nothing. *Workaround:* add the printer by its network address as `ipp` or raw
TCP if it reads PDF, or choose a queue whose driver lists `PDF`. *Code:*
`transport/windows_spooler.rs` (`choose_datatype`).

**25. [Low] Android has no system printer type.** `system` printers exist only on
Windows and Linux, so a printer that Android reaches through a print service
is not available. A `system` row on Android reports that it is not supported
on this platform. *Workaround:* add the printer by address as `ipp` or raw
TCP. *Code:* `transport/mod.rs` (`create_transport`).

**26. [Low] Direct USB and Bluetooth are Android only, and neither desktop system
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
- **Raw TCP stays a plain socket.** No TLS and no sign-in; see item 22.

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
| 5. ESC/POS feed and cut | High | Affects every receipt printer; the encoder code already exists | Small |
| 10. Visible PDF-on-raw-wire warning | High | Stops a confusing failure at the source | Small |
| 21. PDF copies on raw wires | High | Wrong output with no error; sending one job per copy fixes it | Small |
| 13. USB permission timeout | High | A mismatch between two timeouts; hits the first USB print on Android | Small |
| 24. Windows GDI queues and PDF | High | Same fix as 10: show the log warning in the app | Small |
| 6. TSPL gap setting | Medium | Needs a new column, the form field and the encoder change | Small to medium |
| 3. Insecure RFCOMM fallback | Medium | Fixes printers that refuse the connection; needs a real device to test | Small |
| 11–12. USB list and stable address | Medium | Filter by class, show the product name, match by vendor and product ID | Small to medium |
| 15–16. IPP sign-in and certificates | Medium | New settings and secret storage; only if a user needs it | Medium |
| 17. Job status after acceptance | Medium | Poll Get-Job-Attributes; adds a wait to every job | Medium |
| 4. Write pacing | Low | Only if a printer is seen dropping data; needs hardware | Small to medium |
| 18. IPP declared as PDF only | Low | Refuse or warn when an IPP row has a command language | Small |
| 7. Status checks for more languages | Low | Needs each language's documented status reply | Medium |
| 1–2. BLE and scanning | Low | New plugin code, permissions and UI; only worth it if a printer needs it | Large |

Item 9 (checking on a real print head) is High but is testing work, not code,
so it is not in the table.
