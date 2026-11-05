//! One-click repair for the Windows print pipeline.
//!
//! The failure mode this exists for: Edge exits 0 without producing a
//! PDF — a headless launch that hands off to an already-running Edge or
//! lands in a stale/locked render profile. The log shows a 500 and a
//! stderr-less exit code; nothing tells the operator to close Edge.
//! The repair does exactly what that log hints at:
//!
//! 1. locate Edge (the same paths the renderer uses),
//! 2. close the running `msedge.exe` processes (only when the UI got the
//!    user's confirmation — `close_edge`),
//! 3. remove the stale render profiles from the cache dir,
//! 4. reset the persistent-browser cooldown and dead connection,
//! 5. prove the pipeline with a real test render.
//!
//! Windows only: the handoff failure is an Edge-on-Windows symptom. On
//! other platforms [`run`] reports that plainly instead of pretending.

use serde::Serialize;
use std::path::Path;

/// Render profile entries in the cache dir. Kept in sync with
/// `edge::WARM_PROFILE_DIR`, `cdp::PERSISTENT_PROFILE_DIR` (including the
/// fresh `…-<8 hex>` retry suffix) and the throwaway prefix in `edge.rs`.
const WARM_PROFILE: &str = "edge-warm-profile";
const PERSISTENT_PROFILE_PREFIX: &str = "browser-cdp-profile";
const THROWAWAY_PREFIX: &str = "edge-profile-";

/// Whether a cache-dir entry is one of the app's render profiles.
pub fn is_render_profile(name: &str) -> bool {
    name == WARM_PROFILE
        || name.starts_with(PERSISTENT_PROFILE_PREFIX)
        || name.starts_with(THROWAWAY_PREFIX)
}

/// What the repair did, one field per step, for the settings page.
#[derive(Debug, Clone, Serialize)]
pub struct FixReport {
    /// Edge was found in one of the known install locations.
    pub edge_found: bool,
    pub edge_path: Option<String>,
    /// At least one `msedge.exe` process was running when it started.
    pub edge_was_running: bool,
    /// The repair closed the running Edge processes (`close_edge` was set).
    pub edge_closed: bool,
    /// Render profiles removed from the cache dir.
    pub profiles_removed: Vec<String>,
    /// The persistent-browser connection and failure cooldown were reset.
    pub cooldown_reset: bool,
    /// The test render produced a real PDF.
    pub test_render_ok: bool,
    pub test_render_error: Option<String>,
}

/// The document the test render prints: one page, the size the pipeline
/// is told to render, nothing that depends on app state. Windows-only,
/// with the repair itself.
#[cfg(windows)]
const TEST_HTML: &str = concat!(
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">",
    "<style>@page { size: 100mm 150mm; margin: 0; }",
    " body { margin: 0; font-family: sans-serif; }</style>",
    "</head><body><p>PrintNinja test render</p></body></html>"
);

/// `tasklist /FI "IMAGENAME eq msedge.exe"` prints one line per matching
/// process naming the image; when nothing matches it prints only a "no
/// tasks" line that never names the image. Locale-proof: only the image
/// name is matched.
pub fn tasklist_says_running(stdout: &str) -> bool {
    stdout.to_ascii_lowercase().contains("msedge.exe")
}

