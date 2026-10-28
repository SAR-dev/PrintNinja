# dev-printer

A local fake IPP printer for developing PrintNinja's IPP transport
(`src-tauri/src/transport/ipp.rs`). Built on [`ipp-printer`](https://github.com/watson/ipp-printer).
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

## Options

| Option | Default | Meaning |
|---|---|---|
| `--port <n>` | `6310` | Listen port. `631` needs root. |
| `--lan` | off | Listen on the local network and print the URL(s) other devices should use. Same as `--host 0.0.0.0`. |
| `--host <addr>` | `127.0.0.1` | Bind to one specific address. |
| `--name <text>` | `PrintNinja Dev Printer` | Printer name. |
| `--out <dir>` | `./output` | Where jobs are saved. |
| `--delay <ms>` | `0` | Wait before answering every request. Use more than `30000` to hit the app's 30 s response timeout. |
| `--fault <kind>` | none | Simulate a broken printer (below). |
| `--mdns` | off | Advertise `_ipp._tcp` over Bonjour. |

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

- IPP/1.1 only, no TLS and no auth. Keep it on localhost unless you need `--lan`.
- Advertises `application/pdf`, `application/postscript`, `text/plain`, `text/html`
  and a few others, not PWG Raster or Apple URF, so it is not a stand-in for
  AirPrint testing from iOS.
- `ipp-printer` is unmaintained (last release 2016) and pulls old dependencies.
  Fine for a loopback dev tool, not for anything exposed.
