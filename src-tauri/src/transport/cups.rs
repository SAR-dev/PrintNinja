//! CUPS system printers, spoken to over IPP: no libcups, no `lpstat`.
//!
//! cupsd serves IPP on localhost:631. CUPS-Get-Printers (`0x4002`)
//! lists the queues; Print-Job against a queue URI prints to them
//! through the same raw IPP framing as [`IppPrinter`]. A missing cupsd
//! is normal (no daemon, no queues) and yields an empty list, not an
//! error — discovery must never fail the Setup page.

use async_trait::async_trait;
use std::time::Duration;

use super::{
    ipp::{describe_reason, parse_attributes, parse_status_code, IppPrinter},
    PrinterInfo, PrinterLanguage, PrinterTransport, PrinterType, RenderedJob,
};

/// How long discovery and the test probe wait for cupsd. Short: a
/// missing daemon refuses fast, and Setup must not hang on a wedged one.
const CUPS_TIMEOUT: Duration = Duration::from_secs(3);

fn cups_base_url() -> String {
    std::env::var("PRINTNINJA_CUPS_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:631".to_string())
}

fn queue_uri(name: &str) -> String {
    format!("{}/printers/{name}", cups_base_url())
}

/// One CUPS queue as IPP knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CupsQueue {
    pub name: String,
    pub uri: String,
    /// CUPS `printer-state`: 3 idle, 4 processing, 5 stopped.
    pub state: Option<u8>,
}

pub fn printer_state_word(state: Option<u8>) -> &'static str {
    match state {
        Some(3) => "idle",
        Some(4) => "processing",
        Some(5) => "stopped",
        _ => "unknown",
    }
}

/// CUPS-Get-Printers request (`0x4002`): charset + language only.
/// Queue selection attributes are optional; stock cupsd answers the
/// bare form with every destination.
fn build_cups_get_printers() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0x01, 0x01]); // IPP 1.1
    body.extend_from_slice(&[0x40, 0x02]); // CUPS-Get-Printers
    body.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]); // request id
    body.push(0x01); // operation attributes group
    IppPrinter::push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
    IppPrinter::push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
    body.push(0x03); // end of attributes
    body
}

/// Split a CUPS-Get-Printers body into one record per queue.
///
/// The response carries a printer group (`0x04`) per queue, but groups
/// flatten out in [`parse_attributes`] — so records restart at each
/// `printer-name`, which every CUPS printer group carries first.
pub fn parse_cups_printers(body: &[u8]) -> Result<Vec<CupsQueue>, String> {
    let status = parse_status_code(body)?;
    if status != 0 {
        return Err(format!("CUPS refused the request: status 0x{status:04x}"));
    }
    let mut queues = Vec::new();
    let mut name: Option<String> = None;
    let mut uri: Option<String> = None;
    let mut state: Option<u8> = None;
    let flush = |name: &mut Option<String>,
                 uri: &mut Option<String>,
                 state: &mut Option<u8>,
                 queues: &mut Vec<CupsQueue>| {
        if let (Some(n), Some(u)) = (name.take(), uri.take()) {
            queues.push(CupsQueue {
                name: n,
                uri: u,
                state: state.take(),
            });
        } else {
            name.take();
            uri.take();
            state.take();
        }
    };
    for (attr, tag, value) in parse_attributes(body) {
        match attr.as_str() {
            "printer-name" if tag == 0x42 || tag == 0x45 => {
                if name.is_some() {
                    flush(&mut name, &mut uri, &mut state, &mut queues);
                }
                name = Some(String::from_utf8_lossy(&value).into_owned());
            }
            "printer-uri" if tag == 0x45 => {
                uri = Some(String::from_utf8_lossy(&value).into_owned());
            }
            "printer-state" if (tag == 0x21 || tag == 0x23) && value.len() == 4 => {
                let raw = u32::from_be_bytes(value[..4].try_into().unwrap());
                state = u8::try_from(raw).ok();
            }
            _ => {}
        }
    }
    flush(&mut name, &mut uri, &mut state, &mut queues);
    Ok(queues)
}

/// What a Get-Printer-Attributes reply says about whether a queue can
/// take a job right now.
///
/// Every field is optional on purpose: the probe fails only on positive
/// evidence. A reply that says nothing about state (a minimal or odd
/// cupsd, a proxy) leaves all three empty and passes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct QueueHealth {
    /// `printer-state`: 3 idle, 4 processing, 5 stopped.
    pub state: Option<u8>,
    /// `printer-is-accepting-jobs`.
    pub accepting: Option<bool>,
    /// `printer-state-reasons` keywords, in the order the queue listed them.
    pub reasons: Vec<String>,
}

