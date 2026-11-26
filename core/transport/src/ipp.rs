//! IPP / CUPS: page printers reached over IPP, one HTTP request per unit.
//!
//! Each unit is its own `Print-Job`; the reply is checked for honesty —
//! the operation status and the `job-state` the server reports. A page
//! printer cannot confirm a print in the raw sense (there is no status
//! dialect on the line), so jobs end `SentUnconfirmed` at the job level;
//! the byte-level honesty lives in the per-unit reply check (plan §5.7).
//!
//! Plain HTTP only in this increment: `ipps://`/`https://` endpoints are
//! parsed and rejected with a clear error — TLS is a follow-up. CUPS on
//! the machines we support listens on plain `http://localhost:631`.
//!
//! Also home to the pure CUPS helpers (queue listing, queue health,
//! blocking-reason vocabulary) that the discovery/probe phase builds on.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use crate::{SendError, SendPlan, Transport, UnitReport};

/// The plain-HTTP URL to POST IPP requests to.
const MAX_HEADERS: usize = 16 * 1024;
/// A sane cap for an IPP response body; anything bigger is a bug or a
/// hostile peer, not a reply.
const MAX_RESPONSE: u64 = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

/// A parsed IPP endpoint: where to POST (plain HTTP) and the `ipp://` URI
/// the server expects in `printer-uri`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IppEndpoint {
    /// The plain-HTTP URL to POST the IPP request to.
    pub url: String,
    /// The `ipp://` URI to name in `printer-uri`.
    pub printer_uri: String,
    /// `host:port` to dial (a default port is filled in when missing).
    pub authority: String,
}

/// Parse an IPP endpoint from user input.
///
/// Accepted forms: `host`, `host:port`, `http://host[:port][/path]`,
/// `ipp://…`, `ipps://…`, `https://…`. Without a scheme the endpoint is
/// plain HTTP on port 631; without a port the scheme's default is filled
/// in (631, or 443 for TLS); without a path `/ipp/print` is used. An
/// `ipp://` or `ipps://` URI is posted over plain `http`/`https` — the
/// `ipp://` form is what goes in the request body, the `http://` form is
/// where the bytes actually go.
pub fn parse_endpoint(address: &str) -> IppEndpoint {
    let address = address.trim();
    let (scheme, rest) = match address.find("://") {
        Some(i) => (&address[..i], &address[i + 3..]),
        None => ("http", address),
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let path = if path.is_empty() { "/ipp/print" } else { path };
    let tls = matches!(scheme, "https" | "ipps");
    let has_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok());
    let authority = if has_port {
        authority.to_string()
    } else {
        format!("{authority}:{}", if tls { 443 } else { 631 })
    };
    IppEndpoint {
        url: format!("{}://{authority}{path}", if tls { "https" } else { "http" }),
        printer_uri: format!("{}://{authority}{path}", if tls { "ipps" } else { "ipp" }),
        authority,
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// A page printer reached over IPP (CUPS, or the printer's own IPP
/// interface). Plain HTTP only: TLS endpoints are rejected at connect.
#[derive(Debug)]
pub struct IppTransport {
    endpoint: IppEndpoint,
    /// Sent as `requesting-user-name` in every request.
    user: String,
    /// Declared as `document-format` for each unit.
    document_format: &'static str,
}

impl IppTransport {
    /// Parse `address` and verify the endpoint is reachable (one dial,
    /// dropped at once). Refuses TLS endpoints: see the module docs.
    pub fn connect(address: &str) -> Result<Self, SendError> {
        let endpoint = parse_endpoint(address);
        if endpoint.url.starts_with("https") {
            return Err(SendError::Io(
                "TLS (ipps/https) endpoint: TLS support is not implemented yet".to_string(),
            ));
        }
        let _ = dial(&endpoint.authority, Duration::from_secs(3))?;
        Ok(IppTransport {
            endpoint,
            user: "PrintNinja".to_string(),
            document_format: "application/octet-stream",
        })
    }

    /// Override the `requesting-user-name` sent with every request.
    pub fn with_user(mut self, user: impl Into<String>) -> Self {
        self.user = user.into();
        self
    }

    /// Override the `document-format` declared for each unit
    /// (see [`ipp_document_format`]).
    pub fn with_document_format(mut self, document_format: &'static str) -> Self {
        self.document_format = document_format;
        self
    }
}

impl Transport for IppTransport {
    fn send_unit(&mut self, data: &[u8], plan: &SendPlan) -> UnitReport {
        // One Print-Job per unit: the reply names the outcome of exactly
        // this unit, so a rejected unit is an honest per-unit failure.
        let body = build_print_job(
            &self.endpoint.printer_uri,
            &self.user,
            self.document_format,
            1,
            data,
        );
        let reply = match ipp_roundtrip(&self.endpoint, &body, plan.send) {
            Ok(r) => r,
            Err(e) => {
                return UnitReport {
                    bytes_written: 0,
                    error: Some(e),
                }
            }
        };
        match parse_status_code(&reply) {
            Err(msg) => UnitReport {
                bytes_written: 0,
                error: Some(SendError::Io(format!("malformed IPP response: {msg}"))),
            },
            // Status class 0x00xx is a success; anything else is a refusal.
            Ok(status) if status >> 8 != 0 => UnitReport {
                bytes_written: 0,
                error: Some(SendError::Io(format!(
                    "the printer rejected the job: {}",
                    describe_status(status)
                ))),
            },
            Ok(_) => match parse_job_outcome(&reply) {
                // The server reported a terminal fault on this job.
                Some(outcome) if !outcome.is_ok() => UnitReport {
                    bytes_written: 0,
                    error: Some(SendError::Io(format!(
                        "the printer did not print the job: {}",
                        outcome.sentence()
                    ))),
                },
                // Accepted (or said nothing) — the bytes are in the queue.
                _ => UnitReport::ok(data.len() as u64),
            },
        }
    }

    fn status_reply(
        &mut self,
        _query: &[u8],
        _deadline: Duration,
        _complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError> {
        // Page printers speak no status dialect over the line: the job
        // ends `SentUnconfirmed`, and the per-unit reply check above is
        // the honesty mechanism (same pattern as the spooler).
        Ok(None)
    }

    fn finish(&mut self, _plan: &SendPlan) {
        // Each request already closed its own connection; there is
        // nothing to hold open.
    }
}

/// The MIME type to declare for one unit, from the render result's MIME:
/// PDF stays PDF, everything else goes out as opaque bytes.
pub fn ipp_document_format(mime: &str) -> &'static str {
    let mime = mime.trim().to_ascii_lowercase();
    if mime.is_empty() || mime == "application/pdf" {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/// One plain-HTTP POST of an IPP request and the whole reply body.
///
/// A fresh connection is made per call and closed with the reply
/// (`Connection: close`) — there is no keep-alive state. `deadline`
/// bounds both the dial and the reply. Shared by the transport and the
/// discovery/probe phase (which sends Get-Printer-Attributes and friends
/// the same way).
pub fn ipp_roundtrip(
    endpoint: &IppEndpoint,
    body: &[u8],
    deadline: Duration,
) -> Result<Vec<u8>, SendError> {
    let stream = dial(&endpoint.authority, deadline)?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        path_of(endpoint),
        endpoint.authority,
        body.len()
    );
    let stream = write_request(stream, request.as_bytes(), body, deadline)?;
    read_response(stream, deadline)
}

/// Dial `host:port`, giving up after `deadline`. A failed dial is
/// retryable — nothing was said, nothing was heard. The authority may be
/// a hostname, so it is resolved first; every address it yields is tried.
fn dial(authority: &str, deadline: Duration) -> Result<TcpStream, SendError> {
    let addrs = authority
        .to_socket_addrs()
        .map_err(|e| SendError::Connect(format!("could not resolve {authority}: {e}")))?;
    let mut error: Option<String> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, deadline) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(e) => error = Some(e.to_string()),
        }
    }
    Err(SendError::Connect(format!(
        "could not reach {authority}: {}",
        error.unwrap_or_else(|| "no addresses".into())
    )))
}

