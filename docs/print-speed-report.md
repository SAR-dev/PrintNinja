# PrintNinja: Print Speed Report and Plan

Branch: `develop` of `SAR-dev/PrintNinja`
Scope: Windows, Linux, Android
Method: static code reading only. Nothing was profiled, so every finding is a hypothesis until Phase 0 produces numbers.

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
| A1 | `htmlToPdf` creates a new `WebView` on the UI thread for every job, loads the HTML and destroys the view afterwards. WebView cold start is paid per job. | High |
| A2 | Bluetooth opens a new RFCOMM socket per operation. With a status pre-check enabled, one job opens two sockets (`query_bluetooth` then `write_bluetooth`), and each `connect()` takes seconds. | High on Bluetooth |
| A3 | USB does the same with the device: pre-check query, then write, each doing permission check, `openDevice`, `claimInterface` and close. | Medium |
| A4 | Job bytes cross the Rust to Kotlin boundary as Base64 (about 33% larger, plus encode and decode copies on both sides). | Medium for big raster jobs |
| A5 | USB bulk writes use 16 KiB chunks, and each chunk is copied with `copyOfRange`. Larger chunks and an offset-based `bulkTransfer` would avoid both. | Low to Medium |
| A6 | The status pre-check is rate-limited by `should_probe`, but an unanswered query waits up to 3 s (`STATUS_REPLY_TIMEOUT`) before the job proceeds. | Low to Medium |
| A7 | Bluetooth reply reading polls with `Thread.sleep(50)`. | Low |
| A8 | Rust side already uses `spawn_blocking` plus timeouts, so there is no async-blocking issue. | None |

---

## 3. Phased plan

### Phase 0: Measure (about 0.5 day)
- Add per-job timing logs for queue wait, render, and transport (datatype lookup, spool or IPP send, Android connect/write). Add a clear warning whenever the render falls back to a one-shot browser.
- Baseline 20 jobs on each platform, single and burst. Use `virtual-printer` as the target.
- Done when a table of p50/p95 per stage exists.

### Phase 1: Transport quick wins (about 1-1.5 days, low risk)
- Windows: cache `offered_datatypes()` per printer with a TTL, run the spooler send in `spawn_blocking`, drop the unneeded page calls (W3-W5).
- Linux: one shared `reqwest::Client` (L2).
- Android: reuse the connection for pre-check plus write. Keep the Bluetooth socket and USB connection open across the status query and the write, or skip the query when a recent one succeeded (A2, A3, A6).
- Done when transport p50 drops and the e2e print tests pass.

### Phase 2: Render path (about 1-2 days, biggest expected gain)
- Windows/Linux: find out why the persistent browser fails (launch timeout, profile lock, stale port file), start it at app launch, and restart it in the background if it dies (W1, L1).
- All platforms: make templates self-contained, with bundled fonts and images and no network fetches (W2).
- Android: keep one warm `WebView` and reuse it between jobs instead of creating and destroying one each time (A1). Guard against leaks and stale state between jobs.
- Done when fallbacks no longer appear in normal use and render p50 meets the Phase 0 target.

### Phase 3: Android data path (about 1 day)
- Pass job bytes without Base64 where the plugin API allows it, or at least avoid extra copies (A4).
- Larger USB chunks and no per-chunk copy (A5).
- Replace the 50 ms polling in the Bluetooth read with a blocking read with timeout (A7).
- Done when large raster jobs show a measurable drop in send time.

### Phase 4: Skip the heavy pipeline for label printers (about 2-3 days, optional, higher risk)
- Send native ZPL/TSPL as `RAW` on Windows and raw CUPS queues on Linux, and raster or command bytes directly on Android, instead of PDF (L3).
- Put it behind a per-printer setting with PDF as the default, and verify print quality.
- Only worth doing if Phase 0 shows the driver or filter is the bottleneck.

### Phase 5: Throughput and regression guard (about 1 day)
- Test bursts across several printers and tune the global in-flight limit in `worker.rs` if render is the bottleneck.
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
- No profiling or on-device testing was done. Android findings in particular (A1, A2) need confirmation on a real device and printer.
- Gains are ordered by what the code does, not by measured time.
