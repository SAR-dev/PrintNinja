//! Headless browser renderer — the html document track (plan §5.3).
//!
//! One-shot `--print-to-pdf` against the desktop OS's own browser
//! (Edge on Windows, Chromium/Chrome on Linux): write the document to
//! a temporary file, let the browser print it to a temporary PDF, and
//! hand back the PDF's bytes. No persistent browser, no CDP, no
//! downloaded binary — std only.
//!
//! Like the rest of the core, failures are honest: when no browser is
//! found, when the launch fails, when the document takes too long, or
//! when the browser exits without a PDF, the error says what happened
//! in plain words (with the browser's own stderr excerpt) rather than
//! substituting a placeholder.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long one document may take before the render is abandoned and
/// the browser killed.
pub const RENDER_DEADLINE: Duration = Duration::from_secs(60);

/// The document could not be rendered to a PDF.
#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    /// No browser binary was found anywhere.
    #[error("no headless browser found (searched: {searched})")]
    NoBrowser {
        /// Every location checked, for the user to act on.
        searched: String,
    },
    /// The browser process could not be started (or could not be
    /// waited on).
    #[error("the browser could not be started: {0}")]
    Launch(String),
    /// The render outlived [`RENDER_DEADLINE`].
    #[error("the browser took more than {0} s to print the document")]
    Deadline(u64),
    /// The browser exited, but no usable PDF came out.
    #[error("the browser did not produce a PDF (exit: {status}): {detail}")]
    NoPdf {
        /// How the process ended, in plain words.
        status: String,
        /// The browser's own stderr, excerpted.
        detail: String,
    },
    /// Filesystem trouble around the temporary files.
    #[error("io: {0}")]
    Io(String),
}

/// Find the browser to print with: an explicit path first (the app
/// passes a downloaded Chromium here), then the `PRINTNINJA_BROWSER`
/// environment override, then the system's own locations.
pub fn find_browser_with(explicit: Option<&Path>) -> Result<PathBuf, BrowserError> {
    let override_ = match explicit {
        Some(p) => Some(p.to_string_lossy().into_owned()),
        None => std::env::var("PRINTNINJA_BROWSER")
            .ok()
            .filter(|s| !s.trim().is_empty()),
    };
    let (found, searched) = resolve(override_.as_deref(), &candidates());
    found.ok_or(BrowserError::NoBrowser {
        searched: searched.join("; "),
    })
}

/// The environment override, as the app's default choice.
pub fn find_browser() -> Result<PathBuf, BrowserError> {
    find_browser_with(None)
}

/// The installed browsers the app can offer in Settings.
pub fn system_browsers() -> Vec<PathBuf> {
    candidates().into_iter().filter(|p| p.is_file()).collect()
}

/// The system browser locations, in preference order.
fn candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        dedup(&[
            PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
            PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        ])
    }
    #[cfg(not(windows))]
    {
        let mut found = Vec::new();
        if let Ok(path) = std::env::var("PATH") {
            found.extend(path_candidates(&path));
        }
        found.extend(
            [
                "/opt/google/chrome/chrome",
                "/opt/google/chrome/google-chrome",
                "/usr/lib/chromium-browser/chromium.bin",
                "/usr/lib/chromium/chromium",
                "/usr/lib/microsoft-edge/msedge",
                "/snap/bin/chromium",
            ]
            .iter()
            .map(PathBuf::from),
        );
        dedup(&found)
    }
}

/// The browser names found on each `PATH` entry.
#[cfg(not(windows))]
fn path_candidates(path_var: &str) -> Vec<PathBuf> {
    const NAMES: [&str; 6] = [
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "microsoft-edge",
        "microsoft-edge-stable",
    ];
    std::env::split_paths(path_var)
        .flat_map(|dir| NAMES.iter().map(move |name| dir.join(name)))
        .collect()
}

/// Drop duplicates that resolve to the same file (PATH entries often
/// repeat, and a name may be a symlink to an earlier candidate).
fn dedup(candidates: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for c in candidates {
        let key = c.canonicalize().unwrap_or_else(|_| c.clone());
        if seen.insert(key) {
            out.push(c.clone());
        }
    }
    out
}

/// The first candidate that exists; every location checked, so a
/// `NoBrowser` error can show the user exactly where to look.
fn resolve(override_path: Option<&str>, candidates: &[PathBuf]) -> (Option<PathBuf>, Vec<String>) {
    let mut searched = Vec::new();
    if let Some(o) = override_path {
        let p = PathBuf::from(o);
        searched.push(p.display().to_string());
        if p.is_file() {
            return (Some(p), searched);
        }
    }
    for c in candidates {
        searched.push(c.display().to_string());
        if c.is_file() {
            return (Some(c.clone()), searched);
        }
    }
    (None, searched)
}

