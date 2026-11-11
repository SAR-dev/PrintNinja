//! What a printer tells us about itself before its row is saved
//! (TODO items 2 + 4).
//!
//! The printer form asks the printer what it understands, so the
//! operator does not have to guess the language column. One command,
//! one result, a per-transport strategy:
//!
//! - `ipp` — Get-Printer-Attributes over HTTP, reusing the request
//!   builder and the parser the diagnostics path already ships
//!   (`ipp.rs`), on the same `DIAGNOSE_TIMEOUT` budget.
//! - `raw_tcp` — a status query per dialect on the raw wire, using the
//!   exact bytes and `answered()` rules of the pre-send check
//!   (`status::Dialect`), so a printer that answers the probe answers
//!   the precheck too.
//! - `usb` / `bluetooth` — device identity first (no I/O to the
//!   printer): the model string the system reports for the device is
//!   matched against the same model → language table the IPP path
//!   uses; when the name does not decide it, Android and Linux ask the
//!   wire — a protocol probe over the device's own connection (Linux
//!   dials RFCOMM directly, so the add form can too). Windows has no
//!   raw wire to query there (spooler queues and name-based identity
//!   only).
//! - `system` — the spooler converts whatever we send; nothing to ask.
//!
//! The contract is the one `IppPrinter::printer_state_reasons` sets:
//! an unreachable, refusing or silent printer comes back as
//! "unknown" (`detected: false`) — never as an error. The form keeps
//! its default language and shows "unknown — please pick".

use crate::transport::status::Dialect;
use crate::transport::{insecure_http_client, shared_http_client, PrinterType, TransportSettings};
use serde::Serialize;
use std::time::Duration;

/// The wire budget of one dialect question: the same generosity as the
/// pre-send check's `STATUS_REPLY_TIMEOUT`.
const WIRE_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// How long a raw-wire connection may take to be accepted.
const WIRE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// What the printer told us, if it told us anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProbeCapabilities {
    /// `true` only when a positive signal arrived: a MIME list, a
    /// matching model name, or a dialect answering its own query.
    pub detected: bool,
    /// One of the app's six language values. `None` means the printer
    /// did not identify itself — the form keeps its default language
    /// and shows the result as "unknown — please pick".
    pub suggested_language: Option<String>,
    /// `printer-make-and-model` (IPP) or the device name the system
    /// reports (USB/BT), when we know it.
    pub make_and_model: Option<String>,
    /// `printer-info` (IPP).
    pub printer_info: Option<String>,
    /// The document/content formats the printer reported, as it
    /// reported them (IPP; empty on every other transport).
    pub document_formats: Vec<String>,
}

impl ProbeCapabilities {
    fn unknown() -> Self {
        Self {
            detected: false,
            suggested_language: None,
            make_and_model: None,
            printer_info: None,
            document_formats: Vec::new(),
        }
    }
}

/// The model name → language table, shared by the IPP attribute probe
/// and the device-identity probe (one table, both paths).
///
/// Keyword match on the lower-cased name. Order matters: the vendor
/// brands are checked before the generic thermal words, so a "Zebra
/// thermal" is ZPL, not generic ESC/POS.
pub fn language_for_model(model: &str) -> Option<&'static str> {
    let m = model.to_lowercase();
    if m.contains("zebra") || m.contains("zpl") {
        Some("zpl")
    } else if m.contains("tsc") || m.contains("tspl") {
        Some("tspl")
    } else if m.contains("citizen") || m.contains("cpcl") {
        Some("cpcl")
    } else if m.contains("epson")
        || m.contains("escpos")
        || m.contains("esc/pos")
        || m.contains("thermal")
        || m.contains("receipt")
        || m.contains("pos-")
    {
        Some("escpos")
    } else {
        None
    }
}

/// The command language a dialect's answer implies.
pub fn language_of(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::EscPos => "escpos",
        Dialect::Zpl => "zpl",
        Dialect::Tspl => "tspl",
    }
}

/// Map an IPP-reported MIME list onto one of the app's languages:
///
/// - `application/pdf` → `pdf`;
/// - PostScript/PCL only → `pdf` (a page printer: we send PDF and CUPS
///   filters do the conversion);
/// - `application/vnd.cups-raw` / `application/octet-stream` → the
///   queue takes whatever bytes we send, so the model name decides
///   which command language those bytes are;
/// - nothing, or none of the above → `None` (unknown).
pub fn language_for_formats(formats: &[String], model: &str) -> Option<String> {
    let joined = formats.join(",").to_lowercase();
    if joined.is_empty() {
        return None;
    }
    if joined.contains("application/pdf") {
        return Some("pdf".into());
    }
    let raw = joined.contains("vnd.cups-raw") || joined.contains("application/octet-stream");
    let page = joined.contains("application/postscript")
        || joined.contains("vnd.pcl")
        || joined.contains("application/vnd.hp-pcl");
    if page && !raw {
        return Some("pdf".into());
    }
    if raw {
        return language_for_model(model).map(str::to_string);
    }
    None
}

