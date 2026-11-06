use anyhow::{anyhow, Result};
use std::path::PathBuf;

pub mod barcode;
/// The user's browser preference (Settings → Diagnostics): automatic,
/// system browser, downloaded shell, or a custom path. The render layer
/// reads a cached copy; it never touches the DB itself.
pub mod browser_choice;
/// Opt-in download of the headless-shell fallback browser (Windows).
pub mod browser_download;
// Launches headless Edge (Windows) or Chromium (Linux). Edge runs it for
// real; the unit tests build it everywhere so the profile logic is tested
// without Edge.
#[cfg(any(windows, target_os = "linux", test))]
mod cdp;
#[cfg(any(windows, test))]
mod edge;
/// Whether this process is running elevated (administrator). Headless Edge
/// will not print from an elevated parent (see
/// docs/architecture/RENDERING_AND_LAYOUT.md), so
/// the failure paths report it instead of guessing.
mod elevation;
/// One-click repair for the Windows print pipeline (Settings → Diagnostics).
pub mod fix;
pub mod handlebars;
pub mod layout;
pub mod raster;

pub struct PdfRenderer {
    cache_dir: PathBuf,
}

/// The app handle the Android transports (USB, Bluetooth) need to reach
/// the Kotlin plugin. `PdfRenderer::new` is called from the worker, the
/// REST API and the print command with only a cache dir, so the handle
/// is registered once at app setup instead of being threaded through
/// every constructor.
#[cfg(target_os = "android")]
static ANDROID_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Register the app handle the Android transports need. Call once from
/// app setup, before the worker spawns.
#[cfg(target_os = "android")]
pub fn register_android_app(app: tauri::AppHandle) {
    let _ = ANDROID_APP.set(app);
}

/// The handle the Android transports need to reach the Kotlin plugin.
///
/// `None` before setup registered it — either way the caller reports
/// "not ready / not available" instead of panicking. Android-only: no
/// other platform has a transport that needs it.
#[cfg(target_os = "android")]
pub(crate) fn android_app() -> Option<tauri::AppHandle> {
    ANDROID_APP.get().cloned()
}

/// Debug copy of a render artifact (`last-render.*`), fire-and-forget:
/// file I/O never sits on a print's critical path. With `cleanup` the
/// per-job source is removed in the same task, so it always survives
/// until the copy lands. Nothing reads these back — humans do, when a
/// print looks wrong.
fn debug_copy(src: PathBuf, dst: PathBuf, cleanup: bool) {
    tokio::spawn(async move {
        let _ = tokio::fs::copy(&src, &dst).await;
        if cleanup {
            let _ = tokio::fs::remove_file(&src).await;
        }
    });
}

