# PrintNinja: Print Speed Report and Plan

Branch: `develop` of `SAR-dev/PrintNinja`
Scope: Windows, Linux, Android
Method: static code reading only. Nothing was profiled, so every finding is a hypothesis until Phase 0 produces numbers.

Verification pass (2026-10-28, still static reading, no devices): every
finding below was checked against the code. A1 was rejected (dead code,
never on the hot path), A2 was undercounted (3 connects, not 2), A6's
premise was inverted (`should_probe` does not rate-limit the success
path), Phase 0's main ask already exists (`StageTimings`), and Phase 4's
premise is wrong (thermal printers already receive native bytes). Three
new Android findings (A9–A11) were added. Corrections are marked
[VERIFIED], [CORRECTED] or [REJECTED] inline; nothing was deleted, so the
original reasoning stays readable.

---

## 1. Shared pipeline

```
job -> queue/worker -> render (HTML -> PDF/raster) -> transport -> printer
```

Per-printer semaphores serialize jobs for one printer. The worker wakes on a notify, with a 5 s sweep as a fallback, so queueing itself is not a visible cost.

---

## 2. Findings per platform

### Windows (`render/edge.rs`, `render/cdp.rs`, `transport/windows_spooler.rs`)

| # | Finding | Impact |
|---|---|---|
| W1 | Render uses headless Edge. The persistent CDP browser is on by default. On any CDP failure it silently falls back to launching Edge for every job. | High |
| W2 | Each CDP render opens a tab and waits for `Page.loadEventFired` and `document.fonts.ready`. Remote fonts or images add latency to every job. | Medium |
| W3 | `send()` calls `offered_datatypes()` on every PDF job (`OpenPrinter`, `GetPrinter`, `EnumPrintProcessorDatatypes`, `ClosePrinter`), then opens the printer again to send. | Medium |
| W4 | Blocking Win32 calls (`OpenPrinterA`, `StartDocPrinterA`, `WritePrinter`, ...) run inside an `async fn` on a tokio worker thread. Slow or remote queues stall other jobs. | Medium |
| W5 | `StartPagePrinter` / `EndPagePrinter` are not needed for `RAW` or `PDF` datatypes. | Low |
| W6 | A single `WritePrinter` call for the whole job is fine. | None |

### Linux (`render/mod.rs`, `transport/cups.rs`, `transport/ipp.rs`)

| # | Finding | Impact |
|---|---|---|
| L1 | Same render pattern as Windows. `chromium_print_to_pdf` tries persistent CDP, then falls back to one-shot Chromium per job. The log field `persistent = true` and `chromium_ms` show which path ran. | High |
| L2 | `send_bytes` builds a new `reqwest::Client` per job. That means a new connection pool and TCP connection per job, and no keep-alive reuse. | Medium |
| L3 | PDFs sent to a CUPS queue go through CUPS filters and the driver filter. A raw queue with native ZPL/TSPL (`application/octet-stream`) skips them. This is already supported. | High for label printers |
| L4 | The IPP body is copied from the PDF, and the debug `last-render.pdf` is cloned off the hot path. | Low |
| L5 | The IPP send is async and non-blocking. | None |

### Android (`plugins/tauri-plugin-android-print`, `transport/android_*.rs`)

