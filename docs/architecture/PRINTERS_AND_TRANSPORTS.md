# Printers and transports

> **Who this is for:** anyone adding a printer, choosing between PDF and a label language, or wondering why USB works on one system and not another.
> **What you will know after reading:** the four ways to reach a printer, how the app finds printers on the network, the two output paths (document vs bitmap), the five label dialects, and what changes per operating system.

A printer is configured with a **type** (how to reach it) and a
**language** (what it understands).

## Transports: how to reach a printer

- **Network printers** are reached over the office protocol IPP
  (Print-Job requests, default port 631) or over a raw TCP socket (default
  port 9100 — bytes in, paper out). Before sending, the app can probe the
  printer in its own dialect to catch an offline or faulted machine early.
- **System printers** go through the operating system: the Windows spooler on
  Windows, CUPS on Linux. The app hands over finished bytes and lets the OS
  queue them.
- **USB and Bluetooth printers** are reached differently per platform. On
  Windows they are spooler lookups by name: the printer must already be
  installed as a Windows printer, and the app does not open the USB device or
  the COM port itself. On Android they are driven directly (bulk-OUT through
  `UsbManager`, RFCOMM serial). On Linux there is no direct transport; the
  app reports USB/Bluetooth as unsupported and tells the operator to install
  the device as a CUPS raw queue instead (e.g.
  `sudo lpadmin -p Label -m raw -v usb://... -E` or
  `bluetooth://... -E` and add the queue as type `system`). A raw queue passes
  `application/octet-stream` bytes unchanged, so ESC/POS, ZPL, TSPL, CPCL and
  raster reach the head exactly as encoded.

## Discovery

Discovery lists the machine's OS queues (Windows spooler, CUPS) and, on
Android, USB devices. On top of that, a bounded mDNS browse finds network
printers on the LAN — the IPP services `_ipp._tcp` and `_ipps._tcp`
(become type `ipp`) and the raw-TCP services `_pdl-datastream._tcp` and
`_printer._tcp` (become type `raw_tcp`) — so a printer that advertises itself
appears in the list with its address, and a tap adds it without typing
anything. Hosts that do not resolve to a private address are skipped, and the
browse is one-shot (a few seconds per tap, plus a short automatic window
after the page opens), never a continuous scan.

A **test print** runs the entire pipeline end to end with mock data to prove
a new printer works. For Windows system, USB and Bluetooth printers the
connectivity test only checks the queue's status and sends nothing.

## Languages: two fundamentally different paths

The printer's language decides what the backend produces.

**The PDF path** is for office printers: the page is rendered at its real
size in millimetres and the resulting document is sent untouched. No
screenshot, no translation — the printer's own PDF interpreter does the work.

**The bitmap path** is for receipt and label printers, which understand small
command languages rather than documents. The sheet is photographed at exactly
the printer's dot density — one screen pixel per printer dot, so nothing is
resampled or blurred. Sheets are laid out in millimetres, so before the
photograph the whole sheet is scaled so the paper's width spans exactly the
printer's dot width: one millimetre of design becomes one millimetre of label
at that printer's resolution, rather than a small sheet floating in a large
capture area. The result is reduced to pure black and white and packed into
bits.

Those bits are then wrapped in the printer's dialect:

- **Receipt printers (ESC/POS)** get an initialize command followed by a
  raster-graphics command carrying the raw bitmap.
- **TSPL label printers** get a short script: label size, gap size,
  direction and origin, a clear command, the bitmap, and a print command.
- **Zebra printers (ZPL)** get a format frame with the bitmap encoded as
  hexadecimal text (readable, but roughly twice the size of raw bytes).
- **Mobile CPCL printers** get a compact header, one hex line per row, and a
  print command.
- **Bare-bitmap devices** (some spoolers and bridges) receive just the packed
  dots with no command language at all.

Two details matter in practice. First, the label dimensions in those headers
describe the paper, not the design: the size headers and the rendered dots
both use the paper dimensions, so the bytes and the sheet always agree — a
wrong paper choice in the Print page mis-sizes the label even when the
preview (which shows the same mapping) warned you. Second, copies are a send
loop, not a language feature: the finished payload is transmitted once per
copy, except on transports (IPP/CUPS) that take a hardware copies count.

## Per operating system

The pipeline is identical on every OS; what changes is how pages become bytes
and which transports exist.

- **Windows** renders PDFs through the built-in browser engine (kept warm in
  the background for speed) and reaches printers via network protocols or the
  system spooler. USB and Bluetooth printers go through the spooler too, so
  they must be installed as Windows printers first.
- **Linux** renders through headless Chromium, which must be installed
  (the `.deb` declares `cups` and a Chromium-family browser; the AppImage does
  not bundle one and warns once at startup if none is found —
  `apt install chromium` or `google-chrome`) and reaches printers via network
  protocols or CUPS (including CUPS raw queues that front USB/Bluetooth
  thermal heads — `lpadmin -m raw`, declared as `system` with
  `application/octet-stream`). The browser stays running in the background so
  every print only opens a tab, like on Windows. Direct USB/Bluetooth are not
  supported — the app tells the operator to use the CUPS raw route instead.
- **Android** renders PDFs through the system WebView, and renders
  ESC/POS, ZPL and TSPL jobs directly: the same WebView measures the page
  at the head's own resolution (1 CSS px = 1 dot, via a density-160
  context) and the device thresholds the pixels to 1-bit dots before the
  encoder. Those languages are not yet verified on a real head (PLAN §4,
  D4.1), so the printer form offers only the QA'd ones and labels them
  accordingly; CPCL and raster still need a paired PC (PDF only). Network
  printers are added by address or picked from an mDNS scan of the LAN;
  USB printers are listed through the USB host API, and Bluetooth
  printers are chosen from the bonded devices, which the Add sheet lists
  by name and MAC address. A background
  service, on by default, keeps the print queue draining even after the app
  is swiped away (Open and Close sit on its notification), and the app can
  request exemption from battery optimization so the system doesn't defer
  prints.
- **macOS** is not a print target: rendering and delivery both report
  unsupported rather than failing mysteriously.

See also: [rendering and layout](./RENDERING_AND_LAYOUT.md) (how the pages
get here), [queue and history](./QUEUE_AND_HISTORY.md) (how the job is
tracked), and the [glossary](../GLOSSARY.md).