impl PdfRenderer {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self { cache_dir }
    }
    /// Write one job's HTML to a **uniquely named** file and return the path.
    ///
    /// Every job shares this cache directory and jobs for different printers
    /// render in parallel, so the fixed `render.html` this used to write let
    /// one job hand its document to another printer (P6).
    pub async fn write_job_html(&self, html: &str) -> Result<PathBuf> {
        let path = self
            .cache_dir
            .join(format!("render-{}.html", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, html).await?;
        // Keep the newest input next to `last-render.pdf` for debugging;
        // it is an artifact, never read back by a render.
        debug_copy(path.clone(), self.cache_dir.join("last-render.html"), false);
        Ok(path)
    }

    /// Render `html` to a PDF.
    ///
    /// Page size arrives in the document's `@page` rule (`apply_layout`):
    /// one sheet per page, margins already applied by the layout, so the
    /// parameters here are for the log line.
    ///
    /// Failure is an error, never a placeholder (P5). When Edge was missing
    /// or failed — and on every platform without a renderer — this used to
    /// return a stub PDF containing the word "PrintNinja" and the job
    /// reported success, so the operator saw a printed page instead of
    /// their label.
    ///
    /// Android has no branch here: the phone never renders locally, every
    /// job is bought from its paired PC (see `need_peer` in the print
    /// pipeline), so a local renderer would be dead code.
    pub async fn html_to_pdf(
        &self,
        html: &str,
        page_width_mm: f64,
        page_height_mm: f64,
        orientation: &str,
    ) -> Result<Vec<u8>> {
        tracing::debug!(page_width_mm, page_height_mm, orientation, "rendering PDF");
        let html_path = self.write_job_html(html).await?;

        #[cfg(windows)]
        let result = self.webview2_print_to_pdf(&html_path).await;

        // Linux v1: IPP and raw TCP are the supported transports, rendered
        // through a system Chromium (--print-to-pdf honors the @page rule
        // `apply_layout` injects). No bundled browser, no placeholders.
        #[cfg(target_os = "linux")]
        let result = self.chromium_print_to_pdf(&html_path).await;

        #[cfg(not(any(windows, target_os = "linux")))]
        let result = Err(anyhow!(
            "no PDF renderer on this platform (printing needs Windows with Edge/WebView2 \
             or Linux with a system Chromium; Android buys every render from its paired PC); \
             refusing to send a placeholder instead of the document"
        ));

        // Per-job file: removed whether the render worked or not, so the
        // cache dir does not grow a file per print.
        let _ = tokio::fs::remove_file(&html_path).await;
        result
    }

    #[cfg(windows)]
    async fn webview2_print_to_pdf(&self, html_path: &std::path::Path) -> Result<Vec<u8>> {
        // Unique per job: a shared `output.pdf` could be stale (Edge exits 0
        // without writing when it hands off to a running instance) or be
        // overwritten by a concurrent job.
        let job = uuid::Uuid::new_v4();
        let pdf_path = self.cache_dir.join(format!("output-{job}.pdf"));

        let edge_path = find_edge("PDF rendering")?;
        let html_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));

        // The persistent Edge first: no process start, no new profile — a tab
        // opens, prints and closes. Any failure there falls through to the
        // one-shot launcher below, so printing never depends on it.
        if cdp::enabled() {
            let started = std::time::Instant::now();
            let cfg = cdp::Config::new(std::path::Path::new(&edge_path), &self.cache_dir);
            match cdp::shared().print_pdf(&cfg, &html_url).await {
                Ok(bytes) => {
                    crate::metrics::count_browser_render(true);
                    tracing::info!(
                        html = %html_url,
                        bytes = bytes.len(),
                        edge_ms = started.elapsed().as_millis() as u64,
                        persistent = true,
                        "rendered PDF with Edge"
                    );
                    // Debug copy, off the print's critical path.
                    let last = self.cache_dir.join("last-render.pdf");
                    let copy = bytes.clone();
                    tokio::spawn(async move {
                        let _ = tokio::fs::write(last, copy).await;
                    });
                    return Ok(bytes);
                }
                Err(e) => {
                    crate::metrics::count_browser_render(false);
                    tracing::warn!(
                        error = %e,
                        "persistent Edge could not render; using one-shot Edge"
                    )
                }
            }
        }

        let mut args: Vec<String> = [
            "--headless=new",
            "--disable-features=msEdgeStartupBoost",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--print-to-pdf-no-header",
            "--no-pdf-header-footer",
            // Without this headless Edge writes nothing to stderr on
            // failure (the report's empty-stderr symptom); with it, the
            // failure branches below can quote Edge's real log lines.
            // The launcher pipes stderr (`cmd.output()`), so nothing
            // blocks.
            "--enable-logging=stderr",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--print-to-pdf={}", pdf_path.to_string_lossy()));
        args.push(html_url.clone());

        // The profile (reusable, or a throwaway) is the launcher's business.
        let run = match edge::shared()
            .run(
                std::path::Path::new(&edge_path),
                &self.cache_dir,
                &args,
                &pdf_path,
            )
            .await
        {
            Ok(run) => run,
            Err(e) => {
                let _ = std::fs::remove_file(&pdf_path);
                return Err(e);
            }
        };

        if run.output.status.success() && pdf_path.exists() {
            let bytes = tokio::fs::read(&pdf_path).await;
            // Keep the newest render next to last-render.html so it can be
            // opened directly to tell "Edge output is unstyled" apart from
            // "styling is lost later in the print path".
            let last = self.cache_dir.join("last-render.pdf");
            let _ = std::fs::copy(&pdf_path, &last);
            let _ = std::fs::remove_file(&pdf_path);
            tracing::info!(
                html = %html_url,
                pdf = %last.display(),
                bytes = bytes.as_ref().map_or(0, |b| b.len()),
                edge_ms = run.edge_ms,
                profile_cleanup_ms = run.cleanup_ms,
                warm_profile = run.warm,
                "rendered PDF with Edge"
            );
            return bytes.map_err(Into::into);
        }

        // Edge failed or wrote nothing. Report it; do not fall back to a
        // placeholder (P5).
        let stderr = String::from_utf8_lossy(&run.output.stderr);
        let _ = std::fs::remove_file(&pdf_path);

        // The command line is the diagnostic anchor for every branch
        // below: with `--enable-logging=stderr`, the flags plus the
        // stderr excerpt tell the story the exit code alone cannot.
        tracing::warn!(
            edge = %edge_path.display(),
            args = %args.join(" "),
            status = %run.output.status,
            "Edge print-to-pdf did not produce a PDF"
        );

        // Elevated parent: the report's A/B test showed Edge exits 0 in a
        // few hundred milliseconds without printing whenever its parent
        // is elevated, even on a fresh profile — the expected failure,
        // not a handoff or a stale profile. Checked before the handoff
        // signature below because msedge.exe is resident even on an
        // elevated PC, so the handoff branch would misattribute the
        // cause. (Only for msedge.exe: the elevation failure is a
        // property of Edge, and the headless shell is unverified.)
        if run.output.status.success()
            && elevation::is_elevated()
            && edge_path.file_name().is_some_and(|n| n == "msedge.exe")
        {
            return Err(anyhow!("{}", elevation::ELEVATED_ERROR));
        }

        // The handoff signature, named for what it is: Edge exited 0,
        // wrote no PDF, and msedge.exe is still running — the fresh
        // launch handed its job to the resident Edge session instead of
        // printing. The generic message below is not something an
        // operator can act on; this one is. (Only for msedge.exe: the
        // headless shell has no resident session to hand off to, so the
        // same exit-0-no-PDF there is a different bug.)
        if run.output.status.success()
            && edge_path.file_name().is_some_and(|n| n == "msedge.exe")
            && fix::processes_running("msedge.exe")
        {
            return Err(anyhow!(
                "Edge handed the print job to a running Edge session (exit 0, \
                 no PDF) — close all Edge windows, or run Fix PC printing \
                 (Settings > Diagnostics)"
            ));
        }
        Err(anyhow!(
            "Edge print-to-pdf did not produce a PDF (status {}{})",
            run.output.status,
            stderr_excerpt(&stderr)
                .map(|s| format!(", Edge stderr: {s}"))
                .unwrap_or_default()
        ))
    }

    /// Render `html` to a 1-bit raster at the printer's own resolution (P4).
    ///
    /// On Windows and Linux a headless browser screenshots the page at
    /// exactly the window size the label prints at (1 CSS px = 1 printer
    /// dot) and the PNG is thresholded to dots; on Android the system
    /// WebView does the same render on the device (PLAN §4). Same rule on
    /// every platform: failure is an error, never a placeholder.
    pub async fn html_to_raster(
        &self,
        html: &str,
        w_px: usize,
        h_px: usize,
    ) -> Result<crate::render::raster::RasterImage> {
        tracing::debug!(w_px, h_px, "rasterizing for a command-language printer");
        let html_path = self.write_job_html(html).await?;

        #[cfg(windows)]
        let result = self.webview2_screenshot(&html_path, w_px, h_px).await;

        // Same Chromium as the PDF path: --screenshot at the exact label
        // size, then the shared PNG thresholding below.
        #[cfg(target_os = "linux")]
        let result = self.chromium_screenshot(&html_path, w_px, h_px).await;

        // The system WebView measures the page at the head's own
        // resolution and thresholds on the device (PLAN §4).
        #[cfg(target_os = "android")]
        let result = Self::android_webview_raster(html, w_px, h_px).await;

        #[cfg(not(any(windows, target_os = "linux", target_os = "android")))]
        let result = Err(anyhow!(
            "no raster renderer on this platform (command-language printing needs \
             Windows with Edge/WebView2 or Linux with a system Chromium); refusing to \
             send a placeholder instead of the label"
        ));

        // Per-job file: removed whether the render worked or not, so the
        // cache dir does not grow a file per print.
        let _ = tokio::fs::remove_file(&html_path).await;
        result
    }

    /// Android: the WebView renders at the head's own resolution (1 CSS px
    /// = 1 dot) and thresholds on the device (PLAN §4). Kotlin writes the
    /// packed dots to a cache-dir file, which this reads and deletes.
    ///
    /// The deadline sits above Kotlin's own 60 s render watchdog (see
    /// `renderTimeoutMs` in `AndroidPrintPlugin`), like the USB path's
    /// timeout sits above its socket deadlines: whichever gives up first
    /// reports the cause.
    #[cfg(target_os = "android")]
    async fn android_webview_raster(
        html: &str,
        w_px: usize,
        h_px: usize,
    ) -> Result<crate::render::raster::RasterImage> {
        use tauri_plugin_android_print::AndroidPrintExt;

        const ANDROID_RENDER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(75);

        let app = crate::render::android_app()
            .ok_or_else(|| anyhow!("the Android render bridge is not ready yet"))?;
        let payload = tauri_plugin_android_print::HtmlToRasterRequest {
            html: html.to_string(),
            width_px: w_px as u32,
            height_px: h_px as u32,
        };
        let res = tokio::time::timeout(
            ANDROID_RENDER_DEADLINE,
            tokio::task::spawn_blocking(move || app.android_print().html_to_raster(payload)),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "the Android WebView did not finish rasterizing within {}s",
                ANDROID_RENDER_DEADLINE.as_secs()
            )
        })?
        .map_err(|e| anyhow!("the Android raster render task failed: {e}"))?
        .map_err(|e| anyhow!("the Android WebView could not rasterize the job: {e}"))?;

        let bytes = tokio::fs::read(&res.path).await?;
        let _ = tokio::fs::remove_file(&res.path).await;

        // Length for the error message, taken before `bytes` moves into
        // `from_packed` (the closure may not borrow it afterwards).
        let dot_bytes = bytes.len();
        crate::render::raster::RasterImage::from_packed(
            res.width as usize,
            res.height as usize,
            bytes,
        )
        .ok_or_else(|| {
            anyhow!(
                "raster size mismatch from the Android WebView: {dot_bytes} bytes for {}x{} dots",
                res.width,
                res.height
            )
        })
    }

    /// Headless Edge `--screenshot` at `w_px`×`h_px`, thresholded to dots.
    #[cfg(windows)]
    async fn webview2_screenshot(
        &self,
        html_path: &std::path::Path,
        w_px: usize,
        h_px: usize,
    ) -> Result<crate::render::raster::RasterImage> {
        // Unique per job, like the PDF path: no shared screenshot target,
        // no stale hand-offs between concurrent jobs.
        let job = uuid::Uuid::new_v4();
        let png_path = self.cache_dir.join(format!("shot-{job}.png"));

        let edge_path = find_edge("raster printing")?;
        let html_url = format!("file:///{}", html_path.to_string_lossy().replace('\\', "/"));

        // Persistent Edge first, as in `webview2_print_to_pdf`.
        if cdp::enabled() {
            let started = std::time::Instant::now();
            let cfg = cdp::Config::new(std::path::Path::new(&edge_path), &self.cache_dir);
            match cdp::shared()
                .screenshot(&cfg, &html_url, w_px as u32, h_px as u32)
                .await
            {
                Ok(bytes) => {
                    let edge_ms = started.elapsed().as_millis() as u64;
                    tokio::fs::write(&png_path, &bytes).await?;
                    crate::metrics::count_browser_render(true);
                    tracing::info!(edge_ms, persistent = true, "rendered screenshot with Edge");
                    let decoded = png_to_raster(&png_path);
                    debug_copy(png_path, self.cache_dir.join("last-render.png"), true);
                    return decoded.map_err(|e| anyhow!("screenshot decode: {e}"));
                }
                Err(e) => {
                    crate::metrics::count_browser_render(false);
                    tracing::warn!(
                        error = %e,
                        "persistent Edge could not render; using one-shot Edge"
                    )
                }
            }
        }

        let mut args: Vec<String> = [
            "--headless=new",
            "--disable-features=msEdgeStartupBoost",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            // 1 CSS px = 1 printer dot: the PNG comes out exactly the
            // label in dots — no HiDPI scaling, no scrollbar gutters.
            "--force-device-scale-factor=1",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--window-size={w_px},{h_px}"));
        args.push(format!("--screenshot={}", png_path.to_string_lossy()));
        args.push(html_url);

        let run = match edge::shared()
            .run(
                std::path::Path::new(&edge_path),
                &self.cache_dir,
                &args,
                &png_path,
            )
            .await
        {
            Ok(run) => run,
            Err(e) => {
                let _ = tokio::fs::remove_file(&png_path).await;
                return Err(e);
            }
        };

        if !(run.output.status.success() && png_path.exists()) {
            let stderr = String::from_utf8_lossy(&run.output.stderr);
            let _ = tokio::fs::remove_file(&png_path).await;
            return Err(anyhow!(
                "Edge screenshot did not produce a PNG (status {}, stderr: {})",
                run.output.status,
                stderr.trim()
            ));
        }
        tracing::info!(
            edge_ms = run.edge_ms,
            profile_cleanup_ms = run.cleanup_ms,
            warm_profile = run.warm,
            "rendered screenshot with Edge"
        );

        let raster = png_to_raster(&png_path).map_err(|e| anyhow!("screenshot decode: {e}"))?;

        // Keep the newest screenshot next to last-render.pdf for debugging;
        // the per-job file is removed either way.
        debug_copy(png_path, self.cache_dir.join("last-render.png"), true);
        Ok(raster)
    }
}