/// The request path: `url` is `http://<authority><path>`.
fn path_of(endpoint: &IppEndpoint) -> &str {
    let after_scheme = &endpoint.url[endpoint.url.find("://").map(|i| i + 3).unwrap_or(0)..];
    &after_scheme[endpoint.authority.len()..]
}

fn write_request(
    mut stream: TcpStream,
    head: &[u8],
    body: &[u8],
    deadline: Duration,
) -> Result<TcpStream, SendError> {
    stream
        .set_write_timeout(Some(deadline))
        .map_err(|e| SendError::Io(e.to_string()))?;
    let result = stream
        .write_all(head)
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush());
    let _ = stream.set_write_timeout(None);
    result.map(|_| stream).map_err(|e| match e.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => SendError::SendDeadline,
        ErrorKind::ConnectionAborted | ErrorKind::ConnectionReset | ErrorKind::BrokenPipe => {
            SendError::ClosedByPeer
        }
        _ => SendError::Io(e.to_string()),
    })
}

/// Read the response: the header up to CRLFCRLF, then exactly the
/// `Content-Length` bytes (or to EOF when the server gives no length).
fn read_response(mut stream: TcpStream, deadline: Duration) -> Result<Vec<u8>, SendError> {
    let head = read_headers(&mut stream, deadline)?;
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.lines();
    let status_line = lines.next().unwrap_or("");
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| SendError::Io(format!("malformed HTTP status line: {status_line:?}")))?;
    if !(200..300).contains(&code) {
        return Err(SendError::Io(format!("IPP server returned HTTP {code}")));
    }
    let mut content_length: Option<u64> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().ok();
            }
        }
    }
    let mut out = Vec::new();
    match content_length {
        Some(len) if len > MAX_RESPONSE => {
            return Err(SendError::Io(format!(
                "unreasonably large reply: {len} bytes"
            )))
        }
        Some(len) => read_exact_budgeted(&mut stream, &mut out, len as usize, deadline)?,
        // No length: the connection closes with the reply (we asked for
        // `Connection: close`), so read to EOF.
        None => read_to_eof_budgeted(&mut stream, &mut out, deadline)?,
    }
    let _ = stream.set_read_timeout(None);
    Ok(out)
}

fn read_headers(stream: &mut TcpStream, deadline: Duration) -> Result<Vec<u8>, SendError> {
    let end = Instant::now() + deadline;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SendError::Io(format!("no reply within {deadline:?}")));
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| SendError::Io(e.to_string()))?;
        match stream.read(&mut byte) {
            Ok(0) => return Err(SendError::ClosedByPeer),
            Ok(_) => {
                head.push(byte[0]);
                if head.len() > MAX_HEADERS {
                    return Err(SendError::Io("unreasonably large HTTP headers".into()));
                }
            }
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                return Err(SendError::Io(format!("no reply within {deadline:?}")))
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if matches!(e.kind(), ErrorKind::ConnectionReset | ErrorKind::BrokenPipe) => {
                return Err(SendError::ClosedByPeer)
            }
            Err(e) => return Err(SendError::Io(e.to_string())),
        }
    }
    Ok(head)
}

fn read_exact_budgeted(
    stream: &mut TcpStream,
    out: &mut Vec<u8>,
    mut len: usize,
    deadline: Duration,
) -> Result<(), SendError> {
    let end = Instant::now() + deadline;
    let mut buf = [0u8; 4096];
    while len > 0 {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SendError::Io(format!("no reply within {deadline:?}")));
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| SendError::Io(e.to_string()))?;
        match stream.read(&mut buf) {
            Ok(0) => return Err(SendError::ClosedByPeer),
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                len -= n;
            }
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                return Err(SendError::Io(format!("no reply within {deadline:?}")))
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if matches!(e.kind(), ErrorKind::ConnectionReset | ErrorKind::BrokenPipe) => {
                return Err(SendError::ClosedByPeer)
            }
            Err(e) => return Err(SendError::Io(e.to_string())),
        }
    }
    Ok(())
}

fn read_to_eof_budgeted(
    stream: &mut TcpStream,
    out: &mut Vec<u8>,
    deadline: Duration,
) -> Result<(), SendError> {
    let end = Instant::now() + deadline;
    let mut buf = [0u8; 4096];
    loop {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SendError::Io(format!("no reply within {deadline:?}")));
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|e| SendError::Io(e.to_string()))?;
        match stream.read(&mut buf) {
            Ok(0) => return Ok(()), // the peer closed: the reply is complete
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() as u64 > MAX_RESPONSE {
                    return Err(SendError::Io("unreasonably large reply".into()));
                }
            }
            Err(e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {
                return Err(SendError::Io(format!("no reply within {deadline:?}")))
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) if matches!(e.kind(), ErrorKind::ConnectionReset | ErrorKind::BrokenPipe) => {
                return Err(SendError::ClosedByPeer)
            }
            Err(e) => return Err(SendError::Io(e.to_string())),
        }
    }
}