#[cfg(windows)]
fn edge_processes_running() -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", r"IMAGENAME eq msedge.exe"])
        .output()
        .map(|o| tasklist_says_running(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}

#[cfg(windows)]
pub async fn run(cache_dir: &Path, close_edge: bool) -> anyhow::Result<FixReport> {
    // 1. Edge — the same lookup the renderer itself uses.
    let edge_path = super::find_edge("the print repair").ok();
    let mut report = FixReport {
        edge_found: edge_path.is_some(),
        edge_path: edge_path.map(str::to_owned),
        edge_was_running: false,
        edge_closed: false,
        profiles_removed: Vec::new(),
        cooldown_reset: false,
        test_render_ok: false,
        test_render_error: None,
    };
    if edge_path.is_none() {
        // Nothing to repair: the install notice already names the fix
        // (install Edge), and the test render would only fail again.
        return Ok(report);
    }

    // 2./3. Close the running Edge first: its open files are exactly what
    // would make the profile removal below fail, and a live browser is
    // the thing a new headless launch hands off to. This also closes the
    // app's own persistent (headless) browser — the cdp handle is reset
    // in the next step and the next render starts a fresh one.
    report.edge_was_running = edge_processes_running();
    if report.edge_was_running && close_edge {
        let status = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "msedge.exe"])
            .status();
        tracing::info!(?status, "closed running Edge for the print repair");
        // Give the killed processes a moment to release their profile locks.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        report.edge_closed = true;
    }

    // 4. Drop the app's persistent-browser handle (closing it politely if
    // it is somehow still alive) and clear the failure cooldown, so the
    // next render retries the persistent path immediately.
    super::cdp::shared().reset().await;
    report.cooldown_reset = true;

    // 5. Stale profiles: the warm one-shot, the persistent CDP (including
    // fresh-retry suffixes) and any leftover throwaways.
    if let Ok(mut rd) = tokio::fs::read_dir(cache_dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_render_profile(&name) {
                continue;
            }
            match tokio::fs::remove_dir_all(entry.path()).await {
                Ok(()) => report.profiles_removed.push(name),
                Err(e) => {
                    tracing::warn!(
                        profile = %name,
                        error = %e,
                        "print repair: could not remove render profile"
                    );
                }
            }
        }
    }

    // 6. The proof: the real pipeline, a real render. Success is a
    // document that starts with a PDF header, not just an exit code —
    // the exit-0-with-no-PDF handoff is exactly what this repair exists
    // for.
    let renderer = super::PdfRenderer::new(cache_dir.to_path_buf());
    match renderer
        .html_to_pdf(TEST_HTML, 100.0, 150.0, "portrait")
        .await
    {
        Ok(bytes) if bytes.len() >= 4 && bytes[0..4] == *b"%PDF" => {
            report.test_render_ok = true;
        }
        Ok(_) => {
            report.test_render_error = Some(
                "Edge exited but did not return a PDF (the handoff symptom) — \
             close every Edge window and try again"
                    .into(),
            )
        }
        Err(e) => report.test_render_error = Some(e.to_string()),
    }
    Ok(report)
}

#[cfg(not(windows))]
pub async fn run(_cache_dir: &Path, _close_edge: bool) -> anyhow::Result<FixReport> {
    Err(anyhow::anyhow!(
        "the print repair is only available on Windows \
         (the Edge handoff failure it fixes does not exist here)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_every_render_profile_name() {
        assert!(is_render_profile("edge-warm-profile"));
        assert!(is_render_profile("browser-cdp-profile"));
        assert!(is_render_profile("browser-cdp-profile-1a2b3c4d"));
        assert!(is_render_profile("edge-profile-9f8e7d6c"));
    }

    #[test]
    fn ignores_everything_else_in_the_cache_dir() {
        assert!(!is_render_profile("last-render.pdf"));
        assert!(!is_render_profile("last-render.html"));
        assert!(!is_render_profile("output-1234.pdf"));
        assert!(!is_render_profile("render-5678.html"));
        assert!(!is_render_profile("edge"));
        assert!(!is_render_profile("browser-cdp"));
    }

    #[test]
    fn tasklist_output_is_matched_on_the_image_name_only() {
        assert!(tasklist_says_running(
            "Image Name                     PID SESSION\nmsedge.exe                 1234 Console\n"
        ));
        assert!(tasklist_says_running(
            "MSEdge.exe                 1234 Console\n"
        ));
        // The "no tasks" line (any locale) never names the image.
        assert!(!tasklist_says_running(
            "INFO: No tasks are running which match the specified criteria.\n"
        ));
        assert!(!tasklist_says_running(""));
    }
}
