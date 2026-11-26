//! Delivery e2e: the real pn-transport + pn-job against the virtual printer.
//!
//! Every scenario ends in one of the honest job-result states of plan §5.7 —
//! the point of the phase is that a job never ends in a state that lies
//! about what reached the printer.

use std::time::Duration;

use pn_e2e::Printer;
use pn_job::{run, IppFactory, JobQueue, JobResult, JobSpec, TcpFactory};
use pn_profiles::Profile;
use pn_transport::Transport;

const HOST: &str = "127.0.0.1";

fn factory(raw_port: u16) -> TcpFactory {
    TcpFactory {
        host: HOST.into(),
        port: raw_port,
        connect_deadline: Duration::from_secs(2),
    }
}

/// A ZPL profile that keeps the line open and polls `~HS` — the profile the
/// happy-path and fault scenarios are run with.
fn zpl_profile() -> Profile {
    parse(
        r#"
[profile]
model = "Virtual ZPL"
language = "zpl"
mode = "zpl"
media = ["label"]
[delivery]
chunk_bytes = 512
pause_ms = 10
close_delay_ms = 0
keep_open_for_status = true
[status]
query = "~HS"
expected_prefix = "\u0002"
poll_after_ms = 200
"#,
    )
}

/// The same, but the line is paced slowly (small chunks, long pauses) so a
/// multi-unit job takes a known, comfortable amount of wall-clock — the
/// paper-out-mid-batch scenario flips the printer in that window.
fn zpl_slow_profile() -> Profile {
    parse(
        r#"
[profile]
model = "Virtual ZPL"
language = "zpl"
mode = "zpl"
media = ["label"]
[delivery]
chunk_bytes = 256
pause_ms = 150
close_delay_ms = 0
keep_open_for_status = true
[status]
query = "~HS"
expected_prefix = "\u0002"
poll_after_ms = 200
"#,
    )
}

/// A ZPL profile with no status dialect: bytes go out, but the job can never
/// end `Confirmed`.
fn zpl_no_status_profile() -> Profile {
    parse(
        r#"
[profile]
model = "Virtual ZPL"
language = "zpl"
mode = "zpl"
media = ["label"]
[delivery]
chunk_bytes = 512
pause_ms = 10
close_delay_ms = 0
keep_open_for_status = true
"#,
    )
}

fn parse(toml: &str) -> Profile {
    pn_profiles::parse(toml).expect("test profile is valid")
}

fn labels(n: u32) -> Vec<Vec<u8>> {
    (0..n)
        .map(|i| format!("^XA^FO0,{i}^FDlabel-{i}^XZ").into_bytes())
        .collect()
}

fn pages(n: u32) -> Vec<Vec<u8>> {
    (0..n)
        .map(|i| format!("%PDF-1.4 page-{i} fake-content %EOF").into_bytes())
        .collect()
}

/// A page profile with no status dialect: page printers confirm through the
/// IPP reply, not through a query on the line.
fn pdf_profile() -> Profile {
    parse(
        r#"
[profile]
model = "Virtual Page"
language = "pdf"
media = ["page"]
[delivery]
chunk_bytes = 512
pause_ms = 0
close_delay_ms = 0
keep_open_for_status = false
"#,
    )
}