// ---------------------------------------------------------------------------
// IPP request builders
// ---------------------------------------------------------------------------

/// Append one attribute to an IPP body: tag, name (u16 BE length),
/// value (u16 BE length).
pub(crate) fn push_attr(body: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
    body.push(tag);
    body.extend_from_slice(&(name.len() as u16).to_be_bytes());
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(&(value.len() as u16).to_be_bytes());
    body.extend_from_slice(value);
}

/// Append one 32-bit integer attribute (tag 0x21, value 4 bytes BE).
pub(crate) fn push_integer(body: &mut Vec<u8>, name: &str, value: i32) {
    body.push(0x21);
    body.extend_from_slice(&(name.len() as u16).to_be_bytes());
    body.extend_from_slice(name.as_bytes());
    body.extend_from_slice(&4u16.to_be_bytes());
    body.extend_from_slice(&value.to_be_bytes());
}

/// A Print-Job request: one document, submitted against `printer_uri`.
pub fn build_print_job(
    printer_uri: &str,
    user: &str,
    document_format: &str,
    copies: u32,
    document: &[u8],
) -> Vec<u8> {
    let mut body = vec![0x01, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01];
    body.push(0x01); // operation-attributes group
    push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
    push_attr(&mut body, 0x45, "printer-uri", printer_uri.as_bytes());
    push_attr(&mut body, 0x42, "requesting-user-name", user.as_bytes());
    push_attr(&mut body, 0x42, "job-name", b"PrintNinja Job");
    push_attr(
        &mut body,
        0x44,
        "document-format",
        document_format.as_bytes(),
    );
    if copies > 1 {
        push_integer(&mut body, "copies", copies as i32);
    }
    // Ask the server to hold the document verbatim: no PDL translation.
    push_attr(&mut body, 0x22, "ipp-attribute-fidelity", &[0x00]);
    body.push(0x03); // end of attributes; the document follows
    body.extend_from_slice(document);
    body
}

/// A Get-Printer-Attributes request (op 0x000B) for `printer_uri`.
pub fn build_get_printer_attributes(printer_uri: &str) -> Vec<u8> {
    let mut body = vec![0x01, 0x01, 0x00, 0x0B, 0x00, 0x00, 0x00, 0x01];
    body.push(0x01);
    push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
    push_attr(&mut body, 0x45, "printer-uri", printer_uri.as_bytes());
    body.push(0x03);
    body
}

/// A Get-Job-Attributes request (op 0x0008) for `job_uri`.
pub fn build_get_job_attributes(job_uri: &str) -> Vec<u8> {
    let mut body = vec![0x01, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01];
    body.push(0x01);
    push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
    push_attr(&mut body, 0x45, "job-uri", job_uri.as_bytes());
    body.push(0x03);
    body
}

/// A CUPS-Get-Printers request (op 0x4002): list the local queues.
pub fn build_cups_get_printers() -> Vec<u8> {
    let mut body = vec![0x01, 0x01, 0x40, 0x02, 0x00, 0x00, 0x00, 0x01];
    body.push(0x01);
    push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
    push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
    body.push(0x03);
    body
}

// ---------------------------------------------------------------------------
// IPP response parsing
// ---------------------------------------------------------------------------

/// The operation status of an IPP response: bytes 2–3, big endian.
pub fn parse_status_code(body: &[u8]) -> Result<u16, String> {
    if body.len() < 4 {
        return Err(format!(
            "malformed IPP response: {} bytes, need at least 4",
            body.len()
        ));
    }
    if body[0] != 0x01 && body[0] != 0x02 {
        return Err(format!(
            "not an IPP response (starts 0x{:02x}{:02x})",
            body[0], body[1]
        ));
    }
    Ok(u16::from_be_bytes([body[2], body[3]]))
}

/// Plain words for an IPP operation status: class name plus hex code.
pub fn describe_status(status: u16) -> String {
    let name = match status {
        0x0000 => "successful-ok",
        0x0001 => "successful-ok-ignored-or-substituted-attributes",
        0x0002 => "successful-ok-conflicting-attributes",
        0x0400 => "client-error-bad-request",
        0x0500 => "server-error-internal-error",
        0x0501 => "server-error-operation-not-supported",
        0x0502 => "server-error-service-unavailable",
        0x0503 => "server-error-version-not-supported",
        0x0504 => "server-error-device-error",
        0x0505 => "server-error-temporary-error",
        0x0506 => "server-error-not-accepting-jobs",
        0x0507 => "server-error-busy",
        0x0508 => "server-error-job-canceled",
        _ if status >> 8 == 0x04 => "client-error",
        _ if status >> 8 == 0x05 => "server-error",
        _ => "unexpected status",
    };
    format!("IPP status 0x{status:04x} ({name})")
}

/// All attributes of an IPP body as `(name, tag, value)` triples.
///
/// Multi-valued attributes carry their name once; the following values
/// repeat with an empty name, so the last non-empty name is carried
/// forward. Group delimiters (tag < 0x10) are skipped; the
/// end-of-attributes marker (0x03) stops the scan. Every step is bounds
/// checked: a truncated body simply ends the list.
pub(crate) fn parse_attributes(body: &[u8]) -> Vec<(String, u8, Vec<u8>)> {
    let mut out: Vec<(String, u8, Vec<u8>)> = Vec::new();
    let mut last_name = String::new();
    let mut i = 8;
    while i < body.len() {
        let tag = body[i];
        if tag < 0x10 {
            if tag == 0x03 {
                break;
            }
            i += 1;
            continue;
        }
        if i + 3 > body.len() {
            break;
        }
        let name_len = u16::from_be_bytes([body[i + 1], body[i + 2]]) as usize;
        let name_at = i + 3;
        if name_at + name_len + 2 > body.len() {
            break;
        }
        if name_len > 0 {
            last_name = String::from_utf8_lossy(&body[name_at..name_at + name_len]).into_owned();
        }
        let len_at = name_at + name_len;
        let value_len = u16::from_be_bytes([body[len_at], body[len_at + 1]]) as usize;
        let value_at = len_at + 2;
        if value_at + value_len > body.len() {
            break;
        }
        out.push((
            last_name.clone(),
            tag,
            body[value_at..value_at + value_len].to_vec(),
        ));
        i = value_at + value_len;
    }
    out
}