/// Read `printer-state`, `printer-is-accepting-jobs` and
/// `printer-state-reasons` out of a Get-Printer-Attributes reply.
pub(crate) fn parse_queue_health(body: &[u8]) -> QueueHealth {
    let mut health = QueueHealth::default();
    for (attr, tag, value) in parse_attributes(body) {
        match attr.as_str() {
            "printer-state" if (tag == 0x21 || tag == 0x23) && value.len() == 4 => {
                let raw = u32::from_be_bytes(value[..4].try_into().unwrap());
                health.state = u8::try_from(raw).ok();
            }
            "printer-is-accepting-jobs" if tag == 0x22 && value.len() == 1 => {
                health.accepting = Some(value[0] != 0);
            }
            "printer-state-reasons" if tag == 0x44 => {
                health
                    .reasons
                    .push(String::from_utf8_lossy(&value).trim().to_string());
            }
            _ => {}
        }
    }
    health
}

/// The reasons that mean a job will not print: paper out, jam, offline,
/// out of toner, paused.
///
/// IPP keywords carry a severity suffix (RFC 8011 §5.4.12). `-warning`
/// and `-report` are advisories — a printer low on toner or with one
/// empty tray still prints — so they never block, with the single
/// exception of `offline-report`, which is the standard keyword for
/// "offline". `-error` is the fault form of the same keyword.
fn blocking_reasons(reasons: &[String]) -> Vec<&str> {
    reasons
        .iter()
        .map(String::as_str)
        .filter(|r| is_blocking_reason(r))
        .collect()
}

fn is_blocking_reason(reason: &str) -> bool {
    let reason = reason.trim().to_ascii_lowercase();
    if reason == "offline-report" {
        return true;
    }
    if reason.ends_with("-warning") || reason.ends_with("-report") {
        return false;
    }
    let base = reason.strip_suffix("-error").unwrap_or(&reason);
    matches!(
        base,
        "media-empty"
            | "media-needed"
            | "media-jam"
            | "toner-empty"
            | "toner-life-end"
            | "marker-supply-empty"
            | "paused"
            | "printer-stopped"
    )
}

/// One sentence for the blocking reasons, with the raw keywords kept
/// beside it so a support exchange has the actual IPP value.
fn describe_blocking(blocking: &[&str]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for reason in blocking {
        let lower = reason.trim().to_ascii_lowercase();
        let base = lower.strip_suffix("-error").unwrap_or(&lower);
        // `media-needed` is the PWG keyword for an empty tray.
        let base = if base == "media-needed" {
            "media-empty"
        } else {
            base
        };
        if let Some(text) = describe_reason(base) {
            if !parts.contains(&text) {
                parts.push(text);
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!("{} [{}]", parts.join(" and "), blocking.join(", ")))
}

/// Why a queue cannot take a job, or `None` when nothing says it cannot.
///
/// Order: a stopped queue first, then one refusing jobs, then a device
/// fault. When a stopped queue also reports a cause, the cause is added.
pub(crate) fn queue_problem(name: &str, health: &QueueHealth) -> Option<String> {
    let cause = describe_blocking(&blocking_reasons(&health.reasons));
    let with_cause = |lead: String| match &cause {
        Some(c) => format!("{lead}: {c}"),
        None => lead,
    };
    if health.state == Some(5) {
        return Some(with_cause(format!("CUPS queue `{name}` is stopped")));
    }
    if health.accepting == Some(false) {
        return Some(with_cause(format!(
            "CUPS queue `{name}` is not accepting jobs"
        )));
    }
    cause.map(|c| format!("CUPS queue `{name}` cannot print: {c}"))
}

/// Judge a Get-Printer-Attributes reply: refused request, then queue state.
///
/// Pure, so the whole decision is unit-tested on reply bytes.
pub(crate) fn check_probe_reply(name: &str, body: &[u8]) -> Result<(), String> {
    let status = parse_status_code(body)?;
    // 0x00xx is the whole "successful" class (RFC 8011 §4.1.6.1): a
    // printer may answer ok-ignored-or-substituted (0x0001).
    if status >> 8 != 0 {
        return Err(format!(
            "CUPS queue refused the probe: status 0x{status:04x}"
        ));
    }
    match queue_problem(name, &parse_queue_health(body)) {
        Some(problem) => Err(problem),
        None => Ok(()),
    }
}

async fn post_ipp(path: &str, body: Vec<u8>) -> Result<Vec<u8>, String> {
    let url = format!("{}{path}", cups_base_url());
    let client = reqwest::Client::builder()
        .timeout(CUPS_TIMEOUT)
        .build()
        .map_err(|e| format!("CUPS client failed: {e}"))?;
    let response = client
        .post(&url)
        .header("Content-Type", "application/ipp")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!("no CUPS daemon at {url}: {e}")
            } else {
                format!("CUPS request failed: {e}")
            }
        })?;
    if !response.status().is_success() {
        return Err(format!("CUPS returned HTTP {}", response.status()));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("CUPS response unreadable: {e}"))
}