fn ipp_factory(ipp_port: u16) -> IppFactory {
    IppFactory {
        address: format!("{HOST}:{}", ipp_port),
        user: None,
        document_format: "application/pdf",
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn zpl_job_is_confirmed_and_reached_the_printer() {
    let vp = Printer::spawn("ok");
    let units = labels(3);
    let spec = JobSpec::new("three labels", units.clone());
    let result = run(&spec, &zpl_profile(), &factory(vp.raw_port));
    assert_eq!(result, JobResult::Confirmed);

    // And the bytes actually landed: the fixture saved one job containing
    // every unit (the `~HS` polls are interleaved, so match per unit).
    let jobs = vp.wait_for_jobs(1, Duration::from_secs(5));
    assert_eq!(jobs.len(), 1, "exactly one connection is one saved job");
    let data = vp.read_job(&jobs[0]);
    for unit in &units {
        assert!(
            contains_bytes(&data, unit),
            "a unit is missing from the saved job"
        );
    }
}

#[test]
fn job_without_a_status_dialect_is_unconfirmed() {
    let vp = Printer::spawn("ok");
    let units = labels(2);
    let spec = JobSpec::new("two labels", units.clone());
    let result = run(&spec, &zpl_no_status_profile(), &factory(vp.raw_port));
    assert_eq!(result, JobResult::SentUnconfirmed);

    let jobs = vp.wait_for_jobs(1, Duration::from_secs(5));
    assert_eq!(jobs.len(), 1);
    let data = vp.read_job(&jobs[0]);
    for unit in &units {
        assert!(contains_bytes(&data, unit));
    }
}

#[test]
fn a_printer_that_drops_the_line_fails_the_job() {
    let vp = Printer::spawn("drop");
    // Too large to be swallowed whole into the socket buffer before the
    // fixture's close (RST) arrives, so the write is guaranteed to fail.
    let unit = vec![b'x'; 16 * 1024];
    let spec = JobSpec::new("one big label", vec![unit]);
    let result = run(&spec, &zpl_profile(), &factory(vp.raw_port));
    match result {
        JobResult::Failed { reason } => assert!(!reason.is_empty(), "a failure names its cause"),
        other => panic!("a dropped line should fail the job, got {other:?}"),
    }
}

#[test]
fn a_printer_that_never_reads_hits_the_send_deadline() {
    let vp = Printer::spawn("hang");
    let mut t =
        pn_transport::TcpTransport::connect(HOST, vp.raw_port, Duration::from_secs(2)).unwrap();
    // A short send budget: the point is the deadline, not a 30 s wait.
    let plan = pn_transport::SendPlan {
        chunk_bytes: 1024,
        pause_ms: 0,
        send: Duration::from_secs(1),
        ..pn_transport::SendPlan::default()
    };
    // Larger than any send buffer or initial window, so the write blocks in
    // the kernel until the deadline no matter what the OS absorbs first.
    let data = vec![0u8; 8 * 1024 * 1024];
    let report = t.send_unit(&data, &plan);
    assert_eq!(report.error, Some(pn_transport::SendError::SendDeadline));
    assert!(
        report.bytes_written < data.len() as u64,
        "the stall stopped the write short: {} of {} bytes",
        report.bytes_written,
        data.len()
    );
}

#[test]
fn paper_out_mid_batch_is_partial_with_a_paper_reason() {
    let vp = Printer::spawn("ok");
    let profile = zpl_slow_profile();
    let raw = vp.raw_port;
    // Unit 0 is paced slowly (16 × 256 B chunks, 150 ms apart ≈ 2.2 s); the
    // flip lands comfortably inside that send — well after the preflight and
    // well before the poll that follows unit 0 — so that poll reads
    // paper-out and unit 1 is held back.
    let units: Vec<Vec<u8>> = vec![vec![b'a'; 4096], vec![b'b'; 512]];
    let spec = JobSpec::new("two labels", units);
    let worker = std::thread::spawn(move || run(&spec, &profile, &factory(raw)));

    std::thread::sleep(Duration::from_millis(500));
    vp.set_state("paperout");

    match worker.join().unwrap() {
        JobResult::PartiallyPrinted {
            printed,
            total,
            reason,
        } => {
            assert_eq!((printed, total), (1, 2), "unit 0 out, unit 1 held back");
            assert!(reason.to_lowercase().contains("paper"), "{reason}");
        }
        other => panic!("expected a partial result, got {other:?}"),
    }
}

#[test]
fn back_to_back_jobs_on_one_printer_are_serialized() {
    let vp = Printer::spawn("ok");
    let queue = std::sync::Arc::new(JobQueue::new());
    let profile = zpl_profile();
    let raw = vp.raw_port;

    let spawn = |i: u32| {
        let queue = std::sync::Arc::clone(&queue);
        let profile = profile.clone();
        std::thread::spawn(move || {
            let spec = JobSpec::new(format!("job {i}"), labels(2));
            queue.run_serialized("virtual", move || run(&spec, &profile, &factory(raw)))
        })
    };
    let a = spawn(1);
    let b = spawn(2);
    let ra = a.join().unwrap();
    let rb = b.join().unwrap();
    assert_eq!(ra, JobResult::Confirmed);
    assert_eq!(rb, JobResult::Confirmed);

    // One saved job per connection: two jobs, two files.
    let jobs = vp.wait_for_jobs(2, Duration::from_secs(5));
    assert_eq!(jobs.len(), 2, "each serialized job is its own saved file");
}

#[test]
fn ipp_job_is_sent_and_reached_the_printer() {
    let vp = Printer::spawn("ok");
    let units = pages(2);
    let spec = JobSpec::new("two pages", units.clone());
    let result = run(&spec, &pdf_profile(), &ipp_factory(vp.ipp_port));
    // Page printers speak no status dialect: the job ends unconfirmed,
    // with the honesty living in the per-unit IPP replies.
    assert_eq!(result, JobResult::SentUnconfirmed);

    // One Print-Job per unit: one saved job file per unit, each holding
    // exactly its own document bytes.
    let jobs = vp.wait_for_jobs(2, Duration::from_secs(5));
    assert_eq!(jobs.len(), 2, "one Print-Job per unit is one saved file");
    for unit in &units {
        assert!(
            jobs.iter().any(|p| contains_bytes(&vp.read_job(p), unit)),
            "a unit is missing from the saved jobs"
        );
    }
}

#[test]
fn an_ipp_printer_that_cannot_print_fails_the_job_with_the_reason() {
    let vp = Printer::spawn("paperout");
    let spec = JobSpec::new("one page", pages(1));
    let result = run(&spec, &pdf_profile(), &ipp_factory(vp.ipp_port));
    // The Print-Job reply reports job-state 6 (processing-stopped) with
    // `printer-stopped`: that is a per-unit failure, and with one unit the
    // whole job fails — naming the cause.
    match result {
        JobResult::Failed { reason } => {
            assert!(reason.to_lowercase().contains("paused"), "{reason}");
            assert!(reason.contains("printer-stopped"), "{reason}");
        }
        other => panic!("a stopped printer should fail the job, got {other:?}"),
    }
}
