//! Running a job: the state machine that turns transport byte-facts into
//! the honest result states of plan §5.7.
//!
//! Every job ends in exactly one state:
//!
//! | State | Meaning |
//! | --- | --- |
//! | `Confirmed` | the printer's own reply confirms no fault |
//! | `SentUnconfirmed` | bytes were accepted, but this printer cannot confirm |
//! | `PartiallyPrinted { printed, total, reason }` | the job stopped before the last unit; `printed` is the number of units fully accepted by the printer before the fault |
//! | `Failed { reason }` | nothing was printed (or the failure happened before print) |
//! | `WrongModeSuspected` | data was accepted, but the reply speaks a different dialect than the profile's language |
//!
//! The retry rule (plan §5.6): a job is retried once, and only when the
//! failure happened **before any byte was accepted** (a refused
//! connection, or a write that failed before the first byte went out). A
//! failure after partial delivery is a hard result — no blind retry; the
//! user restarts explicitly.

use std::time::Duration;

use pn_profiles::{Language, Profile};
use pn_transport::{SendError, SendPlan, Transport};

use crate::status::{decode, reply_complete, StatusReading};

/// One job: the units to send (encoders split a batch into units — one
/// label each — in a later phase; phase 3 takes pre-split units).
#[derive(Debug, Clone)]
pub struct JobSpec {
    /// Human name for logs and the job list.
    pub name: String,
    /// One unit of output (e.g. one label).
    pub units: Vec<Vec<u8>>,
}

impl JobSpec {
    pub fn new(name: impl Into<String>, units: Vec<Vec<u8>>) -> Self {
        JobSpec {
            name: name.into(),
            units,
        }
    }
}

/// What happened to a job. `printed`/`total` count units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobResult {
    /// The printer's reply confirmed no fault.
    Confirmed,
    /// Bytes were accepted; the printer cannot confirm (no status dialect,
    /// or it stayed silent).
    SentUnconfirmed,
    /// The job stopped before the last unit. `printed` units were fully
    /// accepted by the printer before the fault was detected.
    PartiallyPrinted {
        printed: u32,
        total: u32,
        reason: String,
    },
    /// Nothing was printed.
    Failed { reason: String },
    /// Data was accepted, but the printer is probably in the wrong mode.
    WrongModeSuspected,
}

impl JobResult {
    /// The count for multi-unit jobs: always shown to the user as
    /// "N of M" (plan §5.7).
    pub fn counts(&self) -> Option<(u32, u32)> {
        match self {
            JobResult::PartiallyPrinted { printed, total, .. } => Some((*printed, *total)),
            _ => None,
        }
    }

    /// True for every state that means "something may be on the paper".
    pub fn printed_anything(&self) -> bool {
        matches!(
            self,
            JobResult::Confirmed
                | JobResult::SentUnconfirmed
                | JobResult::PartiallyPrinted { .. }
                | JobResult::WrongModeSuspected
        )
    }
}

/// Builds one transport per attempt — a retry needs a fresh connection.
pub trait TransportFactory {
    fn connect(&self) -> Result<Box<dyn Transport>, SendError>;
}

/// Run `spec` against `profile` using `factory` to build transports.
/// The profile drives pacing, close delay, the status query and its
/// decode dialect (plan §5.6/§5.7).
pub fn run<F: TransportFactory>(spec: &JobSpec, profile: &Profile, factory: &F) -> JobResult {
    let plan = send_plan_from(profile);
    let total = spec.units.len() as u32;
    if total == 0 {
        return JobResult::Failed {
            reason: "the job has no units".to_string(),
        };
    }

    for attempt in 0..2u32 {
        let transport = match factory.connect() {
            Ok(t) => t,
            Err(e) if attempt == 0 && e.retryable() => continue, // one retry
            Err(e) => return JobResult::Failed { reason: e.reason() },
        };
        match run_attempt(spec, profile, &plan, transport, total) {
            Some(result) => return result,
            // None: a retryable pre-byte failure on the first attempt.
            None if attempt == 0 => continue,
            None => {
                return JobResult::Failed {
                    reason: "the connection could not be re-established".to_string(),
                };
            }
        }
    }
    unreachable!("the attempt loop returns or retries exactly once")
}

