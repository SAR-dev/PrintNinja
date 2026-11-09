# dev-printer

A local fake printer for developing PrintNinja without hardware. Two modes:

- **IPP** (default) for the IPP transport (`src-tauri/src/transport/ipp.rs`), built on
  [`ipp-printer`](https://github.com/watson/ipp-printer).
- **Raw** (`--raw`) for the raw TCP / JetDirect transport and its status precheck
  (`raw_tcp.rs`, `status.rs`): a fake ESC/POS, ZPL, TSPL or CPCL thermal head.
It is a plain folder at the repo root (not a pnpm workspace package): `ipp-printer`
is a root devDependency, and only `dev-printer/output/` is git-ignored.

## Run

From the repo root, after `pnpm install`:

```bash
pnpm dev:printer               # ipp://localhost:6310/ipp/print
```

In PrintNinja, add a Wi-Fi/IPP printer with address `localhost:6310` or
`ipp://localhost:6310/ipp/print`, then print or send a test page. Each job is
saved to `dev-printer/output/` (PDFs end in `.pdf`; git ignores the folder).

Check it from a second terminal without the app (sends the same bytes as
`IppPrinter`, prints the job state and `printer-state-reasons`):

```bash
pnpm dev:printer:smoke         # or: node dev-printer/smoke.cjs http://localhost:6310/ipp/print
```

## Raw thermal head (`--raw`)

```bash
pnpm dev:printer:raw           # raw head on 127.0.0.1:9100
pnpm dev:printer:raw:smoke     # or: node dev-printer/smoke-raw.cjs [host:port]
```

In PrintNinja add a printer with connection **Raw TCP**, address `127.0.0.1:9100`, and
set its language to ESC/POS, ZPL, TSPL or CPCL.

- Every job is saved to `dev-printer/output/` as `.escpos`, `.zpl`, `.tspl`, `.cpcl` or
  `.bin`, picked from the first bytes, and a one-line summary (text, labels, cuts) is
  printed.
- **Previews:** every bitmap in a job (ESC/POS `GS v 0`, TSPL `BITMAP`, ZPL `^GFA` with
  plain hex data, CPCL `CG`) is also written as a `.png` beside the job, so you can look at
  what would have printed. Bits are read as the app packs them (1 = black). Compressed
  ZPL graphics (`:Z64:`) are skipped.
- Status queries (ESC/POS `DLE EOT`, ZPL `~HS`, TSPL `ESC !?`) are answered the way
  `status.rs` expects, so the pre-print status check behaves as it would on a real head.
  `ESC @` alone is treated as the connectivity test, not a job.

### Raw faults

`--fault <kind>` changes what the head answers to status queries. The app should then
refuse the job with the matching "did not print" message:

| Kind | ESC/POS | ZPL | TSPL |
|---|---|---|---|
| `paper-out` | out of paper | out of paper flag | out of paper |
| `cover-open` | cover open | silent | cover open |
| `head-open` | cover open | silent | head open |
| `offline` | offline | silent | generic error |
| `cutter-jam` | cutter jam | silent | paper jam |
| `error` | generic error | silent | generic error |
| `paused` | offline | pause flag | paused |
| `ribbon-out` | healthy (no such bit) | silent | out of ribbon |
| `silent` | silent | silent | silent |

"Silent" means no reply at all. A real Zebra does that for open head, out of media or out
of ribbon, and the app treats silence after an earlier answer as a stopped printer.

- `--silent-after <n>` answers the first `n` status queries, then goes silent, which
  reproduces the "printer that answered before and has now stopped" rule.
- `--delay <ms>` holds every status reply, to test the status read timeout.

Combine them with the smoke script to see what the app would see:
`pnpm dev:printer:raw --fault paper-out`, then `pnpm dev:printer:raw:smoke`.

## IPP options

| Option | Default | Meaning |
|---|---|---|
| `--port <n>` | `6310` | Listen port. `631` needs root. |
| `--lan` | off | Listen on the local network and print the URL(s) other devices should use. Same as `--host 0.0.0.0`. |
| `--host <addr>` | `127.0.0.1` | Bind to one specific address. |
| `--name <text>` | `PrintNinja Dev Printer` | Printer name. |
| `--out <dir>` | `./output` | Where jobs are saved. |
| `--delay <ms>` | `0` | Wait before answering every request. Use more than `30000` to hit the app's 30 s response timeout. |
| `--fault <kind>` | none | Simulate a broken printer (below; raw kinds above). |
| `--mdns` | off | Advertise `_ipp._tcp` over Bonjour, plus a fake `_printninja._tcp` peer ("PrintNinja-Test-PC") for peer discovery tests. |
| `--raw` | off | Run the raw thermal head instead of the IPP printer; default port `9100`. |
| `--silent-after <n>` | none | `--raw` only, see above. |

`--delay` also works with `--raw` (delays status replies).

Pass options after the script name: `pnpm dev:printer --fault media-empty`.

## Same-network access

```bash
pnpm dev:printer --lan
```

The banner lists one `ipp://<ip>:6310/ipp/print` line per network adapter (Wi-Fi,
Ethernet, and any virtual ones such as WSL or Docker). Use the one on the same
network as the other device. These are local-network addresses, not internet
URLs, and there is no authentication, so only use `--lan` on a network you trust.
On Windows, allow Node.js through the firewall for Private networks when asked.

## Fault simulation

`--fault` makes Get-Printer-Attributes report the matching `printer-state-reasons`
and answers Print-Job with a stopped job (state 6), so the app shows its
"did not print" messages instead of success. The document is discarded.

`media-empty`, `media-jam`, `paused`, `offline-report`, `toner-empty`, and
`aborted` (job-state 8 with no reason).

## Limits

- Raw mode previews bitmaps and lists text, but is not a full ESC/POS, ZPL or TSPL
  renderer: text styling, fonts, barcodes and vector shapes are not drawn.
- Nothing here covers Bluetooth, USB, Android direct printing, the Windows spooler or CUPS.
- IPP/1.1 only, no TLS and no auth. Keep it on localhost unless you need `--lan`.
- Advertises `application/pdf`, `application/postscript`, `text/plain`, `text/html`
  and a few others, not PWG Raster or Apple URF, so it is not a stand-in for
  AirPrint testing from iOS.
- `ipp-printer` is unmaintained (last release 2016) and pulls old dependencies.
  Fine for a loopback dev tool, not for anything exposed.
