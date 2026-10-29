# Print Architecture

How data becomes dots on paper in PrintNinja. This document explains the
ideas; it deliberately contains no code and no file references.

## The pipeline at a glance

Printing is a chain of transformations. Raw business data goes in one end,
printer-specific bytes come out the other, and every step in between exists
to answer one question: what should each dot on the paper be?

```
Data  +  Template  →  Design pages  →  Sheets  →  Image or PDF  →  Printer language  →  Wire  →  Paper
```

The middle of that chain is the part to hold in your head. A template is
rendered into *design pages* exactly as it looks in the Designer, with no
knowledge of any paper. Only afterwards are those finished pages *placed* on
physical *sheets*. Rendering and placement are separate steps, and nothing
about the paper ever feeds back into the template.

Each stage is timed, so a slow print can be traced to the exact step that
caused it — fetching data, rendering the template, laying out pages,
producing the image, sending it, or recording history.

One stage can be done by a different machine. A phone never produces the
image itself: it hands that single step to a paired PC on the same Wi-Fi and
takes back the finished bytes (§9). A desktop can do the same to borrow a
faster PC, but it can also render for itself. Everything before and after
that step stays on the device that owns the printer.

## 1. Where a print can start

A print can be triggered from many places — the Print page, a test button in
the Designer, the local REST API, a deep link from another app, or by
reprinting an old job from history. But all of them converge on a single
pipeline. This is deliberate: there is exactly one place where pages are
rendered and sent, so a fix or improvement applies to every entry point at
once.

Each job remembers how it entered the system: through the UI, the API, a
deep link, a multi-row batch run, or as a test. Deep links from untrusted
sources pause at a confirmation sheet before anything renders, and every
reprint of a physical page asks for confirmation first — printing costs paper
and toner, so destructive actions are never one click.

## 2. Gathering the data and previewing

A print needs three things: a printer, a template, and data.

Data arrives in one of two ways. In test mode the app uses built-in mock
data shaped like a small shop — a store, a customer, an order with line
items — so layouts can be designed without a backend. In a real print the
user gives a data URL; the app fetches it (plain GET, or POST with an empty
JSON body) and the result becomes the data. If the fetch fails, the preview
falls back to the mock data and says so, rather than showing a blank page.

The preview is a real render, not a mock-up: the same template engine that
the backend uses runs in the browser, one record per page, and the same
placement rules put each page on a drawn sheet of the chosen paper — so what
you see is what prints. A list of records prints one page each; a single
object repeats for as many copies or records as requested, with the preview
capped to the first few pages, and to a fixed number of drawn sheets, so a
thousand-record run or a very tall design doesn't freeze the screen.

Because the template is rendered only once per record, changing the paper,
orientation, margins, fit mode, or grayscale never re-renders anything. The
preview simply redraws the same finished pages in a new position and scale,
which is why those controls respond instantly.

Templates are HTML with placeholders. A template engine merges each data
record into the HTML, producing finished pages. Small helpers format values
— currency, dates, upper/lower case, padded numbers — and two special
helpers draw barcodes and QR codes as inline vector graphics, either from a
fixed value or from a data field (so every label and every CSV row can carry
its own code). Styling comes in three layers: a base stylesheet, compiled
utility classes detected in the template, and the author's own CSS.

When the user presses Print, the app sends the printer name, the template,
the paper size (chosen in the Print page, or the template's own size when
left on automatic), the orientation (defaulting to the template's own, still
flippable per print), margins, fit mode, the copy count, and either the data
itself (test mode) or the data URL (real prints — the backend re-fetches it,
so the preview fetch is never trusted for output).

### Design size vs paper size

A template has a *design size*: the page it was authored at, shown in the
Designer and stored with the template. A print has a *paper size*: the
physical sheet it lands on, chosen per print and never written back to the
template. The preview draws the paper sheet and maps the design onto it,
exactly as the backend will — a mapping label under the preview spells it
out ("design 80×200 mm → paper 210×297 mm"), and the orientation selector
swaps the paper, never the design.

The central rule is that **a design is never re-laid out for the paper.**
Each record is rendered once, at exactly the design size, inside its own
frame — the same way the Designer canvas shows it. That finished frame is
then scaled, as a picture would be, and positioned on the sheet. Line
breaks, wrapping, and aspect ratio therefore stay exactly as designed;
only where the finished page lands on the paper changes. Scaling is always
uniform on both axes, so a design is never stretched.

### Placement: how a design lands on a sheet