/// One connection's worth of the job. `None` means "retryable, nothing
/// was flushed" (first attempt only — `run` turns it into a retry).
fn run_attempt(
    spec: &JobSpec,
    profile: &Profile,
    plan: &SendPlan,
    mut transport: Box<dyn Transport>,
    total: u32,
) -> Option<JobResult> {
    let status = status_params(profile);

    // Preflight: ask before any byte goes out. A fault here means nothing
    // will print, so the job fails with the reason — it does not print
    // anyway.
    if let Some((reading, _)) = ask(&mut *transport, status.as_ref()) {
        match reading {
            StatusReading::Ready => {}
            StatusReading::Fault(reason) => {
                return Some(JobResult::Failed {
                    reason: format!("the printer reports {reason} before print"),
                });
            }
            StatusReading::WrongMode => {
                return Some(JobResult::Failed {
                    reason: "wrong mode suspected before print".to_string(),
                });
            }
            StatusReading::Unknown => {} // silence: never block a print
        }
    }

    let mut flushed = 0u32;
    let mut bytes_out = 0u64;
    for (i, unit) in spec.units.iter().enumerate() {
        let report = transport.send_unit(unit, plan);
        bytes_out += report.bytes_written;
        if report.error.is_none() {
            flushed += 1;
            // Poll between units so a mid-batch paper-out is caught while
            // there are still units left to hold back.
            if let Some((reading, _)) = ask(&mut *transport, status.as_ref()) {
                match reading {
                    StatusReading::Ready | StatusReading::Unknown => {}
                    StatusReading::Fault(reason) => {
                        return Some(JobResult::PartiallyPrinted {
                            printed: flushed,
                            total,
                            reason: format!("the printer reports {reason}"),
                        });
                    }
                    StatusReading::WrongMode => {
                        return Some(JobResult::WrongModeSuspected);
                    }
                }
            }
            continue;
        }

        // A unit failed.
        let error = report.error.expect("checked above");
        if i == 0 && bytes_out == 0 && error.retryable() {
            transport.finish(plan);
            return None; // retryable, nothing flushed
        }
        transport.finish(plan);
        if flushed > 0 {
            return Some(JobResult::PartiallyPrinted {
                printed: flushed,
                total,
                reason: error.reason(),
            });
        }
        return Some(JobResult::Failed {
            reason: error.reason(),
        });
    }

    // All units flushed. Ask once more before closing: the reply confirms,
    // or names a fault the tail of the job may have hit.
    let result = match ask(&mut *transport, status.as_ref()).map(|(r, _)| r) {
        Some(StatusReading::Ready) => JobResult::Confirmed,
        Some(StatusReading::Fault(reason)) => JobResult::PartiallyPrinted {
            printed: total,
            total,
            reason: format!(
                "all units were accepted, but the printer reports {reason} after the last one"
            ),
        },
        Some(StatusReading::WrongMode) => JobResult::WrongModeSuspected,
        _ => JobResult::SentUnconfirmed, // silence and unreadable alike
    };
    transport.finish(plan);
    Some(result)
}

/// The profile's status dialect, if it should be polled: the query bytes
/// and the reply shape. `None` for CPCL, PDF, or `keep_open_for_status =
/// false` — those jobs never end confirmed (plan §5.7).
fn status_params(profile: &Profile) -> Option<(Vec<u8>, Poll)> {
    let status = profile.status.as_ref()?;
    if status.query.trim().is_empty() || !profile.delivery.keep_open_for_status {
        return None;
    }
    Some((
        status.query.clone().into_bytes(),
        Poll {
            language: profile.profile.language,
            deadline: Duration::from_millis(status.poll_after_ms as u64 + 2000),
        },
    ))
}

struct Poll {
    language: Language,
    deadline: Duration,
}

/// Send the status query and decode the reply. `None` = no dialect for
/// this profile.
fn ask(
    transport: &mut dyn Transport,
    status: Option<&(Vec<u8>, Poll)>,
) -> Option<(StatusReading, Option<Vec<u8>>)> {
    let (query, poll) = status?;
    let reply = transport
        .status_reply(query, poll.deadline, &|r| reply_complete(poll.language, r))
        .ok()?;
    Some((decode(poll.language, reply.as_deref()), reply))
}

/// Derive the transport's pacing from the profile (plan §5.6: the pace is
/// taken from the profile, not hard-coded).
pub fn send_plan_from(profile: &Profile) -> SendPlan {
    SendPlan {
        chunk_bytes: profile.delivery.chunk_bytes,
        pause_ms: profile.delivery.pause_ms,
        close_delay_ms: profile.delivery.close_delay_ms,
        ..SendPlan::default()
    }
}

