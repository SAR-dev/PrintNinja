# Queue, memory, and history

> **Who this is for:** anyone debugging a slow or stuck print, reading the metrics, wiring print callbacks, or curious what the app remembers about each job.
> **What you will know after reading:** how jobs are queued and recovered after a crash, what every history row stores, the timing breakdown, where the counters and logs live, and how webhook callbacks report outcomes.

## The queue

Printers print one thing at a time, so each printer has its own turn-taking
lock and every job goes out in a single send — one `send_to` per job, with a
hardware copies count where the transport takes one (IPP/CUPS) and the
payload repeated back-to-back otherwise — so jobs to the same machine never
interleave. A background worker drains queued jobs a few at a time; if the
app crashes mid-print, rows stuck in *printing* are marked failed on the
next start, then queued rows resume. Cancelling a job is terminal: the
close-out guard guarantees a cancelled job can never flip to successful
later.

## What is remembered

Every job is remembered: settings, data, outcome, error, duration, and
per-stage timings, indexed for the history views. Old jobs are purged
automatically under the retention limits from Settings, and history can be
exported as a spreadsheet. The stored job keeps the design pages as rendered
— before any paper is involved — so a reprint is placed on sheets again from
those same pages using the job's saved settings. Reprinting clones an old row
and wakes the worker; retrying re-queues only jobs that ended in failure or
cancellation.

## Timing logs and counters

Every job carries its own breakdown: `StageTimings` (fetch, template,
layout, render, send, history, total) is saved on the history row
(`timings_json`) and logged as `print job timing` at `info` level, with
`queued job claimed` (queue wait) alongside it. Sub-stages log at `debug`
level so production logs stay quiet — run baselines with `RUST_LOG=debug`:
spooler datatype lookup vs send, Android USB/Bluetooth probe vs status query
vs write (with byte counts and a `via_file` flag for the large-payload file
handoff), and the peer caps-probe collect (`peer_probe_ms`; the
POST-vs-download split is `waited_ms` vs `render_ms` in `peer render
succeeded`).

Process-lifetime counters live on `/v1/metrics` (JSON) and
`/v1/metrics/prometheus`: job outcomes, peer renders (bought vs locally
fallen back), and browser renders (`persistent` vs `oneshot` fallback
launches). Environment seams: `PRINTNINJA_SEND_TIMEOUT_SECS` (per-send
deadline, read fresh on every send), `PRINTNINJA_PERSISTENT_BROWSER=0`
(force one-shot rendering), `PRINTNINJA_CUPS_URL` (cupsd address).

The same events are also kept on disk: a size-rotated backend log
(`printninja.log`, 512 KiB per file, five files max) under the platform log
directory, viewable in-app from Settings → Diagnostics (View App Log,
64 KiB dialog budget) and downloadable in full (Download App Log). A logging
failure never fails a print — unwritable bytes are dropped.

## Webhooks (print callbacks)

`POST /v1/print` accepts an optional `callback_url`. When it is present and
the job closes, the server fires one `POST` to it carrying the outcome —
`event` (`print.succeeded` / `print.failed`), `job_id`, `status`, `printer`,
`template`, `error`, `duration_ms`, `timestamp` and the idempotency key —
from a background task, so the print response is never delayed by it.
Delivery is best-effort: four attempts spaced 5 s / 25 s / 125 s, a 10 s
timeout, no redirects, and a 64 KiB response cap; an outcome is not resent
if the app restarts. The `X-PrintNinja-Event` and `X-PrintNinja-Job-Id`
headers carry the same for filtering, and when `PRINTNINJA_CALLBACK_SECRET`
is set the body is signed as `X-PrintNinja-Signature: sha256=<hex>`
(HMAC-SHA256 of the raw body).

The URL is validated **before any DB work**, and a bad one answers `400` with
`code: callback_url_invalid`: `https://` only, at most 2048 characters, no
embedded credentials, and no private / loopback / link-local hosts — the same
SSRF posture as the data-URL rules of the fetch step.
`PRINTNINJA_CALLBACK_ALLOW_HTTP`, `PRINTNINJA_CALLBACK_ALLOW_PRIVATE` and
`PRINTNINJA_CALLBACK_ALLOWLIST` (a comma-separated exact-match host list)
relax the first three rules deliberately; all four variables are documented
in `ENV.md`. Duplicate requests (a replayed idempotency key) fire no second
callback, and logs keep only a host-plus-truncated-path form of the URL,
never the full one.

See also: [phone and PC sharing](./phone-and-pc-sharing.md) (the jobs a phone
sends through a PC, and how both histories record it), and the
[glossary](../GLOSSARY.md).