/// Executable names tried on Linux, in order, in every `PATH` directory.
#[cfg(target_os = "linux")]
const CHROMIUM_CANDIDATES: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "microsoft-edge",
    "microsoft-edge-stable",
];

/// Fixed absolute locations tried after the `PATH` scan: some layouts put
/// a Chromium browser outside `PATH` (the `.deb` binaries live in
/// `/opt` and `/usr/lib` with only a launcher symlink; snap installs to
/// `/snap/bin`, which minimal desktops may not carry in a service's PATH).
#[cfg(target_os = "linux")]
const CHROMIUM_ABSOLUTE_PATHS: &[&str] = &[
    "/opt/google/chrome/chrome",
    "/opt/google/chrome/google-chrome",
    "/usr/lib/chromium-browser/chromium.bin",
    "/usr/lib/chromium/chromium",
    "/usr/lib/microsoft-edge/msedge",
    "/snap/bin/chromium",
];

/// Where Edge is looked for on Windows.
#[cfg(windows)]
const EDGE_PATHS: [&str; 2] = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
];

/// Which Chromium-family browser prints on Linux: the
/// `PRINTNINJA_CHROMIUM_BIN` override (tests, containers with a
/// non-PATH browser), the user's choice (see `browser_choice`), then a
/// PATH scan over the known names. Missing everywhere is a loud error
/// naming what was tried, not a placeholder render.
#[cfg(target_os = "linux")]
fn find_chromium() -> Result<std::path::PathBuf> {
    let (choice, custom) = browser_choice::current_choice();
    resolve_browser(
        "PRINTNINJA_CHROMIUM_BIN",
        std::env::var_os("PRINTNINJA_CHROMIUM_BIN"),
        choice,
        custom.as_deref(),
        browser_download::ready_path(),
        &chromium_candidates(),
        "system Chromium",
        "printing",
    )
    .map(|r| r.path)
}

/// The known browser names expanded over `PATH` in PATH order, then the
/// fixed absolute locations: the Linux equivalent of Windows' fixed
/// `EDGE_PATHS`.
#[cfg(target_os = "linux")]
fn chromium_candidates() -> Vec<PathBuf> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(&path_var) {
        for name in CHROMIUM_CANDIDATES {
            let path = dir.join(name);
            if path.is_file() {
                out.push(path);
            }
        }
    }
    for name in CHROMIUM_ABSOLUTE_PATHS {
        let path = PathBuf::from(name);
        if path.is_file() {
            out.push(path);
        }
    }
    // The PATH scan and the fixed list can point at the same binary
    // (launcher symlink plus real file); keep the first hit per resolved
    // location so duplicates do not skew the resolution order.
    let mut seen = std::collections::HashSet::new();
    out.into_iter()
        .filter(|p| {
            let key = p.canonicalize().unwrap_or_else(|_| p.clone());
            seen.insert(key)
        })
        .collect()
}