/// A factory over one TCP endpoint.
pub struct TcpFactory {
    pub host: String,
    pub port: u16,
    pub connect_deadline: Duration,
}

impl TransportFactory for TcpFactory {
    fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
        Ok(Box::new(pn_transport::TcpTransport::connect(
            &self.host,
            self.port,
            self.connect_deadline,
        )?))
    }
}

/// A factory over one Windows spooler queue. `datatype` is the spooler
/// datatype declared for each unit — `"RAW"` for command languages,
/// `"PDF"` for PDF jobs (see `pn_transport::spooler::spool_datatype`);
/// the caller picks it from the render result.
#[cfg(windows)]
pub struct SpoolerFactory {
    pub printer_name: String,
    pub datatype: &'static str,
}

#[cfg(windows)]
impl TransportFactory for SpoolerFactory {
    fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
        Ok(Box::new(pn_transport::WindowsSpoolerTransport::connect(
            &self.printer_name,
            self.datatype,
        )?))
    }
}

/// A factory over one IPP endpoint (CUPS, or a page printer's own IPP
/// interface). `document_format` is the MIME type declared for each unit —
/// `"application/pdf"` for PDF jobs, `"application/octet-stream"` for
/// everything else (see `pn_transport::ipp::ipp_document_format`); the
/// caller picks it from the render result.
pub struct IppFactory {
    pub address: String,
    pub user: Option<String>,
    pub document_format: &'static str,
}

impl TransportFactory for IppFactory {
    fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
        let mut transport = pn_transport::IppTransport::connect(&self.address)?;
        if let Some(user) = &self.user {
            transport = transport.with_user(user.clone());
        }
        Ok(Box::new(
            transport.with_document_format(self.document_format),
        ))
    }
}