/// Ask the printer what it understands. See the module docs for the
/// per-transport strategy and the "unknown, never an error" contract.
pub async fn probe(
    printer_type: &PrinterType,
    name: &str,
    address: &str,
    settings: &TransportSettings,
) -> ProbeCapabilities {
    match printer_type {
        PrinterType::Ipp => probe_ipp(address, settings).await,
        PrinterType::RawTcp => probe_raw_tcp(address).await,
        PrinterType::Usb => probe_usb(name, address).await,
        PrinterType::Bluetooth => probe_bluetooth(name, address).await,
        PrinterType::System => ProbeCapabilities::unknown(),
    }
}

// ─────────────────────────────────────────────────────────────────────
// ipp
// ─────────────────────────────────────────────────────────────────────

/// Get-Printer-Attributes, then read the attributes the form cares
/// about. Mirrors `IppPrinter::printer_state_reasons` step for step —
/// including every early return — so a printer the diagnostics treat
/// as "silently unreachable" is treated the same way here.
async fn probe_ipp(address: &str, settings: &TransportSettings) -> ProbeCapabilities {
    use crate::transport::ipp::{IppPrinter, DIAGNOSE_TIMEOUT};

    let mut out = ProbeCapabilities::unknown();
    let printer = IppPrinter::new(String::new(), address.to_string()).with_credentials(
        settings.username.clone(),
        settings.password.clone(),
        settings.skip_tls_verification,
    );
    let body = IppPrinter::build_get_printer_attributes(printer.printer_uri());
    let mut request = if settings.skip_tls_verification {
        insecure_http_client()
    } else {
        shared_http_client()
    }
    .post(printer.endpoint_url())
    .header("Content-Type", "application/ipp")
    .timeout(DIAGNOSE_TIMEOUT);
    if let Some(auth) = printer.auth_header() {
        request = request.header("Authorization", auth);
    }
    let Ok(response) = request.body(body).send().await else {
        return out;
    };
    if !response.status().is_success() {
        return out;
    }
    let Ok(bytes) = response.bytes().await else {
        return out;
    };
    let Ok(status) = crate::transport::ipp::parse_status_code(&bytes) else {
        return out;
    };
    if status >> 8 != 0 {
        return out;
    }
    for (n, tag, value) in crate::transport::ipp::parse_attributes(&bytes) {
        if tag != 0x44 {
            continue;
        }
        let text = String::from_utf8_lossy(&value).into_owned();
        match n.as_str() {
            "document-format-supported" | "content-type-supported" => {
                out.document_formats.push(text);
            }
            "printer-make-and-model" => out.make_and_model = Some(text),
            "printer-info" => out.printer_info = Some(text),
            _ => {}
        }
    }
    let model = out.make_and_model.as_deref().unwrap_or("");
    if let Some(language) = language_for_formats(&out.document_formats, model) {
        out.suggested_language = Some(language);
    } else if out.document_formats.is_empty() {
        // No formats at all: the printer probably fronts a raw queue
        // that does not advertise any — the model name still decides.
        if let Some(language) = language_for_model(model) {
            out.suggested_language = Some(language.into());
        }
    }
    out.detected = out.suggested_language.is_some() || out.make_and_model.is_some();
    out
}

// ─────────────────────────────────────────────────────────────────────
// raw tcp
// ─────────────────────────────────────────────────────────────────────

/// Protocol probe on a raw (JetDirect) port: one dialect at a time, in
/// order of how distinctive its answer is, each question on a fresh
/// connection so a stray late byte from one question cannot be read as
/// the answer to the next. The first answered query decides.
///
/// Deliberately no status bookkeeping: `status::note_*` tracks the
/// pre-print state of printers that already have rows, and a question
/// asked from the add form is not a print.
async fn probe_raw_tcp(address: &str) -> ProbeCapabilities {
    use crate::transport::raw_tcp::split_host_port;

    let (host, port) = split_host_port(address.trim(), 9100);
    let addr = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    for dialect in [Dialect::Zpl, Dialect::Tspl, Dialect::EscPos] {
        if wire_reply(dialect, &addr).await {
            let mut out = ProbeCapabilities::unknown();
            out.detected = true;
            out.suggested_language = Some(language_of(dialect).into());
            return out;
        }
    }
    ProbeCapabilities::unknown()
}