/// Print one document to a PDF and hand back the PDF's bytes.
///
/// `work_dir` holds the temporary HTML, PDF and stderr files; they are
/// removed whether or not the render worked.
pub fn render_pdf(html: &str, work_dir: &Path) -> Result<Vec<u8>, BrowserError> {
    render_pdf_with(html, work_dir, None)
}

/// As [`render_pdf`], with a chosen browser path (a managed download).
pub fn render_pdf_with(
    html: &str,
    work_dir: &Path,
    browser: Option<&Path>,
) -> Result<Vec<u8>, BrowserError> {
    let browser = find_browser_with(browser)?;
    fs::create_dir_all(work_dir).map_err(|e| BrowserError::Io(e.to_string()))?;
    let html_path = work_dir.join("job.html");
    let pdf_path = work_dir.join("job.pdf");
    let stderr_path = work_dir.join("job.stderr");
    fs::write(&html_path, html).map_err(|e| BrowserError::Io(e.to_string()))?;
    if pdf_path.exists() {
        fs::remove_file(&pdf_path).map_err(|e| BrowserError::Io(e.to_string()))?;
    }

    let stderr_file =
        fs::File::create(&stderr_path).map_err(|e| BrowserError::Io(e.to_string()))?;
    // stderr goes to a file, not a pipe: a chatty browser must never be
    // able to fill the pipe and hang the render.
    let mut child = Command::new(&browser)
        .args(print_args(&pdf_path, &file_url(&html_path), work_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| BrowserError::Launch(e.to_string()))?;

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) => {
                if started.elapsed() > RENDER_DEADLINE {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(BrowserError::Deadline(RENDER_DEADLINE.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => break Err(BrowserError::Launch(e.to_string())),
        }
    };
    let stderr = fs::read_to_string(&stderr_path).unwrap_or_default();
    let clean = |path: &Path| {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    };
    let result = match status {
        Ok(s) if s.success() => match fs::read(&pdf_path) {
            Ok(bytes) if looks_like_pdf(&bytes) => Ok(bytes),
            Ok(_) => Err(BrowserError::NoPdf {
                status: "exit 0".into(),
                detail: format!("the output file is not a PDF ({})", stderr_excerpt(&stderr)),
            }),
            Err(_) => Err(BrowserError::NoPdf {
                status: "exit 0".into(),
                detail: format!(
                    "the browser exited without writing a PDF ({})",
                    stderr_excerpt(&stderr)
                ),
            }),
        },
        Ok(s) => Err(BrowserError::NoPdf {
            status: s
                .code()
                .map(|c| format!("exit {c}"))
                .unwrap_or_else(|| "killed".into()),
            detail: stderr_excerpt(&stderr),
        }),
        Err(e) => Err(e),
    };
    clean(&html_path);
    clean(&pdf_path);
    clean(&stderr_path);
    let profile = work_dir.join("profile");
    if profile.exists() {
        let _ = fs::remove_dir_all(&profile);
    }
    result
}

/// The one-shot print-to-pdf command line.
fn print_args(pdf_path: &Path, html_url: &str, work_dir: &Path) -> Vec<String> {
    // A fresh profile per job avoids a running browser taking over the
    // request (Edge startup boost), and the background services are
    // switched off so the one-shot print starts and finishes quickly.
    let profile = work_dir.join("profile");
    let mut args = vec![
        "--headless=new".to_string(),
        "--disable-gpu".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-component-update".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-extensions".to_string(),
        "--disable-sync".to_string(),
        "--mute-audio".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--print-to-pdf-no-header".to_string(),
        "--no-pdf-header-footer".to_string(),
    ];
    // Edge-specific: a startup-boost Edge hands the job to a running
    // session and prints nothing; logging to stderr is how that
    // handoff shows up in the failure detail.
    #[cfg(windows)]
    {
        args.push("--disable-features=msEdgeStartupBoost".to_string());
        args.push("--enable-logging=stderr".to_string());
    }
    args.push(format!("--print-to-pdf={}", pdf_path.display()));
    args.push(html_url.to_string());
    args
}

/// The `file://` URL of a local document, in the form the browser
/// wants (forward slashes on Windows).
fn file_url(path: &Path) -> String {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy().replace('\\', "/");
        format!("file:///{s}")
    }
    #[cfg(not(windows))]
    {
        format!("file://{}", path.display())
    }
}

/// Whether these bytes are a PDF (the `%PDF-` magic).
fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.len() >= 5 && bytes.starts_with(b"%PDF-")
}

