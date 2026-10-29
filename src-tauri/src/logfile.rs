//! File logging with size-based rotation.
//!
//! `tracing-appender` only rotates by time; prints need files kept small
//! by size instead, so this module owns a tiny appender: each file is
//! capped at [`MAX_BYTES_PER_FILE`], and at most [`MAX_FILES`] files are
//! kept (the live `printninja.log` plus numbered history). Rotation is
//! structural — enforced on every write — so a crash cannot grow the
//! directory past the cap, and there is no cleanup job to forget.
//!
//! Both the writer and the reader ([`read_recent_logs`], used by the
//! Diagnostics download) agree on the layout below. Log at the same
//! filter as stdout; a logging failure must never fail a print, so
//! every I/O error here degrades to dropping bytes, loudly in the
//! Directory-open path and silently past it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Live file name inside the log directory.
pub const LIVE_NAME: &str = "printninja.log";
/// Bytes that fit in one file before it rotates.
pub const MAX_BYTES_PER_FILE: u64 = 512 * 1024;
/// Files kept, live included: `printninja.log` plus `.1` (newest) up to
/// `.N-1`. Worst case on disk is files × bytes (about 2.5 MiB default).
pub const MAX_FILES: usize = 5;
/// Upper bound for one viewer/export read, so a huge directory cannot
/// turn into a huge IPC payload.
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

fn numbered(dir: &Path, n: usize) -> PathBuf {
    if n == 0 {
        dir.join(LIVE_NAME)
    } else {
        dir.join(format!("{LIVE_NAME}.{n}"))
    }
}

/// Append-only writer with size rotation. Clone shares one file behind a
/// mutex, which is how the tracing layer hands it out per event; pair it
/// with `tracing_appender::non_blocking` so rotation I/O never runs on a
/// print path.
#[derive(Clone, Debug)]
pub struct SizeRotatingWriter {
    inner: Arc<Mutex<WriterState>>,
}

#[derive(Debug)]
struct WriterState {
    dir: PathBuf,
    file: Option<std::fs::File>,
    bytes: u64,
}

impl SizeRotatingWriter {
    /// Open (creating) the log directory and the live file in append
    /// mode, resuming its current size so a restart does not reset the
    /// budget mid-file.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let live = numbered(dir, 0);
        let bytes = std::fs::metadata(&live).map(|m| m.len()).unwrap_or(0);
        // Touch the file so the directory is never empty after a first run.
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&live)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(WriterState {
                dir: dir.to_path_buf(),
                file: None,
                bytes,
            })),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WriterState> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            // A logging lock must never panic a print: carry on with the
            // guard as-is. The bytes counter may be stale, which only
            // delays one rotation.
            poisoned.into_inner()
        })
    }
}

impl Write for SizeRotatingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let mut state = self.lock();
        // Best-effort throughout: a failed append drops these bytes rather
        // than failing the caller (a print). The handle is dropped on
        // error so the next event reopens; rotation state only advances
        // on bytes actually accepted.
        if state.file.is_none() {
            state.file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(numbered(&state.dir, 0))
                .ok();
        }
        if let Some(file) = state.file.as_mut() {
            if file.write_all(buf).is_ok() {
                state.bytes += buf.len() as u64;
                if state.bytes > MAX_BYTES_PER_FILE {
                    state.file = None;
                    rotate_files(&state.dir);
                    state.bytes = 0;
                }
            } else {
                state.file = None;
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut state = self.lock();
        if let Some(file) = state.file.as_mut() {
            let _ = file.flush();
        }
        Ok(())
    }
}

/// Shift history down and start a fresh live file: delete the oldest
/// past the cap, rename `.k` to `.k+1` from the top down, rename live
/// to `.1`. Every step is best-effort; a half-finished rotation leaves
/// at most one extra file, reaped on the next rotation.
fn rotate_files(dir: &Path) {
    if MAX_FILES <= 1 {
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(numbered(dir, 0));
        return;
    }
    let _ = std::fs::remove_file(numbered(dir, MAX_FILES - 1));
    for k in (1..MAX_FILES - 1).rev() {
        let _ = std::fs::rename(numbered(dir, k), numbered(dir, k + 1));
    }
    let _ = std::fs::rename(numbered(dir, 0), numbered(dir, 1));
}

