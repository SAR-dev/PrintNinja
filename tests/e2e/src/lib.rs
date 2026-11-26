//! Delivery e2e harness: owns a virtual-printer fixture subprocess.
//!
//! Each test spawns its own [`Printer`] on OS-chosen ports (the fixture's
//! `--ports-file` mode binds port 0, so parallel tests never share a port)
//! and in its own throwaway jobs directory. The fixture answers real
//! Raw/JetDirect, LPD, IPP and HTTP traffic, so the tests exercise the
//! shipped [`pn_transport`] and [`pn_job`] crates end to end.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A running virtual printer, bound to OS-chosen loopback ports.
pub struct Printer {
    child: Child,
    /// Raw / JetDirect port — where print jobs go.
    pub raw_port: u16,
    /// IPP port — where page-printer jobs go (CUPS-style endpoint).
    pub ipp_port: u16,
    /// HTTP port — where `/set?state=…` state control lives.
    pub http_port: u16,
    /// Where the fixture writes one file per received job.
    pub jobs_dir: PathBuf,
    /// Root temp dir, removed on drop.
    root: PathBuf,
}

impl Drop for Printer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Printer {
    /// Spawn the fixture in `initial_state` (`ok`, `paperout`, `jam`,
    /// `offline`, `hang`, `drop`) and wait until its ports file is written.
    pub fn spawn(initial_state: &str) -> Self {
        let binary = binary_path();
        let root = fresh_temp_dir("vp");
        let jobs = root.join("jobs");
        std::fs::create_dir_all(&jobs).expect("make jobs dir");
        let ports_file = root.join("ports.txt");

        let mut child = Command::new(&binary)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--ports-file")
            .arg(&ports_file)
            .arg("--jobs")
            .arg(&jobs)
            .arg("--state")
            .arg(initial_state)
            .arg("--idle")
            .arg("2.0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("spawn virtualprinter ({binary:?}): {e}"));

        let ports = read_ports_file(&ports_file, &mut child);
        Printer {
            child,
            raw_port: ports["raw"],
            ipp_port: ports["ipp"],
            http_port: ports["http"],
            jobs_dir: jobs,
            root,
        }
    }

    /// Switch the fixture's state at runtime (the `/set?state=…` endpoint).
    pub fn set_state(&self, state: &str) {
        let path = format!("/set?state={state}");
        let body = http_get(self.http_port, &path);
        // The endpoint answers `state=<new>` with a 200; anything else is a
        // problem the test should not silently ride over.
        assert!(
            body.starts_with("HTTP/1.1 200"),
            "set_state({state}) failed: {body}"
        );
    }

    /// Every job file the fixture has saved so far.
    pub fn saved_jobs(&self) -> Vec<PathBuf> {
        std::fs::read_dir(&self.jobs_dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect()
    }

    /// Poll until at least `n` job files have been saved (the fixture
    /// saves a job when its connection closes, a beat after the job ends).
    pub fn wait_for_jobs(&self, n: usize, timeout: Duration) -> Vec<PathBuf> {
        let start = Instant::now();
        loop {
            let jobs = self.saved_jobs();
            if jobs.len() >= n || start.elapsed() > timeout {
                return jobs;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// Read a saved job file's bytes.
    pub fn read_job(&self, path: &Path) -> Vec<u8> {
        std::fs::read(path).expect("read saved job")
    }
}

/// The fixture's release binary, built on first use if it is not there yet.
///
/// The build goes to the workspace's `target/fixture`, not the fixture's
/// own source tree: the Docker test container runs as root on a
/// bind-mounted checkout, and a root-owned `support/virtual-printer/
/// target/` would lock the host-side fixture step (plain `cargo test`
/// on the checkout) out with a permission error. In CI the workspace
/// `target/` is a named Docker volume, so the artifact never lands in
/// the host tree at all.
fn binary_path() -> PathBuf {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("support/virtual-printer");
    let target_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .join("target")
        .join("fixture");
    let bin = target_dir.join(if cfg!(windows) {
        "release/virtualprinter.exe"
    } else {
        "release/virtualprinter"
    });
    if !bin.exists() {
        let status = Command::new("cargo")
            .args(["build", "--release"])
            .current_dir(&fixture)
            .env("CARGO_TARGET_DIR", &target_dir)
            .status()
            .expect("run `cargo build --release` for the virtual printer");
        assert!(status.success(), "virtualprinter release build failed");
    }
    bin
}

/// Poll the ports file until the fixture has written the `raw` and `http`
/// lines; fail the test (not hang) if the fixture dies before that.
fn read_ports_file(path: &Path, child: &mut Child) -> std::collections::HashMap<&'static str, u16> {
    let start = Instant::now();
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            let mut out = std::collections::HashMap::new();
            for line in text.lines() {
                if let Some((k, v)) = line.split_once('=') {
                    if let Ok(port) = v.trim().parse::<u16>() {
                        let key: &'static str = match k {
                            "raw" => "raw",
                            "ipp" => "ipp",
                            "http" => "http",
                            _ => continue,
                        };
                        out.insert(key, port);
                    }
                }
            }
            if out.contains_key("raw") && out.contains_key("ipp") && out.contains_key("http") {
                return out;
            }
        }
        // The fixture is supposed to be up; if it already exited, the ports
        // file will never be complete — surface that now.
        if child.try_wait().expect("poll fixture").is_some() {
            panic!("virtual printer exited before it bound its ports");
        }
        if start.elapsed() > Duration::from_secs(30) {
            panic!("virtual printer did not write its ports file in time");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// A minimal `GET path` over a fresh TCP connection — enough for the
/// fixture's state-control endpoint without pulling in an HTTP client.
fn http_get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to fixture HTTP");
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).expect("send GET");
    let mut out = Vec::new();
    stream.read_to_end(&mut out).expect("read GET reply");
    String::from_utf8_lossy(&out).into_owned()
}

/// A unique, pre-created temp directory under the OS temp root.
fn fresh_temp_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("pn-e2e-{tag}-{}-{n}-{ns}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("make temp dir");
    dir
}