/// The tail of a browser's stderr, capped: the interesting part of a
/// one-shot failure (a handoff to a running session, a sandbox refusal)
/// is at the end, and the error is read by a human.
fn stderr_excerpt(stderr: &str) -> String {
    let t = stderr.trim();
    if t.is_empty() {
        return "(no output)".to_string();
    }
    let mut start = t.len().saturating_sub(300);
    while !t.is_char_boundary(start) {
        start += 1;
    }
    if start > 0 {
        format!("…{}", &t[start..])
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pdf_magic_is_recognized() {
        assert!(looks_like_pdf(b"%PDF-1.7\n%binary"));
        assert!(!looks_like_pdf(b"PDF-1.7"));
        assert!(!looks_like_pdf(b""));
        assert!(!looks_like_pdf(b"<html></html>"));
    }

    #[test]
    fn stderr_excerpts_keep_the_tail_and_never_split_a_char() {
        assert_eq!(stderr_excerpt(""), "(no output)");
        assert_eq!(stderr_excerpt("  boom  "), "boom");
        let long = "a".repeat(500);
        let e = stderr_excerpt(&long);
        assert!(e.starts_with('…'));
        assert_eq!(e.chars().count(), 301);
        // A multibyte tail must not be sliced mid-character: the cap is
        // in bytes, so a wide tail yields fewer characters, never a
        // panic or a broken rune.
        let jp = "ア".repeat(200);
        let e = stderr_excerpt(&jp);
        assert!(e.starts_with('…'));
        assert!(e.chars().count() <= 301);
        assert!(e.chars().count() >= 101);
    }

    #[test]
    fn the_print_args_carry_the_document_and_the_output_path() {
        let pdf = Path::new("/tmp/work/job.pdf");
        let args = print_args(pdf, "file:///tmp/work/job.html", Path::new("/tmp/work"));
        assert!(args.contains(&"--headless=new".to_string()));
        assert!(args.contains(&"--no-pdf-header-footer".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--print-to-pdf=")));
        assert_eq!(*args.last().unwrap(), "file:///tmp/work/job.html");
        assert!(args.iter().any(|a| a == "--disable-background-networking"));
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
        // The output path in the flag is the exact file we will read.
        assert!(args
            .iter()
            .any(|a| a == &format!("--print-to-pdf={}", pdf.display())));
    }

    #[test]
    fn the_file_url_is_a_file_url_of_the_path() {
        // A real path on this platform: forward slashes in the URL
        // (Windows: `file:///C:/…`, Unix: `file:///…`).
        let p = std::env::temp_dir().join("job.html");
        let url = file_url(&p);
        let expected = if cfg!(windows) {
            format!("file:///{}", p.to_string_lossy().replace('\\', "/"))
        } else {
            format!("file://{}", p.display())
        };
        assert_eq!(url, expected);
        assert!(!url.contains('\\'));
        assert!(url.ends_with("job.html"));
    }

    #[test]
    fn resolve_picks_the_first_existing_location_and_lists_the_rest() {
        let dir = std::env::temp_dir().join(format!("pn-browser-resolve-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("nope");
        let present = dir.join("yes");
        fs::write(&present, b"x").unwrap();
        let none = PathBuf::from("/definitely/none");
        // The first existing candidate wins; the search stops there.
        let (found, _) = resolve(None, &[missing.clone(), present.clone(), none.clone()]);
        assert_eq!(found.as_deref(), Some(present.as_path()));
        // The override wins when it exists.
        let (found, _) = resolve(Some(present.to_str().unwrap()), &[]);
        assert_eq!(found.as_deref(), Some(present.as_path()));
        // Nothing found: every location checked — override and
        // candidates alike — is named, so the error can show where to
        // look.
        let (found, searched) =
            resolve(Some(missing.to_str().unwrap()), std::slice::from_ref(&none));
        assert!(found.is_none());
        assert_eq!(
            searched,
            vec![missing.display().to_string(), none.display().to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn path_candidates_follows_the_path_variable() {
        let dir = std::env::temp_dir().join(format!("pn-browser-path-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cands = path_candidates(&dir.display().to_string());
        assert_eq!(cands.len(), 6, "one candidate per name");
        assert!(cands
            .iter()
            .any(|c| c.file_name() == Some("chromium".as_ref())));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedup_keeps_one_per_file() {
        let dir = std::env::temp_dir().join(format!("pn-browser-dedup-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("browser");
        fs::write(&f, b"x").unwrap();
        let out = dedup(&[f.clone(), f.clone(), PathBuf::from("/definitely/none")]);
        // The missing one stays (it cannot canonicalize to a duplicate),
        // the two copies of the same file collapse to one.
        assert_eq!(out.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
