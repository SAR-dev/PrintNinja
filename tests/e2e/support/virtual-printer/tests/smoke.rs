//! Smoke tests for the Virtual Printer fixture.
//!
//! A placeholder for the e2e suite this repo will grow: it spawns the
//! fixture as a subprocess (`CARGO_BIN_EXE_virtualprinter`, so no rebuild)
//! and drives it over real TCP, the same way the later app tests will.
//! The fixture is std-only, so the harness needs cargo and nothing else,
//! and none of these tests skip.
//!
//! | test | what it drives | what it asserts |
//! |---|---|---|
//! | `raw_job_bytes_are_stored` | Raw/JetDirect port, ZPL payload | the job file under `--jobs` is byte-for-byte the sent payload |
//! | `ipp_reports_ready` | IPP Get-Printer-Attributes, state `ok` | `successful-ok`, `printer-state` 3, reasons `none` |
//! | `ipp_reports_paper_out` | `GET /set?state=paperout`, then Get-Printer-Attributes | `printer-state` 5, reasons `media-empty` |
//!
//! Ports are ephemeral: the fixture is spawned with `--ports-file`, which
//! makes it bind every listener to port 0 and write the real ports to a
//! file the harness polls for — no port guessing, no clashes between
//! parallel tests. Each test owns a fresh fixture in its own temp
//! directory, and a `Drop` guard kills it, so CI never leaks a process.
//! Every read has a timeout, so a hung fixture fails the test instead of
//! hanging CI.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_virtualprinter");
const HOST: &str = "127.0.0.1";
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const SPAWN_TIMEOUT: Duration = Duration::from_secs(15);
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

struct Ports {
    raw: u16,
    ipp: u16,
    http: u16,
}

/// A running fixture; killed (and reaped) on drop, temp dir cleaned up.
struct Fixture {
    child: Child,
    workdir: PathBuf,
    ports: Ports,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.workdir);
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn workdir() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("vp-smoke-{}-{}", std::process::id(), n));
    fs::create_dir_all(&dir).expect("create workdir");
    dir
}

/// Spawn the fixture and wait until its `--ports-file` lists every port.
fn spawn_fixture(state: &str) -> Fixture {
    let dir = workdir();
    let ports_file = dir.join("ports.txt");
    let mut child = Command::new(BIN)
        .args([
            "--host",
            HOST,
            "--state",
            state,
            "--jobs",
            dir.join("jobs").to_str().unwrap(),
            "--ports-file",
            ports_file.to_str().unwrap(),
        ])
        .spawn()
        .expect("spawn fixture");
    let deadline = Instant::now() + SPAWN_TIMEOUT;
    loop {
        let text = fs::read_to_string(&ports_file).unwrap_or_default();
        let port = |key: &str| -> Option<u16> {
            text.lines()
                .find_map(|l| l.strip_prefix(&format!("{key}=")))
                .and_then(|v| v.parse().ok())
        };
        match (port("raw"), port("ipp"), port("http")) {
            (Some(raw), Some(ipp), Some(http)) => {
                break Fixture {
                    child,
                    workdir: dir,
                    ports: Ports { raw, ipp, http },
                }
            }
            _ => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    panic!("fixture did not write its ports file in time");
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

/// Poll `f` until it returns `Some` or the deadline passes.
fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        if let Some(t) = f() {
            return Some(t);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Send a raw HTTP request; return (status code, header block, body).
fn http_request(port: u16, request: &[u8]) -> (u16, Vec<u8>, Vec<u8>) {
    let mut stream = TcpStream::connect((HOST, port)).expect("connect");
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .expect("set read timeout");
    stream.write_all(request).expect("send request");
    // Half-close: no more request bytes coming; the response ends at EOF.
    stream
        .shutdown(std::net::Shutdown::Write)
        .expect("half-close");
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .expect("read response (fixture hung or closed badly)");
    let status_line = raw
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| &raw[..i])
        .unwrap_or(&raw);
    let status = String::from_utf8_lossy(status_line);
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .unwrap_or_else(|| panic!("bad status line: {status:?}"));
    let (head, body) = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (&raw[..i], raw[i + 4..].to_vec()))
        .unwrap_or_else(|| (&raw[..], Vec::new()));
    (code, head.to_vec(), body)
}

fn set_state(f: &Fixture, state: &str) {
    let request =
        format!("GET /set?state={state} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n");
    let (code, _, body) = http_request(f.ports.http, request.as_bytes());
    assert_eq!(code, 200, "state switch should be accepted");
    assert_eq!(
        body,
        format!("state={state}\n").into_bytes(),
        "fixture did not actually change state"
    );
}

/// Minimal hand-built Get-Printer-Attributes request (op 0x000B, IPP 1.1).
fn get_printer_attributes(f: &Fixture) -> (u16, Vec<u8>) {
    let mut ipp = vec![1u8, 1, 0x00, 0x0B, 0, 0, 0, 1];
    ipp.push(0x01); // operation-attributes
    ipp_attr(&mut ipp, 0x47, "attributes-charset", b"utf-8");
    ipp_attr(&mut ipp, 0x48, "attributes-natural-language", b"en");
    ipp.push(0x03); // end of attributes
    let request = format!(
        "POST /ipp HTTP/1.1\r\nHost: {HOST}\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        ipp.len()
    );
    let mut bytes = request.into_bytes();
    bytes.extend_from_slice(&ipp);
    let (code, _, body) = http_request(f.ports.ipp, &bytes);
    (code, body)
}

fn ipp_attr(out: &mut Vec<u8>, tag: u8, name: &str, val: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&(name.len() as u16).to_be_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&(val.len() as u16).to_be_bytes());
    out.extend_from_slice(val);
}

/// One response attribute: (value tag, name, value bytes).
type IppAttr = (u8, String, Vec<u8>);

/// Parse an IPP response body: (status code, request id, attributes).
fn ipp_parse(body: &[u8]) -> (u16, u32, Vec<IppAttr>) {
    assert!(body.len() >= 8, "IPP response too short: {body:?}");
    let status = u16::from_be_bytes([body[2], body[3]]);
    let id = u32::from_be_bytes([body[4], body[5], body[6], body[7]]);
    let mut attrs = Vec::new();
    let mut i = 8;
    while i < body.len() {
        let tag = body[i];
        if tag <= 0x05 {
            i += 1; // group delimiter / end of attributes
            continue;
        }
        let nl = u16::from_be_bytes([body[i + 1], body[i + 2]]) as usize;
        let name = String::from_utf8_lossy(&body[i + 3..i + 3 + nl]).into_owned();
        let vl = u16::from_be_bytes([body[i + 3 + nl], body[i + 4 + nl]]) as usize;
        let value = body[i + 5 + nl..i + 5 + nl + vl].to_vec();
        attrs.push((tag, name, value));
        i += 5 + nl + vl;
    }
    (status, id, attrs)
}

fn attr<'a>(attrs: &'a [IppAttr], name: &str) -> Option<&'a IppAttr> {
    attrs.iter().find(|(_, n, _)| n == name)
}