/// Write one dialect's question on a fresh connection and wait for its
/// answer. `true` only when the answer is one `dialect.answered()` can
/// read; a connect failure, a silent printer and a wrong answer all
/// come back `false`.
async fn wire_reply(dialect: Dialect, addr: &str) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let Ok(stream) = tokio::time::timeout(WIRE_CONNECT_TIMEOUT, TcpStream::connect(addr)).await
    else {
        return false;
    };
    let Ok(mut stream) = stream else {
        return false;
    };
    let query = dialect.query();
    let reply = match tokio::time::timeout(WIRE_REPLY_TIMEOUT, async move {
        let mut reply = Vec::new();
        if stream.write_all(&query).await.is_err() {
            return reply;
        }
        let mut chunk = [0u8; 256];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    reply.extend_from_slice(&chunk[..n]);
                    if dialect.answered(&reply) {
                        break;
                    }
                }
            }
        }
        reply
    })
    .await
    {
        Ok(reply) => reply,
        Err(_) => return false,
    };
    dialect.answered(&reply)
}

// ─────────────────────────────────────────────────────────────────────
// usb / bluetooth
// ─────────────────────────────────────────────────────────────────────

/// Identity match without touching the printer: the system's own name
/// for the device is a model string ("Zebra ZT411", "RUIJIE RP325").
///
/// Windows-only: its transports are spooler-by-name, so the queue name
/// is the only signal. Android matches the enumerated device name
/// instead (it must first map `vid:pid` to the name), and Linux has no
/// USB/BT transports at all.
#[cfg(target_os = "windows")]
fn probe_by_name(name: &str) -> ProbeCapabilities {
    let mut out = ProbeCapabilities::unknown();
    if let Some(language) = language_for_model(name) {
        out.detected = true;
        out.suggested_language = Some(language.into());
        out.make_and_model = Some(name.to_string());
    }
    out
}

#[cfg(target_os = "android")]
async fn probe_usb(name: &str, address: &str) -> ProbeCapabilities {
    use tauri_plugin_android_print::AndroidPrintExt;

    // 1. Identity: the stored address is `vendor:product` (lowercase
    //    hex, as `AndroidUsbPrinter::discover` writes it); the
    //    enumeration's device name is the model string.
    if let Some(app) = crate::render::android_app() {
        if let Ok(list) = app.android_print().enumerate_usb_printers() {
            for d in &list {
                let vid_pid = format!("{:04x}:{:04x}", d.vendor_id, d.product_id);
                if vid_pid.eq_ignore_ascii_case(address.trim()) {
                    if let Some(language) = language_for_model(&d.name) {
                        let mut out = ProbeCapabilities::unknown();
                        out.detected = true;
                        out.suggested_language = Some(language.into());
                        out.make_and_model = Some(d.name.clone());
                        return out;
                    }
                }
            }
        }
    }
    // 2. The name did not decide: ask the wire. Opening can show the
    //    system permission dialog — the operator's explicit Detect
    //    click is what authorizes it.
    let p = crate::transport::android_usb::AndroidUsbPrinter::new(
        name.to_string(),
        address.to_string(),
    );
    probe_on_android_wire_usb(&p).await
}

#[cfg(target_os = "android")]
async fn probe_on_android_wire_usb(
    p: &crate::transport::android_usb::AndroidUsbPrinter,
) -> ProbeCapabilities {
    let Ok(handle) = p.open_remote().await else {
        return ProbeCapabilities::unknown();
    };
    let mut out = ProbeCapabilities::unknown();
    for dialect in [Dialect::Zpl, Dialect::Tspl, Dialect::EscPos] {
        if let Ok(reply) = p.query_remote(&handle, &dialect.query()).await {
            if dialect.answered(&reply) {
                out.detected = true;
                out.suggested_language = Some(language_of(dialect).into());
                break;
            }
        }
    }
    p.close_remote(&handle).await;
    out
}