Placement happens inside the *printable area*: the paper minus its margins.
Margins belong to the paper alone; they are carved out of the sheet, never
out of the design. The fit mode then decides the scale and position:

- **Actual size** — one design millimetre is one paper millimetre, anchored
  at the top-left. A design taller than the printable area continues on the
  next sheet.
- **Fit to width** (the default) — scaled so the design spans the printable
  width, anchored at the top-left, continuing onto further sheets when it is
  taller than one.
- **Fit to page** — the largest scale at which the whole design fits,
  centred.
- **Shrink only** — like fit to page, but never enlarges, centred.
- **Fill** — the smallest scale that covers the whole printable area,
  centred and cropped to it.

A design that continues across sheets is sliced by simply moving it up by
one printable height per sheet; a design that lands exactly on a sheet
boundary uses one sheet, not two, and a hard cap stops a pathologically tall
design from producing an unbounded document. When design and paper are the
same size and margins are zero, the scale is exactly one and the design sits
precisely where it was authored.

### Pagination: content taller than the design

A design's Height is the height of **one page**, and a record whose content
is taller than that is not clipped: the rest continues on further pages of
that height, each placed on the sheet exactly as the first is. How tall the
content is only the browser knows, so it is measured once, by laying the
finished document out at the design's own width and height and reading its
scroll height (with a one pixel tolerance). A record that needs `n` pages is
shown in a frame `n` pages tall, moved up by `k` pages and clipped to one for
page `k`. Template `h-full` / `min-h-screen` elements therefore stretch over
all `n` pages, so a footer pinned to the bottom lands on the last page.