/// Every CUPS queue as Setup rows. Never fails: no daemon means no
/// queues, and a malformed reply is logged and skipped, not fatal.
pub async fn list_cups_printers() -> Vec<PrinterInfo> {
    let body = match post_ipp("/", build_cups_get_printers()).await {
        Ok(body) => body,
        Err(e) => {
            tracing::debug!("{e}");
            return Vec::new();
        }
    };
    match parse_cups_printers(&body) {
        Ok(queues) => queues
            .into_iter()
            .map(|q| PrinterInfo {
                id: q.name.clone(),
                name: q.name,
                address: q.uri,
                printer_type: PrinterType::System,
                language: PrinterLanguage::Pdf,
                status: printer_state_word(q.state).to_string(),
            })
            .collect(),
        Err(e) => {
            tracing::debug!("CUPS reply unusable: {e}");
            Vec::new()
        }
    }
}

/// A CUPS queue as a [`PrinterTransport`]: discovery lists it, the test
/// probe reads its attributes without printing, and sending is an IPP
/// Print-Job against the queue URI — the same bytes path as a network
/// IPP printer, which is exactly what CUPS is.
/// Blocking twin for the synchronous `enumerate_system_printers`
/// command: spins a throwaway current-thread runtime, so discovery
/// never needs an async context at the call site.
pub fn list_blocking() -> Vec<PrinterInfo> {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt.block_on(list_cups_printers()),
        Err(e) => {
            tracing::debug!("CUPS runtime failed: {e}");
            Vec::new()
        }
    }
}

pub struct CupsPrinter {
    name: String,
    uri: String,
}

impl CupsPrinter {
    pub fn new(name: String, address: String) -> Self {
        let uri = if address.trim().is_empty() {
            queue_uri(&name)
        } else {
            address
        };
        Self { name, uri }
    }

    fn ipp(&self) -> IppPrinter {
        IppPrinter::new(self.name.clone(), self.uri.clone())
    }
}

#[async_trait]
impl PrinterTransport for CupsPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        list_cups_printers().await
    }

    async fn test(&self) -> Result<(), String> {
        let body = post_ipp(
            "/",
            IppPrinter::build_get_printer_attributes(&ipp_uri(&self.uri)),
        )
        .await?;
        check_probe_reply(&self.name, &body)
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        // A CUPS queue is an IPP Print-Job like any other: the only
        // difference is the document-format. A raw queue (`lpadmin -m raw`)
        // must receive `application/octet-stream` so ESC/POS/ZPL/TSPL/CPCL/
        // raster bytes pass through unchanged; declaring them as PDF would
        // make cupsd filter them. The pipeline already sets `mime_type`
        // correctly per language (see `encode_for_language`).
        let format = if job.mime_type == "application/pdf" {
            "application/pdf"
        } else {
            "application/octet-stream"
        };
        self.ipp().send_bytes(&job.data, job.copies, format).await
    }
}

