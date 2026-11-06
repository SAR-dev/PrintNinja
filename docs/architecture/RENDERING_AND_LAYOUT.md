# Rendering and layout

> **Who this is for:** anyone who wonders how a design becomes pages, how a page lands on a sheet, or why the preview matches the printout.
> **What you will know after reading:** how data and templates become design pages, the central "never re-lay out" rule, the five fit modes, and how content taller than a design paginates.

## Gathering the data and previewing

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

## Design size vs paper size

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

## Placement: how a design lands on a sheet

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

## Pagination: content taller than the design

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

## One logic, two implementations

Placement is the one piece of logic that exists twice — once in the browser
for the preview and once in the backend for the real output. Both are pinned
to a single shared table of expected results, so a change to one that isn't
mirrored in the other fails a test instead of silently making the preview
lie.

## The Windows Edge handoff failure

On some Windows 11 machines with a recent Edge (observed on Edge 156), a
headless `msedge.exe` launch exits **0** immediately, produces **no PDF**
and prints **nothing to stderr** while many `msedge.exe` processes sit
resident. The launcher-level session handoff forwards the command line to
the already-running Edge session instead of printing, regardless of
`--user-data-dir`. Every render path (persistent CDP, fresh-profile CDP,
one-shot warm, one-shot throwaway) hits the same wall.

The app deals with it in three layers, all in `src-tauri/src/render/`:

- **Detect and name it.** When a print exits 0 with no PDF and
  `msedge.exe` is still running, the error says so plainly (translated in
  the UI): "Edge handed the print job to a running Edge session".
- **Repair that verifies.** **Fix PC printing** (Settings → Diagnostics)
  kills `msedge.exe` in a bounded kill/verify loop (re-checking `tasklist`
  after each round, up to 15 rounds) instead of one taskkill plus a fixed
  sleep. When the process table still shows Edge afterwards, the report
  says the kill could not be verified instead of claiming success — and
  skips a test render that could not possibly pass.
- **A browser Edge cannot take.** The opt-in headless download
  (`chrome-headless-shell`, pinned version + SHA-256 in
  `browser_download.rs`) has no resident-session behaviour, so its
  launches always print. `find_edge` prefers it when installed;
  `PRINTNINJA_EDGE_BIN` (see `../ENV.md`) overrides everything for
  manual setups.

### A second cause: an elevated parent

The same symptom — exit 0, no PDF, nothing on stderr, even on a fresh
profile — has a second cause: the app itself is elevated (started with
"Run as administrator" or a Compatibility setting that forces it). It
was proven by an A/B test on an affected PC (Edge 156): the identical
launch wrote a PDF from a normal shell and failed in about 180 ms from
an elevated one, with policy, other Edge processes, stale profiles and
the flag set all ruled out on the way.

The app deals with it the same way, in `elevation.rs`:

- **Detect.** `is_elevated()` reads the process token
  (`OpenProcessToken` + `GetTokenInformation(TokenElevation)`) once and
  caches the result — elevation cannot change during a run. Windows
  only; other platforms report `false`.
- **Name it before guessing.** When a print exits 0 with no PDF and the
  process is elevated, the error names that instead of the session
  handoff — checked first, because `msedge.exe` is resident even on an
  elevated PC, so the handoff signature would misattribute the cause.
  It is restricted to `msedge.exe` launches: the headless shell's
  elevated behaviour is unverified. The CDP `ExitedWhileStarting`
  message appends the same wording, and the repair's report carries
  `elevated`, so its test-render failure points at a normal restart
  instead of a broken pipeline (Settings → Diagnostics shows the
  warning).
- **Capture the real stderr.** Both Edge launchers run with
  `--enable-logging=stderr`: without it headless Edge writes nothing to
  stderr on failure. One-shot failures quote the first few stderr lines
  in the error; the persistent CDP browser writes `browser-stderr.log`
  in its profile dir.

Making printing *work* while elevated is deliberately not built: the
owner decided PrintNinja does not need to run elevated, so the
behaviour is the actionable "restart normally" message — not a
de-elevated Edge launch or `--no-sandbox` (both considered and
rejected), and WebView2 printing remains a longer-term option.

See also: [printers and transports](./PRINTERS_AND_TRANSPORTS.md) (what the
produced bytes become), [queue and history](./QUEUE_AND_HISTORY.md) (what
happens to the job), and the [glossary](../GLOSSARY.md) for the plain words.