/// Whether a system Chromium is available on Linux, for the startup health
/// check. The AppImage does not bundle a browser — printing fails with the
/// same message as `find_chromium` — so the app warns once at startup
/// instead of failing silently on the first print from an AppImage with no
/// browser installed.
#[cfg(target_os = "linux")]
pub fn check_chromium() -> Result<std::path::PathBuf, String> {
    find_chromium().map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
impl PdfRenderer {
    /// Headless Chromium `--print-to-pdf`, mirroring the Edge path above:
    /// unique output per job, debug copy at `last-render.pdf`, no output
    /// file left behind either way, stderr only surfaces on failure
    /// (Chromium logs dbus noise even on success).
    ///
    /// Sandboxing is kept whenever it works: `--no-sandbox` is added only
    /// as a one-shot retry when Chromium itself reports that running as
    /// root without it is unsupported (containers, services as root).
    async fn chromium_print_to_pdf(&self, html_path: &std::path::Path) -> Result<Vec<u8>> {
        let chromium = find_chromium()?;
        let html_url = format!("file://{}", html_path.display());

        // The persistent Chromium first: a tab opens, prints and closes.
        // Any failure there falls through to the one-shot path below, so
        // printing never depends on it.
        if cdp::enabled() {
            let started = std::time::Instant::now();
            let cfg = persistent_chromium_config(&chromium, &self.cache_dir);
            match cdp::shared().print_pdf(&cfg, &html_url).await {
                Ok(bytes) => {
                    crate::metrics::count_browser_render(true);
                    tracing::info!(
                        html = %html_url,
                        bytes = bytes.len(),
                        chromium_ms = started.elapsed().as_millis() as u64,
                        persistent = true,
                        "rendered PDF with Chromium"
                    );
                    // Debug copy, off the print's critical path.
                    let last = self.cache_dir.join("last-render.pdf");
                    let copy = bytes.clone();
                    tokio::spawn(async move {
                        let _ = tokio::fs::write(last, copy).await;
                    });
                    return Ok(bytes);
                }
                Err(e) => {
                    crate::metrics::count_browser_render(false);
                    tracing::warn!(
                        error = %e,
                        "persistent Chromium could not render; using one-shot Chromium"
                    )
                }
            }
        }

        let job = uuid::Uuid::new_v4();
        let pdf_path = self.cache_dir.join(format!("output-{job}.pdf"));

        let mut args: Vec<String> = [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--print-to-pdf-no-header",
            "--no-pdf-header-footer",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--print-to-pdf={}", pdf_path.to_string_lossy()));
        args.push(html_url.clone());

        let output = run_chromium(&chromium, &args).await?;
        if !(output.status.success() && pdf_path.exists()) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = tokio::fs::remove_file(&pdf_path).await;
            return Err(anyhow!(
                "Chromium print-to-pdf did not produce a PDF (status {}, stderr: {})",
                output.status,
                stderr.trim()
            ));
        }
        let bytes = tokio::fs::read(&pdf_path).await;
        let last = self.cache_dir.join("last-render.pdf");
        debug_copy(pdf_path, last.clone(), true);
        tracing::info!(
            html = %html_url,
            pdf = %last.display(),
            bytes = bytes.as_ref().map_or(0, |b| b.len()),
            "rendered PDF with Chromium"
        );
        bytes.map_err(Into::into)
    }

    /// Headless Chromium `--screenshot` at exactly `w_px`×`h_px`
    /// (1 CSS px = 1 printer dot), then the shared PNG thresholding.
    async fn chromium_screenshot(
        &self,
        html_path: &std::path::Path,
        w_px: usize,
        h_px: usize,
    ) -> Result<crate::render::raster::RasterImage> {
        let chromium = find_chromium()?;
        let html_url = format!("file://{}", html_path.display());

        // Persistent Chromium first, as in `chromium_print_to_pdf`.
        if cdp::enabled() {
            let started = std::time::Instant::now();
            let cfg = persistent_chromium_config(&chromium, &self.cache_dir);
            match cdp::shared()
                .screenshot(&cfg, &html_url, w_px as u32, h_px as u32)
                .await
            {
                Ok(bytes) => {
                    let chromium_ms = started.elapsed().as_millis() as u64;
                    let job = uuid::Uuid::new_v4();
                    let png_path = self.cache_dir.join(format!("shot-{job}.png"));
                    tokio::fs::write(&png_path, &bytes).await?;
                    crate::metrics::count_browser_render(true);
                    tracing::info!(
                        chromium_ms,
                        persistent = true,
                        "rendered screenshot with Chromium"
                    );
                    let decoded = png_to_raster(&png_path);
                    debug_copy(png_path, self.cache_dir.join("last-render.png"), true);
                    return decoded.map_err(|e| anyhow!("screenshot decode: {e}"));
                }
                Err(e) => {
                    crate::metrics::count_browser_render(false);
                    tracing::warn!(
                        error = %e,
                        "persistent Chromium could not render; using one-shot Chromium"
                    )
                }
            }
        }

        let job = uuid::Uuid::new_v4();
        let png_path = self.cache_dir.join(format!("shot-{job}.png"));

        let mut args: Vec<String> = [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--window-size={w_px},{h_px}"));
        args.push(format!("--screenshot={}", png_path.to_string_lossy()));
        args.push(html_url);

        let output = run_chromium(&chromium, &args).await?;
        if !(output.status.success() && png_path.exists()) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = tokio::fs::remove_file(&png_path).await;
            return Err(anyhow!(
                "Chromium screenshot did not produce a PNG (status {}, stderr: {})",
                output.status,
                stderr.trim()
            ));
        }
        tracing::info!("rendered screenshot with Chromium");
        let raster = png_to_raster(&png_path).map_err(|e| anyhow!("screenshot decode: {e}"))?;
        debug_copy(png_path, self.cache_dir.join("last-render.png"), true);
        Ok(raster)
    }
}

/// Config for the persistent Chromium: the system browser, the shared
/// cache dir, and `--no-sandbox` when running as root (containers,
/// services as root) — Chromium refuses the sandbox there, so without
/// the flag the persistent launch would fail exactly like the one-shot
/// launch does before its retry (see `run_chromium`).
#[cfg(target_os = "linux")]
fn persistent_chromium_config(
    chromium: &std::path::Path,
    cache_dir: &std::path::Path,
) -> cdp::Config {
    static ROOT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    // SAFETY: geteuid takes no arguments and cannot fail.
    let is_root = *ROOT.get_or_init(|| unsafe { libc::geteuid() } == 0);
    let mut cfg = cdp::Config::new(chromium, cache_dir);
    if is_root {
        cfg.extra_args.push("--no-sandbox".to_string());
    }
    cfg
}

/// Runs Chromium once, retrying unsandboxed a single time when Chromium
/// itself reports that running without `--no-sandbox` is unsupported.
/// Normal users stay sandboxed; root and AppArmor-locked runners (Ubuntu
/// 23.10+ with unprivileged user namespaces disabled) get one loud retry
/// instead of a dead queue.
#[cfg(target_os = "linux")]
async fn run_chromium(chromium: &std::path::Path, args: &[String]) -> Result<std::process::Output> {
    use tokio::process::Command;
    let output = Command::new(chromium).args(args).output().await?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("Running as root without --no-sandbox")
        || stderr.contains("No usable sandbox")
    {
        tracing::warn!(
            "Chromium sandbox unavailable ({}); retrying once with --no-sandbox",
            stderr.lines().next().unwrap_or("sandbox error")
        );
        let mut retry: Vec<String> = vec!["--no-sandbox".to_string()];
        retry.extend(args.iter().cloned());
        return Ok(Command::new(chromium).args(&retry).output().await?);
    }
    Ok(output)
}

/// The first few non-empty lines of a browser's stderr, joined for an
/// error message. `--enable-logging=stderr` is what makes headless Edge
/// emit real log lines at all (before it wrote nothing on failure); the
/// whole log would bury the message, so keep the first three lines.
#[cfg(windows)]
fn stderr_excerpt(stderr: &str) -> Option<String> {
    let joined = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ");
    (!joined.is_empty()).then_some(joined)
}

/// The result of browser resolution: the executable plus where it came
/// from, so the UI can say which browser will print (`"env"`, `"shell"`,
/// `"system"` or `"custom"`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedBrowser {
    pub path: PathBuf,
    pub source: &'static str,
}

/// Browser resolution order, shared by Windows (`find_edge`) and Linux
/// (`find_chromium`):
/// 1. the environment override (`PRINTNINJA_EDGE_BIN` /
///    `PRINTNINJA_CHROMIUM_BIN`) — an operator lever that always wins; a
///    set-but-missing override is a loud error, never a silent fall-back.
/// 2. the user's choice (see `browser_choice`): `Custom` uses the stored
///    path (missing = loud error), `System` skips the downloaded shell,
///    `Shell` requires it (missing = loud error), `Auto` prefers the
///    shell when it is on disk and falls through to the system browser.
///
/// `purpose` names the render in the error so the operator knows what
/// failed. Pure over its inputs so it is testable on any platform.
#[cfg(any(windows, target_os = "linux", test))]
fn resolve_browser(
    env_name: &'static str,
    env_override: Option<std::ffi::OsString>,
    choice: browser_choice::BrowserChoice,
    custom_path: Option<&str>,
    shell: Option<PathBuf>,
    candidates: &[PathBuf],
    system_name: &str,
    purpose: &str,
) -> Result<ResolvedBrowser> {
    if let Some(bin) = env_override {
        let path = PathBuf::from(&bin);
        if path.is_file() {
            return Ok(ResolvedBrowser {
                path,
                source: "env",
            });
        }
        return Err(anyhow!(
            "{env_name} points at {} which is not a file — \
             {purpose} cannot run without a browser",
            path.display()
        ));
    }
    match choice {
        browser_choice::BrowserChoice::Custom => {
            let raw = custom_path.filter(|p| !p.trim().is_empty()).ok_or_else(|| {
                anyhow!(
                    "the browser choice is set to a custom path, but no path is \
                     stored — {purpose} cannot guess; set the path in Settings or \
                     choose Automatic"
                )
            })?;
            let path = PathBuf::from(raw.trim());
            if !path.is_file() {
                return Err(anyhow!(
                    "the custom browser path {} is not a file — {purpose} cannot \
                     run without a browser; fix the path in Settings or choose Automatic",
                    path.display()
                ));
            }
            Ok(ResolvedBrowser {
                path,
                source: "custom",
            })
        }
        browser_choice::BrowserChoice::System => {
            first_candidate(candidates, system_name, purpose)
        }
        browser_choice::BrowserChoice::Shell => match shell.filter(|p| p.is_file()) {
            Some(path) => Ok(ResolvedBrowser {
                path,
                source: "shell",
            }),
            None => Err(anyhow!(
                "the downloaded headless browser is not installed, but the browser \
                 choice requires it — {purpose} cannot run without it; download it in \
                 Settings → Diagnostics or choose Automatic"
            )),
        },
        browser_choice::BrowserChoice::Auto => match shell.filter(|p| p.is_file()) {
            Some(path) => Ok(ResolvedBrowser {
                path,
                source: "shell",
            }),
            None => first_candidate(candidates, system_name, purpose),
        },
    }
}