This too exists twice: the PDF measures and adds pages with a small script in
the print document (`PAGINATE_SCRIPT` in `render/layout.rs`, awaited by the
CDP renderer after web fonts load; a one-shot browser adds them from the
frames' `load` events), and the Designer canvas and Print preview use
`lib/render/paginate.ts`. Pages are cut at exact multiples of the Height, not
at line or block boundaries. A record whose frames the script cannot read
stays one page. Raster (ZPL/ESC-POS) output rasterizes the first sheet only,
as before. The UI holds a skeleton until each record's page count is
measured rather than flashing a premature single page; re-edits keep the
stale count (no flash while typing) until the new measurement lands.

Placement is the one piece of logic that exists twice — once in the browser
for the preview and once in the backend for the real output. Both are pinned
to a single shared table of expected results, so a change to one that isn't
mirrored in the other fails a test instead of silently making the preview
lie.

## 3. The backend pipeline

The backend works through the same stages for every job:

1. **Resolve content.** Load the template and rebuild its full stylesheet
   from the three layers. Split the geometry: the design size comes from the
   template (raw HTML sent via the API defaults to A4), while the paper size
   is the request's explicit choice first, the design size second, A4 last —
   so an API or UI caller can print a template on different paper without
   touching the template. Orientation defaults to the template's stored
   value, overridable per request. Raw HTML sent via the API defaults to A4.
2. **Open a job record.** A row is written to the jobs database in the
   *printing* state, stamped with the settings, the data, and the start
   time. It carries an idempotency key stored under a uniqueness constraint:
   retrying the same request returns the existing job instead of printing
   twice.
3. **Fetch the data.** The backend pulls the data URL itself, with a timeout
   and a size cap. Domain allow-lists and private-network blocking apply, so
   a template can't be tricked into reading internal services.
4. **Render the design pages.** The backend engine merges data into one
   page per record exactly as the preview did — same placeholders, same
   helpers. Each record becomes its own complete document at the design
   size, carrying the template's styling and nothing about paper. Any page
   size or margin the template's own CSS tries to declare is stripped, so
   the template cannot fight the layout step. Pages are joined with a fixed
   separator, and the stored job keeps that separator so a replayed job
   splits back into the same pages.
5. **Place the pages on sheets.** The backend builds one printable document
   made of *sheets*, each exactly the paper size. Every design page is
   dropped into a frame of its own design size, scaled and positioned by the
   placement rules above, inside a printable-area box that clips whatever
   the fit mode pushes outside it (fill's crop, the next sheet's slice). The
   document's own page margin is deliberately zero: margins are applied by
   the printable-area box alone, so the browser's handling of page margins
   can never disagree with the preview. Exact color reproduction and an
   optional grayscale conversion are applied on top.
6. **Produce output.** Either a PDF document or a bitmap image, depending on
   the printer's language (see §5) — always at the paper size, so the file's
   page box and the printed sheet agree. Before capturing, the renderer waits
   for web fonts to finish loading in every design frame, not just the outer
   document; otherwise a label could print in a fallback font. This is the one
   step that may run on a paired PC instead of the local machine (§9). On a
   desktop, if that fails for any reason it runs locally, so the outcome is
   the same. A phone has no local renderer: it always buys this step from its
   paired PC, and if that fails the job fails with a message naming the PC.
7. **Send.** The finished bytes go to the printer through the transport
   matching its type (see §4), once per copy, holding that printer's turn so
   two jobs never interleave on the same machine.
8. **Close the job.** The row flips to *success* or *failed* with the error,
   the rendered output (redacted where sensitive), and the finish time. The
   update only applies while the job is still *printing*, so a cancelled job
   can never be resurrected as successful.

## 4. How the bytes reach the printer

Printers are configured with a type (how to reach them) and a language (what
they understand):

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
  the device as a CUPS raw queue instead (e.g. `sudo lpadmin -p Label -m raw -v usb://... -E` or `bluetooth://... -E` and add the queue as type `system`). A raw queue passes `application/octet-stream` bytes unchanged, so ESC/POS, ZPL, TSPL, CPCL and raster reach the head exactly as encoded.

Discovery lists the machine's OS queues (Windows spooler, CUPS) and, on
Android, USB devices; it does not find network printers on any platform. A
test print runs the entire pipeline end to end with mock data to prove a new
printer works. For Windows system, USB and Bluetooth printers the connectivity
test only checks the queue's status and sends nothing.

## 5. Printing across printer languages

The printer's language decides what the backend produces. There are two
fundamentally different paths.

**The PDF path** is for office printers: the page is rendered at its real
size in millimetres and the resulting document is sent untouched. No
screenshot, no translation — the printer's own PDF interpreter does the
work.

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

- **Receipt printers** get an initialize command followed by a raster-graphics
  command carrying the raw bitmap.
- **TSPL label printers** get a short script: label size, gap size, direction
  and origin, a clear command, the bitmap, and a print command.
- **Zebra printers** get a format frame with the bitmap encoded as
  hexadecimal text (readable, but roughly twice the size of raw bytes).
- **Mobile CPCL printers** get a compact header, one hex line per row, and a
  print command.
- **Bare-bitmap devices** (some spoolers and bridges) receive just the packed
  dots with no command language at all.

Two details matter in practice. First, the label dimensions in those headers
describe the paper, not the design: the size headers and the rendered dots
both use the paper dimensions, so the bytes and the sheet always agree — a
wrong paper choice in the Print page mis-sizes the label even when the
preview (which shows the same mapping) warned you. Second,
copies are a send loop, not a language feature: the finished payload is
transmitted once per copy.

## 6. Printing across operating systems

The pipeline is identical on every OS; what changes is how pages become
bytes and which transports exist.

- **Windows** renders PDFs through the built-in browser engine (kept warm in
  the background for speed) and reaches printers via network protocols or the
  system spooler. USB and Bluetooth printers go through the spooler too, so
  they must be installed as Windows printers first.
- **Linux** renders through headless Chromium, which must be installed
  (the `.deb` declares `cups` and a Chromium-family browser; the AppImage does not bundle one and warns once at startup if none is found — `apt install chromium` or `google-chrome`) and reaches printers via
  network protocols or CUPS (including CUPS raw queues that front USB/Bluetooth thermal heads — `lpadmin -m raw`, declared as `system` with `application/octet-stream`). The browser stays running in the background
  so every print only opens a tab, like on Windows. Direct USB/Bluetooth are not
  supported — the app tells the operator to use the CUPS raw route instead.
- **Android** renders PDFs through the system WebView. Network printers are
  added by address; automatic network discovery is not implemented yet. USB
  printers are listed through the USB host API and Bluetooth printers are
  chosen from the bonded devices. The receipt and label languages (ESC/POS,
  ZPL, TSPL, CPCL, raster) need a raster Android cannot produce yet, so the
  printer form offers only PDF there. A background service keeps the print
  queue draining even after the app is swiped away, and the app requests
  exemption from battery optimization so the system doesn't defer prints.
- **macOS** is not a print target: rendering and delivery both report
  unsupported rather than failing mysteriously.

## 7. Printing across app modes

- **Desktop app, online.** Everything works: local prints, shared templates,
  remote data, update checks.
- **Desktop app, offline.** Local printing works completely — the engine,
  templates, and printers all live on the machine. Only remote data sources,
  cloud sync, and release checks degrade. (The "working offline" banner
  refers to the sharing service, not to printing.)
- **Phone paired with a PC.** A phone is always paired: the app opens on a
  pairing screen until a PC is paired, and every render (PDF included) is done
  on that PC while it is on the same network and sharing. When the PC is off,
  asleep, or away, the job fails at once with a message that names the PC.
  Nothing is queued or retried automatically; the failed job stays in History
  and can be retried once the PC is back (§9).
- **Web preview.** The design surface and preview render in the browser, but
  nothing can print: there is no local backend to receive the job.
- **Test vs real.** Test prints run the full pipeline on mock data and are
  flagged in history, where they can be hidden to keep the log clean.

## 8. Queue, memory, and history

Printers print one thing at a time, so each printer has its own turn-taking
lock and every job goes out in a single send — one `send_to` per job, with
a hardware copies count where the transport takes one (IPP/CUPS) and the
payload repeated back-to-back otherwise — so jobs to the same machine never
interleave. A background worker drains queued jobs a few at a time; if the
app crashes mid-print, rows stuck in *printing* are marked failed on the next
start, then queued rows resume. Cancelling a job is terminal: the close-out
guard guarantees a cancelled job can never flip to successful later.

Every job is remembered: settings, data, outcome, error, duration, and
per-stage timings, indexed for the history views. Old jobs are purged
automatically under the retention limits from Settings, and history can be
exported as a spreadsheet. The stored job keeps the design pages as rendered
— before any paper is involved — so a reprint is placed on sheets again from
those same pages using the job's saved settings. Reprinting
clones an old row and wakes the worker; retrying re-queues only jobs that ended in failure or cancellation.

### Timing logs and counters

Every job carries its own breakdown: `StageTimings` (fetch, template,
layout, render, send, history, total) is saved on the history row
(`timings_json`) and logged as `print job timing` at `info` level, with
`queued job claimed` (queue wait) alongside it. Sub-stages log at
`debug` level so production logs stay quiet — run baselines with
`RUST_LOG=debug`: spooler datatype lookup vs send, Android USB/Bluetooth
probe vs status query vs write (with byte counts and a `via_file` flag
for the large-payload file handoff), and the peer caps-probe collect
(`peer_probe_ms`; the POST-vs-download split is `waited_ms` vs
`render_ms` in `peer render succeeded`).

Process-lifetime counters live on `/v1/metrics` (JSON) and
`/v1/metrics/prometheus`: job outcomes, peer renders (bought vs locally
fallen back), and browser renders (`persistent` vs `oneshot` fallback
launches). Environment seams: `PRINTNINJA_SEND_TIMEOUT_SECS` (per-send
deadline, read fresh on every send), `PRINTNINJA_PERSISTENT_BROWSER=0`
(force one-shot rendering), `PRINTNINJA_CUPS_URL` (cupsd address).

The same events are also kept on disk: a size-rotated backend log
(`printninja.log`, 512 KiB per file, five files max) under the
platform log directory, viewable in-app from Settings → Diagnostics
(View App Log, 64 KiB dialog budget) and downloadable in full
(Download App Log). A logging failure never fails a print — unwritable
bytes are dropped.

## 9. Borrowing a faster device

Producing the image or PDF (step 6 of §3) is by far the most expensive part
of a print, and a phone does not do it at all. A phone is always paired with
a PC (Windows or Linux) that renders for it, and the app stays on its pairing
screen until one is paired. A desktop can also borrow a faster PC, but only to
be quicker, because it can render for itself. The direction is fixed: **a phone asks a PC, never
the other way round**, so each device only shows its own half of the
feature. A PC offers itself; a phone pairs with a PC.

### What travels, and what never does

The phone does everything up to and including laying the pages out on
sheets. It then sends the finished document — plus the paper size,
orientation, printer language and resolution — to the PC. The PC renders it
with its own engine and returns the finished bytes. Rendering has no side
effects, so a repeated request is harmless.

The PC never touches the phone's printers, templates, data sources or
history, and never fetches the print's data itself. Because the document is
the finished page, it does contain that print's real content, which is why
pairing is a deliberate, same-network act. The phone still sends the bytes
to the printer and still writes the history row, which records which device
did the rendering.

### Pairing

The PC shows a one-time 8-character code, valid for 30 seconds, together
with its address. Turning sharing on does everything needed in one step,
including bringing up the local server so phones on the Wi-Fi can reach
it. The phone types the code; while a window is open the PC answers a
discovery hello, and the phone otherwise probes its own /24 for it, with
a typed address as fallback.

Both devices must be signed in to the same account on the same server:
the claim carries the phone's account id and service URL, the PC
compares them with its own, and a mismatch (or a signed-out side) is
refused before the code is spent. The verified account is stored on the
pair row, and every later request re-checks it against the PC's current
account — signing out or switching account disables existing pairs, and
they must be redone. An account id is an identifier, not a secret: it
never replaces the token or the one-time code.

The code is only the introduction: claiming it mints a per-device token
(the PC stores just its hash in a `paired_devices` registry), and the
window closes. One active code at a time; five wrong guesses close the
window and only the PC's user can open a new one. A freshly paired PC is
tested on the spot so a bad code shows up immediately. A phone always
uses its paired PC, so there is no "use my PC" switch to turn on. Both
devices show who is paired with whom: the PC lists its phones (with
rename and remove), the phone lists its PCs (with unpair).

Three rules keep this safe:

- **Local network only.** A typed address is checked before anything is
  contacted. Only private addresses, loopback, link-local addresses and
  local or single-word names are accepted. A hostile address therefore
  cannot make a phone send its prints, or the token, to a machine on the
  internet. Claim callers must be private or loopback too.
- **Each phone can be revoked.** Removing a phone on the PC deletes its
  row, and its token is refused from its very next request until it
  pairs again with a new code. (Turning sharing off refuses every phone
  outright; a removal is for when the PC stays shared but one phone
  should lose access.) Re-pairing the same phone replaces its row and
  keeps the PC's rename; the old token dies with the row.
- **The code cannot be guessed.** 40 bits of entropy, a 30-second
  window, five wrong guesses close it, and comparison leaks nothing
  about how close a guess was.

The code is an introduction, not proof of identity, and traffic is
plain HTTP on the local network. Pinned encryption is a planned
hardening, not part of this design.

### Who may use the API

The render routes (`/v1/render`, `/v1/capabilities`) always needed a
paired-device token. Since v0.15.0 the main routes (`/v1/print`,
`/v1/printers`, `/v1/templates`, `/v1/jobs*`, `/v1/metrics*`,
`/v1/openapi.json`) do too: loopback callers (the PC's own UI and local
scripts) pass unchanged, but any LAN caller must present its
per-device Bearer token. Unknown tokens get the same generic 401
whatever the reason, and repeated failures from one address get 429.
There is no API key and no CORS wildcard — scripts that need the API
run on the PC itself.

Each phone additionally carries a print permission (`can_print`, on by
default, toggled per phone on the PC). Render-only phones keep the
render routes; every main route refuses them with 403. A removal, a
sign-out, or an account switch takes effect on the next request.

### Guests

Owners prove who they are; guests prove they hold a time-boxed invite.
The PC mints invite codes (expiry, optional max uses, print preset); a
guest pairs with the code alone — no account, no window. Guest rows
carry `role = 'guest'` and the invite expiry instead of an account,
and both gates refuse them past expiry with the same generic 401. The
account recheck never applies to guests: there is nothing to compare,
so only expiry governs. Templates stay read-only structurally — the API
serves names, never bodies.

Decided, kept here so the plan file could go:

- Identity: invite code only. The invite *is* the credential (entropy +
  expiry + max-uses + 5-guess lockout); an account UUID was never doing
  that work, and guests are the users least able to bear sign-in friction.
- Scope per invite (render-only or print), stamped onto the fresh row,
  still togglable per phone afterwards. All templates by name.
- Defaults: 24 h, multi-use, print allowed; the owner narrows at mint.
- Expired/exhausted invites answer 410 at claim ("ask for a new one");
  spent pairs fail like revocations. Re-pairing follows the credential
  just used (owner window promotes, invite demotes).
- No per-template grants, no kiosk mode, no auto-merging guest rows by
  device name (names collide across physical phones).

### Printing via a PC

Rendering borrows the PC's engine; printing via a PC borrows its
printers. On Android, "Print via PC" reroutes the print dialog from the
local pipeline to `POST /v1/print` on the chosen paired PC: template
name plus the sync identity (`server_id`, `server_revision`), the PC's
printer name, data, and settings. The PC prints with the same pipeline
as its own UI — including the per-printer queue — and the phone polls
`GET /v1/jobs/{id}` for the outcome.

Three rules govern it:

- **No fallback.** While the flag is on the phone calls no local
  transport at all. An unreachable PC or a rejected token fails the job
  with the reason ("PC not reachable", "removed on the PC"); printing
  locally means turning the flag off. Retries reuse the caller's
  `Idempotency-Key`, so a timeout never prints twice.
- **The template must match.** The PC resolves by `server_id`, never by
  name, and compares revisions: a missing template is 409
  `template_missing`, a different revision (or unsynced local edits on
  the PC's copy) is 409 `template_stale` with both revisions, and the
  phone offers Sync instead of printing wrongly. Legacy name-only
  callers keep the old lookup.
- **Remote jobs are bounded.** Inline `data` over ~1 MiB and copies over
  100 are refused before any job row exists; the pipeline itself rejects
  over-max copies and records, so no caller can make a printer eat an
  unbounded batch.

Both histories tell the story: the PC's job row carries
`requested_by_device_id` (shown as "from \<phone\>" until a revocation
clears it), and the phone writes its own row marked "printed by \<PC\>"
with the revision that ran.

### Choosing a PC and asking it

When "use my PC" is on (on a phone it has to be, or no job can print), each
print first asks every paired PC, at the same time, whether it is available
and able to render. The phone prefers a PC of
the same operating family (rendering engines differ subtly between
platforms), then the one with the best capability score, and asks exactly
one of them. Probing is deliberately impatient: opening a connection gets
about a second and a half and the whole probe a few seconds, because on a
home network a live PC answers in milliseconds. A render gets 30 seconds,
well inside the PC's own limit. Fonts uploaded to the app are embedded in
the document that is sent, within a size budget, so the PC renders what the
template means rather than what its own fonts happen to look like.

### When the PC cannot help

What happens depends on whether the device can render for itself.

**A desktop is never worse than printing alone.** Sharing is only allowed to
make a print faster. Any failure — PC off, wrong token, too slow, too busy,
refusing the job, a different protocol version — means the desktop renders
locally and the print goes ahead. Two small memories keep that cheap:

- A PC that answered recently is trusted for a minute, so back-to-back
  prints skip the handshake.
- A PC that just failed is skipped for half a minute, so a PC that is off
  costs one short wait per half minute instead of one per print. When
  asking for a render, only failures that say the PC itself is unwell —
  unreachable, timed out, a server error — count. "Busy", "this document
  is too big" and "the render failed" describe one job, not the PC, and
  do not mark it down. A failed availability check always counts, whether
  the PC is unreachable, refuses the token, has sharing switched off,
  speaks another protocol version or cannot render.

**A phone has no local render to fall back to, so a failure ends the job
with the reason.** The messages name the cause: no PC paired, no paired PC
answered, the PC timed out, refused the document as too large, or is busy.
The phone never reports "cannot rasterize", which would hide the real cause.
The rules differ from a desktop's in three ways:

- Every job asks the PC. The "recently failed" memory is not consulted,
  because a stale skip would fail a job without asking, and the attempt is
  cheap. A recent success (the one-minute memory) is still reused.
- A busy PC is retried instead of abandoned: up to three more tries, waiting
  as long as the PC asks (or five seconds), never more than thirty seconds
  per wait. If it is still busy, the job fails as busy.
- If "use my PC" is switched off, every job fails with a message telling the
  user to turn auto rendering on.

A failed job stays in History and can be retried once the PC is back.

The Settings "Test" button ignores both memories and shows the PC's state
right now, and clears them when it finds the PC.

### The PC's own prints come first

A PC should never get slower because a phone is borrowing it. While the PC
is rendering one of its own prints, requests from phones are answered
"busy, retry shortly". A desktop consumer then renders locally; a phone waits
and retries (above). Beyond that,
the PC renders at most two borrowed documents at once, caps the size of a
document (and, above that, of the whole request, so an oversized upload is
cut off rather than buffered), and gives up on a render that takes too long.
Each limit ends with a desktop printing locally, or a phone failing the job
with the reason.

### What it does not do

A PC cannot print on a phone's printer, the server in the cloud is not
involved (it has no rendering engine), and accounts are not shared. Only
Windows and Linux desktops can act as the PC for now (they are the ones
with a browser engine to render with); phones and macOS report that they
cannot render and are never chosen. Discovery is by typed pairing code
(backed by a /24 hello probe, with a typed address as fallback);
finding PCs automatically on the network, and encrypting the traffic with a
pinned certificate, are future work.
