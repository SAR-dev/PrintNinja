# Raw Console — minimal (test-only) version

Simplified version of the full Raw Console plan (`RAW-CONSOLE-PLAN.md` at the repo root).
Goal: **just test** — send arbitrary bytes to a saved printer through the app's real send
path, with the delivery variables that matter for the B-FP2D-style experiments
(content, pacing, close timing) adjustable. Everything else is cut.

## In the MVP

- One Tauri command: `send_raw_bytes(printer_id, data_base64, options) -> RawSendReport`.
- Options: `chunk_bytes`, `chunk_pause_ms`, `settle_ms` — each optional; `None` means the
  printer row's stored value or the built-in default.
- A developer-only page (behind a **Developer tools** toggle in Settings, off by default):
  saved-printer picker, data field (text with escapes or hex, live byte count), five preset
  buttons, three numeric inputs for the options, **Send**, and a result line
  (ok/error, bytes sent, per-stage timings, which option values were actually applied).
- **Template library** (section below): a selectable set of simple templates covering
  text, barcodes, QR, shapes, CJK and raster — per language — sent through the same
  real send path with the adjustable options.

## Template library

The Data section offers **templates** instead of bare presets: a selectable list of simple
templates, grouped by what they test. Selecting one fills the data field and sets the mode
(text or hex); the user can then edit the bytes before sending. All byte strings are
hand-adapted minimal jobs — **verify each against the encoders' tests** (item 1 in
`PORTABLE-RELIABILITY-WINS.md`) before shipping, the same caveat as the full plan §13.

| Template | Tests | Language | Bytes (text-escape mode) |
| --- | --- | --- | --- |
| Text minimal | smallest valid job | ZPL | `^XA^FO30,30^ADN,36,20^FDTEST^FS^XZ` |
| Text minimal | smallest valid job | ESC/POS | `\x1B\x40TEST\n\n\n` |
| Text minimal | smallest valid job | TSPL | `SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nTEXT 0,0,"2",0,1,1,"TEST"\r\nPRINT 1\r\n` |
| Text minimal | smallest valid job | CPCL | `! 0 200 200 210 1\r\nTEXT 4 0 0 20 TEST\r\nPRINT\r\n` |
| Large text | scalable/double-size font | ZPL | `^XA^FO30,30^A0N,40,40^FDTEST^FS^XZ` |
| Large text | scalable/double-size font | ESC/POS | `\x1B@\x1B!\x11TEST\n\x1B!\x00` (hex: `1B 40 1B 21 11 54 45 53 54 0A 1B 21 00`) |
| Newlines | newline handling, `^A0` + `\n` (B-FP2D case) | ZPL | `^XA\n^FO50,50^A0N,40,40\n^FDPrintNinja test^FS\n^XZ\n` |
| Multiline | several lines, wrapping | ESC/POS | `TEST LINE 1\nTEST LINE 2\nTEST LINE 3\n\n` |
| Barcode Code128 | native 1D barcode | ZPL | `^XA^FO50,50^BY3^BCN,100,Y,N,N^FD1234567890^FS^XZ` |
| Barcode Code128 | native 1D barcode | TSPL | `SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBARCODE 10,10,"128",2,90,0,0,2,"1234567890"\r\nPRINT 1\r\n` |
| Barcode Code128 | native 1D barcode | ESC/POS | hex: `1B 40 1D 6B 4E 01 02 30 31 32 33 34 35 36 37 38 39 30 00 1D 68 48` |
| QR | native 2D code | ZPL | `^XA^FO50,50^BQN,2,10^FDQ,PrintNinja^FS^XZ` |
| QR | native 2D code | ESC/POS | hex: `1B 40 1D 28 6B 04 00 31 41 32 00 1D 28 6B 03 00 31 43 03 1D 28 6B 03 00 31 45 30 33 32 1D 28 6B 0D 00 31 50 30 50 72 69 6E 74 4E 69 6E 6A 61 1D 28 6B 03 00 31 51 30 32 30` |
| Box + line | shapes/graphics | ZPL | `^XA^FO30,30^GB300,200,20^FS^FO50,120^FDIN BOX^FS^XZ` |
| Box + line | shapes/graphics | TSPL | `SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nCLS\r\nBOX 10,10,350,250,2\r\nPRINT 1\r\n` |
| Japanese text | CJK in native fonts — expected to fail on many printers (validates the raster-fallback need) | ZPL | `^XA^FO50,50^A0N,30,30^FDプリントニンジャ^FS^XZ` |
| Japanese text | CJK in native fonts — needs code-page selection; expected to fail without it | ESC/POS | hex: `1B 40 1B 74 28 F8 EA C4 FC EA D4 EA C9 48 53` (note: sequence is hypothesis, confirm per printer) |
| Raster square | bitmap path over raw connection, 16×16 black square | ESC/POS | hex: `1B 40 1D 76 30 00 01 00 10` + 16 × `FF` |
| Raster square | bitmap path — `BITMAP 16,16,0,0,0,<16 bytes>` | ZPL | hex: `5E 58 41 0D 5E 44 47 30 2C 31 2C 31 2C 30 2C 30 2C 30 2C FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF 0D 5E 58 5A` (data format to confirm against encoder tests) |

