# Glossary

> **Who this is for:** anyone meeting the printing vocabulary for the first time — the app, the architecture docs, or the error messages.
> **What you will know after reading:** the plain meaning of every term PrintNinja uses, in the order you are likely to meet them.

Terms are written *plain word first, technical name second*.

## The pipeline

- **Template** — your saved layout, in one of two kinds: a **document template** or a **label template**. Each saved version has its own ID, so devices can agree on exactly which copy a print used.
- **Document template** — the HTML and CSS kind, for document (office) printers: `{{placeholders}}` where your data goes, with barcodes and QR codes drawable from the data.
- **Label template** — the canvas kind, for thermal receipt and label printers: text, barcodes, QR codes, images, lines, rectangles, frames and groups placed in millimetres. Labels live on the device only — they are not synced or shared to the community.
- **Track** — the side a template is on: *document* (HTML and CSS) or *label* (a scene drawn in millimetres). The app follows the track to send each job down the right print path, and refuses a request that mixes the two.
- **Data** — the JSON that fills the template: one order, a list of orders, or a test dataset.
- **Design page** — one finished page, rendered at exactly the size the template was authored at, with no knowledge of any paper. A template's *design size* is the size of one of these pages.
- **Sheet** — a physical page of paper, at the *paper size* chosen for the print. Sheets are what actually go into the printer.
- **Placement (fit mode)** — how a finished design page is scaled and positioned on a sheet: Actual size, Fit to width (default), Fit to page, Shrink only, or Fill. A design is never re-laid out for the paper, only scaled like a picture.
- **Printable area** — the sheet minus its margins; where pages may land.
- **Pagination** — when a record's content is taller than one design page, the rest continues on further pages of the same height.
- **Test print** — a real end-to-end print with built-in mock data, to prove a printer works.

## Reaching a printer

- **Transport (printer type)** — how to reach the machine: Network, System, USB, or Bluetooth (the app's display names; `ipp` and `raw_tcp` are both Network).
- **Printer language** — what the machine understands: a document (PDF) or a small command language for receipts and labels (ESC/POS, ZPL, TSPL, CPCL, or bare raster).
- **IPP** — the office network printing protocol; Print-Job requests on default port 631.
- **Raw TCP** — the other network option: a plain socket (default port 9100) with bytes in and paper out.
- **Spooler / CUPS** — the operating system's print queue: the Windows spooler on Windows, CUPS on Linux. A *system printer* means "hand the bytes to the OS."
- **Raw queue** — a CUPS queue (e.g. `lpadmin -m raw`) that passes bytes through unchanged, which is how Linux talks to thermal heads.
- **mDNS browse** — the short, one-shot network scan that finds printers (and PCs) that advertise themselves on the LAN.

## Printing from a phone

- **Pairing** — the one-time, deliberate connection of a phone to a PC on the same network. The PC shows a short-lived **pairing code**; typing it on the phone mints a **device token** that the phone presents on every later request.
- **Shared rendering** — the phone lays the pages out, asks the PC to produce the image or PDF, takes back the finished bytes, and prints them on its own printer. The PC never touches the phone's printers, templates, data, or history.
- **Print via PC** — a stronger borrowing: the whole job runs on the PC's printers with the PC's templates, and the phone only polls for the outcome. No local fallback while it is on.
- **Guest invite** — a time-boxed code a PC owner mints so someone without an account can pair: expiry, optional max uses, and print or render-only. The invite *is* the credential.
- **Background service** — the Android service that keeps the print queue draining after the app is swiped away.
- **Devices page** — where phones pair with this PC, guests are invited, and Print via PC is switched on. Titled "Devices" on every platform (phone included); its main card is "Shared rendering".

## Automation

- **Local API** — the REST server inside the app (default `127.0.0.1:17717`) that scripts, POS systems, and phones print through. No API keys: loopback callers pass, LAN callers must be paired.
- **Idempotency key** — a caller-chosen stamp on a print request; replaying the same key never prints a second copy.
- **Deep link** — a `printninja://print?...` link that starts a print from another app or web page; links from untrusted sources ask first.
- **Webhook (print callback)** — an optional `https` URL the app POSTs the job outcome to after the job closes.
- **Share service** — the hosted account server for templates, fonts, and preferences. It has no rendering engine: printing never goes through it.
- **Sync ID / revision** — the server identity of a template version; Print via PC compares these and refuses (with a Sync prompt) rather than print the wrong version.

## Jobs

- **Job** — one print request, remembered end to end: settings, data, outcome, error, duration, and per-stage timings.
- **Reprint vs retry** — reprint clones a finished job and wakes the queue; retry re-queues only jobs that ended in failure or cancellation.
- **Retention** — the Settings limits (age and record count) that automatically purge old history rows.

## Pages and sections

- **Print** — where you pick a printer, load data, and send a job.
- **History** — every job with its outcome, settings, and reprint actions.
- **Templates** — the library of saved templates, each with a badge naming its kind, and a preview, print, and edit. It is the one place where new templates (label or document) are created.
- **Designer** — where templates are opened and edited: a live HTML and CSS editor for document templates, a millimetre canvas for label templates.
- **Printers** — the printer list with test print and per-printer settings.
- **Automation** — the program-driven side: the local API server, an explorer console, and trusted deep links.
- **Devices** — phone-to-PC pairing, guest invites, and Print via PC (see "Devices page" above).
- **Settings** — app configuration, grouped into sections: General (appearance and language), Setup, Profile, Background, Account & sync, Data & network, Retention, and Diagnostics.

## Where to go deeper

- [Architecture overview](./ARCHITECTURE.md) — the system map and pipeline
- [Rendering and layout](./architecture/RENDERING_AND_LAYOUT.md) — design pages, fit modes, pagination
- [Printers and transports](./architecture/PRINTERS_AND_TRANSPORTS.md) — transports, languages, per-OS notes
- [Queue, memory, and history](./architecture/QUEUE_AND_HISTORY.md) — the queue, timings, webhooks
- [Phone and PC sharing](./architecture/PHONE_AND_PC_SHARING.md) — pairing, tokens, guests, Print via PC