| # | Finding | Impact |
|---|---|---|
| A1 [REJECTED as a hot-path finding] | `htmlToPdf` exists in the plugin (`AndroidPrintPlugin.kt:146`, new `WebView` per call) but **nothing calls it**: no TS/TSX caller exists, and Rust `html_to_pdf` on Android returns `Err("no PDF renderer on this platform … Android buys every render from its paired PC")` (`render/mod.rs`), while `run_stages` forces `need_peer = true` on Android (`commands/print.rs:1053`). WebView cold start is paid **zero** times per job. The real Android render cost is the peer round trip (HTML up, PC render, PDF down). | None (dead code) |
| A2 [CORRECTED: 3 sockets, not 2] | Bluetooth opens a new RFCOMM socket per operation, and a print does **three** connects, not two: the preflight `probe` in `run_stages` (`commands/print.rs:983`) runs **before** the peer render, then `send()` does the status `query` and the `write` (`transport/android_bluetooth.rs:196`), each via `openBluetoothSocket` + `connect()` + `close()` (`AndroidPrintPlugin.kt:803`). Each `connect()` takes ~0.5–3 s. Copies multiply it: the copies loop (`commands/print.rs:1187`) re-runs a full `send_to` per copy, i.e. 2 more connects per extra copy. | High on Bluetooth |
| A3 [VERIFIED] | USB does the same with the device: preflight probe, pre-check query, then write, each doing permission check, `openDevice`, `claimInterface` and close. USB opens are millisecond-scale, so this hurts less than Bluetooth. | Medium |
| A4 | Job bytes cross the Rust to Kotlin boundary as Base64 (about 33% larger, plus encode and decode copies on both sides). | Medium for big raster jobs |
| A5 | USB bulk writes use 16 KiB chunks, and each chunk is copied with `copyOfRange`. Larger chunks and an offset-based `bulkTransfer` would avoid both. | Low to Medium |
| A6 [CORRECTED: premise inverted] | `should_probe` (`transport/status.rs:320`) does **not** rate-limit the success path: it returns true for every print on a printer that answers (or is new) — only never-answering printers get the hourly `SILENT_COOLDOWN`. So an answering printer pays the full status-query round trip (up to `STATUS_REPLY_TIMEOUT` = 3 s when silent, one fast query when healthy) on **every** job, not "occasionally". | Medium (every answering-printer job) |
| A7 [VERIFIED, impact confirmed Low] | Bluetooth reply reading polls with `Thread.sleep(50)` (`AndroidPrintPlugin.kt:953`), breaking after 250 ms of silence. Worst case this adds ~50 ms of tail granularity per status query — and queries happen per print (see A6). Note `BluetoothSocket` has no `setSoTimeout`, so a "blocking read with timeout" needs a `Future`-with-timeout on `ioPool`, not a socket option. | Low |
| A8 [VERIFIED] | Rust side already uses `spawn_blocking` plus timeouts, so there is no async-blocking issue. | None |
| A9 [NEW] | `peer_consume::client()` (`api/peer_consume.rs:419`) builds a **fresh `reqwest::Client` for every probe and every render** (call sites: `:589`, `:768`) — no connection pooling, so every Android print pays a fresh TCP handshake plus slow-start on top of the render POST. Same bug class as L2, but on the Android-critical path where *every* job does a peer round trip. | Low per job, trivial fix |
| A10 [NEW] | The preflight transport probe runs **serially before** the peer render (`commands/print.rs:983` vs `:1024`). On Android the render cost is paid by the PC, so serializing the probe ahead of it adds a full probe latency (a BT connect, ~0.5–3 s) to every success path for no phone-side saving. | Medium on Bluetooth |
| A11 [NEW] | The copies loop (`commands/print.rs:1187-1209`) re-sends per copy with a full `send_to` each (precheck + write), and clones the whole payload per copy (`payload.clone()`, `:1195`) — memory churn plus 2 extra BT connects per extra copy for large PDFs. Concatenating the payload once and writing once removes both. | Medium-High for multi-copy jobs |

---

## 2b. Ways to fix (concrete, with code pointers)

### Windows