Rules:

- Templates are grouped by case in the UI (Text, Barcode, QR, Shapes, CJK, Raster), each
  row showing its language; the list filters to the selected printer's stored language,
  with the other languages still reachable.
- The CJK and raster rows are expected to expose limitations — that is the point. The
  result panel states the expectation so a "failure" is read as a finding, not a bug.
- Templates live in `src/pages/raw-console/templates.ts` (name, language, mode, bytes,
  one-line description); a Vitest test pins each one's decoded bytes so they cannot drift.

## Cut from the full plan, and when it comes back

| Cut | Why | Comes back |
| --- | --- | --- |
| Reply capture (`read_reply_ms` in the Kotlin plugin + read-back in the four raw transports, `reply_supported`) | By far the biggest chunk — Android plugin changes plus four transports plus tests | v2, when experiments need the printer's answer |
| Status pre-check toggle, `wait_reply_ms` | Not needed for content / pacing / close-timing experiments | v2 |
| In-memory history of last 10 sends | Single-job experiments don't need it | v2 |
| Copy report | The result line is enough to paste by hand | v2 |
| i18n (ja) | Developer tool; English first | Before the toggle is ever user-visible |
| E2E beyond the fake agent | Only the build-keeping fake is needed now | Later |

## Backend (step 1)

- New command `send_raw_bytes` in `src-tauri/src/commands/printer.rs`, next to
  `test_printer`; register in `src-tauri/src/lib.rs`.
- Resolve the printer row and build the transport exactly the way `test_printer` does —
  same registry, so this is the real send path, not a copy.
- `RawSendReport { ok, error, bytes_sent, timings_ms: { open, write, settle, close },
  effective_options }` — `effective_options` echoes the option values that were actually
  applied, so the UI can show when a transport ignored an override.
- Android Bluetooth caveat: the `settle_ms` override needs the Kotlin plugin change
  (full plan §6.3), which is **not** in this version. On that transport the built-in settle
  delay applies and `effective_options` says so. chunk/pause apply where already supported.
- Validation: clamp options with the same bounds as `BluetoothDelivery::validate`;
  reject unknown printer id, empty payload, and payloads over 1 MiB.
- Log byte counts and timings only — never the payload. No job-history or queue writes.

## Frontend (step 2)

- New `src/pages/RawConsole.tsx` (lazy-loaded like `Devices`) and
  `src/pages/raw-console/parse.ts` (text-escape and hex parsers, byte counting).
- Route in `src/App.tsx`; the route and its settings link render only while the
  **Developer tools** toggle (stored with app settings, off by default) is on.
- Visible warning: "Raw bytes can make the printer feed or print garbage."
- `e2e/support/fakeAgent/commands.ts`: fake `send_raw_bytes` so web/mobile e2e builds compile.
- English only for now (no `ja.ts` strings yet).

## Tests (small set)

- Parsers: valid/invalid hex, every escape, odd digit count, 1 MiB cap.
- Option clamping (chunk, pause, settle bounds).
- Regression guard: with all overrides `None`, the send path produces identical bytes and
  calls to the normal path.
- Raw TCP end-to-end against the existing virtual printer
  (`src-tauri/tests/virtual_printer.rs`): bytes arrive unchanged, in order.
- Run via `pnpm test:rust` (Docker, per `CLAUDE.md`).

## First experiments to run once it exists

Straight from the B-FP2D investigation:

1. **Content.** ZPL minimal, then ZPL newlines + `^A0`. If one prints and the other doesn't,
   the bytes were the problem.
2. **Close timing.** The working job with close delay 300 / 1000 / 3000 ms. Longer delay
   prints → the socket was closing too early.
3. **Pacing.** A larger payload with chunk 512 / 50 ms, then 128 / 100 ms, then one chunk.
   Tells whether the printer drops overflow.
4. **ESC/POS.** Repeat 1–3 with the ESC/POS preset, printer CMD SETTING switched to ESC/POS.

The first setting that turns "data received" into a printed label is the fix; it then lands
as a normal code change with a regression test.

## Rollout

| Step | Work | Result |
| --- | --- | --- |
| 1 | `send_raw_bytes` + clamping + tests | Testable over raw TCP, USB, desktop Bluetooth |
| 2 | Page, Developer tools toggle, template library, fake agent | Testable on the device |

Size estimate: one Tauri command + one page. No Android plugin changes, no changes to the
normal print path, no i18n beyond English.