/// What the server said about a job: its final state and reasons.
pub(crate) struct JobOutcome {
    state: Option<u8>,
    reasons: Vec<String>,
}

impl JobOutcome {
    /// A job is fine when it completed or is still on its way; a fault
    /// is a terminal state (stopped, canceled, aborted). No state at all
    /// is not a failure — the server simply said nothing.
    fn is_ok(&self) -> bool {
        matches!(self.state, None | Some(3) | Some(4) | Some(5) | Some(9))
    }

    /// One sentence for the job result: the reason in plain words, the
    /// raw keywords in brackets.
    fn sentence(&self) -> String {
        if let Some(text) = describe_reasons(&self.reasons) {
            return format!("{text} [{}]", self.reasons.join(", "));
        }
        match self.state {
            Some(n) => format!(
                "the printer reported job-state {n} ({})",
                describe_job_state(n)
            ),
            None => "the printer reported no job status".to_string(),
        }
    }
}

/// The job group of a Print-Job reply, if there is one: `job-state`
/// (integer or enum, 4 bytes BE) and `job-state-reasons`. Vendor
/// extensions beyond 255 do not read as "completed" — they are simply
/// unknown.
pub(crate) fn parse_job_outcome(body: &[u8]) -> Option<JobOutcome> {
    let mut state: Option<u8> = None;
    let mut reasons: Vec<String> = Vec::new();
    for (name, tag, value) in parse_attributes(body) {
        if name == "job-state" && matches!(tag, 0x21 | 0x23) && value.len() == 4 {
            let v = u32::from_be_bytes([value[0], value[1], value[2], value[3]]);
            state = u8::try_from(v).ok();
        }
        if name == "job-state-reasons" && tag == 0x44 {
            reasons.push(String::from_utf8_lossy(&value).into_owned());
        }
    }
    if state.is_none() && reasons.is_empty() {
        return None;
    }
    Some(JobOutcome { state, reasons })
}

fn describe_job_state(state: u8) -> &'static str {
    match state {
        3 => "pending",
        4 => "pending-held",
        5 => "processing",
        6 => "processing-stopped",
        7 => "canceled",
        8 => "aborted",
        9 => "completed",
        _ => "unknown",
    }
}

/// Plain words for one IPP reason keyword, when we know it.
pub(crate) fn describe_reason(reason: &str) -> Option<String> {
    let reason = reason.trim().to_ascii_lowercase();
    let text = match reason.as_str() {
        "media-empty" | "media-empty-warning" => "it is out of paper",
        "media-jam" | "media-jam-warning" => "there is a paper jam",
        "paused" | "printer-stopped" | "stopped-partly" => "it is paused",
        "offline-report" => "it is offline",
        "toner-empty" | "toner-life-end" | "marker-supply-empty" => {
            "it has run out of toner or ink"
        }
        "toner-low" | "marker-supply-low-warning" => "it is low on toner or ink",
        "output-area-full" => "its output tray is full",
        _ => return None,
    };
    Some(text.to_string())
}

/// Plain words for a list of reason keywords (skipping `none`), joined
/// with "and", or `None` when nothing in the list is known.
fn describe_reasons(reasons: &[String]) -> Option<String> {
    let mut parts: Vec<String> = reasons
        .iter()
        .filter(|r| !r.trim().eq_ignore_ascii_case("none"))
        .filter_map(|r| describe_reason(r))
        .collect();
    parts.dedup();
    (!parts.is_empty()).then(|| parts.join(" and "))
}

// ---------------------------------------------------------------------------
// CUPS helpers (queue listing, queue health, blocking reasons)
// ---------------------------------------------------------------------------

/// The CUPS base URL for the local spooler: the user's setting wins,
/// then the `CUPS_SERVER`-style environment value, then the default
/// `http://localhost:631`. Trailing slashes are trimmed. The core crate
/// has no settings table, so the caller supplies both arguments.
pub fn resolve_cups_base_url(setting: Option<&str>, env: Option<&str>) -> String {
    setting
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| env.map(str::trim).filter(|s| !s.is_empty()))
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "http://localhost:631".to_string())
}

/// The IPP URI of one CUPS queue, for use in `printer-uri`.
pub fn queue_uri(base_url: &str, name: &str) -> String {
    format!("{}/printers/{name}", base_url.trim_end_matches('/'))
}

/// Rewrite a CUPS queue URI from `http(s)://` to `ipp(s)://`.
pub fn ipp_uri(http_uri: &str) -> String {
    if let Some(rest) = http_uri.strip_prefix("http://") {
        return format!("ipp://{rest}");
    }
    if let Some(rest) = http_uri.strip_prefix("https://") {
        return format!("ipps://{rest}");
    }
    http_uri.to_string()
}

/// One CUPS queue, from a CUPS-Get-Printers reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CupsQueue {
    pub name: String,
    pub uri: String,
    /// `printer-state`: 3 idle, 4 busy, 5 stopped.
    pub state: Option<u8>,
}

/// Parse a CUPS-Get-Printers reply into one record per queue. A new
/// record starts at each `printer-name`; `printer-uri` and
/// `printer-state` attach to the current record.
pub fn parse_cups_printers(body: &[u8]) -> Result<Vec<CupsQueue>, String> {
    let status = parse_status_code(body)?;
    if status != 0 {
        return Err(format!("CUPS refused the request: status 0x{status:04x}"));
    }
    let mut out: Vec<CupsQueue> = Vec::new();
    let mut current: Option<CupsQueue> = None;
    for (name, tag, value) in parse_attributes(body) {
        match (name.as_str(), tag) {
            ("printer-name", 0x42 | 0x45) => {
                if let Some(c) = current.take() {
                    out.push(c);
                }
                current = Some(CupsQueue {
                    name: String::from_utf8_lossy(&value).into_owned(),
                    uri: String::new(),
                    state: None,
                });
            }
            ("printer-uri", 0x45) => {
                if let Some(c) = current.as_mut() {
                    c.uri = String::from_utf8_lossy(&value).into_owned();
                }
            }
            ("printer-state", 0x21 | 0x23) if value.len() == 4 => {
                let v = u32::from_be_bytes([value[0], value[1], value[2], value[3]]);
                if let (Some(c), Some(s)) = (current.as_mut(), u8::try_from(v).ok()) {
                    c.state = Some(s);
                }
            }
            _ => {}
        }
    }
    if let Some(c) = current {
        out.push(c);
    }
    Ok(out)
}