#[cfg(target_os = "android")]
async fn probe_bluetooth(name: &str, address: &str) -> ProbeCapabilities {
    use tauri_plugin_android_print::AndroidPrintExt;

    // 1. Identity: the stored address is the MAC; the bonded device
    //    listing's name is the model string.
    if let Some(app) = crate::render::android_app() {
        if let Ok(list) = app.android_print().list_bluetooth_devices() {
            if let Some(d) = list
                .iter()
                .find(|d| d.id.eq_ignore_ascii_case(address.trim()))
            {
                if let Some(language) = language_for_model(&d.name) {
                    let mut out = ProbeCapabilities::unknown();
                    out.detected = true;
                    out.suggested_language = Some(language.into());
                    out.make_and_model = Some(d.name.clone());
                    return out;
                }
            }
        }
    }
    // 2. The name did not decide: ask the wire. Detection always talks
    // to the device directly — the row's manual driver mode does not
    // exist yet (this runs from the add form), and a status query is a
    // question, not a print, on either path.
    let p = crate::transport::android_bluetooth::AndroidBluetoothPrinter::new(
        name.to_string(),
        address.to_string(),
        false,
    );
    probe_on_android_wire_bluetooth(&p).await
}

#[cfg(target_os = "android")]
async fn probe_on_android_wire_bluetooth(
    p: &crate::transport::android_bluetooth::AndroidBluetoothPrinter,
) -> ProbeCapabilities {
    let Ok(handle) = p.open_remote().await else {
        return ProbeCapabilities::unknown();
    };
    let mut out = ProbeCapabilities::unknown();
    for dialect in [Dialect::Zpl, Dialect::Tspl, Dialect::EscPos] {
        if let Ok(reply) = p.query_remote(&handle, &dialect.query()).await {
            if dialect.answered(&reply) {
                out.detected = true;
                out.suggested_language = Some(language_of(dialect).into());
                break;
            }
        }
    }
    p.close_remote(&handle).await;
    out
}

#[cfg(target_os = "windows")]
async fn probe_usb(name: &str, _address: &str) -> ProbeCapabilities {
    // The Windows USB transport is spooler-by-name: there is no raw
    // wire to query, so the queue name (which usually carries the
    // model string) is the only signal.
    probe_by_name(name)
}

#[cfg(target_os = "windows")]
async fn probe_bluetooth(name: &str, _address: &str) -> ProbeCapabilities {
    probe_by_name(name)
}

#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn probe_usb(_name: &str, _address: &str) -> ProbeCapabilities {
    // No USB transport exists on this platform.
    ProbeCapabilities::unknown()
}

/// Linux drives Bluetooth directly (an RFCOMM socket), so the probe
/// can ask the device itself: the model name in the row decides first
/// — the operator usually typed the model — and only when it does not
/// does the wire answer, one dialect at a time on fresh connections
/// with the same `answered()` rules as the raw-TCP probe. An
/// unreachable device or a silent one comes back "unknown", never an
/// error.
#[cfg(target_os = "linux")]
async fn probe_bluetooth(name: &str, address: &str) -> ProbeCapabilities {
    if let Some(language) = language_for_model(name) {
        let mut out = ProbeCapabilities::unknown();
        out.detected = true;
        out.suggested_language = Some(language.into());
        out.make_and_model = Some(name.to_string());
        return out;
    }
    let mut out = ProbeCapabilities::unknown();
    if let Some(dialect) =
        crate::transport::linux_bluetooth::LinuxBluetoothPrinter::probe_wire_dialect(address).await
    {
        out.detected = true;
        out.suggested_language = Some(language_of(dialect).into());
    }
    out
}