#[cfg(any(windows, target_os = "linux", test))]
fn first_candidate(
    candidates: &[PathBuf],
    system_name: &str,
    purpose: &str,
) -> Result<ResolvedBrowser> {
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .map(|path| ResolvedBrowser {
            path,
            source: "system",
        })
        .ok_or_else(|| {
            anyhow!(
                "{system_name} not found (looked in {}) — {purpose} needs \
                 a browser; the job cannot print without it",
                candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

#[cfg(windows)]
pub(crate) fn find_edge(purpose: &str) -> Result<PathBuf> {
    let (choice, custom) = browser_choice::current_choice();
    let candidates: Vec<PathBuf> = EDGE_PATHS.iter().map(PathBuf::from).collect();
    resolve_browser(
        "PRINTNINJA_EDGE_BIN",
        std::env::var_os("PRINTNINJA_EDGE_BIN"),
        choice,
        custom.as_deref(),
        browser_download::ready_path(),
        &candidates,
        "Microsoft Edge",
        purpose,
    )
    .map(|r| r.path)
}

/// Whether this machine has the browser the renderer needs, for the UI.
///
/// Windows prints through Edge (`msedge.exe`), Linux through a system
/// Chromium-family browser; neither ships in the installer (Windows can
/// opt into the downloaded headless shell — see `browser_download`). When
/// it is missing the UI
/// shows a modal with the exact steps to fix it, instead of the first print
/// failing with a one-line error. Platforms that never render locally
/// (Android buys every render from a paired PC) report `available: true`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RenderEngineStatus {
    /// `"windows"`, `"linux"` or `"other"`.
    pub platform: &'static str,
    pub available: bool,
    /// The browser that will be used, when one was found.
    pub path: Option<String>,
    /// Where it came from: `"env"` (override variable), `"shell"`
    /// (downloaded headless browser), `"system"` (Edge / system
    /// Chromium) or `"custom"` (user-stored path).
    pub source: Option<&'static str>,
    /// Every place or name that was tried, for the "what was checked" list.
    pub searched: Vec<String>,
    /// Linux only: `ID` and `ID_LIKE` from `/etc/os-release`, lowercase, so
    /// the UI can show the right package manager.
    pub distro: Vec<String>,
    /// Linux only: `PRETTY_NAME`, shown in the modal.
    pub distro_name: Option<String>,
    /// Linux only: running from an AppImage (which never bundles a browser).
    pub appimage: bool,
}

pub fn render_engine_status() -> RenderEngineStatus {
    #[cfg(windows)]
    {
        let (choice, custom) = browser_choice::current_choice();
        let candidates: Vec<PathBuf> = EDGE_PATHS.iter().map(PathBuf::from).collect();
        // The same resolution a real render would run, so the "what will
        // print" the UI shows is what a print will actually use.
        let resolved = resolve_browser(
            "PRINTNINJA_EDGE_BIN",
            std::env::var_os("PRINTNINJA_EDGE_BIN"),
            choice,
            custom.as_deref(),
            browser_download::ready_path(),
            &candidates,
            "Microsoft Edge",
            "PDF rendering",
        )
        .ok();
        // The whole resolution order, not just the install paths: the env
        // override (when set) and the downloaded shell (when present) can
        // be what actually prints, and the UI should show that.
        let mut searched = Vec::new();
        if std::env::var_os("PRINTNINJA_EDGE_BIN").is_some() {
            searched.push("PRINTNINJA_EDGE_BIN (if set)".to_string());
        }
        if choice == browser_choice::BrowserChoice::Custom {
            if let Some(p) = custom.as_deref().filter(|p| !p.trim().is_empty()) {
                searched.push(p.trim().to_string());
            }
        } else {
            if let Some(shell) = browser_download::ready_path() {
                searched.push(shell.display().to_string());
            }
            searched.extend(EDGE_PATHS.iter().map(|p| p.to_string()));
        }
        RenderEngineStatus {
            platform: "windows",
            available: resolved.is_some(),
            path: resolved.as_ref().map(|r| r.path.display().to_string()),
            source: resolved.as_ref().map(|r| r.source),
            searched,
            distro: Vec::new(),
            distro_name: None,
            appimage: false,
        }
    }
    #[cfg(target_os = "linux")]
    {
        let (choice, custom) = browser_choice::current_choice();
        let resolved = resolve_browser(
            "PRINTNINJA_CHROMIUM_BIN",
            std::env::var_os("PRINTNINJA_CHROMIUM_BIN"),
            choice,
            custom.as_deref(),
            browser_download::ready_path(),
            &chromium_candidates(),
            "system Chromium",
            "PDF rendering",
        )
        .ok();
        let mut searched = Vec::new();
        if std::env::var_os("PRINTNINJA_CHROMIUM_BIN").is_some() {
            searched.push("PRINTNINJA_CHROMIUM_BIN (if set)".to_string());
        }
        if choice == browser_choice::BrowserChoice::Custom {
            if let Some(p) = custom.as_deref().filter(|p| !p.trim().is_empty()) {
                searched.push(p.trim().to_string());
            }
        } else {
            if let Some(shell) = browser_download::ready_path() {
                searched.push(shell.display().to_string());
            }
            searched.extend(CHROMIUM_CANDIDATES.iter().map(|n| n.to_string()));
        }
        let (distro, distro_name) = linux_distro();
        RenderEngineStatus {
            platform: "linux",
            available: resolved.is_some(),
            path: resolved.as_ref().map(|r| r.path.display().to_string()),
            source: resolved.as_ref().map(|r| r.source),
            searched,
            distro,
            distro_name,
            appimage: std::env::var_os("APPIMAGE").is_some(),
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        RenderEngineStatus {
            platform: "other",
            available: true,
            path: None,
            source: None,
            searched: Vec::new(),
            distro: Vec::new(),
            distro_name: None,
            appimage: false,
        }
    }
}

/// `(ID + ID_LIKE, PRETTY_NAME)` of the running distribution.
#[cfg(target_os = "linux")]
fn linux_distro() -> (Vec<String>, Option<String>) {
    parse_os_release(&std::fs::read_to_string("/etc/os-release").unwrap_or_default())
}

#[cfg(any(target_os = "linux", test))]
fn parse_os_release(text: &str) -> (Vec<String>, Option<String>) {
    let mut ids = Vec::new();
    let mut pretty = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        match key.trim() {
            "ID" => ids.insert(0, value.to_lowercase()),
            "ID_LIKE" => ids.extend(value.split_whitespace().map(str::to_lowercase)),
            "PRETTY_NAME" => pretty = Some(value.to_string()),
            _ => {}
        }
    }
    (ids, pretty)
}

/// Start headless Edge once, in the background, so the first real print does
/// not pay for Edge's start-up.
///
/// The persistent Edge (`cdp.rs`) is started and primed with one page; only if
/// that fails is the one-shot launcher's reusable profile warmed instead.
///
/// Call from app setup after `sweep_leftover_edge_profiles` and **before the
/// worker spawns**: the profile is claimed synchronously here, and a job that
/// arrives while the warm-up runs waits for it (bounded) instead of building a
/// cold throwaway profile. Never blocks startup and never fails it: if Edge is
/// missing or the warm-up fails, it is logged and the first job falls back to
/// the old behaviour.
#[cfg(windows)]
pub fn warm_up_edge(cache_dir: PathBuf) {
    let Ok(edge_path) = find_edge("warm-up") else {
        tracing::warn!("Edge not found; skipping warm-up");
        return;
    };
    let Some(claim) = edge::shared().claim_warm_up() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let id = uuid::Uuid::new_v4();
        let html = cache_dir.join(format!("warmup-{id}.html"));
        let pdf = cache_dir.join(format!("warmup-{id}.pdf"));
        if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
            tracing::warn!(error = %e, "Edge warm-up: cache dir unavailable");
            return;
        }
        // Text, an @page rule and a web font family exercise the same paths
        // a label does, so font and print-pipeline set-up happen here too.
        let doc = "<!doctype html><html><head><meta charset=\"utf-8\">\
                   <style>@page{size:50mm 30mm;margin:0}\
                   body{font-family:Arial,sans-serif;font-size:12px}</style></head>\
                   <body>PrintNinja warm-up 0123456789</body></html>";
        if tokio::fs::write(&html, doc).await.is_err() {
            return;
        }
        let url = format!("file:///{}", html.to_string_lossy().replace('\\', "/"));

        // Preferred: start the persistent Edge and print one page through
        // it, which also warms its renderer, fonts and print pipeline. Then
        // the one-shot profile is not needed unless a render falls back.
        if cdp::enabled() {
            let cfg = cdp::Config::new(std::path::Path::new(&edge_path), &cache_dir);
            let started = std::time::Instant::now();
            let primed = match cdp::shared().start(&cfg).await {
                Ok(()) => cdp::shared().print_pdf(&cfg, &url).await.map(|_| ()),
                Err(e) => Err(e),
            };
            match primed {
                Ok(()) => {
                    tracing::info!(
                        warm_up_ms = started.elapsed().as_millis() as u64,
                        "persistent Edge is running and warm"
                    );
                    let _ = tokio::fs::remove_file(&html).await;
                    return; // `claim` drops: the one-shot profile stays free.
                }
                Err(e) => tracing::warn!(
                    error = %e,
                    "persistent Edge did not start; warming one-shot Edge instead"
                ),
            }
        }
        // Same switches as `webview2_print_to_pdf`, so the same code paths load.
        let mut args: Vec<String> = [
            "--headless=new",
            "--disable-features=msEdgeStartupBoost",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--print-to-pdf-no-header",
            "--no-pdf-header-footer",
            "--enable-logging=stderr",
        ]
        .iter()
        .map(|a| a.to_string())
        .collect();
        args.push(format!("--print-to-pdf={}", pdf.to_string_lossy()));
        args.push(url);
        claim
            .run(std::path::Path::new(&edge_path), &cache_dir, &args, &pdf)
            .await;
        let _ = tokio::fs::remove_file(&html).await;
    });
}