/// The queue's state in plain words (3 idle, 4 processing, 5 stopped).
pub fn printer_state_word(state: Option<u8>) -> &'static str {
    match state {
        Some(3) => "idle",
        Some(4) => "processing",
        Some(5) => "stopped",
        _ => "unknown",
    }
}

/// What a queue probe says about the queue's health.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueueHealth {
    /// `printer-state`: 3 idle, 4 busy, 5 stopped.
    pub state: Option<u8>,
    /// `printer-is-accepting-jobs`.
    pub accepting: Option<bool>,
    /// `printer-state-reasons`, one entry per value.
    pub reasons: Vec<String>,
}

/// Parse the health attributes out of a Get-Printer-Attributes reply.
pub fn parse_queue_health(body: &[u8]) -> QueueHealth {
    let mut health = QueueHealth::default();
    for (name, tag, value) in parse_attributes(body) {
        match (name.as_str(), tag) {
            ("printer-state", 0x21 | 0x23) if value.len() == 4 => {
                let v = u32::from_be_bytes([value[0], value[1], value[2], value[3]]);
                health.state = u8::try_from(v).ok();
            }
            ("printer-is-accepting-jobs", 0x22) if value.len() == 1 => {
                health.accepting = Some(value[0] != 0);
            }
            ("printer-state-reasons", 0x44) => {
                health
                    .reasons
                    .push(String::from_utf8_lossy(&value).into_owned());
            }
            _ => {}
        }
    }
    health
}

/// Whether one reason keyword blocks printing. Warnings and reports
/// (`-warning`, `-report` suffixes) never block on their own — except
/// `offline-report`, which means the queue is unreachable. Faults block
/// with or without an `-error` suffix.
pub fn is_blocking_reason(reason: &str) -> bool {
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

/// Plain words for the blocking reasons in a list, with the raw keywords
/// in brackets: `it is out of paper [media-empty]`. `None` when nothing
/// in the list blocks.
pub fn describe_blocking(reasons: &[String]) -> Option<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    let mut raws: Vec<String> = Vec::new();
    for reason in reasons {
        let reason = reason.trim().to_ascii_lowercase();
        if !is_blocking_reason(&reason) {
            continue;
        }
        let base: &str = reason.strip_suffix("-error").unwrap_or(&reason);
        if seen.iter().any(|s| s == base) {
            continue;
        }
        // `media-needed` (the PDL name) is the same fault as `media-empty`.
        let mapped = if base == "media-needed" {
            "media-empty"
        } else {
            base
        };
        if let Some(text) = describe_reason(mapped) {
            seen.push(base.to_string());
            parts.push(text);
            raws.push(base.to_string());
        }
    }
    (!parts.is_empty()).then(|| format!("{} [{}]", parts.join(" and "), raws.join(", ")))
}

/// The problem with a queue, in plain words, or `None` when the queue is
/// healthy. Priority: stopped > not accepting > a blocking fault.
pub fn queue_problem(name: &str, health: &QueueHealth) -> Option<String> {
    let cause = describe_blocking(&health.reasons);
    if health.state == Some(5) {
        return Some(match cause {
            Some(c) => format!("CUPS queue `{name}` is stopped: {c}"),
            None => format!("CUPS queue `{name}` is stopped"),
        });
    }
    if health.accepting == Some(false) {
        return Some(match cause {
            Some(c) => format!("CUPS queue `{name}` is not accepting jobs: {c}"),
            None => format!("CUPS queue `{name}` is not accepting jobs"),
        });
    }
    cause.map(|c| format!("CUPS queue `{name}` cannot print: {c}"))
}

