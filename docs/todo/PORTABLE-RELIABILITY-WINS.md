# Portable reliability wins (from REFACTORING-PLAN.md)

Reliability machinery from the rewrite plan (`REFACTORING-PLAN.md`) that can be implemented
**in the current codebase** without the rewrite. Ordered by leverage; 1–3 are the plan's
stages 1–3, which the plan itself says deliver most of the reliability gain in-place.

## 1. Golden-byte tests for the encoders — cheapest, pure upside

Status: not started

The ZPL/TSPL/ESC-POS byte builders already exist in code
(`src-tauri/src/transport/label_langs.rs`, `src-tauri/src/transport/escpos.rs`
`print_raster` / `print_raster_banded`, the `^XA` / `^FO` / `SIZE` builders).

- [ ] Add golden-file tests: fixed input → pinned exact bytes, per language
- [ ] Cover the raster path (`print_raster`, `print_raster_banded`) with golden output too
- [ ] Fail loudly if any encoder change alters pinned bytes

Effort: days. From then on every encoder change either keeps the bytes or fails CI.
Also the safety net required before item 5.

## 2. Raw Console — the force multiplier

Status: not started

Transports all exist (`src-tauri/src/transport/raw_tcp.rs`, `windows_bluetooth.rs`,
`linux_bluetooth.rs`, `android_bluetooth.rs`, USB). What's missing is the plan's §5.8:

- [ ] `raw_send` command: send raw bytes over a chosen transport with adjustable chunk size, pause and close delay
- [ ] Reply capture on the same connection (reuse the reply readers in `src-tauri/src/transport/status.rs`)
- [ ] Developer-toggled UI screen: byte input, pacing controls, send history, copyable report
- [ ] Save captured sessions so they can serve as profile quirk evidence (item 4)

Value: every printer quirk is investigated in minutes instead of rebuild cycles.
This is the plan's phase 1 and its first shippable build.

- Full implementation plan: `RAW-CONSOLE-PLAN.md` (repo root).
- Simplified test-only version (no plugin changes, no reply capture): `docs/todo/RAW-CONSOLE-MINIMAL.md`.

## 3. Honest result states — direct reliability win

Status: not started

Today a job ends `success` when bytes are accepted
(`src-tauri/src/commands/print.rs` — `success: status == "success"`; the API
`JOB_STATUSES` is a string enum, `src-tauri/src/api/routes.rs`). Port the plan's §5.7:

- [ ] Split `success` into **printed (confirmed)** — re-run the per-language status query
      (`DLE EOT` / `~HS` / `ESC !?`, already implemented in `src-tauri/src/transport/status.rs`)
      after the close delay — and **sent (unconfirmed)** for printers that cannot confirm
- [ ] Add **partially printed (N of M)** for multi-label jobs: track per-label outcomes
      instead of one job status
- [ ] Add **wrong-mode suspected**: data accepted but the profile says the printer ignores
      this language in its current mode
- [ ] Show the state in plain words in the UI and the API (string enum — backward compatible)

## 4. Printer profiles as data — kills the string matching

Status: not started

`src-tauri/src/transport/capabilities.rs` decides a printer's language by substring on the
model name (`m.contains("zebra") || m.contains("zpl")` …). Replace with shipped data:

- [ ] Step 1: TOML profiles (aliases, language, dpi, head width, media, status dialect);
      pure refactor of `capabilities.rs` / `status.rs` dialect picking — same behavior,
      data-driven
- [ ] Step 2: move `EscPosTuning` / `TsplTuning` (today per-printer settings JSON) into
      profile defaults with user overrides
- [ ] Step 3: move delivery pacing values into profiles — fixes the Rust/Kotlin drift
      (Android pacing in `plugins/tauri-plugin-android-print/.../BluetoothPacing.kt`,
      desktop pacing in Rust)
- [ ] Profile status field `verified` / `community` / `untested`, shown to users
- [ ] Every quirk carries a link to the Raw Console session that proved it
- [ ] Hardware checklist per profile (minimal text, label, barcode, long job, two jobs
      back to back, expected results) run before a profile is marked `verified`

## 5. Native-first planner with fallback — the payoff

Status: not started (needs 1 and 4)

Add the plan's §5.3 selection on top of existing code:

- [ ] Planner: if the template uses only elements the printer's language can draw
      (text in the profile's native fonts, barcodes, lines/boxes) and the profile
      supports the language → native commands; otherwise raster
- [ ] Record the fallback reason (which element forced raster)
- [ ] Per-printer "prefer native" toggle in settings
- [ ] Verify emitted bytes on real printers via the Raw Console (item 2)

This is what makes Bluetooth labels small, fast and sharp — a planner function, not a
new renderer.

## Not portable (rewrite-only)

- **Rust renderer** — its value (determinism, no browser) only pays off in the rewrite;
  it cannot be extracted from the browser-rendering architecture
- **Scene format** — Handlebars templates remain the core until the rewrite
- **Multi-page pagination** — needs the renderer to own page geometry
