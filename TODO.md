# TODO — PDFium on Linux and Android

Make PDF-in work on the two platforms that currently don't: **Linux**
(no bundled PDFium binary → system-library fallback, usually absent) and
**Android** (hard refusal stub). Decisions taken:

- **Linux** — vendor a prebuilt `libpdfium.so` (x86-64) beside the
  existing `pdfium.dll`; the existing `candidate_paths()` loader already
  resolves the right filename per OS, so **no Rust code change**.
- **Android** — no binary in the APK. Use the framework's
  `android.graphics.pdf.PdfRenderer` (the platform's own PDFium port)
  in Kotlin, mirroring the existing `htmlToRaster` on-device path
  (cache-file handoff, same `dotsFromArgb` threshold).

## 1. Linux: bundle PDFium

- [x] Source a prebuilt `libpdfium.so` (x86-64) at a revision matching
      the bundled build (8046d; binding `pdfium_7881` — the FPDF_LIBRARY
      function table is append-only, so a binding at or below the binary
      revision is the safe direction). Same `paulocoutinhox/pdfium-lib`
      8046d release as the Windows DLL: `linux.zip` →
      `release/lib/x64/libpdfium.so` (ELF x86-64, 7.5 MB).
- [x] Vendor it at `src-tauri/resources/pdfium/libpdfium.so`; extend
      `LICENSE.txt` provenance with the Linux binary's source.
- [x] No Rust change: `candidate_paths()` →
      `pdfium_platform_library_name_at_path` picks `libpdfium.so` on
      Linux; Tauri bundles `resources/pdfium/` beside the executable.
- [x] Update the module doc at the top of `src-tauri/src/render/pdfium.rs`
      (now names both binaries + the dead-weight tradeoff) and the
      `Cargo.toml` dependency comment.
- [x] Update the "PDFium tests self-skip on Linux" notes in
      `src-tauri/Dockerfile.test` and `docs/DEVELOPMENT.md`: with the
      `.so` vendored, the Docker suite binds it via the manifest-dir
      candidate and the three unit tests run on Linux.
- [x] Known tradeoff documented (in the `pdfium.rs` module doc):
      `resources: ["resources/pdfium"]` bundles the whole dir to every
      platform, so each installer carries the other platform's ~7 MB
      binary.
- [x] **Verify:** Docker `cargo test` — the three pdfium unit tests
      **passed on Linux** in both runs (not skipped); the re-run
      confirms the `api_routes` fixes (two stale assertions:
      `required` is now `["printer"]` since `template`
      gained its `pdf` alternative, and the body cap moved 2 MiB →
      10 MiB for the base64 `pdf` field, so the 413 probe now sends
      11 MiB).

## 2. Android: platform PdfRenderer (the OS's own PDFium)

No APK bloat, no NDK cross-compile of pdfium-render. Kotlin renders,
Rust reads the dots back — exactly how `htmlToRaster` works today.

- [x] **Kotlin** (`plugins/tauri-plugin-android-print/android/…/AndroidPrintPlugin.kt`):
      - `PdfToRasterArgs` (`@InvokeArg`: `pdfBase64`, `widthPx`, `heightPx`).
      - `@Command pdfToRaster(invoke)`: base64-decode → cache file →
        `PdfRenderer(ParcelFileDescriptor)` (API 21+, below Tauri's
        minSdk floor); `renderer.pageCount` feeds the multi-page warning;
        `openPage(0)`, Matrix scaling the page into w×h keeping aspect,
        top-left anchored, **landscape pages rotated 90° to fill the
        width** (mirrors PDFium `scale_page_to_display_size`); render
        into a white-backed ARGB_8888 `Bitmap`; `dotsFromArgb` (the
        existing shared threshold, `AndroidPrintPlugin.kt:73`) → cache
        file; resolve `{ path, width, height, pageCount }`.
- [x] **Plugin Rust** (`plugins/tauri-plugin-android-print/src/`):
      - `models.rs`: `PdfToRasterRequest { pdf_base64, width_px, height_px }`
        and `PdfToRasterResponse { path, width, height, page_count }`
        (camelCase serde, like the sibling raster models).
      - `mobile.rs`: `AndroidPrint::pdf_to_raster` via
        `run_mobile_plugin("pdfToRaster", payload)`, plus a unit test
        next to the existing `HtmlToRaster` serde test (models.rs:584).
- [x] **Dispatch** (`src-tauri/src/render/mod.rs` + `commands/print.rs`):
      - New `pub async fn pdf_to_raster(&self, pdf, w_px, h_px)
        -> Result<(RasterImage, u32)>` on `PdfRenderer`, mirroring
        `html_to_raster` (render/mod.rs:308): non-Android → the existing
        `render::pdfium::pdf_to_raster` in `spawn_blocking`; Android →
        new `android_pdf_raster` helper mirroring
        `android_webview_raster` (render/mod.rs:339: `android_app()` +
        deadline + read/delete the dot file + `RasterImage::from_packed`).
      - `impl JobRenderer for PdfRenderer::rasterize_pdf`
        (commands/print.rs:297) becomes `self.pdf_to_raster(...).await`.
- [x] **Fix the latent Android break** the PDF-in feature introduced:
      `pub mod pdfium;` (render/mod.rs:29) is not cfg-gated, but
      `static PDFIUM: OnceLock<Result<Pdfium, String>>`
      (render/pdfium.rs:42) names `Pdfium` from the
      `#[cfg(not(target_os = "android"))]` prelude import — the tree
      does not compile for Android today. Gate the whole engine
      (`#[cfg(not(target_os = "android"))] pub mod pdfium;`) and drop
      the Android stub (dispatch now lives in `PdfRenderer`).
- [x] Update the comment at commands/print.rs:1431 ("PDF on Android is
      still bought from the paired PC") — true only for PDF-*language*
      printers (they need real PDF bytes); PDF-*input* to thermal heads
      now rasterises on the device.

## 3. Docs and verification

- [x] `docs/architecture/RENDERING_AND_LAYOUT.md` (PDF input section):
      Linux ships the bundled `.so`; Android rasterises on-device via
      the platform renderer (multi-page warning unchanged).
- [x] `docs/architecture/PRINTERS_AND_TRANSPORTS.md`: the Android bullet
      ("PDF input is desktop-only") and the PDF-path paragraph.
- [x] `docs/ARCHITECTURE.md` "Printing across modes" — phone bullet:
      PDF-*language* jobs still need a pair; PDF input to a thermal
      printer works unpaired.
- [x] `docs/ENV.md` `PDFIUM_LIBRARY_PATH` — mention the Linux default.
- [x] **Verify, in order:**
      1. Docker `cargo test` — **green** (378 lib tests + all
         integration suites; pdfium unit tests run on Linux).
      2. `cargo check --all-targets` + `cargo clippy --all-targets`
         (desktop) — **clean**, zero warnings.
      3. Android compile check — `cargo check --target
         aarch64-linux-android` with explicit NDK CC/AR — **passes**,
         zero warnings (after the `probe_by_name` Windows gate).
      4. Kotlin compile/unit tests — **BUILD SUCCESSFUL** on this
         machine via `src-tauri/gen/android` gradle
         (`:tauri-plugin-android-print:testDebugUnitTest`, cached
         gradle 9.6.1). Caught and fixed three real API errors in the
         new code (see below). `RasterDotsInstrumentedTest` still
         needs a real device — note, not blocking.
      5. `pnpm check` fast set — exit 0 (Rust-only contract change;
         frontend untouched, confirmed).

## 4. Print-flow review + dead-code removal

- [x] Traced every PDF-input path end to end: REST decode (routes.rs:505-568,
      either/or checks + `MAX_PDF_BYTES` cap) → `PrintRequest.pdf` →
      `validate_pdf_input` (print.rs:571) → dispatch (print.rs:1373) →
      `render_pdf_input` (1787: Pdf-language passthrough / command-language
      `rasterize_pdf` + multi-page warning) → `PdfRenderer::pdf_to_raster`
      (render/mod.rs:357: desktop bundled PDFium in `spawn_blocking` /
      Android `android_pdf_raster` via the plugin) → `encode_for_language`.
      Coherent, no gaps.
- [x] Removed the dead `#[cfg(not(target_os = "android"))]` attributes
      *inside* `render/pdfium.rs` (prelude import, `pdfium()`,
      `candidate_paths()`, `pdf_to_raster`, tests module → `#[cfg(test)]`)
      — redundant now that `mod pdfium` itself is cfg-gated (render/mod.rs).
- [x] Confirmed what looked dead is intentional: `JobRenderer::rasterize` /
      `rasterize_pdf` default impls (refuse loudly for non-PDF renderers),
      the `PdfInStub` test double (3 live uses), no stale refusal strings.

## Verification results — all green

- [x] Docker `cargo test` — **378 lib tests + every integration suite
  green**; the three pdfium unit tests run on Linux (vendored `.so`
  bound via the manifest-dir candidate). First run surfaced two stale
  `api_routes` assertions — fixed.
- [x] Desktop `cargo check --all-targets` — clean.
- [x] Desktop `cargo clippy --all-targets` — **zero warnings**
  (after the dead-cfg cleanup + `probe_by_name` Windows gate).
- [x] `pnpm check` fast set — exit 0.
- [x] Android `cargo check --target aarch64-linux-android` — **passes,
  zero warnings**. cc-rs needs `CC_aarch64_linux_android` /
  `AR_aarch64_linux_android` pointed explicitly at
  `C:\Users\1142\Android\Sdk\ndk\29.0.13846066\toolchains\llvm\prebuilt\
  windows-x86_64\bin\{clang.exe, llvm-ar.exe}` (`ANDROID_NDK_HOME`
  alone is not enough).
- [x] Flaky-test confirmation: `virtual_printer` re-run on an idle host
  — **29 passed; 0 failed** in 16.8 s. The earlier 40.2 s failure of
  `a_hanging_raw_printer_times_out_instead_of_blocking_forever` was CPU
  contention (2 s tokio deadline fired late while the desktop compile
  ran in parallel), not a regression.
- [x] **Kotlin plugin build** — run on this machine via
  `src-tauri/gen/android` (Tauri app project, has `gradlew`, cached
  gradle 9.6.1): `gradlew :tauri-plugin-android-print:testDebugUnitTest`
  → **BUILD SUCCESSFUL** (compiles the new Kotlin incl. `pdfToRaster` /
  `renderPdfDots` + runs the JVM unit tests). This check caught three
  real API errors in the new code (the Rust side had compiled clean, so
  nothing else could have caught them):
  - `ParcelFileDescriptor.fromFile(pdfFile)` → no such method; now
    `ParcelFileDescriptor.open(pdfFile, MODE_READ_ONLY)`.
  - `android.graphics.pdf.PdfPage` → does not exist; the page type is
    the nested `PdfRenderer.Page`.
  - `page.render(bmp, null, matrix)` → 4-arg method; now
    `page.render(bmp, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_
    DISPLAY)` (API 36's name for the old `RENDER_MODE_FOR_SCREEN`;
    value 0 is compile-time inlined, so older devices behave the same).
  - Remaining: the instrumented test (`src/androidTest`) needs a real
    device — note, don't block on it.