#[cfg(not(any(target_os = "android", target_os = "windows", target_os = "linux")))]
async fn probe_bluetooth(_name: &str, _address: &str) -> ProbeCapabilities {
    ProbeCapabilities::unknown()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_table_matches_vendor_brands_before_generic_words() {
        assert_eq!(language_for_model("Zebra ZT411"), Some("zpl"));
        assert_eq!(language_for_model("ZEBRA thermal"), Some("zpl"));
        assert_eq!(language_for_model("TSC TTP-244 Pro"), Some("tspl"));
        assert_eq!(language_for_model("CITIZEN CT-S500"), Some("cpcl"));
        assert_eq!(language_for_model("Epson TM-T88VII"), Some("escpos"));
        assert_eq!(
            language_for_model("Generic Thermal Printer 58mm"),
            Some("escpos")
        );
        assert_eq!(language_for_model("RUIJIE RP325"), None);
        assert_eq!(language_for_model("HP LaserJet 1020"), None);
        assert_eq!(language_for_model(""), None);
    }

    #[test]
    fn the_mime_map_reads_what_cups_reports() {
        assert_eq!(
            language_for_formats(
                &[
                    "application/pdf".into(),
                    "application/vnd.cups-raster".into()
                ],
                "HP LaserJet"
            ),
            Some("pdf".into())
        );
        assert_eq!(
            language_for_formats(&["application/postscript".into()], "HP LaserJet 1020"),
            Some("pdf".into())
        );
        assert_eq!(
            language_for_formats(
                &[
                    "application/vnd.cups-raw".into(),
                    "application/octet-stream".into()
                ],
                "Zebra ZT411"
            ),
            Some("zpl".into())
        );
        assert_eq!(
            language_for_formats(&["application/octet-stream".into()], "TSC TTP-244"),
            Some("tspl".into())
        );
        // A raw queue whose model we do not recognize: unknown, not a
        // guess.
        assert_eq!(
            language_for_formats(&["application/vnd.cups-raw".into()], "Some Brand Printer"),
            None
        );
        assert_eq!(language_for_formats(&[], "Zebra ZT411"), None);
    }

    /// A loopback "printer" that answers a dialect the way the real one
    /// would: the query is read off the socket, the reply is written
    /// back, and the connection stays open for the next question.
    async fn fake_printer(
        answer: fn(query: &[u8]) -> Option<Vec<u8>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback listener binds");
        let addr = listener.local_addr().expect("loopback addr");
        let handle = tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let answer = answer;
                tokio::spawn(async move {
                    // One question per connection (see `probe_raw_tcp`).
                    let mut buf = [0u8; 256];
                    let n = sock.read(&mut buf).await;
                    let Ok(n) = n else { return };
                    if let Some(reply) = answer(&buf[..n]) {
                        let _ = sock.write_all(&reply).await;
                    }
                    // Hold the socket briefly so the client's read sees
                    // the reply before the FIN, then drop it.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                });
            }
        });
        (addr.to_string(), handle)
    }

    #[tokio::test]
    async fn a_zpl_answer_identifies_zpl() {
        // Zebra's ~HS reply: three STX-terminated lines (three 0x02
        // bytes, which is what `Dialect::answered` counts).
        let (addr, _h) = fake_printer(|q| {
            (q == b"~HS").then(|| {
                b"\x02 030,0,0,1,2,3,4,5,6,7,8,9\x03\r\n\x02 1234,1.0\x03\r\n\x02 ZT411\x03\r\n"
                    .to_vec()
            })
        })
        .await;
        let out = probe_raw_tcp(&addr).await;
        assert!(out.detected);
        assert_eq!(out.suggested_language.as_deref(), Some("zpl"));
        assert!(out.document_formats.is_empty());
    }

    #[tokio::test]
    async fn an_escpos_answer_identifies_escpos() {
        // The fake answers DLE EOT with the four status bytes and stays
        // silent to the two questions that come first.
        let (addr, _h) =
            fake_printer(|q| (q.first() == Some(&0x10)).then(|| vec![0x04, 0x12, 0x00, 0x00]))
                .await;
        let out = probe_raw_tcp(&addr).await;
        assert!(out.detected);
        assert_eq!(out.suggested_language.as_deref(), Some("escpos"));
    }

    #[tokio::test]
    async fn a_silent_socket_is_unknown_not_an_error() {
        // Answers nothing and closes: every dialect sees EOF, and the
        // probe ends as "unknown" without an error.
        let (addr, _h) = fake_printer(|_| None).await;
        let out = probe_raw_tcp(&addr).await;
        assert!(!out.detected);
        assert!(out.suggested_language.is_none());
    }

    #[tokio::test]
    async fn a_dead_address_is_unknown_not_an_error() {
        // Port 1 on loopback: nothing listens, the connect fails, and
        // the contract still holds.
        let out = probe_raw_tcp("127.0.0.1:1").await;
        assert!(!out.detected);
        assert!(out.suggested_language.is_none());
    }

    /// Linux: the row's own name decides for free (no I/O), and only
    /// when it does not does the probe touch the wire — which, with an
    /// address that is not a Bluetooth address, ends as "unknown"
    /// rather than an error.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linux_bluetooth_probe_prefers_the_name_then_the_wire() {
        let named = probe(
            &PrinterType::Bluetooth,
            "Zebra ZT411",
            "A4:77:17:22:33:44",
            &TransportSettings::default(),
        )
        .await;
        assert!(named.detected);
        assert_eq!(named.suggested_language.as_deref(), Some("zpl"));

        let anonymous = probe(
            &PrinterType::Bluetooth,
            "Front Desk",
            "usb://dummy",
            &TransportSettings::default(),
        )
        .await;
        assert!(!anonymous.detected);
        assert!(anonymous.suggested_language.is_none());
    }
}