/// The `ipp://` form of a queue's HTTP URI, for the printer-uri attribute.
fn ipp_uri(http_uri: &str) -> String {
    if let Some(rest) = http_uri.strip_prefix("http://") {
        return format!("ipp://{rest}");
    }
    if let Some(rest) = http_uri.strip_prefix("https://") {
        return format!("ipps://{rest}");
    }
    http_uri.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(tag: u8, name: &str, value: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        out.extend_from_slice(&(name.len() as u16).to_be_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value);
        out
    }

    fn attr_int(name: &str, value: u32) -> Vec<u8> {
        let mut out = vec![0x23]; // enum
        out.extend_from_slice(&(name.len() as u16).to_be_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&value.to_be_bytes());
        out
    }

    fn get_printers_response() -> Vec<u8> {
        let mut body = vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
        for (name, uri, state) in [
            ("DeskJet", "ipp://localhost:631/printers/DeskJet", 3u32),
            ("Label", "ipp://localhost:631/printers/Label", 5u32),
        ] {
            body.push(0x04); // printer group
            body.extend(attr(0x42, "printer-name", name.as_bytes()));
            body.extend(attr(0x45, "printer-uri", uri.as_bytes()));
            body.extend(attr(0x44, "printer-location", b"office"));
            body.extend(attr_int("printer-state", state));
        }
        body.push(0x03);
        body
    }

    #[test]
    fn request_encodes_cups_get_printers() {
        let body = build_cups_get_printers();
        assert_eq!(&body[..8], &[0x01, 0x01, 0x40, 0x02, 0, 0, 0, 1]);
        assert!(body
            .windows(b"attributes-charset".len())
            .any(|w| w == b"attributes-charset"));
        assert_eq!(*body.last().unwrap(), 0x03);
    }

    #[test]
    fn response_splits_into_one_record_per_queue() {
        let queues = parse_cups_printers(&get_printers_response()).expect("parses");
        assert_eq!(queues.len(), 2);
        assert_eq!(queues[0].name, "DeskJet");
        assert_eq!(queues[0].uri, "ipp://localhost:631/printers/DeskJet");
        assert_eq!(queues[0].state, Some(3));
        assert_eq!(printer_state_word(queues[0].state), "idle");
        assert_eq!(queues[1].name, "Label");
        assert_eq!(queues[1].state, Some(5));
        assert_eq!(printer_state_word(queues[1].state), "stopped");
        assert_eq!(printer_state_word(None), "unknown");
    }

    #[test]
    fn non_ok_status_is_an_error_not_queues() {
        let mut body = vec![0x01, 0x01, 0x05, 0x01, 0, 0, 0, 1, 0x03];
        assert!(parse_cups_printers(&body).is_err());
        body[2] = 0x04;
        body[3] = 0x00;
        assert!(parse_cups_printers(&body).is_err());
    }

    #[test]
    fn ipp_uri_rewrites_the_scheme_only() {
        assert_eq!(
            ipp_uri("http://localhost:631/printers/A"),
            "ipp://localhost:631/printers/A"
        );
        assert_eq!(
            ipp_uri("https://print.local:631/printers/A"),
            "ipps://print.local:631/printers/A"
        );
        assert_eq!(ipp_uri("ipp://x/printers/A"), "ipp://x/printers/A");
    }

    // --- queue health: Get-Printer-Attributes replies ---

    fn attr_bool(name: &str, value: bool) -> Vec<u8> {
        attr(0x22, name, &[value as u8])
    }

    /// A Get-Printer-Attributes reply. `reasons` repeat the attribute name
    /// as empty after the first value (RFC 8010 §3.1.6), as a printer does.
    fn probe_reply(
        status: u16,
        state: Option<u32>,
        accepting: Option<bool>,
        reasons: &[&str],
    ) -> Vec<u8> {
        let mut body = vec![0x01, 0x01, (status >> 8) as u8, status as u8, 0, 0, 0, 1];
        body.push(0x01); // operation attributes
        body.extend(attr(0x47, "attributes-charset", b"utf-8"));
        body.push(0x04); // printer attributes
        body.extend(attr(0x42, "printer-name", b"Q"));
        if let Some(state) = state {
            body.extend(attr_int("printer-state", state));
        }
        if let Some(accepting) = accepting {
            body.extend(attr_bool("printer-is-accepting-jobs", accepting));
        }
        for (i, reason) in reasons.iter().enumerate() {
            let name = if i == 0 { "printer-state-reasons" } else { "" };
            body.extend(attr(0x44, name, reason.as_bytes()));
        }
        body.push(0x03);
        body
    }

    #[test]
    fn an_idle_accepting_queue_passes() {
        let body = probe_reply(0, Some(3), Some(true), &["none"]);
        assert_eq!(check_probe_reply("Q", &body), Ok(()));
    }

    #[test]
    fn a_busy_queue_passes() {
        let body = probe_reply(0, Some(4), Some(true), &["none"]);
        assert_eq!(check_probe_reply("Q", &body), Ok(()));
    }

    #[test]
    fn a_stopped_queue_fails_with_its_name() {
        let body = probe_reply(0, Some(5), Some(true), &["none"]);
        let err = check_probe_reply("Office", &body).unwrap_err();
        assert!(err.contains("CUPS queue `Office` is stopped"), "{err}");
    }

    #[test]
    fn a_stopped_queue_names_why_when_it_says() {
        let body = probe_reply(0, Some(5), Some(true), &["paused"]);
        let err = check_probe_reply("Q", &body).unwrap_err();
        assert!(err.contains("is stopped"), "{err}");
        assert!(err.contains("paused"), "{err}");
    }

    #[test]
    fn a_queue_refusing_jobs_fails() {
        let body = probe_reply(0, Some(3), Some(false), &["none"]);
        let err = check_probe_reply("Q", &body).unwrap_err();
        assert!(err.contains("not accepting jobs"), "{err}");
    }

    #[test]
    fn paper_out_fails_and_keeps_the_keyword() {
        let body = probe_reply(0, Some(3), Some(true), &["media-empty"]);
        let err = check_probe_reply("Q", &body).unwrap_err();
        assert!(err.contains("out of paper"), "{err}");
        assert!(err.contains("[media-empty]"), "{err}");
    }

    #[test]
    fn each_fault_reason_fails() {
        for (reason, words) in [
            ("media-jam", "paper jam"),
            ("media-needed", "out of paper"),
            ("offline-report", "offline"),
            ("toner-empty", "out of toner"),
            ("marker-supply-empty", "out of toner"),
            ("media-empty-error", "out of paper"),
            ("media-jam-error", "paper jam"),
            ("MEDIA-JAM", "paper jam"),
        ] {
            let body = probe_reply(0, Some(3), Some(true), &[reason]);
            let err = check_probe_reply("Q", &body)
                .expect_err(&format!("{reason} should block the queue"));
            assert!(err.contains(words), "{reason}: {err}");
        }
    }

    #[test]
    fn a_fault_in_a_longer_list_is_found() {
        let body = probe_reply(0, Some(3), Some(true), &["toner-low-warning", "media-jam"]);
        let err = check_probe_reply("Q", &body).unwrap_err();
        assert!(err.contains("paper jam"), "{err}");
        assert!(!err.contains("toner"), "{err}");
    }

    #[test]
    fn warnings_alone_do_not_fail() {
        for reason in [
            "toner-low",
            "toner-low-warning",
            "marker-supply-low-warning",
            "media-empty-warning",
            "media-low-report",
            "cover-open-report",
            "output-area-almost-full",
            "vendor-mystery",
        ] {
            let body = probe_reply(0, Some(3), Some(true), &[reason]);
            assert_eq!(
                check_probe_reply("Q", &body),
                Ok(()),
                "{reason} must not block a print"
            );
        }
    }

    #[test]
    fn a_reply_that_says_nothing_about_state_passes() {
        let body = probe_reply(0, None, None, &[]);
        assert_eq!(check_probe_reply("Q", &body), Ok(()));
        // Header only, no attributes at all.
        let bare = vec![0x01, 0x01, 0x00, 0x00, 0, 0, 0, 1, 0x03];
        assert_eq!(check_probe_reply("Q", &bare), Ok(()));
    }

    #[test]
    fn an_error_status_still_fails_before_state_is_read() {
        let body = probe_reply(0x0400, Some(3), Some(true), &["none"]);
        let err = check_probe_reply("Q", &body).unwrap_err();
        assert!(err.contains("refused the probe"), "{err}");
        assert!(err.contains("0x0400"), "{err}");
    }

    #[test]
    fn a_successful_class_status_is_not_a_refusal() {
        // 0x0001 successful-ok-ignored-or-substituted-attributes.
        let body = probe_reply(0x0001, Some(3), Some(true), &["none"]);
        assert_eq!(check_probe_reply("Q", &body), Ok(()));
    }

    #[test]
    fn a_truncated_reply_does_not_panic() {
        let full = probe_reply(0, Some(5), Some(false), &["media-empty", "media-jam"]);
        for cut in 0..full.len() {
            let _ = check_probe_reply("Q", &full[..cut]);
        }
    }

    #[test]
    fn health_reads_all_three_attributes() {
        let body = probe_reply(0, Some(5), Some(false), &["media-empty", "media-jam"]);
        let health = parse_queue_health(&body);
        assert_eq!(health.state, Some(5));
        assert_eq!(health.accepting, Some(false));
        assert_eq!(health.reasons, vec!["media-empty", "media-jam"]);
    }
}
