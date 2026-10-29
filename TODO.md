# TODO: print-speed validation on hardware

The code is done and unit-tested (`perf` work, all on `main` since
v0.10.0); static checks and emulators cannot cover what is listed here.
Each item says how to run it, what to record, and what "done" looks
like. General device setup (pairing, printers, Wi-Fi) lives in
`docs/HARDWARE_TODO.md` — this file is only the performance half.
Background and per-finding details: `docs/PRINT_SPEED.md`.

Conventions used below:
- **Timing source of truth:** open the finished job in History — every
  job carries its per-stage breakdown (fetch / template / layout /
  render / send / history / total). No logcat needed for these.
- **Backend log without a terminal:** Settings → Diagnostics →
  Download App Log (size-rotated file, newest chunk last). On desktop
  the same lines go to stdout (`RUST_LOG=debug` for sub-stage detail);
  on Android the file is the only practical source.
- **A/B builds:** the v0.9.0 APK (GitHub releases) is the "before".
  Install it next to the current build to compare the same printer/job.
- **Where to record numbers:** paste the tables into the tracking
  issue (or update `docs/PRINT_SPEED.md` Phase 0 directly).

## 0. Release hygiene (no hardware, decisions only)

- [x] Delete the stale drafts `v0.1.0` and `v0.0.2` (pre-release) from
  the GitHub releases page, or keep them deliberately. They sit behind
  the published v0.10.0 and confuse the download list.
  Done 2026-10-29: both deleted; releases list is now v0.10.0
  (Latest, published) + v0.9.0 (published).

## 1. Held connections (A2/A3) — Bluetooth + USB

Goal: one connect per send (was: one per operation), and no skipped
fault detection.

1. Pair the phone, add the Bluetooth printer (ZPL/TSPL) and the USB
   printer (ESC/POS).
2. Print the same small label/receipt **three times in quick
   succession** on each printer (well inside a minute).
3. Record each job's History breakdown, especially `send_ms`.
4. On the 2nd and 3rd prints, `send_ms` should be roughly one
   connection cheaper than the 1st (no repeat RFCOMM connect / USB
   reopen for the status query). All three must print correctly.
5. Regression check (must still fail fast): unplug the printer (or
   turn it off), print once, and confirm the job fails with a clear
   status/probe error — **not** a success, and not a hang. This is the
   behavior the query-skip rejection protects; if it ever reports
   success into a dead printer, file a bug and reference A6.

Done when: 3-rapid-print timings recorded for BT and USB, plus the
unplugged failure case confirmed on both.

## 2. File handoff (A4) — large raster over USB/BT

Goal: payloads over 256 KiB cross by file, print identically, no
orphans.

1. Print a full-page image (photo/logo covering most of the label) —
   large enough that the rendered bytes exceed 256 KiB.
2. Confirm the output matches the v0.9.0 build's output for the same
   job (no missing bands, no duplication).
3. After the print, check the app cache dir holds no
   `printninja-payload-*.bin` leftovers (both sides delete; at most one
   orphan per crashed print is acceptable, steady-state must be zero).

Done when: large-job output matches v0.9.0 and no staged files linger.

## 3. Phase-0 baselines (the table everything else waits on)

Goal: p50/p95 per stage, per printer type, single + burst.

1. For each printer type at hand (USB thermal, BT thermal, network
   IPP, CUPS/system): print the same job **20 times singly**, then a
   **burst of 20 back-to-back**, recording History `total_ms` (and
   `render_ms`/`send_ms`) each time.
2. On the PC side (Windows/Linux with a browser): note the
   `browser_renders` counter before/after — read it from the Automation
   page → Try the API → `GET /v1/metrics` (`persistent` vs `oneshot`).
   Any `oneshot` > 0 in normal use is a W1/L1 datum (see item 5).
3. Fill one table per printer type:

   | run | p50 total | p95 total | p50 render | p50 send | notes |
   |---|---|---|---|---|---|
   | single ×20 | | | | | |
   | burst ×20 | | | | | |

4. Paste the tables into the tracking issue.

Done when: tables exist for every printer type on hand. These numbers
then calibrate `BENCH_P50_MS`/`BENCH_P95_MS` in
`src-tauri/tests/virtual_printer.rs` (currently generous placeholders)
and the A5 chunk decision below.

## 4. Chunk size (A5 follow-up)

Blocked on item 3. If `send_ms` on USB is dominated by transfer (not
connect) in the baselines, raise the bulk chunk 16 KiB → 64 KiB in
`bulkWriteOut` and re-run the USB burst. If connect dominates, leave it.

## 5. Persistent-browser data (W1/L1)

Blocked on item 3's counter readings. If `oneshot` stays 0 across the
baselines, W1/L1 need no work — record that and close them. If it
climbs, capture the accompanying `persistent … could not render`
warning lines (`adb logcat` on Android, console on desktop: launch
timeout vs profile lock vs stale port file) and file them as the W1/L1
work order.

## 6. Template self-containment (W2) — 2-minute UI check

- [x] Enforced at every write path (client create/update reject remote refs;
  the server rejects them too, strictly). Just confirm the operator
  wording once: in the Designer, save a template containing
  `<img src="https://…">` and confirm it is refused with the
  "use data: URIs" message.
  Done 2026-10-29: operator confirmed the refusal wording.

## 7. Phase-4 warning sighting

Set a USB or Bluetooth printer row's language to PDF, print, and
confirm the per-job warning appears (logcat/console) while the job
still goes out. Then set it back to the native command language.
(RawTcp and CUPS `System` rows are deliberately excluded — JetDirect
lasers take PDF, and raw-vs-filtered is unknowable from the row.)