fn attr_value<'a>(attrs: &'a [IppAttr], name: &str) -> Option<&'a [u8]> {
    attr(attrs, name).map(|(_, _, v)| v.as_slice())
}

#[test]
fn raw_job_bytes_are_stored() {
    let fixture = spawn_fixture("ok");
    let payload = b"^XA^FO30,30^FDTEST^FS^XZ";

    let mut stream = TcpStream::connect((HOST, fixture.ports.raw)).expect("connect raw");
    stream.write_all(payload).expect("send job");
    // Closing the connection (EOF) ends the raw job — no idle wait.
    drop(stream);

    // The fixture saves every raw job verbatim under `--jobs`. Wait until a
    // `raw_` file holds exactly the bytes we sent, then check it.
    let jobs = fixture.workdir.join("jobs");
    let stored = wait_for(|| {
        fs::read_dir(&jobs)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .find_map(|e| {
                let p = e.path();
                let name = p.file_name()?.to_str()?;
                (name.starts_with("raw_"))
                    .then(|| fs::read(&p))
                    .and_then(|r| r.ok())
                    .filter(|data| data == payload)
                    .map(|_| p)
            })
    });
    assert!(
        stored.is_some(),
        "fixture never stored the raw job byte-for-byte under {jobs:?}"
    );
}

#[test]
fn ipp_reports_ready() {
    let fixture = spawn_fixture("ok");
    let (code, body) = get_printer_attributes(&fixture);
    assert_eq!(code, 200, "IPP over HTTP should answer 200");
    let (status, id, attrs) = ipp_parse(&body);
    assert_eq!(status, 0x0000, "expected successful-ok");
    assert_eq!(id, 1, "request id must be echoed");
    // `printer-state` is an `enum` (tag 0x23) holding a 4-byte big-endian int.
    let st = attr(&attrs, "printer-state").expect("printer-state missing");
    assert_eq!(st.0, 0x23, "printer-state should be an enum");
    assert_eq!(&st.2, &[0, 0, 0, 3], "ready is state 3");
    assert_eq!(
        attr_value(&attrs, "printer-state-reasons"),
        Some(&b"none"[..])
    );
    assert_eq!(
        attr_value(&attrs, "printer-name"),
        Some(&b"Virtual Printer"[..])
    );
}

#[test]
fn ipp_reports_paper_out() {
    let fixture = spawn_fixture("ok");
    set_state(&fixture, "paperout");

    let (code, body) = get_printer_attributes(&fixture);
    assert_eq!(code, 200);
    let (status, _id, attrs) = ipp_parse(&body);
    assert_eq!(status, 0x0000, "successful-ok even while out of paper");
    let st = attr(&attrs, "printer-state").expect("printer-state missing");
    assert_eq!(&st.2, &[0, 0, 0, 5], "paperout is state 5");
    assert_eq!(
        attr_value(&attrs, "printer-state-reasons"),
        Some(&b"media-empty"[..]),
        "the specific condition lives in printer-state-reasons"
    );
}