/// A factory over a paired Bluetooth device. `address` is what the row
/// stores: a MAC (Linux dials its RFCOMM channel; Windows looks up the
/// port the paired device owns) or, on Windows, the port itself
/// (`COM7`).
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub struct BtFactory {
    pub address: String,
    pub connect_deadline: Duration,
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
impl TransportFactory for BtFactory {
    fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
        Ok(Box::new(pn_transport::BluetoothTransport::connect(
            &self.address,
            self.connect_deadline,
        )?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pn_transport::UnitReport;

    /// A scripted fake transport: per-unit outcomes, per-query replies.
    struct Fake {
        unit_errors: Vec<Option<SendError>>,
        replies: Vec<Option<Vec<u8>>>,
        units_sent: std::sync::Mutex<usize>, // how many units received
        queries_sent: std::sync::Mutex<usize>,
    }

    impl Transport for Fake {
        fn send_unit(&mut self, data: &[u8], _plan: &SendPlan) -> UnitReport {
            let i = *self.units_sent.lock().unwrap();
            *self.units_sent.lock().unwrap() += 1;
            match self.unit_errors.get(i).cloned().flatten() {
                None => UnitReport::ok(data.len() as u64),
                Some(e) => UnitReport {
                    bytes_written: 0,
                    error: Some(e),
                },
            }
        }

        fn status_reply(
            &mut self,
            _query: &[u8],
            _deadline: Duration,
            _complete: &dyn Fn(&[u8]) -> bool,
        ) -> Result<Option<Vec<u8>>, SendError> {
            let i = *self.queries_sent.lock().unwrap();
            *self.queries_sent.lock().unwrap() += 1;
            Ok(self.replies.get(i).cloned().flatten())
        }

        fn finish(&mut self, _plan: &SendPlan) {}
    }

    /// A factory that re-scripts the same expectations on every connect,
    /// and counts how many times it was asked to connect.
    struct FakeFactory {
        unit_errors: Vec<Option<SendError>>,
        replies: Vec<Option<Vec<u8>>>,
        connects: std::sync::Mutex<u32>,
    }

    impl TransportFactory for FakeFactory {
        fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
            *self.connects.lock().unwrap() += 1;
            Ok(Box::new(Fake {
                unit_errors: self.unit_errors.clone(),
                replies: self.replies.clone(),
                units_sent: std::sync::Mutex::new(0),
                queries_sent: std::sync::Mutex::new(0),
            }))
        }
    }

    const OK_ZPL: &[u8] = b"\x02030,0,0,1234,000,0,0,0,000,0,0,0\x03\r\n\x02x\x03\r\n\x02y\x03\r\n";
    const PAPEROUT_ZPL: &[u8] =
        b"\x02030,1,0,1234,000,0,0,0,000,0,0,0\x03\r\n\x02x\x03\r\n\x02y\x03\r\n";

    fn zpl_profile() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "Test"
language = "zpl"
media = ["label"]
[status]
query = "~HS"
expected_prefix = "\u0002"
"#,
        )
        .unwrap()
    }

    fn no_status_profile() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "Test"
language = "zpl"
media = ["label"]
"#,
        )
        .unwrap()
    }

    fn units(n: usize) -> Vec<Vec<u8>> {
        (0..n)
            .map(|i| format!("^XA^FO0,{i}^FDlabel{i}^XZ").into_bytes())
            .collect()
    }

    /// n units: one preflight query, one after every unit, one post-job.
    fn replies_ok(n: usize) -> Vec<Option<Vec<u8>>> {
        vec![Some(OK_ZPL.to_vec()); n + 2]
    }

    #[test]
    fn all_ok_with_status_reply_is_confirmed() {
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: replies_ok(3),
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(3)), &zpl_profile(), &factory);
        assert_eq!(result, JobResult::Confirmed);
        assert_eq!(*factory.connects.lock().unwrap(), 1);
    }

    #[test]
    fn all_ok_without_status_is_unconfirmed() {
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(
            &JobSpec::new("job", units(3)),
            &no_status_profile(),
            &factory,
        );
        assert_eq!(result, JobResult::SentUnconfirmed);
    }

    #[test]
    fn preflight_fault_fails_before_print() {
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![Some(PAPEROUT_ZPL.to_vec())],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(3)), &zpl_profile(), &factory);
        match result {
            JobResult::Failed { reason } => assert!(reason.contains("out of paper"), "{reason}"),
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(
            *factory.connects.lock().unwrap(),
            1,
            "no reconnect after a preflight fault"
        );
    }

    #[test]
    fn mid_batch_fault_is_partial() {
        // Preflight ok, unit 0 ok, query ok, unit 1 ok, query paper-out.
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![
                Some(OK_ZPL.to_vec()),
                Some(OK_ZPL.to_vec()),
                Some(PAPEROUT_ZPL.to_vec()),
            ],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(5)), &zpl_profile(), &factory);
        match result {
            JobResult::PartiallyPrinted {
                printed,
                total,
                reason,
            } => {
                assert_eq!((printed, total), (2, 5));
                assert!(reason.contains("out of paper"), "{reason}");
            }
            other => panic!("expected PartiallyPrinted, got {other:?}"),
        }
        assert_eq!(*factory.connects.lock().unwrap(), 1);
    }

    #[test]
    fn mid_write_failure_is_partial() {
        // Unit 0 ok, unit 1 fails on the wire.
        let factory = FakeFactory {
            unit_errors: vec![None, Some(SendError::ClosedByPeer)],
            replies: vec![Some(OK_ZPL.to_vec())],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(3)), &zpl_profile(), &factory);
        match result {
            JobResult::PartiallyPrinted { printed, total, .. } => {
                assert_eq!((printed, total), (1, 3));
            }
            other => panic!("expected PartiallyPrinted, got {other:?}"),
        }
        assert_eq!(
            *factory.connects.lock().unwrap(),
            1,
            "a mid-write failure is never retried"
        );
    }

    #[test]
    fn connect_failure_before_any_byte_is_retried() {
        // The factory fails the first connect, succeeds the second.
        struct Flaky {
            fails: std::sync::Mutex<u32>,
            factory: FakeFactory,
        }
        impl TransportFactory for Flaky {
            fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
                let mut f = self.fails.lock().unwrap();
                if *f > 0 {
                    *f -= 1;
                    return Err(SendError::Connect("refused".to_string()));
                }
                drop(f);
                self.factory.connect()
            }
        }
        let flaky = Flaky {
            fails: std::sync::Mutex::new(1),
            factory: FakeFactory {
                unit_errors: vec![],
                replies: replies_ok(2),
                connects: std::sync::Mutex::new(0),
            },
        };
        let result = run(&JobSpec::new("job", units(2)), &zpl_profile(), &flaky);
        assert_eq!(result, JobResult::Confirmed);
        assert_eq!(
            *flaky.factory.connects.lock().unwrap(),
            1,
            "only the second connect is used"
        );
    }

    #[test]
    fn persistent_connect_failure_fails() {
        struct AlwaysFails;
        impl TransportFactory for AlwaysFails {
            fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
                Err(SendError::Connect("refused".to_string()))
            }
        }
        let result = run(&JobSpec::new("job", units(1)), &zpl_profile(), &AlwaysFails);
        match result {
            JobResult::Failed { reason } => assert!(reason.contains("connect"), "{reason}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn closed_first_unit_is_failed_not_retried() {
        // A wire failure on the very first unit: a retry would risk a
        // duplicate, so it is a hard Failed.
        let factory = FakeFactory {
            unit_errors: vec![Some(SendError::ClosedByPeer)],
            replies: vec![],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(1)), &zpl_profile(), &factory);
        match result {
            JobResult::Failed { .. } => {}
            other => panic!("expected Failed (0 units flushed), got {other:?}"),
        }
        assert_eq!(*factory.connects.lock().unwrap(), 1);
    }

    #[test]
    fn post_job_fault_is_partial_with_all_units() {
        // All units ok, final reply says paper out.
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![
                Some(OK_ZPL.to_vec()),
                Some(OK_ZPL.to_vec()),
                Some(OK_ZPL.to_vec()),
                Some(PAPEROUT_ZPL.to_vec()),
            ],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(2)), &zpl_profile(), &factory);
        match result {
            JobResult::PartiallyPrinted {
                printed,
                total,
                reason,
            } => {
                assert_eq!((printed, total), (2, 2));
                assert!(reason.contains("out of paper"), "{reason}");
            }
            other => panic!("expected PartiallyPrinted, got {other:?}"),
        }
    }

    #[test]
    fn silence_never_fails() {
        // Every query gets no reply: the job prints and ends unconfirmed.
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![None; 8],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(3)), &zpl_profile(), &factory);
        assert_eq!(result, JobResult::SentUnconfirmed);
    }

    #[test]
    fn wrong_mode_reply_is_suspected() {
        // Preflight: a well-formed ESC/POS byte answers a ZPL query.
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![Some(vec![0x12])],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", units(1)), &zpl_profile(), &factory);
        match result {
            JobResult::Failed { reason } => assert!(reason.contains("wrong mode"), "{reason}"),
            other => panic!("expected Failed(wrong mode preflight), got {other:?}"),
        }
        assert_eq!(*factory.connects.lock().unwrap(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_spooler_queue_fails_honestly() {
        // The factory cannot open a queue that does not exist: the job
        // is retried once (nothing was flushed) and ends Failed with the
        // spooler's refusal.
        let factory = SpoolerFactory {
            printer_name: "PrintNinja No Such Queue 9876".to_string(),
            datatype: "RAW",
        };
        let result = run(
            &JobSpec::new("job", units(1)),
            &no_status_profile(),
            &factory,
        );
        match result {
            JobResult::Failed { reason } => assert!(reason.contains("OpenPrinter"), "{reason}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn a_bad_bluetooth_address_fails_honestly() {
        // Neither a MAC nor a COM port: the job fails before print and
        // names the shape the address should have had.
        let factory = BtFactory {
            address: "Front Desk".to_string(),
            connect_deadline: Duration::from_secs(2),
        };
        let result = run(
            &JobSpec::new("job", units(1)),
            &no_status_profile(),
            &factory,
        );
        match result {
            JobResult::Failed { reason } => {
                assert!(reason.contains("A4:77:17:22:33:44"), "{reason}")
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn empty_job_fails() {
        let factory = FakeFactory {
            unit_errors: vec![],
            replies: vec![],
            connects: std::sync::Mutex::new(0),
        };
        let result = run(&JobSpec::new("job", vec![]), &zpl_profile(), &factory);
        assert!(matches!(result, JobResult::Failed { .. }));
    }

    #[test]
    fn counts_are_exposed() {
        let partial = JobResult::PartiallyPrinted {
            printed: 41,
            total: 50,
            reason: "it is out of paper".into(),
        };
        assert_eq!(partial.counts(), Some((41, 50)));
        assert_eq!(JobResult::Confirmed.counts(), None);
    }
}
