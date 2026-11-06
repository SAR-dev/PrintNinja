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
    /// The kill was verified against the process table. When false, at
    /// least one `msedge.exe` survived the repair's kill rounds — the UI
    /// must say so, because a new headless launch will hand off to it.
    pub edge_verified_dead: bool,
    /// How many taskkill rounds the verification loop used (0 = no kill
    /// was attempted).
    pub edge_kill_rounds: u32,
    /// Render profiles removed from the cache dir.
    pub profiles_removed: Vec<String>,
    /// The persistent-browser connection and failure cooldown were reset.
    pub cooldown_reset: bool,
    /// The test render produced a real PDF.
    pub test_render_ok: bool,
    pub test_render_error: Option<String>,
    /// PrintNinja itself is running elevated (administrator). While this
    /// is true Edge will not print at all, so the repair cannot succeed
    /// — the UI must say so and point at a normal restart instead of
    /// implying a broken pipeline.
    pub elevated: bool,
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

/// Locale-proof process-table check for any image name: `tasklist` prints
/// a line per matching process naming the image, and its "no tasks" line
/// (in any locale) never does.
pub fn tasklist_names(stdout: &str, image: &str) -> bool {
    stdout.to_ascii_lowercase().contains(&image.to_ascii_lowercase())
}

#[cfg(windows)]
pub(crate) fn processes_running(image: &str) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {image}")])
        .output()
        .map(|o| tasklist_names(&String::from_utf8_lossy(&o.stdout), image))
        .unwrap_or(false)
}

#[cfg(windows)]
pub(crate) fn edge_processes_running() -> bool {
    processes_running("msedge.exe")
}

/// Kill the image and verify by re-reading the process table, tolerating
/// respawns (Edge's startup boost can relaunch `msedge.exe` right after
/// a kill). `kill` and `is_dead` are injected so the loop is testable off
/// Windows. Returns `(verified_dead, rounds_used)`; the final check runs
/// even after the last round, so a kill that landed late still counts.
async fn kill_until_dead(
    kill: impl Fn() + Send,
    is_dead: impl Fn() -> bool + Send,
    pause: std::time::Duration,
    max_rounds: u32,
) -> (bool, u32) {
    for round in 1..=max_rounds {
        kill();
        tokio::time::sleep(pause).await;
        if is_dead() {
            return (true, round);
        }
    }
    (is_dead(), max_rounds)
}

#[cfg(windows)]
async fn kill_edge_verified() -> (bool, u32) {
    // ~7.5 s worst case: 15 rounds of (kill, 500 ms, verify).
    kill_until_dead(
        || {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", "msedge.exe"])
                .status();
        },
        || !processes_running("msedge.exe"),
        std::time::Duration::from_millis(500),
        15,
    )
    .await
}