/// Build the process subscriber: stdout plus the size-rotated file,
/// under one shared filter. Called once, first in app setup (the file
/// layer needs the app log directory, which only exists once the app
/// handle does). A second call is a no-op — tracing globals set once —
/// so tests and hot reload never panic here.
pub fn init_logging(app: &tauri::AppHandle) {
    use tauri::Manager;
    use tracing_subscriber::Layer as _;
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

    let filter = tracing_subscriber::EnvFilter::from_default_env()
        .add_directive("printninja_lib=info".parse().unwrap());

    let stdout = tracing_subscriber::fmt::layer().with_filter(filter.clone());

    // Resolve the directory first: both the file layer and the panic
    // hook below need it, and a panic must be recorded even if the
    // tracing layer itself never starts.
    let dir = app.path().app_log_dir().ok();
    if let Some(dir) = &dir {
        install_panic_hook(dir);
    }

    let file_layer = match dir.as_deref() {
        Some(dir) => match SizeRotatingWriter::open(dir) {
            Ok(writer) => {
                let (writer, guard) = tracing_appender::non_blocking(writer);
                // Process lifetime (run() never returns while the app is
                // up): the worker flushes as it goes; forgetting only
                // skips the final join at process exit.
                std::mem::forget(guard);
                Some(
                    tracing_subscriber::fmt::layer()
                        .with_writer(writer)
                        .with_ansi(false)
                        .with_filter(filter),
                )
            }
            Err(e) => {
                eprintln!("printninja: file logging unavailable ({e}); stdout only");
                None
            }
        },
        None => {
            eprintln!("printninja: no log directory; stdout only");
            None
        }
    };

    let registry = tracing_subscriber::registry().with(stdout);
    match file_layer {
        Some(layer) => {
            let _ = registry.with(layer).try_init();
        }
        None => {
            let _ = registry.try_init();
        }
    }
}

/// Route Rust panics into the log file. Without this a panic goes to
/// stderr only — invisible in GUI apps and absent from the file log —
/// so a crashing print leaves exactly the silent gap this closes.
/// Best-effort and recursion-safe: the hook never panics itself, never
/// blocks on a lock, and the stock hook still runs first, so nothing
/// that used to be visible is lost.
fn install_panic_hook(dir: &Path) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    let dir = dir.to_path_buf();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            previous(info);
            let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
            let line = format!("{stamp}  PANIC: {info}\n");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(LIVE_NAME))
            {
                use std::io::Write as _;
                let _ = file.write_all(line.as_bytes());
            }
        }));
    });
}