/// Start headless Chromium once, in the background, so the first real print
/// does not pay for its start-up.
///
/// The persistent Chromium (`cdp.rs`) is started and primed with one page.
/// There is no one-shot profile to fall back to — a one-shot Chromium is
/// stateless — so a failed start just logs and the first job starts the
/// browser itself.
///
/// Call from app setup **before the worker spawns**. Never blocks startup
/// and never fails it: if Chromium is missing or the warm-up fails, the
/// first job falls back to one-shot Chromium.
#[cfg(target_os = "linux")]
pub fn warm_up_chromium(cache_dir: PathBuf) {
    let Ok(chromium) = find_chromium() else {
        tracing::warn!("no system Chromium found; skipping warm-up");
        return;
    };
    tauri::async_runtime::spawn(async move {
        let id = uuid::Uuid::new_v4();
        let html = cache_dir.join(format!("warmup-{id}.html"));
        if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
            tracing::warn!(error = %e, "Chromium warm-up: cache dir unavailable");
            return;
        }
        // Text, an @page rule and a web font family exercise the same paths
        // a label does, so font and print-pipeline set-up happen here too.
        let doc = "<!doctype html><html><head><meta charset=\"utf-8\">\
                   <style>@page{size:50mm 30mm;margin:0}\
                   body{font-family:Arial,sans-serif;font-size:12px}</style></head>\
                   <body>PrintNinja warm-up 0123456789</body></html>";
        if tokio::fs::write(&html, doc).await.is_err() {
            return;
        }
        let url = format!("file://{}", html.display());

        // Start the persistent Chromium and print one page through it,
        // which also warms its renderer, fonts and print pipeline.
        if cdp::enabled() {
            let cfg = persistent_chromium_config(&chromium, &cache_dir);
            let started = std::time::Instant::now();
            let primed = match cdp::shared().start(&cfg).await {
                Ok(()) => cdp::shared().print_pdf(&cfg, &url).await.map(|_| ()),
                Err(e) => Err(e),
            };
            match primed {
                Ok(()) => tracing::info!(
                    warm_up_ms = started.elapsed().as_millis() as u64,
                    "persistent Chromium is running and warm"
                ),
                Err(e) => tracing::warn!(
                    error = %e,
                    "persistent Chromium did not start; first print will start it"
                ),
            }
        }
        let _ = tokio::fs::remove_file(&html).await;
    });
}

/// Close the persistent Chromium. Called once when the app exits: the handle
/// is a `static`, so nothing drops it, and a Chromium left running would keep
/// its profile locked for the next start.
#[cfg(target_os = "linux")]
pub fn shutdown_chromium() {
    tauri::async_runtime::block_on(cdp::shared().shutdown());
}

/// Close the persistent Edge. Called once when the app exits: the handle is a
/// `static`, so nothing drops it, and an Edge left running would keep its
/// profile locked for the next start.
#[cfg(windows)]
pub fn shutdown_edge() {
    tauri::async_runtime::block_on(cdp::shared().shutdown());
}

/// Startup sweep: remove throwaway Edge profiles — and the retired
/// `edge-cdp-profile` name — left behind by earlier runs (P17 follow-up — the
/// stray `.pem` next to `last-render.pdf`).
///
/// A print that cannot use the reusable `edge-warm-profile` makes a fresh
/// `edge-profile-{uuid}` dir and removes it after the render (with retries —
/// see `edge.rs`). A run killed mid-render still leaves its profile in the
/// cache dir, certificate-transparency material included, which looked like
/// the app had written a key file. The reusable profile is not swept: keeping
/// it is the point.
///
/// Called once from app setup **before the worker spawns**, so nothing in
/// flight owns these directories. `min_age` guards the one remaining race —
/// a second app instance starting while a render runs: profiles are seconds
/// old during a render, crashed leftovers are not.
pub fn sweep_leftover_edge_profiles(dir: &std::path::Path, min_age: std::time::Duration) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Cache dir does not exist yet (first run) — nothing to sweep.
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Throwaway one-shot profiles, plus the retired name of the
        // persistent profile (renamed to `browser-cdp-profile` when Linux
        // support landed — the active one is never swept).
        // `browser-cdp-profile-<id>` are the fresh profiles the persistent
        // browser falls back to when the main one is in use; the main
        // `browser-cdp-profile` itself is never swept.
        if name != "edge-cdp-profile"
            && !name.starts_with("edge-profile-")
            && !name.starts_with("browser-cdp-profile-")
        {
            continue;
        }
        // Unknown age → leave it alone; only clearly stale profiles go.
        let Some(age) = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
        else {
            continue;
        };
        if age < min_age {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => tracing::info!(
                dir = name,
                age_secs = age.as_secs(),
                "removed an Edge profile left behind by an earlier run"
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::warn!(dir = name, error = %e, "could not remove a leftover Edge profile")
            }
        }
    }
}