#[cfg(windows)]
pub async fn run(cache_dir: &Path, close_edge: bool) -> anyhow::Result<FixReport> {
    // 1. Edge — the same lookup the renderer itself uses.
    let edge_path = super::find_edge("the print repair").ok();
    let mut report = FixReport {
        edge_found: edge_path.is_some(),
        edge_path: edge_path.as_ref().map(|p| p.display().to_string()),
        edge_was_running: false,
        edge_closed: false,
        edge_verified_dead: true,
        edge_kill_rounds: 0,
        profiles_removed: Vec::new(),
        cooldown_reset: false,
        test_render_ok: false,
        test_render_error: None,
        elevated: super::elevation::is_elevated(),
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
        report.edge_closed = true;
        // A single taskkill loses to respawns (Edge startup boost can
        // relaunch msedge.exe mid-repair), so kill in rounds and verify
        // each against the process table before trusting the result.
        let (verified, rounds) = kill_edge_verified().await;
        report.edge_verified_dead = verified;
        report.edge_kill_rounds = rounds;
        tracing::info!(
            verified,
            rounds,
            "closed running Edge for the print repair (verified)"
        );
        if !verified {
            // Be honest up front: while msedge.exe survives, a new
            // headless launch will hand off to it and the test render
            // below would only re-prove the failure.
            report.test_render_error = Some(format!(
                "Edge could not be stopped after {rounds} rounds of \
                 taskkill — msedge.exe is still running. Close every Edge \
                 window (including background tasks), then run the repair \
                 again. Or download the headless browser, which prints \
                 fine while Edge stays open."
            ));
        }
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
    //
    // Skip the proof when it cannot succeed: Edge survived the kill
    // rounds and the render would use msedge.exe, which hands off to the
    // surviving session. (A downloaded headless shell is unaffected, so
    // when the resolved browser is not msedge.exe the proof still runs.)
    if report.edge_closed
        && !report.edge_verified_dead
        && edge_path
            .as_ref()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n == "msedge.exe")
    {
        return Ok(report);
    }
    let renderer = super::PdfRenderer::new(cache_dir.to_path_buf());
    match renderer
        .html_to_pdf(TEST_HTML, 100.0, 150.0, "portrait")
        .await
    {
        Ok(bytes) if bytes.len() >= 4 && bytes[0..4] == *b"%PDF" => {
            report.test_render_ok = true;
        }
        // The render came back without a real PDF.
        other => {
            report.test_render_error = Some(if report.elevated {
                // Edge will not print from an elevated parent, so the test
                // render failing is the expected outcome — name that, and
                // that the repair cannot succeed until the app is
                // restarted normally. The kill, verification and profile
                // removal above still ran; the report says so field by
                // field.
                format!(
                    "{} The repair cannot succeed while PrintNinja is \
                     elevated — restart it normally, then run the repair \
                     again.",
                    super::elevation::ELEVATED_ERROR
                )
            } else {
                match other {
                    Err(e) => e.to_string(),
                    Ok(_) => {
                        "Edge handed the print job to a running Edge session \
                         (exit 0, no PDF) — close all Edge windows and run \
                         the repair again"
                            .to_string()
                    }
                }
            });
        }
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

    #[test]
    fn tasklist_match_is_generic_over_the_image_name() {
        assert!(tasklist_names(
            "Image Name                     PID SESSION\nchrome-headless-shell.exe 999 Console\n",
            "chrome-headless-shell.exe"
        ));
        assert!(!tasklist_names(
            "INFO: No tasks are running which match the specified criteria.\n",
            "chrome-headless-shell.exe"
        ));
    }

    /// Kill rounds stop the moment the process table agrees.
    #[tokio::test]
    async fn kill_loop_stops_as_soon_as_the_image_is_gone() {
        let kills = std::sync::atomic::AtomicU32::new(0);
        let (verified, rounds) = kill_until_dead(
            || {
                let _ = kills.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
            || kills.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            std::time::Duration::from_millis(1),
            15,
        )
        .await;
        assert!(verified);
        assert_eq!(rounds, 2);
    }

    /// A respawn-proofed kill loop must report honestly when the image
    /// never dies: (false, MAX_ROUNDS), not a silent success.
    #[tokio::test]
    async fn kill_loop_reports_failure_when_the_image_never_dies() {
        let (verified, rounds) = kill_until_dead(
            || {},
            || false,
            std::time::Duration::from_millis(1),
            15,
        )
        .await;
        assert!(!verified);
        assert_eq!(rounds, 15);
    }

    /// A kill that lands just after the last round still counts — the
    /// final verification runs once more before giving up.
    #[tokio::test]
    async fn kill_loop_counts_a_late_kill_on_the_final_check() {
        let checks = std::sync::atomic::AtomicU32::new(0);
        let (verified, rounds) = kill_until_dead(
            || {},
            || {
                checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
                    == 16 // 15 in-loop checks, then the final one
            },
            std::time::Duration::from_millis(1),
            15,
        )
        .await;
        assert!(verified);
        assert_eq!(rounds, 15);
    }
}