/// Check a probe reply (Get-Printer-Attributes) for one queue: the
/// operation must succeed, and the queue must not report a blocking
/// fault. `0x0001` (ignored attributes) is still a success.
pub fn check_probe_reply(name: &str, body: &[u8]) -> Result<(), String> {
    let status = parse_status_code(body)?;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- test builders ------------------------------------------------------

    fn attr(tag: u8, name: &str, value: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        push_attr(&mut out, tag, name, value);
        out
    }

    fn attr_int(name: &str, value: i32) -> Vec<u8> {
        let mut out = Vec::new();
        push_integer(&mut out, name, value);
        out
    }

    fn attr_bool(name: &str, value: bool) -> Vec<u8> {
        attr(0x22, name, &[if value { 1 } else { 0 }])
    }

    /// A full IPP response: version, status, request id, the
    /// operation-attributes group, then the given groups, closed with
    /// end-of-attributes.
    fn ipp_response(status: u16, groups: &[&[u8]]) -> Vec<u8> {
        let mut body = vec![0x01, 0x01, (status >> 8) as u8, status as u8, 0, 0, 0, 1];
        body.push(0x01);
        body.extend(attr(0x47, "attributes-charset", b"utf-8"));
        body.extend(attr(0x48, "attributes-natural-language", b"en"));
        for g in groups {
            body.extend_from_slice(g);
        }
        body.push(0x03);
        body
    }

    fn job_group(state: Option<i32>, reasons: &[&str]) -> Vec<u8> {
        let mut g = vec![0x02];
        if let Some(s) = state {
            g.extend(attr_int("job-state", s));
        }
        for (i, r) in reasons.iter().enumerate() {
            g.extend(attr(
                0x44,
                if i == 0 { "job-state-reasons" } else { "" },
                r.as_bytes(),
            ));
        }
        g.push(0x03);
        g
    }

    fn probe_reply(
        status: u16,
        state: Option<i32>,
        accepting: Option<bool>,
        reasons: &[&str],
    ) -> Vec<u8> {
        let mut g = vec![0x04];
        if let Some(s) = state {
            g.extend(attr_int("printer-state", s));
        }
        if let Some(a) = accepting {
            g.extend(attr_bool("printer-is-accepting-jobs", a));
        }
        for (i, r) in reasons.iter().enumerate() {
            g.extend(attr(
                0x44,
                if i == 0 { "printer-state-reasons" } else { "" },
                r.as_bytes(),
            ));
        }
        g.push(0x03);
        ipp_response(status, &[&g])
    }

    fn printers_reply(status: u16, queues: &[(String, String, Option<i32>)]) -> Vec<u8> {
        let mut g = Vec::new();
        for (i, (name, uri, state)) in queues.iter().enumerate() {
            if i > 0 {
                g.push(0x05);
            }
            g.extend(attr(0x42, "printer-name", name.as_bytes()));
            g.extend(attr(0x45, "printer-uri", uri.as_bytes()));
            if let Some(s) = state {
                g.extend(attr_int("printer-state", *s));
            }
        }
        ipp_response(status, &[&g])
    }

    fn find<'a>(attrs: &'a [(String, u8, Vec<u8>)], name: &str) -> Option<&'a [u8]> {
        attrs
            .iter()
            .find(|(n, _, _)| n == name)
            .map(|(_, _, v)| v.as_slice())
    }

    // -- endpoint -----------------------------------------------------------

    #[test]
    fn bare_host_defaults_to_plain_cups() {
        let e = parse_endpoint("192.168.1.10");
        assert_eq!(e.url, "http://192.168.1.10:631/ipp/print");
        assert_eq!(e.printer_uri, "ipp://192.168.1.10:631/ipp/print");
        assert_eq!(e.authority, "192.168.1.10:631");
    }

    #[test]
    fn explicit_port_and_path_are_kept() {
        let e = parse_endpoint("printer.local:8080/ipp/files");
        assert_eq!(e.url, "http://printer.local:8080/ipp/files");
        assert_eq!(e.printer_uri, "ipp://printer.local:8080/ipp/files");
    }

    #[test]
    fn ipp_scheme_is_posted_over_http() {
        // The ipp:// form is what goes in the body; the bytes are posted
        // over plain http.
        let e = parse_endpoint("ipp://host/ipp/print");
        assert_eq!(e.url, "http://host:631/ipp/print");
        assert_eq!(e.printer_uri, "ipp://host:631/ipp/print");
    }

    #[test]
    fn tls_endpoint_defaults_to_443_and_ipps() {
        let e = parse_endpoint("https://host/printers/1");
        assert_eq!(e.url, "https://host:443/printers/1");
        assert_eq!(e.printer_uri, "ipps://host:443/printers/1");
    }

    #[test]
    fn ipv6_brackets_are_kept() {
        let e = parse_endpoint("[::1]");
        assert_eq!(e.url, "http://[::1]:631/ipp/print");
        assert_eq!(e.authority, "[::1]:631");
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(
            parse_endpoint("  192.168.1.10  "),
            parse_endpoint("192.168.1.10")
        );
    }

    // -- request builders ---------------------------------------------------

    #[test]
    fn print_job_encodes_version_and_operation() {
        let body = build_print_job("ipp://p:631/ipp/print", "u", "application/pdf", 1, b"doc");
        assert_eq!(&body[..8], &[0x01, 0x01, 0x00, 0x02, 0, 0, 0, 1]);
        assert_eq!(body[8], 0x01, "the operation-attributes group");
    }

    #[test]
    fn print_job_carries_the_required_attributes() {
        let body = build_print_job(
            "ipp://192.168.1.10:631/ipp/print",
            "alice",
            "application/pdf",
            1,
            b"doc",
        );
        let attrs = parse_attributes(&body);
        assert_eq!(
            find(&attrs, "attributes-charset"),
            Some(b"utf-8".as_slice())
        );
        assert_eq!(
            find(&attrs, "attributes-natural-language"),
            Some(b"en".as_slice())
        );
        assert_eq!(
            find(&attrs, "printer-uri"),
            Some(b"ipp://192.168.1.10:631/ipp/print".as_slice())
        );
        assert_eq!(
            find(&attrs, "requesting-user-name"),
            Some(b"alice".as_slice())
        );
        assert_eq!(find(&attrs, "job-name"), Some(b"PrintNinja Job".as_slice()));
        assert_eq!(
            find(&attrs, "document-format"),
            Some(b"application/pdf".as_slice())
        );
        assert_eq!(
            find(&attrs, "ipp-attribute-fidelity"),
            Some([0x00].as_slice())
        );
    }

    #[test]
    fn print_job_copies_only_when_more_than_one() {
        let one = build_print_job("ipp://p", "u", "application/pdf", 1, b"d");
        assert!(find(&parse_attributes(&one), "copies").is_none());
        let three = build_print_job("ipp://p", "u", "application/pdf", 3, b"d");
        assert_eq!(
            find(&parse_attributes(&three), "copies"),
            Some([0, 0, 0, 3].as_slice())
        );
    }

    #[test]
    fn print_job_ends_with_the_document_after_end_of_attributes() {
        let doc = b"\x25PDF-1.4";
        let body = build_print_job("ipp://p", "u", "application/pdf", 1, doc);
        let (head, tail) = body.split_at(body.len() - doc.len());
        assert_eq!(head.last(), Some(&0x03));
        assert_eq!(tail, doc);
    }

    #[test]
    fn get_printer_attributes_encodes_its_operation() {
        let body = build_get_printer_attributes("ipp://p:631/printers/1");
        assert_eq!(&body[..8], &[0x01, 0x01, 0x00, 0x0B, 0, 0, 0, 1]);
        assert_eq!(body.last(), Some(&0x03));
        assert_eq!(
            find(&parse_attributes(&body), "printer-uri"),
            Some(b"ipp://p:631/printers/1".as_slice())
        );
    }

    #[test]
    fn get_job_attributes_encodes_its_operation() {
        let body = build_get_job_attributes("ipp://p:631/jobs/42");
        assert_eq!(&body[..8], &[0x01, 0x01, 0x00, 0x08, 0, 0, 0, 1]);
        assert_eq!(
            find(&parse_attributes(&body), "job-uri"),
            Some(b"ipp://p:631/jobs/42".as_slice())
        );
    }

    #[test]
    fn cups_get_printers_encodes_its_operation() {
        let body = build_cups_get_printers();
        assert_eq!(&body[..8], &[0x01, 0x01, 0x40, 0x02, 0, 0, 0, 1]);
        assert_eq!(body.last(), Some(&0x03));
        assert_eq!(
            find(&parse_attributes(&body), "attributes-charset"),
            Some(b"utf-8".as_slice())
        );
    }

    #[test]
    fn document_format_choice_is_pdf_or_opaque() {
        assert_eq!(ipp_document_format(""), "application/pdf");
        assert_eq!(ipp_document_format("application/pdf"), "application/pdf");
        assert_eq!(ipp_document_format(" Application/PDF "), "application/pdf");
        assert_eq!(
            ipp_document_format("application/postscript"),
            "application/octet-stream"
        );
    }

    // -- response parsing ---------------------------------------------------

    #[test]
    fn status_code_is_read_from_the_body() {
        assert_eq!(
            parse_status_code(&[0x01, 0x01, 0x00, 0x00, 0, 0, 0, 1]),
            Ok(0)
        );
        assert_eq!(parse_status_code(&[0x01, 0x01, 0x05, 0x01]), Ok(0x0501));
        assert!(parse_status_code(b"IP").is_err(), "too short");
        assert!(
            parse_status_code(b"HTTP/1.1 200 OK\r\n").is_err(),
            "not an IPP body"
        );
    }

    #[test]
    fn statuses_are_described_with_class_and_hex() {
        assert_eq!(describe_status(0x0000), "IPP status 0x0000 (successful-ok)");
        assert_eq!(
            describe_status(0x0501),
            "IPP status 0x0501 (server-error-operation-not-supported)"
        );
        assert!(describe_status(0x0424).contains("client-error"));
        assert!(describe_status(0x05FF).contains("server-error"));
    }

    #[test]
    fn a_completed_job_is_ok() {
        let reply = ipp_response(
            0x0000,
            &[&job_group(Some(9), &["job-completed-successfully"])],
        );
        let outcome = parse_job_outcome(&reply).expect("a job group");
        assert!(outcome.is_ok());
    }

    #[test]
    fn a_pending_job_is_not_a_failure() {
        for state in [3i32, 4, 5] {
            let reply = ipp_response(0x0000, &[&job_group(Some(state), &[])]);
            assert!(
                parse_job_outcome(&reply).expect("a job group").is_ok(),
                "state {state}"
            );
        }
    }

    #[test]
    fn a_stopped_job_is_not_ok_and_names_the_cause() {
        let reply = ipp_response(0x0000, &[&job_group(Some(6), &["printer-stopped"])]);
        let outcome = parse_job_outcome(&reply).expect("a job group");
        assert!(!outcome.is_ok());
        let sentence = outcome.sentence();
        assert!(sentence.contains("paused"), "{sentence}");
        assert!(sentence.contains("[printer-stopped]"), "{sentence}");
    }

    #[test]
    fn canceled_and_aborted_jobs_are_not_ok() {
        for state in [6i32, 7, 8] {
            let reply = ipp_response(0x0000, &[&job_group(Some(state), &[])]);
            let outcome = parse_job_outcome(&reply).expect("a job group");
            assert!(!outcome.is_ok(), "state {state}");
            // No known reasons: the sentence falls back to the state word.
            assert!(
                outcome.sentence().contains("job-state"),
                "{}",
                outcome.sentence()
            );
        }
    }

    #[test]
    fn job_state_is_read_as_four_big_endian_bytes() {
        // 9 as a 4-byte integer, enum-tagged (0x23) as well.
        let g = {
            let mut g = vec![0x02];
            g.extend(attr(0x23, "job-state", &[0, 0, 0, 9]));
            g.push(0x03);
            g
        };
        let reply = ipp_response(0x0000, &[&g]);
        assert!(parse_job_outcome(&reply).expect("a job group").is_ok());
    }

    #[test]
    fn a_response_without_a_job_group_is_not_a_failure() {
        // The server accepted but said nothing about the job's fate.
        let reply = ipp_response(0x0000, &[]);
        assert!(parse_job_outcome(&reply).is_none());
    }

    #[test]
    fn every_prefix_of_a_reply_parses_without_panicking() {
        let reply = ipp_response(0x0000, &[&job_group(Some(6), &["printer-stopped"])]);
        for n in 0..=reply.len() {
            let _ = parse_status_code(&reply[..n]);
            let _ = parse_job_outcome(&reply[..n]);
            let _ = parse_queue_health(&reply[..n]);
        }
    }

    // -- CUPS: base URL and URIs ---------------------------------------------

    #[test]
    fn cups_base_url_prefers_the_setting_over_env_and_default() {
        assert_eq!(
            resolve_cups_base_url(Some("http://10.0.0.5:631"), Some("http://other:631")),
            "http://10.0.0.5:631"
        );
        assert_eq!(
            resolve_cups_base_url(None, Some("http://env:631/")),
            "http://env:631"
        );
        assert_eq!(resolve_cups_base_url(None, None), "http://localhost:631");
    }

    #[test]
    fn an_empty_cups_setting_falls_through_to_env() {
        assert_eq!(
            resolve_cups_base_url(Some("  "), Some("http://env:631")),
            "http://env:631"
        );
        assert_eq!(
            resolve_cups_base_url(Some(""), None),
            "http://localhost:631"
        );
    }

    #[test]
    fn queue_uri_and_ipp_uri_are_built_from_the_base() {
        assert_eq!(
            queue_uri("http://localhost:631/", "laser"),
            "http://localhost:631/printers/laser"
        );
        assert_eq!(
            ipp_uri("http://localhost:631/printers/laser"),
            "ipp://localhost:631/printers/laser"
        );
        assert_eq!(ipp_uri("https://host/printers/1"), "ipps://host/printers/1");
        assert_eq!(ipp_uri("ipp://already"), "ipp://already");
    }

    #[test]
    fn printer_state_words_are_plain() {
        assert_eq!(printer_state_word(Some(3)), "idle");
        assert_eq!(printer_state_word(Some(4)), "processing");
        assert_eq!(printer_state_word(Some(5)), "stopped");
        assert_eq!(printer_state_word(None), "unknown");
        assert_eq!(printer_state_word(Some(99)), "unknown");
    }

    // -- CUPS: queue listing ---------------------------------------------------

    #[test]
    fn cups_get_printers_splits_one_record_per_queue() {
        let body = printers_reply(
            0x0000,
            &[
                (
                    "laser".to_string(),
                    "http://localhost:631/printers/laser".to_string(),
                    Some(3),
                ),
                (
                    "labels".to_string(),
                    "http://localhost:631/printers/labels".to_string(),
                    Some(5),
                ),
            ],
        );
        let queues = parse_cups_printers(&body).expect("parses");
        assert_eq!(queues.len(), 2);
        assert_eq!(queues[0].name, "laser");
        assert_eq!(queues[0].uri, "http://localhost:631/printers/laser");
        assert_eq!(queues[0].state, Some(3));
        assert_eq!(printer_state_word(queues[0].state), "idle");
        assert_eq!(queues[1].name, "labels");
        assert_eq!(printer_state_word(queues[1].state), "stopped");
    }

    #[test]
    fn cups_get_printers_refuses_a_non_ok_status() {
        let body = printers_reply(0x0500, &[(String::new(), String::new(), None)]);
        let err = parse_cups_printers(&body).unwrap_err();
        assert!(err.contains("0x0500"), "{err}");
    }

    // -- CUPS: queue health ------------------------------------------------------

    #[test]
    fn an_idle_or_busy_queue_passes_the_probe() {
        let idle = probe_reply(0x0000, Some(3), Some(true), &["none"]);
        assert!(check_probe_reply("laser", &idle).is_ok());
        let busy = probe_reply(0x0000, Some(4), Some(true), &["none"]);
        assert!(check_probe_reply("laser", &busy).is_ok());
    }

    #[test]
    fn a_stopped_queue_is_a_problem() {
        let err = check_probe_reply(
            "laser",
            &probe_reply(0x0000, Some(5), Some(false), &["none"]),
        )
        .unwrap_err();
        assert!(err.contains("is stopped"), "{err}");
        assert!(err.contains("`laser`"), "{err}");
    }

    #[test]
    fn a_stopped_queue_names_the_cause() {
        let err = check_probe_reply(
            "laser",
            &probe_reply(0x0000, Some(5), Some(false), &["paused"]),
        )
        .unwrap_err();
        assert!(err.contains("is stopped"), "{err}");
        assert!(err.contains("paused"), "{err}");
    }

    #[test]
    fn a_queue_refusing_jobs_is_a_problem() {
        let err = check_probe_reply(
            "laser",
            &probe_reply(0x0000, Some(3), Some(false), &["none"]),
        )
        .unwrap_err();
        assert!(err.contains("not accepting"), "{err}");
    }

    #[test]
    fn paper_out_fails_and_keeps_the_keyword() {
        let err = check_probe_reply(
            "laser",
            &probe_reply(0x0000, Some(3), Some(true), &["media-empty"]),
        )
        .unwrap_err();
        assert!(err.contains("out of paper"), "{err}");
        assert!(err.contains("[media-empty]"), "{err}");
    }

    #[test]
    fn each_fault_reason_fails_with_advice() {
        let cases = [
            ("media-jam", "paper jam"),
            ("media-needed", "out of paper"),
            ("offline-report", "offline"),
            ("toner-empty", "toner or ink"),
            ("marker-supply-empty", "toner or ink"),
            ("printer-stopped", "paused"),
        ];
        for (reason, advice) in cases {
            let reply = probe_reply(0x0000, Some(3), Some(true), &[reason]);
            let err =
                check_probe_reply("laser", &reply).expect_err(&format!("{reason} should block"));
            assert!(err.contains(advice), "{reason}: {err}");
        }
    }

    #[test]
    fn the_error_suffix_forms_block_too() {
        for reason in ["media-empty-error", "media-jam-error"] {
            assert!(
                check_probe_reply(
                    "laser",
                    &probe_reply(0x0000, Some(3), Some(true), &[reason]),
                )
                .is_err(),
                "{reason} should block"
            );
        }
    }

    #[test]
    fn reasons_are_case_insensitive() {
        assert!(check_probe_reply(
            "laser",
            &probe_reply(0x0000, Some(3), Some(true), &[r"MEDIA-EMPTY"]),
        )
        .is_err());
    }

    #[test]
    fn a_fault_buried_in_a_longer_list_is_found() {
        let err = check_probe_reply(
            "laser",
            &probe_reply(
                0x0000,
                Some(3),
                Some(true),
                &[r"media-present", r"toner-low", r"media-empty"],
            ),
        )
        .unwrap_err();
        assert!(err.contains("out of paper"), "{err}");
    }

    #[test]
    fn warnings_alone_do_not_block() {
        let cases: [&[&str]; 7] = [
            &[r"toner-low"],
            &[r"media-empty-warning"],
            &[r"media-jam-warning"],
            &[r"cover-open-report"],
            &[r"output-area-almost-full"],
            &[r"vendor-mystery"],
            &[r"toner-low", r"cover-open-report", r"vendor-mystery"],
        ];
        for reasons in cases {
            let reply = probe_reply(0x0000, Some(3), Some(true), reasons);
            assert!(
                check_probe_reply("laser", &reply).is_ok(),
                "warnings should not block: {reasons:?}"
            );
        }
    }

    #[test]
    fn a_reply_saying_nothing_passes() {
        // Header only: no health attributes at all — never block a print
        // on silence.
        let reply = ipp_response(0x0000, &[]);
        assert!(check_probe_reply("laser", &reply).is_ok());
    }

    #[test]
    fn an_error_status_fails_before_any_state_is_considered() {
        let err = check_probe_reply(
            "laser",
            &probe_reply(0x0500, Some(3), Some(true), &["none"]),
        )
        .unwrap_err();
        assert!(err.contains("refused the probe"), "{err}");
    }

    #[test]
    fn ok_ignored_attributes_is_not_a_refusal() {
        let reply = probe_reply(0x0001, Some(3), Some(true), &["none"]);
        assert!(check_probe_reply("laser", &reply).is_ok());
    }

    #[test]
    fn queue_health_reads_state_accepting_and_reasons() {
        let reply = probe_reply(0x0000, Some(5), Some(false), &[r"media-empty", r"paused"]);
        let health = parse_queue_health(&reply);
        assert_eq!(health.state, Some(5));
        assert_eq!(health.accepting, Some(false));
        assert_eq!(
            health.reasons,
            vec!["media-empty".to_string(), "paused".to_string()]
        );
    }

    #[test]
    fn describe_blocking_dedupes_repeated_faults() {
        let reasons = vec![
            "media-empty".to_string(),
            "media-empty-error".to_string(),
            "toner-empty".to_string(),
        ];
        assert_eq!(
            describe_blocking(&reasons),
            Some(
                "it is out of paper and it has run out of toner or ink \
                 [media-empty, toner-empty]"
                    .to_string()
            )
        );
        assert_eq!(describe_blocking(&["none".to_string()]), None);
        assert_eq!(describe_blocking(&[]), None);
    }

    #[test]
    fn is_blocking_reason_vocab() {
        assert!(is_blocking_reason("offline-report"));
        for r in [
            "media-empty",
            "media-needed",
            "media-jam",
            "toner-empty",
            "toner-life-end",
            "marker-supply-empty",
            "paused",
            "printer-stopped",
            "media-empty-error",
        ] {
            assert!(is_blocking_reason(r), "{r} should block");
        }
        for r in [
            "none",
            "media-empty-warning",
            "toner-low",
            "media-present",
            "cover-open-report",
            "vendor-mystery",
        ] {
            assert!(!is_blocking_reason(r), "{r} should not block");
        }
    }
}