/// Decode a screenshot PNG and threshold it to 1-bit dots.
///
/// `EXPAND | STRIP_16` normalises every colour type to 8 bits. Text is
/// anti-aliased grey, so a midpoint threshold turns dark pixels into dots.
/// Rows are walked via `line_size`, so any row padding is respected.
///
/// Pure PNG logic. The Windows print path calls it, the Linux
/// screenshot path calls it, and the unit tests exercise it on every
/// platform.
#[cfg(any(windows, target_os = "linux", test))]
fn png_to_raster(path: &std::path::Path) -> Result<crate::render::raster::RasterImage> {
    use crate::render::raster::RasterImage;

    let file = std::fs::File::open(path)?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf)?;

    let width = info.width as usize;
    let height = info.height as usize;
    let line = info.line_size;

    let mut gray = vec![0u8; width * height];
    for y in 0..height {
        let row = &buf[y * line..];
        for x in 0..width {
            let lum = match info.color_type {
                png::ColorType::Grayscale => row[x],
                png::ColorType::GrayscaleAlpha => row[x * 2],
                png::ColorType::Rgb | png::ColorType::Rgba => {
                    let step = if info.color_type == png::ColorType::Rgba {
                        4
                    } else {
                        3
                    };
                    let (r, g, b) = (row[x * step], row[x * step + 1], row[x * step + 2]);
                    (0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)).round()
                        as u8
                }
                other => return Err(anyhow!("unexpected PNG colour type {other:?}")),
            };
            gray[y * width + x] = lum;
        }
    }

    let mut raster = RasterImage::new(width, height);
    raster.threshold(&gray, width, height, 128);
    Ok(raster)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode pixel data as a PNG file, as Edge's `--screenshot` would.
    fn write_png(
        dir: &std::path::Path,
        color: png::ColorType,
        width: u32,
        height: u32,
        data: &[u8],
    ) -> std::path::PathBuf {
        let path = dir.join(format!("shot-{}.png", uuid::Uuid::new_v4()));
        let mut encoder = png::Encoder::new(std::fs::File::create(&path).unwrap(), width, height);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(data)
            .unwrap();
        path
    }

    /// Startup sweep: only `edge-profile-*` dirs (and the retired
    /// `edge-cdp-profile` name) go, and only when they are old enough — a
    /// fresh one may belong to a render in flight (e.g. a second app
    /// instance starting mid-print).
    #[test]
    fn os_release_gives_the_distro_family() {
        let (ids, name) = parse_os_release(
            "NAME=\"Linux Mint\"\nPRETTY_NAME=\"Linux Mint 22\"\nID=linuxmint\nID_LIKE=\"ubuntu debian\"\n",
        );
        assert_eq!(ids, ["linuxmint", "ubuntu", "debian"]);
        assert_eq!(name.as_deref(), Some("Linux Mint 22"));
        assert_eq!(parse_os_release(""), (Vec::new(), None));
    }

    #[test]
    fn resolve_browser_respects_the_choice_order() {
        use browser_choice::BrowserChoice as C;
        let dir = std::env::temp_dir().join(format!("pn-resolve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let override_bin = dir.join("override.exe");
        let shell = dir.join("chrome-headless-shell.exe");
        let candidate = dir.join("msedge.exe");
        for p in [&override_bin, &shell, &candidate] {
            std::fs::write(p, b"").unwrap();
        }
        let candidates = vec![candidate.clone()];

        // A valid override wins over every choice.
        for choice in [C::Auto, C::System, C::Shell, C::Custom] {
            let r = resolve_browser(
                "PRINTNINJA_EDGE_BIN",
                Some(override_bin.as_os_str().to_os_string()),
                choice,
                Some("/custom/path"),
                Some(shell.clone()),
                &candidates,
                "Microsoft Edge",
                "test render",
            )
            .unwrap();
            assert_eq!(
                r,
                ResolvedBrowser {
                    path: override_bin.clone(),
                    source: "env"
                }
            );
        }
        // A set-but-missing override is a loud error, not a silent fallback.
        let err = resolve_browser(
            "PRINTNINJA_EDGE_BIN",
            Some(dir.join("nope.exe").as_os_str().to_os_string()),
            C::Auto,
            None,
            Some(shell.clone()),
            &candidates,
            "Microsoft Edge",
            "test render",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("PRINTNINJA_EDGE_BIN"), "{err}");
        assert!(err.contains("not a file"), "{err}");
        // Auto: a shell on disk beats the system browser; a missing shell
        // falls through to it.
        assert_eq!(
            resolve_browser(
                "PRINTNINJA_EDGE_BIN",
                None,
                C::Auto,
                None,
                Some(shell.clone()),
                &candidates,
                "Microsoft Edge",
                "test render"
            )
            .unwrap(),
            ResolvedBrowser {
                path: shell.clone(),
                source: "shell"
            }
        );
        assert_eq!(
            resolve_browser(
                "PRINTNINJA_EDGE_BIN",
                None,
                C::Auto,
                None,
                Some(dir.join("absent.exe")),
                &candidates,
                "Microsoft Edge",
                "test render"
            )
            .unwrap(),
            ResolvedBrowser {
                path: candidate.clone(),
                source: "system"
            }
        );
        // System: the downloaded shell is skipped even when it is on disk.
        assert_eq!(
            resolve_browser(
                "PRINTNINJA_EDGE_BIN",
                None,
                C::System,
                None,
                Some(shell.clone()),
                &candidates,
                "Microsoft Edge",
                "test render"
            )
            .unwrap(),
            ResolvedBrowser {
                path: candidate.clone(),
                source: "system"
            }
        );
        // Shell: requires the download; a missing one is a loud error.
        assert_eq!(
            resolve_browser(
                "PRINTNINJA_EDGE_BIN",
                None,
                C::Shell,
                None,
                Some(shell.clone()),
                &candidates,
                "Microsoft Edge",
                "test render"
            )
            .unwrap(),
            ResolvedBrowser {
                path: shell.clone(),
                source: "shell"
            }
        );
        let err = resolve_browser(
            "PRINTNINJA_EDGE_BIN",
            None,
            C::Shell,
            None,
            None,
            &candidates,
            "Microsoft Edge",
            "test render",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("not installed"), "{err}");
        // Custom: the stored path wins; missing or unset are loud errors.
        assert_eq!(
            resolve_browser(
                "PRINTNINJA_EDGE_BIN",
                None,
                C::Custom,
                Some(candidate.to_str().unwrap()),
                None,
                &candidates,
                "Microsoft Edge",
                "test render"
            )
            .unwrap(),
            ResolvedBrowser {
                path: candidate.clone(),
                source: "custom"
            }
        );
        let err = resolve_browser(
            "PRINTNINJA_EDGE_BIN",
            None,
            C::Custom,
            Some(dir.join("nope.exe").to_str().unwrap()),
            None,
            &candidates,
            "Microsoft Edge",
            "test render",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("not a file"), "{err}");
        let err = resolve_browser(
            "PRINTNINJA_EDGE_BIN",
            None,
            C::Custom,
            None,
            None,
            &candidates,
            "Microsoft Edge",
            "test render",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("no path is stored"), "{err}");
        // Nothing anywhere: the error names every place that was searched.
        let err = resolve_browser(
            "PRINTNINJA_EDGE_BIN",
            None,
            C::Auto,
            None,
            None,
            &[],
            "Microsoft Edge",
            "test render",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("Microsoft Edge not found"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_startup_sweep_only_takes_stale_edge_profiles() {
        let dir = std::env::temp_dir().join(format!("pn-sweep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("edge-profile-crashed")).unwrap();
        std::fs::write(dir.join("edge-profile-crashed").join("junk.pem"), b"cert").unwrap();
        std::fs::create_dir_all(dir.join("edge-profile-live")).unwrap();
        std::fs::create_dir_all(dir.join("edge-cdp-profile")).unwrap();
        // The active persistent profile is never swept, whatever its age.
        std::fs::create_dir_all(dir.join("browser-cdp-profile")).unwrap();
        // ...but the fresh fallback profiles of a crashed run are stale.
        std::fs::create_dir_all(dir.join("browser-cdp-profile-1a2b3c4d")).unwrap();
        // Content is irrelevant to the sweep; deliberately not a PDF header
        // magic: `print_correctness`'s P5 tripwire greps this whole file and
        // only placeholder-PDF bytes may not appear in it.
        std::fs::write(dir.join("last-render.pdf"), b"render artifact").unwrap();

        // Younger than an hour: may belong to a running render — keep them all.
        sweep_leftover_edge_profiles(&dir, std::time::Duration::from_secs(60 * 60));
        assert!(dir.join("edge-profile-crashed").exists());
        assert!(dir.join("edge-profile-live").exists());
        assert!(dir.join("edge-cdp-profile").exists());

        // No age limit: the stale profiles go — junk `.pem` with them —
        // and everything that is not an Edge profile stays put.
        sweep_leftover_edge_profiles(&dir, std::time::Duration::ZERO);
        assert!(!dir.join("edge-profile-crashed").exists());
        assert!(!dir.join("edge-profile-live").exists());
        assert!(!dir.join("edge-cdp-profile").exists());
        assert!(dir.join("browser-cdp-profile").exists());
        assert!(!dir.join("browser-cdp-profile-1a2b3c4d").exists());
        assert!(dir.join("last-render.pdf").exists());

        // A cache dir that does not exist yet (first run) is a no-op.
        sweep_leftover_edge_profiles(&dir.join("missing"), std::time::Duration::ZERO);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P4: the decode path a Windows print takes — a screenshot PNG becomes
    /// exactly the thresholded dots, at the screenshot's own size.
    #[test]
    fn an_rgb_screenshot_becomes_thresholded_dots() {
        let dir = std::env::temp_dir();
        // 2×1: black then white — the two ends of the midpoint cut.
        let path = write_png(&dir, png::ColorType::Rgb, 2, 1, &[0, 0, 0, 255, 255, 255]);
        let raster = png_to_raster(&path).expect("decode");
        let _ = std::fs::remove_file(&path);

        assert_eq!((raster.width, raster.height), (2, 1));
        assert!(raster.get_bit(0, 0), "black must become a dot");
        assert!(!raster.get_bit(1, 0), "white must stay blank");
    }

    /// Every colour type Edge might hand back (post-`EXPAND`) is handled,
    /// including the alpha variants, whose alpha must not darken anything.
    #[test]
    fn grayscale_and_alpha_screenshots_decode() {
        let dir = std::env::temp_dir();

        // Grayscale: 64 → dot, 200 → no dot.
        let path = write_png(&dir, png::ColorType::Grayscale, 2, 1, &[64, 200]);
        let raster = png_to_raster(&path).expect("decode gray");
        let _ = std::fs::remove_file(&path);
        assert!(raster.get_bit(0, 0) && !raster.get_bit(1, 0));

        // GrayscaleAlpha: the opaque/d transparent second pixels decide by
        // luminance only — full transparency must not flip the other way.
        let path = write_png(
            &dir,
            png::ColorType::GrayscaleAlpha,
            2,
            1,
            &[64, 255, 200, 0],
        );
        let raster = png_to_raster(&path).expect("decode gray+alpha");
        let _ = std::fs::remove_file(&path);
        assert!(raster.get_bit(0, 0) && !raster.get_bit(1, 0));

        // RGBA: red-ish text is *dark* under the luminance weights
        // (0.299·200 + 0.587·50 + 0.114·50 ≈ 95 < 128), so it prints.
        let path = write_png(
            &dir,
            png::ColorType::Rgba,
            2,
            1,
            &[200, 50, 50, 255, 255, 255, 255, 0],
        );
        let raster = png_to_raster(&path).expect("decode rgba");
        let _ = std::fs::remove_file(&path);
        assert!(
            raster.get_bit(0, 0),
            "coloured text must threshold to a dot"
        );
        assert!(!raster.get_bit(1, 0));
    }

    /// Cross-language contract (PLAN §4): Android thresholds on the device
    /// (`dotsFromArgb` in `AndroidPrintPlugin.kt`), desktop thresholds here
    /// (`png_to_raster` + `RasterImage::threshold`). Both must produce the
    /// same bytes for the same pixels, or the same label prints differently
    /// depending on which device rendered it. The same 8×1 row is pinned to
    /// `0xAD` in the Kotlin `RasterDotsTest` golden; a drift on either side
    /// fails one of the two tests.
    ///
    /// The row, left to right: (0,0,0)→dot, (255,255,255)→no,
    /// (127,127,127)→dot, (128,128,128)→no (exactly at the `< 128` cut),
    /// (200,100,50)→dot (lum 124.2), (199,99,49)→dot (lum 123.2),
    /// (250,250,250)→no, (10,10,10)→dot. Dots at x = {0,2,4,5,7} → 0xAD.
    #[test]
    fn raster_threshold_matches_the_kotlin_contract() {
        use crate::render::raster::RasterImage;

        let row: [(u8, u8, u8); 8] = [
            (0, 0, 0),
            (255, 255, 255),
            (127, 127, 127),
            (128, 128, 128),
            (200, 100, 50),
            (199, 99, 49),
            (250, 250, 250),
            (10, 10, 10),
        ];

        // The Rust side, exactly as png_to_raster computes it.
        let gray: Vec<u8> = row
            .iter()
            .map(|&(r, g, b)| {
                (0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)).round() as u8
            })
            .collect();
        let mut raster = RasterImage::new(8, 1);
        raster.threshold(&gray, 8, 1, 128);
        assert_eq!(raster.to_bytes(), vec![0xAD]);

        // Through the real decode path too, so a PNG colour-handling
        // change is caught as well as a threshold change.
        let rgb: Vec<u8> = row.iter().flat_map(|&(r, g, b)| [r, g, b]).collect();
        let dir = std::env::temp_dir();
        let path = write_png(&dir, png::ColorType::Rgb, 8, 1, &rgb);
        let via_png = png_to_raster(&path).expect("decode");
        let _ = std::fs::remove_file(&path);
        assert_eq!(via_png.to_bytes(), vec![0xAD]);
    }

    /// The Android file→raster path validates its size before use: a
    /// truncated or corrupted dots file must fail, not print.
    #[test]
    fn from_packed_rejects_a_byte_count_that_fits_no_row() {
        use crate::render::raster::RasterImage;

        // 10 dots wide → 2 bytes per row.
        assert!(RasterImage::from_packed(10, 1, vec![0xAD; 2]).is_some());
        assert!(RasterImage::from_packed(10, 1, vec![0xAD; 1]).is_none());
        assert!(RasterImage::from_packed(10, 1, vec![0xAD; 3]).is_none());
        // 8 dots wide → 1 byte per row.
        assert!(RasterImage::from_packed(8, 2, vec![0xAD, 0xFF]).is_some());
        // A multiple-of-eight width: no padding bytes may be smuggled in.
        assert!(RasterImage::from_packed(8, 2, vec![0xAD, 0xFF, 0x00]).is_none());
    }

    /// Linux Chromium selection and the root retry, behind a fake
    /// browser: a shell script that refuses without `--no-sandbox`
    /// (Chromium's real root error on stderr, exit 2) and otherwise
    /// writes the `--print-to-pdf` target. One test body so the env
    /// override cannot race parallel tests.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn chromium_override_and_root_retry() {
        use std::os::unix::fs::PermissionsExt;

        // A missing override is a loud error, not a silent render.
        std::env::set_var(
            "PRINTNINJA_CHROMIUM_BIN",
            "/nonexistent/chromium-for-printninja",
        );
        assert!(find_chromium().is_err());
        // An override must point at a file: a directory is refused.
        std::env::set_var("PRINTNINJA_CHROMIUM_BIN", "/tmp");
        assert!(find_chromium().is_err());

        let dir = std::env::temp_dir().join(format!("pn-chromium-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("chromium");
        // Refuses sandboxed (exit 2 + the real root message), renders
        // unsandboxed by writing the requested PDF target.
        // Octal \045 is "%": the P5 tripwire scans this file for a PDF
        // magic literal, so spell the bytes without writing one.
        std::fs::write(
            &fake,
            "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    --no-sandbox) UNSANDBOXED=1 ;;\n    --print-to-pdf=*) OUT=\"${a#--print-to-pdf=}\" ;;\n  esac\ndone\nif [ -z \"$UNSANDBOXED\" ]; then echo 'Running as root without --no-sandbox is not supported.' >&2; exit 2; fi\nprintf '\\045PDF-1.4 fake\\n' > \"$OUT\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("PRINTNINJA_CHROMIUM_BIN", &fake);
        assert_eq!(find_chromium().unwrap(), fake);

        let renderer = PdfRenderer::new(dir.clone());
        let bytes = renderer
            .html_to_pdf("<html><body>x</body></html>", 100.0, 150.0, "portrait")
            .await
            .expect("fake chromium renders");
        // Byte-built magic: the P5 tripwire test in
        // tests/print_correctness.rs scans this file for a PDF magic
        // literal, so the four bytes are spelled out instead.
        assert!(
            bytes.starts_with(&[0x25, 0x50, 0x44, 0x46]),
            "must be the fake's PDF"
        );

        // A hard failure (exit 1, no root message) stays a failure:
        // the retry is only for the sandbox refusal.
        std::fs::write(&fake, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(renderer
            .html_to_pdf("<html><body>x</body></html>", 100.0, 150.0, "portrait")
            .await
            .is_err());

        // A browser that cannot host the persistent tab (exits at once,
        // publishes no DevTools port) falls back to the one-shot path:
        // the fake renders --print-to-pdf but dies on anything else.
        // Octal \045 is "%": spelled out for the P5 tripwire, as above.
        std::fs::write(
            &fake,
            "#!/bin/sh\nfor a in \"$@\"; do\n  case \"$a\" in\n    --print-to-pdf=*) OUT=\"${a#--print-to-pdf=}\" ;;\n  esac\ndone\nif [ -n \"$OUT\" ]; then printf '\\045PDF-1.4 fake\\n' > \"$OUT\"; else exit 1; fi\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("PRINTNINJA_CHROMIUM_BIN", &fake);
        let bytes = renderer
            .html_to_pdf("<html><body>x</body></html>", 100.0, 150.0, "portrait")
            .await
            .expect("one-shot fallback renders");
        assert!(
            bytes.starts_with(&[0x25, 0x50, 0x44, 0x46]),
            "must be the fake's PDF"
        );
        // The persistent attempt created its profile dir before failing.
        assert!(
            dir.join(crate::render::cdp::PERSISTENT_PROFILE_DIR)
                .exists(),
            "the persistent browser was tried first"
        );

        std::env::remove_var("PRINTNINJA_CHROMIUM_BIN");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