- **W1-fix — stop the silent one-shot fallback.** The fallback already logs
  (`render/mod.rs`: "persistent Edge could not render; using one-shot
  Edge"), so Phase 0 is grepping that line, not adding it. Then fix the
  cause, in this order: (1) confirm `warm_up_edge` runs at launch
  (`lib.rs:265`) and the profile dir is writable; (2) check the
  failed-start cooldown (`render/cdp.rs:65` — callers skip the persistent
  browser for a while after one bad start, which *looks* like "persistent
  never works" in the logs); (3) look for profile lock / stale port-file
  races when two jobs start together. Only if the browser itself is
  unhealthy, restart it in the background on death instead of per job.
- **W2-fix — self-contained templates.** Inline remote fonts/images at
  template-save time (the peer path already has the pattern:
  `peer_consume::inline_fonts` with a fingerprinted cache), so
  `Page.loadEventFired` + `document.fonts.ready` (`render/cdp.rs:358,391`)
  never wait on the network per job.
- **W3-fix — cache `offered_datatypes()` per printer with a TTL.**
  `WindowsSpooler::send` (`transport/windows_spooler.rs:534`) calls it on
  every PDF job (OpenPrinter + GetPrinter + EnumPrintProcessorDatatypes +
  ClosePrinter) and then `send_raw_with_datatype` opens the printer again.
  Cache the offered list per printer name for ~1 h (datatypes only change
  on driver reinstall); a `StartDocPrinter` 1804 failure invalidates the
  entry early. Saves one full spooler open-cycle per PDF job.
  > ✅ **Done** (`perf/print-speed`): `OFFERED_DATATYPES` static +
  > 1 h `DATATYPES_TTL` in `transport/windows_spooler.rs`; successes
  > cached, `None` never cached (transient denials recover next job).
  > `cargo check` / `clippy -D warnings` / `fmt` clean; unit tests pass
  > (Windows-only code path, verified by compile + existing tests).
- **W4-fix — `spawn_blocking` around the Win32 spooler calls.**
  `windows_spooler.rs` has zero `spawn_blocking`: `OpenPrinterA` /
  `StartDocPrinterA` / `WritePrinter` run on tokio workers. Wrap
  `send_raw_with_datatype`, `check_ready` and `offered_datatypes` bodies
  in `spawn_blocking` (same pattern the Android transports already use).
  Prevents one wedged queue from stalling the worker pool.
- **W5-fix — drop `StartPagePrinter`/`EndPagePrinter` for RAW and PDF.**
  They bracket EMF pages; for RAW spooling they are no-ops on the success
  path (`windows_spooler.rs:447,469`). Remove and verify against the
  `virtual-printer` e2e target — two fewer round trips per job, near-zero
  risk.

### Linux

- **L2-fix — one shared `reqwest::Client`.** `ipp.rs:120` and `cups.rs:261`
  build a client per send. Hoist to a `OnceLock<Client>` with
  `pool_idle_timeout` (keep the per-call `.timeout(...)`), shared by both
  modules. Saves a TCP handshake + TLS-less slow-start per job.
  > ✅ **Done** (`perf/print-speed`): `transport::shared_http_client()`
  > (`transport/mod.rs`, `OnceLock` + 60 s pool idle); all three call
  > sites (`ipp.rs` send + diagnose, `cups.rs` `post_ipp`) use it with
  > per-request `.timeout(...)`, so the `PRINTNINJA_SEND_TIMEOUT_SECS`
  > per-send test seam is preserved. Verified by `virtual_printer`
  > (25), `cups_discovery` (7) and lib (275) tests.
- **L3 — no code change.** `cups.rs:375-382` already sends non-PDF as
  `application/octet-stream` to raw queues. This is operator guidance:
  point label printers at a raw CUPS queue and set the printer row's
  language to the native command language, not PDF.
- **L4 — leave it.** The IPP body copy is structural (framing + document
  in one contiguous body); the `last-render.pdf` debug copy is already
  off the hot path (`tokio::spawn`).

### Android

- **A1-fix — delete or quarantine the dead code, don't optimize it.** A
  warm-`WebView` pool would optimize a path that never runs. Options:
  (a) delete `htmlToPdf`/`printToPdf` from the plugin and note why
  (Android renders via the paired PC by design); (b) keep it only if a
  future "unpaired local raster" feature is planned, and then say so in
  a comment. The real render-side work is A9 + the PC-side W1/L1.
- **A2/A3-fix — one connection per print (the big one).** Three designs,
  cheapest first: (1) **skip the preflight probe when the printer
  answered recently** — record last-success per address in Rust and skip
  `TransportRegistry::probe` within ~60 s (the `send()` precheck still
  guards the actual write); (2) **overlap the probe with the peer
  render** (see A10) instead of removing it; (3) **stateful plugin
  connection** — add `open_usb`/`open_bluetooth` returning a handle id
  kept in a Kotlin map, with `write_*_on(handle)` / `close(handle)`,
  so probe→query→write share one connect. (3) saves ~2 RFCOMM connects
  (~1–6 s) per BT print but changes the plugin API; do (1)/(2) first.
- **A4-fix — file-path handoff for large payloads only.** The Tauri
  bridge is JSON, so per-call base64 is mandatory for small jobs (keep
  it — receipts are KBs). For large raster/PDF payloads crossing to
  Kotlin, write the bytes to the app cache dir in Rust and pass the
  path, deleting after the write. Avoids the 33% inflation + 2 full
  copies where it actually matters.
- **A5-fix — offset-based `bulkTransfer`, trivially safe.** Replace the
  `copyOfRange` 16 KiB loop (`AndroidPrintPlugin.kt:471-475`) with the
  5-arg `bulkTransfer(endpoint, data, offset, length, ioTimeoutMs)`
  overload — available since API 18, minSdk is 24
  (`plugins/tauri-plugin-android-print/android/build.gradle.kts:16`).
  Genuinely Low impact (a 16 KiB memcpy is microseconds); do it while
  touching the function, not as its own task. Optionally raise the
  chunk to 64 KiB to cut JNI crossings — measure first.
- **A6-fix — short "answered OK" cache (follows from the correction).**
  Since the precheck runs on every print, cache a healthy answer per
  address for 30–60 s and skip the query within the window. Keep the
  semantics: any *fault* answer still fails the job immediately, and
  the window stays short so out-of-paper/jam is caught within a minute.
  This is the same mechanism as option (1) in the A2/A3 fix — implement
  once, apply to both probe and precheck.
- **A7-fix — only if queries still dominate after A6.** Replace the
  50 ms poll loop with `inputStream.read()` inside a `Future` on
  `ioPool` bounded by the existing reply timeout. Saves ≤50 ms per
  query; do last.
- **A9-fix — shared peer HTTP client, one line of real work.**
  `peer_consume::client()` → `static CLIENT: OnceLock<reqwest::Client>`,
  built once with `connect_timeout(PEER_CONNECT_TIMEOUT_MS)` and
  `pool_idle_timeout`. Both call sites (`:589` probe, `:768` render)
  use it. Saves a TCP handshake on every Android print.
  > ✅ **Done** (`perf/print-speed`): `SHARED_CLIENT` static in
  > `api/peer_consume.rs` (same connect timeout, +60 s pool idle);
  > `client()` now clones it, call sites untouched. Verified by
  > `peer_consume` (8), `peer_render_priority` (8),
  > `print_correctness` (15) tests.
- **A10-fix — spawn the preflight probe concurrently with the peer
  render.** In `run_stages`, start the `TransportRegistry::probe`
  future alongside the render POST and `.await` it just before the
  send stage: the success path hides the full probe latency, and a dead
  printer still fails before any byte is written (it just also paid the
  PC-side render, which costs the phone nothing). ~10 lines.
  > ✅ **Done** (`perf/print-speed`): probe spawned via
  > `tokio::spawn` before the render in `run_stages`
  > (`commands/print.rs`), awaited just before the send stage with the
  > same fail-before-any-byte-is-written path (now also recording
  > `render_ms`). Verified by `print_correctness` (15, incl. the
  > render-attempt-despite-unreachable-printer tests),
  > `print_path_offline`, `worker_queue`, `language_dispatch` (18).
- **A11-fix — batch copies into a single write.** In the copies loop,
  repeat the payload buffer N times (or pass `copies` through to
  transports that support a hardware copies count, e.g. IPP
  `send_bytes(data, copies, …)` already takes one) and call `send_to`
  once. Removes (N−1) precheck+write cycles and (N−1) full-payload
  clones per multi-copy job.
  > ✅ **Done** (`perf/print-speed`): single `send_to` in `run_stages`
  > (`commands/print.rs`) — IPP (and System-on-Linux → CUPS) get the
  > hardware `copies` count (`ipp.rs:385` already honored `job.copies`;
  > the caller just forced it to 1), all other transports get the
  > payload repeated N× in one write. Verified by `language_dispatch`
  > (18), `virtual_printer` (25), `history_jobs` (8).

---

## 3. Phased plan (revised after verification)

### Phase 0: Measure (about 0.5 day)

> [CORRECTED] Per-job timings **already exist** — do not build them.
> `StageTimings` (`commands/print.rs:95`: fetch/template/layout/render/
> send/history/total) is saved on every job row (`timings_json`) and
> logged as `print job timing`. The persistent-browser fallback already
> warns (`render/mod.rs`). What is actually missing:
>
> - queue wait (time from `queued` to worker claim — `start` begins at
>   `run_print`, so waiting is invisible today);
> - transport sub-stages: datatype lookup vs connect vs write (Windows),
>   probe vs query vs write (Android USB/BT);
> - peer-render split: caps-probe vs HTTP POST vs download (Android);
> - a counted fallback metric (promote the Edge/Chromium fallback `warn!`
>   to a counter so "how often" is a dashboard query, not a log grep).
>
> - Baseline 20 jobs on each platform, single and burst. Use `virtual-printer` (`e2e/support/`, exists) as the target.
> - Done when a table of p50/p95 per stage exists.

### Phase 1: Transport quick wins (about 1-1.5 days, low risk)
- Windows: cache `offered_datatypes()` per printer with a TTL ✅ **done** (`perf/print-speed`), run the spooler send in `spawn_blocking` (W4, todo), drop the unneeded page calls (W5, todo).
- Linux: one shared `reqwest::Client` ✅ **done** (`perf/print-speed`).
- Android: skip the preflight probe when the printer answered recently (todo — needs the recent-OK cache), overlap it with the peer render ✅ **done**, share the peer HTTP client ✅ **done**, batch copies into one write ✅ **done**. Keep the Bluetooth socket/USB-connection reuse across query+write as a follow-up — it saves the most but changes the plugin API.
- Done when transport p50 drops and the e2e print tests pass.

### Phase 2: Render path (about 1-2 days, biggest expected gain)
- Windows/Linux: find out why the persistent browser fails (launch timeout, profile lock, stale port file — and check the failed-start cooldown in `render/cdp.rs` first, which mimics "persistent never works"), start it at app launch (already done: `lib.rs:265-267`), and restart it in the background if it dies (W1, L1; see §2b fixes).
- All platforms: make templates self-contained, with bundled fonts and images and no network fetches (W2; see §2b fix).
- Android: no WebView work — A1 was rejected. The Android render cost is the peer round trip: the phone-side share is the A9 client fix (Phase 1), the rest is PC render speed, i.e. W1/L1 above.
- Done when fallbacks no longer appear in normal use and render p50 meets the Phase 0 target.

### Phase 3: Android data path (about 1 day)
- Pass job bytes without Base64 where the plugin API allows it, or at least avoid extra copies (A4).
- Larger USB chunks and no per-chunk copy (A5).
- Replace the 50 ms polling in the Bluetooth read with a blocking read with timeout (A7).
- Done when large raster jobs show a measurable drop in send time.

### Phase 4: Skip the heavy pipeline for label printers (about 2-3 days, optional, higher risk)

> [CORRECTED — premise was wrong] The pipeline **already** sends native
> command bytes for thermal printers: `render_for_language`
> (`commands/print.rs:160`) rasterizes at the head's DPI and encodes via
> `encode_for_language`, and CUPS raw queues receive
> `application/octet-stream` (`cups.rs:375-382`) — PDF is only produced
> when the printer row's language is PDF. So there is no "PDF instead of
> ZPL" pipeline to bypass. What remains of this phase:
>
> - Verify every label-printer row actually has its native language set
>   (a ZPL printer with language=PDF eats the CUPS-filter cost from L3).
> - Optionally add a startup/config check warning when a raw-queue
>   printer is set to PDF.
> - Only worth doing if Phase 0 shows the driver or filter is the bottleneck.

### Phase 5: Throughput and regression guard (about 1 day)
- Test bursts across several printers and tune the global in-flight limit (`MAX_IN_FLIGHT_SENDS` in `queue.rs:41`, not `worker.rs`) if render is the bottleneck.
- Add a benchmark using `virtual-printer` that fails when p95 for N jobs regresses beyond a threshold.
- Document the timing logs and env switches in `docs/ARCHITECTURE.md`.

---

## 4. Priority summary

| Phase | Expected gain | Risk |
|---|---|---|
| 0 Measure | Visibility | None |
| 1 Transport quick wins | Moderate, per job | Low |
| 2 Render path | Likely largest | Medium |
| 3 Android data path | Moderate on large jobs | Low |
| 4 Native label languages | Large on label printers | Higher |
| 5 Guard | Protects gains | Low |

Phases 1 and 2 can run in parallel after Phase 0. Phase 4 should wait for the Phase 0 numbers.

## 5. Caveats
- No profiling or on-device testing was done. The verification pass was static code reading too — it corrected claims against the code but did not measure anything. Android findings in particular need confirmation on a real device and printer.
- Gains are ordered by what the code does, not by measured time.