/// Read up to `max_bytes` of recent logs for the viewer/export, oldest
/// first so the text reads chronologically. Newest files fill the budget
/// first; a cut chunk drops its leading partial line. Anything unreadable
/// is skipped, never an error — an empty directory reads as empty text.
pub fn read_recent_logs(dir: &Path, max_bytes: u64) -> String {
    let budget = max_bytes.min(MAX_READ_BYTES) as usize;
    if budget == 0 {
        return String::new();
    }
    // Newest first: live, .1, .2, ...; keep while budget lasts.
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut used = 0usize;
    for n in 0..MAX_FILES {
        if used >= budget {
            break;
        }
        let Ok(bytes) = std::fs::read(numbered(dir, n)) else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let take = (budget - used).min(bytes.len());
        let mut chunk = bytes[bytes.len() - take..].to_vec();
        if take < bytes.len() {
            // Cut mid-file: drop the leading partial line.
            if let Some(at) = chunk.iter().position(|&b| b == b'\n') {
                chunk.drain(..=at);
            } else {
                chunk.clear();
            }
        }
        used += chunk.len();
        chunks.push(chunk);
    }
    // Oldest first for reading.
    chunks.reverse();
    let mut out = Vec::with_capacity(used);
    for chunk in &chunks {
        out.extend_from_slice(chunk);
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pn-logfile-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line(n: usize) -> Vec<u8> {
        format!("log line {n:05} with some padding to reach a stable width....\n").into_bytes()
    }

    #[test]
    fn rotation_caps_files_and_keeps_the_newest() {
        let dir = tempdir("rotate");
        let mut w = SizeRotatingWriter::open(&dir).unwrap();
        // Well past five budgets: the set must sit at the cap, having
        // rotated repeatedly. (Line ~65 B; budgets need volume.)
        let per_budget = (MAX_BYTES_PER_FILE / line(0).len() as u64) as usize + 1;
        let mut last = 0usize;
        for _ in 0..8 {
            for _ in 0..per_budget {
                w.write_all(&line(last)).unwrap();
                last += 1;
            }
        }
        // Trailing writes past the final rotation: budget-sized rounds
        // land exactly on rotation boundaries, so without these the last
        // rotation would leave no live file behind (lazy reopen).
        for _ in 0..100 {
            w.write_all(&line(last)).unwrap();
            last += 1;
        }
        w.flush().unwrap();
        // Cap respected: live + history, nothing else.
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        files.sort();
        assert_eq!(files.len(), MAX_FILES, "rotated set: {files:?}");
        assert!(files.contains(&LIVE_NAME.to_string()));
        // Newest content survived: the tail holds the last line written,
        // the first line is long evicted.
        let text = read_recent_logs(&dir, u64::MAX);
        assert!(
            text.contains(&format!("log line {:05}", last - 1)),
            "tail kept newest"
        );
        assert!(
            !text.contains("log line 00000"),
            "head evicted past the cap"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reader_respects_the_budget_newest_first() {
        let dir = tempdir("budget");
        let mut w = SizeRotatingWriter::open(&dir).unwrap();
        for n in 0..50 {
            w.write_all(&line(n)).unwrap();
        }
        // Tiny budget: only the newest bytes, and no partial first line.
        let text = read_recent_logs(&dir, 120);
        assert!(text.len() <= 120, "budget respected: {}", text.len());
        assert!(text.contains("log line 00049"), "newest kept");
        assert!(
            !text.starts_with("ine "),
            "no partial leading line: {text:?}"
        );
        assert!(!text.contains("log line 00000"), "oldest evicted");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_directory_reads_empty() {
        let dir = tempdir("empty");
        assert_eq!(read_recent_logs(&dir, 1024), "");
        // Zero budget never touches the disk.
        assert_eq!(read_recent_logs(&dir, 0), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn panic_hook_records_a_caught_panic() {
        // The hook is process-global and installed once: this is the only
        // test that touches it. Chaining (take_hook first) keeps the test
        // harness's own reporting intact, and a removed tempdir only makes
        // later writes fail silently.
        let dir = tempdir("panichook");
        install_panic_hook(&dir);
        let _ = std::panic::catch_unwind(|| panic!("boom-for-test"));
        let text = std::fs::read_to_string(dir.join(LIVE_NAME)).unwrap();
        assert!(text.contains("PANIC"), "hook recorded: {text:?}");
        assert!(text.contains("boom-for-test"), "message kept: {text:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reopening_resumes_the_size_budget() {
        let dir = tempdir("resume");
        let line_len = line(0).len() as u64;
        // Fill most of one budget, drop the writer, reopen: the resumed
        // counter must still trigger rotation instead of overgrowing.
        let target = (MAX_BYTES_PER_FILE / line_len) as usize;
        {
            let mut w = SizeRotatingWriter::open(&dir).unwrap();
            for n in 0..target {
                w.write_all(&line(n)).unwrap();
            }
        }
        {
            let mut w = SizeRotatingWriter::open(&dir).unwrap();
            for n in 0..target {
                w.write_all(&line(1000 + n)).unwrap();
            }
        }
        let count = std::fs::read_dir(&dir).unwrap().flatten().count();
        assert!(count <= MAX_FILES, "cap holds across restarts: {count}");
        let total: u64 = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
            .sum();
        assert!(
            total <= MAX_FILES as u64 * MAX_BYTES_PER_FILE + line_len * 2,
            "disk use bounded: {total}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
