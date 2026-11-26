use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub address: String,
    pub printer_type: PrinterType,
    pub language: PrinterLanguage,
    pub status: String,
    /// Whether this queue's print processor offers a `PDF` datatype
    /// (Windows spooler queues only): `Some(true)` — a PDF job goes out
    /// declared as PDF; `Some(false)` — the offered list is readable but
    /// has no `PDF` entry, so the driver *may* be GDI-only and a PDF job
    /// would go out as RAW; `None` — unknown (other platforms, remote
    /// queues, or the list could not be read). Best-effort hint: the UI
    /// warns, it never refuses. `#[serde(default)]` keeps rows from an
    /// older PC (no field) deserializable.
    #[serde(default)]
    pub pdf_datatype: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrinterType {
    Ipp,
    RawTcp,
    Usb,
    Bluetooth,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrinterLanguage {
    Pdf,
    Escpos,
    Tspl,
    Zpl,
    Cpcl,
    Raster,
}

/// Environment variable that overrides how long one job may take to be
/// sent to a raw (JetDirect) or IPP printer, in whole seconds.
///
/// Unset, empty, zero or unparsable means the built-in default (30 s).
/// It exists so tests that prove a stalled printer ends as a failed job
/// do not have to sit through the real deadline; like
/// `PRINTNINJA_CUPS_URL` it is a seam, not a setting, and nothing in the
/// app sets it.
pub const SEND_TIMEOUT_ENV: &str = "PRINTNINJA_SEND_TIMEOUT_SECS";

/// The send deadline for one job: [`SEND_TIMEOUT_ENV`] if it holds a
/// positive number of seconds, else `default`. Read on every send, so a
/// test can set it after start-up.
pub(crate) fn send_timeout(default: Duration) -> Duration {
    parse_send_timeout(std::env::var(SEND_TIMEOUT_ENV).ok().as_deref(), default)
}

/// One HTTP client for all IPP/CUPS traffic (L2). Building a client per
/// send threw away TCP keep-alive, so every job paid a fresh handshake.
/// Deliberately no client-level timeouts: per-send deadlines
/// (`send_timeout`, `CUPS_TIMEOUT`, `DIAGNOSE_TIMEOUT`) are applied per
/// request with `RequestBuilder::timeout`, which keeps the env-var test
/// seam above (read on every send) working exactly as before.
pub(crate) fn shared_http_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(60))
                .build()
                .expect("shared IPP/CUPS HTTP client builds with plain timeouts")
        })
        .clone()
}

/// A second client for endpoints whose operator has accepted the
/// self-signed certificate (`printers.skip_tls_verification`). Kept
/// separate so one printer's override never weakens the TLS checks of
/// every other connection the app makes.
pub(crate) fn insecure_http_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(60))
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
                .expect("insecure HTTP client builds")
        })
        .clone()
}

/// Per-printer options a transport may carry on top of the stored address.
///
/// Only IPP reads the credential/TLS fields today (sign-in credentials,
/// self-signed certificates); the other transports ignore them, which is
/// why the defaults — no credentials, verified TLS — are safe to pass
/// around without thinking.
///
/// `via_driver` is the manual Bluetooth mode: `false` (default, and
/// every path the app never sets otherwise) is the driverless raw wire;
/// `true` sends through the OS queue (Windows spooler, CUPS) as the
/// driver the printer is installed with. The user sets it per printer —
/// nothing here ever flips it, so a job cannot change path mid-flight.
#[derive(Debug, Clone, Default)]
pub struct TransportSettings {
    /** IPP sign-in user; `None` keeps the built-in `PrintNinja`. */
    pub username: Option<String>,
    /** IPP password; `None` sends no HTTP authentication. */
    pub password: Option<String>,
    /** Accept a self-signed certificate on this printer's TLS endpoint. */
    pub skip_tls_verification: bool,
    /** Print through the OS driver queue instead of the driverless wire (Bluetooth). */
    pub via_driver: bool,
    /** Driverless Bluetooth pacing (Android); the default is the built-in. */
    pub bluetooth: BluetoothDelivery,
}

/// Pacing for a driverless Bluetooth job on Android: the RFCOMM socket
/// is written in `chunk_bytes` slices with a `chunk_pause_ms` pause
/// between them, so a slow thermal printer's buffer has a chance to drain
/// and the job does not arrive as one flood it drops. The defaults
/// (512 bytes / 50 ms) are safe for 2-inch receipt printers; a stored
/// value narrows or widens the pace per printer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BluetoothDelivery {
    /** Bytes per RFCOMM write. */
    pub chunk_bytes: u32,
    /** Pause between writes, in milliseconds. */
    pub chunk_pause_ms: u32,
}

impl Default for BluetoothDelivery {
    fn default() -> Self {
        Self {
            chunk_bytes: 512,
            chunk_pause_ms: 50,
        }
    }
}

impl BluetoothDelivery {
    pub const MIN_CHUNK_BYTES: u32 = 32;
    pub const MAX_CHUNK_BYTES: u32 = 8192;
    pub const MAX_PAUSE_MS: u32 = 2000;

    /// Strict check for values a person is saving.
    pub fn validate(&self) -> Result<(), String> {
        if !(Self::MIN_CHUNK_BYTES..=Self::MAX_CHUNK_BYTES).contains(&self.chunk_bytes) {
            return Err(format!(
                "chunk size must be between {} and {} bytes",
                Self::MIN_CHUNK_BYTES,
                Self::MAX_CHUNK_BYTES
            ));
        }
        if self.chunk_pause_ms > Self::MAX_PAUSE_MS {
            return Err(format!(
                "chunk pause must be between 0 and {} ms",
                Self::MAX_PAUSE_MS
            ));
        }
        Ok(())
    }

    /// Lenient read for printing: the `bluetooth` object inside a
    /// printer's `default_settings_json`. Anything missing, malformed or
    /// out of range falls back to the built-in pace — a bad stored value
    /// must never break a print.
    pub fn from_settings_json(json: Option<&str>) -> Self {
        let Some(root) = json.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        else {
            return Self::default();
        };
        let Some(node) = root.get("bluetooth") else {
            return Self::default();
        };
        match serde_json::from_value::<Self>(node.clone()) {
            Ok(d) if d.validate().is_ok() => d,
            _ => Self::default(),
        }
    }
}

/// The largest post-write settle the raw console will honor, in
/// milliseconds. Beyond it a label printer is just sitting there and a
/// receipt printer has moved on to the next customer, so bigger values
/// are clamped rather than honored.
pub const MAX_SETTLE_MS: u32 = 10_000;

/// Raw console options exactly as the operator sent them: each value
/// unset means the printer row's stored value, or the transport's
/// built-in behavior where the row stores none (the settle on Android).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RawSendOptions {
    /** Bytes per write; clamped to the Bluetooth chunk bounds. */
    pub chunk_bytes: Option<u32>,
    /** Pause between writes, in ms; clamped to the Bluetooth pause bound. */
    pub chunk_pause_ms: Option<u32>,
    /** Wait between the last byte and the close, in ms; clamped to `MAX_SETTLE_MS`. */
    pub settle_ms: Option<u32>,
}

/// One raw console send's delivery, resolved and clamped: the operator's
/// override where given, else the printer row's stored pace, else the
/// built-in default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawDelivery {
    /** Bytes per write, within the Bluetooth chunk bounds. */
    pub chunk_bytes: u32,
    /** Pause between writes, in ms, within the Bluetooth pause bound. */
    pub chunk_pause_ms: u32,
    /** The requested post-write settle, or `None` for the transport's
     * built-in behavior (an immediate close on desktop, the size-based
     * delay on Android). */
    pub settle_override_ms: Option<u32>,
}

impl RawDelivery {
    /// Resolve the operator's options against the row's stored pace.
    ///
    /// Overrides are clamped to the same bounds `BluetoothDelivery::validate`
    /// enforces for stored values; a bad number narrows the experiment, it
    /// never breaks a send.
    pub fn resolve(options: &RawSendOptions, stored: BluetoothDelivery) -> Self {
        Self {
            chunk_bytes: options
                .chunk_bytes
                .map(|v| {
                    v.clamp(
                        BluetoothDelivery::MIN_CHUNK_BYTES,
                        BluetoothDelivery::MAX_CHUNK_BYTES,
                    )
                })
                .unwrap_or(stored.chunk_bytes),
            chunk_pause_ms: options
                .chunk_pause_ms
                .map(|v| v.min(BluetoothDelivery::MAX_PAUSE_MS))
                .unwrap_or(stored.chunk_pause_ms),
            settle_override_ms: options.settle_ms.map(|v| v.min(MAX_SETTLE_MS)),
        }
    }

    /// The settle a desktop raw transport applies: the override, or an
    /// immediate close when none was given (today's behavior).
    pub fn desktop_settle_ms(&self) -> u32 {
        self.settle_override_ms.unwrap_or(0)
    }
}

/// What one raw console send actually did: the delivery values the
/// transport applied and the wall time of each stage. The command reads
/// the snapshot back into its report; a normal print job carries no
/// recorder, so none of this runs on that path.
///
/// `Arc` because the recorder is shared with the transport's worker
/// thread (blocking sends record from `spawn_blocking`) while the command
/// reads after the send resolves.
#[derive(Debug, Clone, Default)]
pub struct RawRecorder(Arc<Mutex<RawRecorderInner>>);

#[derive(Debug, Default)]
struct RawRecorderInner {
    open_ms: Option<u64>,
    write_ms: Option<u64>,
    settle_ms: Option<u64>,
    close_ms: Option<u64>,
    chunk_bytes: Option<u32>,
    chunk_pause_ms: Option<u32>,
    settle_ms_applied: Option<u32>,
}

impl RawRecorder {
    pub fn record_open(&self, ms: u64) {
        self.0.lock().unwrap().open_ms = Some(ms);
    }

    pub fn record_write(&self, ms: u64) {
        self.0.lock().unwrap().write_ms = Some(ms);
    }

    pub fn record_settle(&self, ms: u64) {
        self.0.lock().unwrap().settle_ms = Some(ms);
    }

    pub fn record_close(&self, ms: u64) {
        self.0.lock().unwrap().close_ms = Some(ms);
    }

    /// The delivery values the transport actually applied.
    pub fn record_effective(&self, chunk_bytes: u32, chunk_pause_ms: u32, settle_ms: u32) {
        let mut inner = self.0.lock().unwrap();
        inner.chunk_bytes = Some(chunk_bytes);
        inner.chunk_pause_ms = Some(chunk_pause_ms);
        inner.settle_ms_applied = Some(settle_ms);
    }

    /// Per-stage wall times, in ms; a stage the transport never ran stays
    /// `None` rather than reporting a fake zero.
    pub fn timings(&self) -> RawSendTimings {
        let inner = self.0.lock().unwrap();
        RawSendTimings {
            open: inner.open_ms,
            write: inner.write_ms,
            settle: inner.settle_ms,
            close: inner.close_ms,
        }
    }

    /// The applied delivery values, or `None` until the transport
    /// recorded them.
    pub fn effective(&self) -> Option<RawSendOptions> {
        let inner = self.0.lock().unwrap();
        match (
            inner.chunk_bytes,
            inner.chunk_pause_ms,
            inner.settle_ms_applied,
        ) {
            (Some(chunk), Some(pause), Some(settle)) => Some(RawSendOptions {
                chunk_bytes: Some(chunk),
                chunk_pause_ms: Some(pause),
                settle_ms: Some(settle),
            }),
            _ => None,
        }
    }
}

/// A raw console send riding on an otherwise-normal job: the resolved
/// delivery and the recorder the transport fills in. `None` — every
/// ordinary print — leaves the transport's behavior unchanged.
#[derive(Debug, Clone)]
pub struct RawSend {
    pub delivery: RawDelivery,
    pub recorder: RawRecorder,
}

/// Per-stage wall times of one raw console send, in milliseconds. A stage
/// the transport never ran stays `None` rather than reporting a fake zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSendTimings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settle: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close: Option<u64>,
}

/// What the raw console told the operator happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSendReport {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub bytes_sent: u64,
    pub timings_ms: RawSendTimings,
    /// The option values that were actually applied, so the UI can show
    /// when a transport ignored an override.
    pub effective_options: RawSendOptions,
}

/// Payloads larger than this cross the Rust→Kotlin bridge by file
/// instead of base64 (A4). Receipts are kilobytes and stay on the fast
/// base64 path; a 256 KiB raster would otherwise inflate by a third and
/// travel as one giant JSON string through JNI. The Kotlin side reads
/// and deletes the file; Rust deletes it too after the call, so a crash
/// on either side leaves at most one orphaned file per print.
///
/// Android-only at runtime (the USB/Bluetooth send tree is unreachable
/// off-device), so the dead-code lint is relaxed elsewhere: on Android
/// it still fires.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) const PLUGIN_FILE_HANDOFF_BYTES: usize = 256 * 1024;

/// Write `data` to a uniquely-named file under `dir` for the plugin
/// file handoff. The caller deletes the file after the plugin call
/// (best-effort); the Kotlin side deletes it after reading.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn stage_plugin_payload(
    dir: &std::path::Path,
    data: &[u8],
) -> Result<std::path::PathBuf, String> {
    let path = dir.join(format!("printninja-payload-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&path, data)
        .map_err(|e| format!("could not stage {} bytes for handoff: {e}", data.len()))?;
    Ok(path)
}

fn parse_send_timeout(raw: Option<&str>, default: Duration) -> Duration {
    match raw.map(str::trim).and_then(|v| v.parse::<u64>().ok()) {
        Some(secs) if secs > 0 => Duration::from_secs(secs),
        _ => default,
    }
}

#[cfg(test)]
mod send_timeout_tests {
    use super::*;

    const DEFAULT: Duration = Duration::from_secs(30);

    #[test]
    fn unset_uses_the_default() {
        assert_eq!(parse_send_timeout(None, DEFAULT), DEFAULT);
    }

    #[test]
    fn a_positive_number_of_seconds_overrides() {
        assert_eq!(
            parse_send_timeout(Some("2"), DEFAULT),
            Duration::from_secs(2)
        );
        assert_eq!(
            parse_send_timeout(Some(" 45 "), DEFAULT),
            Duration::from_secs(45)
        );
    }

    #[test]
    fn zero_empty_and_junk_fall_back_to_the_default() {
        for raw in ["0", "", "  ", "abc", "-3", "1.5", "2s"] {
            assert_eq!(parse_send_timeout(Some(raw), DEFAULT), DEFAULT, "{raw:?}");
        }
    }
}

/// Parse a stored printer language, e.g. from `printers.language`.
///
/// Unknown values fall back to `Pdf` — the language every job used before
/// dispatch existed — rather than failing a print on bad DB data.
pub fn parse_printer_language(raw: &str) -> PrinterLanguage {
    match raw.trim().to_ascii_lowercase().as_str() {
        "escpos" | "esc/pos" | "esc-pos" => PrinterLanguage::Escpos,
        "tspl" | "tspl2" => PrinterLanguage::Tspl,
        "zpl" | "zpl2" => PrinterLanguage::Zpl,
        "cpcl" => PrinterLanguage::Cpcl,
        "raster" => PrinterLanguage::Raster,
        // "" or unknown → pdf, the pre-dispatch behaviour.
        _ => PrinterLanguage::Pdf,
    }
}

/// Encode a raster into a printer's own command language (P4).
///
/// Returns the bytes to send and their MIME type. `Pdf` is not a command
/// language: the pipeline renders PDFs directly and never routes them
/// through here.
///
/// `label_gap_mm` is the TSPL media gap taken from the printer row;
/// `None` falls back to the built-in default (2 mm, the common label gap).
pub fn encode_for_language(
    language: &PrinterLanguage,
    image: &crate::render::raster::RasterImage,
    label_w_mm: f64,
    label_h_mm: f64,
    dpi: u32,
    label_gap_mm: Option<f64>,
) -> Result<(Vec<u8>, &'static str), String> {
    encode_for_language_tuned(
        language,
        image,
        label_w_mm,
        label_h_mm,
        dpi,
        label_gap_mm,
        &label_langs::tspl::TsplTuning::default(),
        &escpos::EscPosTuning::default(),
    )
}

/// [`encode_for_language`] plus the printer's TSPL tuning (darkness,
/// speed, media type) and ESC/POS tuning (raster band height). Only the
/// TSPL arm reads `tspl`, and only the ESC/POS arm reads `escpos_tuning`.
#[allow(clippy::too_many_arguments)]
pub fn encode_for_language_tuned(
    language: &PrinterLanguage,
    image: &crate::render::raster::RasterImage,
    label_w_mm: f64,
    label_h_mm: f64,
    dpi: u32,
    label_gap_mm: Option<f64>,
    tspl: &label_langs::tspl::TsplTuning,
    escpos_tuning: &escpos::EscPosTuning,
) -> Result<(Vec<u8>, &'static str), String> {
    const DEFAULT_GAP_MM: f64 = 2.0;

    match language {
        PrinterLanguage::Pdf => Err(
            "PDF is not a command language: the document is rendered and sent as PDF bytes"
                .to_string(),
        ),
        PrinterLanguage::Escpos => {
            // The complete receipt frame, not just the image: init + raster
            // + three feed lines + a cut. Without the feed the head stops at
            // the image's last row — often short of the tear bar — and
            // without the cut a cutter-equipped model never cuts. The cash-
            // drawer kick is deliberately not sent: opening the drawer after
            // every receipt job would be unwanted. Models without a cutter
            // ignore the cut command, so the frame is safe to send
            // unconditionally.
            Ok((
                escpos::EscPosEncoder::build_receipt_tuned(image, true, false, escpos_tuning),
                "application/octet-stream",
            ))
        }
        PrinterLanguage::Tspl => Ok((
            label_langs::tspl::print_bitmap_tuned(
                image,
                label_w_mm,
                label_h_mm,
                label_gap_mm.unwrap_or(DEFAULT_GAP_MM),
                dpi,
                tspl,
            ),
            "application/octet-stream",
        )),
        PrinterLanguage::Zpl => Ok((
            label_langs::zpl::print_bitmap(image, label_w_mm, label_h_mm, dpi).into_bytes(),
            "application/octet-stream",
        )),
        PrinterLanguage::Cpcl => Ok((
            label_langs::cpcl::print_bitmap(image, label_w_mm, dpi).into_bytes(),
            "application/octet-stream",
        )),
        // The bare packed dots, for spoolers and bridges that take a bitmap
        // and speak no label language of their own.
        PrinterLanguage::Raster => Ok((image.to_bytes(), "application/octet-stream")),
    }
}

/// A plain-text test job for the languages that can print text natively:
/// the smallest job that proves the language mode is right — one line of
/// text, nothing to rasterize, no image buffer for a small Bluetooth head
/// to drop. `None` for languages that only accept bitmaps (pdf, raster):
/// the image test page is the only check they have.
pub fn text_test_bytes(language: &PrinterLanguage, name: &str, label_w_mm: f64) -> Option<Vec<u8>> {
    let line = format!("PrintNinja test: {name}");
    Some(match language {
        PrinterLanguage::Escpos => {
            let mut b = escpos::EscPosEncoder::init();
            b.extend(escpos::EscPosEncoder::text(&line));
            b.extend(escpos::EscPosEncoder::feed(3));
            b
        }
        PrinterLanguage::Tspl => {
            // A 30 mm-tall label, at least as wide as the printer's own.
            let mut s = format!("SIZE {} mm,30 mm\r\n", label_w_mm.max(30.0));
            s.push_str("GAP 2 mm,0 mm\r\n");
            s.push_str("DIRECTION 1\r\n");
            s.push_str("REFERENCE 0,0\r\n");
            s.push_str("CLS\r\n");
            s.push_str("TEXT 0,0,\"2\",0,1,1,\"PrintNinja test\"\r\n");
            s.push_str("PRINT 1\r\n");
            s.into_bytes()
        }
        PrinterLanguage::Zpl => {
            let mut s = String::from("^XA\n^FO50,50^A0N,40,40\n");
            s.push_str(&format!("^FD{line}^FS\n"));
            s.push_str("^XZ\n");
            s.into_bytes()
        }
        PrinterLanguage::Cpcl => {
            let mut s = String::from("! 0 200 200 210 1\r\n");
            s.push_str("TEXT 0 20 4 0 0 PrintNinja test\r\n");
            s.push_str("PRINT\r\n");
            s.into_bytes()
        }
        PrinterLanguage::Pdf | PrinterLanguage::Raster => return None,
    })
}

#[derive(Debug, Clone)]
pub struct RenderedJob {
    pub job_id: String,
    pub printer_id: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub copies: u32,
    /// The printer's own command language, which a raw transport needs to
    /// know *before* the job: it decides which status query, if any, the
    /// printer is asked whether it can actually print. `Pdf` — the language
    /// of a printer row that carries none — asks nothing.
    pub language: PrinterLanguage,
    /// A raw console send: pacing/settle overrides and the recorder the
    /// transport fills with what it actually applied. `None` — every
    /// ordinary print — changes nothing the transport does.
    pub raw: Option<RawSend>,
}

#[async_trait]
pub trait PrinterTransport: Send + Sync {
    /// Find printers this transport can reach.
    ///
    /// Takes `&self` deliberately. Without it the method has no `self`
    /// parameter at all, so it is not dispatchable through `dyn
    /// PrinterTransport` and a registry can only ever call whichever one
    /// implementation it names statically. That made per-printer transports
    /// — a USB thermal head sitting next to an IPP office printer —
    /// impossible to represent.
    async fn discover(&self) -> Vec<PrinterInfo>;

    async fn test(&self) -> Result<(), String>;

    async fn send(&self, job: RenderedJob) -> Result<(), String>;
}

#[cfg(target_os = "android")]
pub mod android_bluetooth;
pub mod android_bridge;
#[cfg(target_os = "android")]
pub mod android_usb;
pub mod bluetooth_addr;
pub mod capabilities;
pub mod cups;
pub mod escpos;
pub mod ipp;
pub mod label_langs;
#[cfg(target_os = "linux")]
pub mod linux_bluetooth;
pub mod raw_tcp;
pub mod status;
pub mod windows_bluetooth;
pub mod windows_spooler;
pub mod windows_usb;

/// Parse a stored printer type id, e.g. from `printers.printer_type`.
impl std::str::FromStr for PrinterType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ipp" => Ok(PrinterType::Ipp),
            "raw_tcp" | "rawtcp" | "tcp" | "network" => Ok(PrinterType::RawTcp),
            "usb" => Ok(PrinterType::Usb),
            "bluetooth" | "bt" => Ok(PrinterType::Bluetooth),
            "system" | "spooler" | "windows" => Ok(PrinterType::System),
            other => Err(format!("Unknown printer type `{other}`")),
        }
    }
}

impl std::fmt::Display for PrinterType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            PrinterType::Ipp => "ipp",
            PrinterType::RawTcp => "raw_tcp",
            PrinterType::Usb => "usb",
            PrinterType::Bluetooth => "bluetooth",
            PrinterType::System => "system",
        };
        f.write_str(s)
    }
}

/// Build a transport for a stored printer row.
///
/// One function so every caller (Tauri commands, REST API routes, deep
/// links) resolves transports identically. `None` means the transport has no
/// implementation on this platform — never a silent success.
pub fn create_transport(
    printer_type: &PrinterType,
    name: &str,
    address: &str,
    settings: &TransportSettings,
) -> Option<Box<dyn PrinterTransport>> {
    match printer_type {
        PrinterType::Ipp => Some(Box::new(
            ipp::IppPrinter::new(name.to_string(), address.to_string()).with_credentials(
                settings.username.clone(),
                settings.password.clone(),
                settings.skip_tls_verification,
            ),
        )),
        PrinterType::RawTcp => Some(Box::new(raw_tcp::RawTcpPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
        #[cfg(windows)]
        PrinterType::System => Some(Box::new(windows_spooler::WindowsSpooler::new(
            name.to_string(),
        ))),
        #[cfg(target_os = "linux")]
        PrinterType::System => Some(Box::new(cups::CupsPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
        #[cfg(windows)]
        PrinterType::Usb => Some(Box::new(windows_usb::WindowsUsbPrinter::new(
            name.to_string(),
        ))),
        #[cfg(windows)]
        PrinterType::Bluetooth => Some(Box::new(windows_bluetooth::WindowsBluetoothPrinter::new(
            name.to_string(),
            address.to_string(),
            settings.via_driver,
        ))),
        #[cfg(target_os = "android")]
        PrinterType::Usb => Some(Box::new(android_usb::AndroidUsbPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
        #[cfg(target_os = "android")]
        PrinterType::Bluetooth => Some(Box::new(android_bluetooth::AndroidBluetoothPrinter::new(
            name.to_string(),
            address.to_string(),
            settings.via_driver,
            settings.bluetooth,
        ))),
        // Linux dials the paired device's RFCOMM socket directly — no
        // driver, no CUPS queue — unless the row is set to print through
        // its CUPS queue (USB still has no direct transport and falls
        // through to the refusal below).
        #[cfg(target_os = "linux")]
        PrinterType::Bluetooth => Some(Box::new(linux_bluetooth::LinuxBluetoothPrinter::new(
            name.to_string(),
            address.to_string(),
            settings.via_driver,
        ))),
        // Off Windows, off Linux and off Android (which drives
        // USB/Bluetooth through the Kotlin plugin above) there is no
        // spooler and no USB/Bluetooth transport (Linux serves system
        // printers through CUPS, matched above), so every other
        // variant is unsupported here.
        #[cfg(not(windows))]
        _ => None,
    }
}

/// Parse a stored printer type, falling back to the platform default rather
/// than panicking on bad DB data.
pub fn parse_printer_type(raw: &str) -> PrinterType {
    raw.parse().unwrap_or(PrinterType::System)
}

/// One entry point for discovery and sending, so callers do not each
/// re-implement the platform `cfg` soup.
#[derive(Default)]
pub struct TransportRegistry {
    _private: (),
}

impl TransportRegistry {
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// Every printer reachable on this machine, across all transports.
    ///
    /// Discovery is inherently per-platform: the Windows spooler enumerates
    /// installed printers, Android uses NsdManager, and USB/Bluetooth need
    /// Windows-specific enumeration. Individual transports that fail are
    /// skipped rather than failing the whole scan.
    pub async fn discover_all() -> Vec<PrinterInfo> {
        #[cfg(windows)]
        {
            match create_transport(&PrinterType::System, "", "", &TransportSettings::default()) {
                Some(t) => t.discover().await,
                None => Vec::new(),
            }
        }
        #[cfg(target_os = "linux")]
        {
            // CUPS queues are the system printers.
            match create_transport(&PrinterType::System, "", "", &TransportSettings::default()) {
                Some(t) => t.discover().await,
                None => Vec::new(),
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            // No system enumeration here; IPP discovery runs through
            // the platform bridge (NsdManager on Android).
            android_bridge::AndroidBridge::new().discover().await
        }
    }

    /// Resolve the transport for a printer row and send `job` to it.
    pub async fn send_to(
        printer_type: &PrinterType,
        name: &str,
        address: &str,
        job: RenderedJob,
        settings: &TransportSettings,
    ) -> Result<(), String> {
        let transport =
            create_transport(printer_type, name, address, settings).ok_or_else(|| {
                format!("`{printer_type}` printers are not supported on this platform")
            })?;
        transport.send(job).await
    }

    /// Connectivity check for a stored printer row.
    pub async fn test_printer(
        printer_type: &PrinterType,
        name: &str,
        address: &str,
        settings: &TransportSettings,
    ) -> Result<(), String> {
        let transport =
            create_transport(printer_type, name, address, settings).ok_or_else(|| {
                format!("`{printer_type}` printers are not supported on this platform")
            })?;
        transport.test().await
    }

    /// Reachability check for a stored printer row: is anything there?
    ///
    /// A probe is a connection, never a job. That distinction matters for
    /// every transport whose [`PrinterTransport::test`] submits a real
    /// document or writes bytes a printer may print (IPP POSTs a test page,
    /// raw TCP and USB/Bluetooth write to the device), so asking them "are
    /// you there?" the way [`Self::test_printer`] does would print a page
    /// just for looking. USB, Bluetooth and raw TCP probes only open and
    /// close; IPP only connects.
    ///
    /// Only transports with an address to dial can be probed; every other
    /// transport is left to its own `test`, so a probe returns `Ok` for
    /// them — except on a platform with no implementation at all, which
    /// says so rather than reporting a printer it never saw.
    pub async fn probe(
        printer_type: &PrinterType,
        name: &str,
        address: &str,
        settings: &TransportSettings,
    ) -> Result<(), String> {
        match printer_type {
            PrinterType::Ipp => {
                ipp::IppPrinter::new(name.to_string(), address.to_string())
                    .with_credentials(
                        settings.username.clone(),
                        settings.password.clone(),
                        settings.skip_tls_verification,
                    )
                    .reach()
                    .await
            }
            PrinterType::RawTcp => {
                raw_tcp::RawTcpPrinter::new(name.to_string(), address.to_string())
                    .reach()
                    .await
            }
            PrinterType::System => {
                // W4: check_ready blocks on the queue; keep it off tokio
                // workers like every other spooler call.
                #[cfg(windows)]
                let res = {
                    let owned = name.to_string();
                    tokio::task::spawn_blocking(move || {
                        windows_spooler::WindowsSpooler::new(owned).check_ready()
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("spooler probe task failed: {e}")))
                };
                #[cfg(target_os = "linux")]
                let res = cups::CupsPrinter::new(name.to_string(), address.to_string())
                    .test()
                    .await;
                #[cfg(not(any(windows, target_os = "linux")))]
                let res: Result<(), String> = Err(format!(
                    "`{printer_type}` printers are not supported on this platform"
                ));
                #[allow(unreachable_code)]
                res
            }
            PrinterType::Usb => {
                #[cfg(target_os = "android")]
                let res =
                    android_usb::AndroidUsbPrinter::new(name.to_string(), address.to_string())
                        .reach()
                        .await;
                #[cfg(windows)]
                let res = windows_spooler::WindowsSpooler::new(name.to_string()).check_ready();
                #[cfg(target_os = "linux")]
                let res: Result<(), String> = Err(format!(
                    "USB printers on Linux are not driven directly; install the device as a CUPS raw queue (sudo lpadmin -p '{}' -m raw -v usb://... -E) and add it as type 'system'",
                    name
                ));
                #[cfg(not(any(target_os = "android", windows, target_os = "linux")))]
                let res: Result<(), String> = Err(format!(
                    "`{printer_type}` printers are not supported on this platform"
                ));
                #[allow(unreachable_code)]
                res
            }
            PrinterType::Bluetooth => {
                // The row's manual mode decides the path here too: a
                // driver row checks its queue's status, a driverless row
                // opens and closes its own wire — the same resolution
                // the job itself uses.
                #[cfg(target_os = "android")]
                let res = android_bluetooth::AndroidBluetoothPrinter::new(
                    name.to_string(),
                    address.to_string(),
                    settings.via_driver,
                    settings.bluetooth,
                )
                .reach()
                .await;
                #[cfg(windows)]
                let res = windows_bluetooth::WindowsBluetoothPrinter::new(
                    name.to_string(),
                    address.to_string(),
                    settings.via_driver,
                )
                .reach()
                .await;
                // Direct RFCOMM connect to the paired device (or the
                // row's CUPS queue when driver mode is on): a probe is
                // a connection and nothing else, so nothing is written.
                #[cfg(target_os = "linux")]
                let res = linux_bluetooth::LinuxBluetoothPrinter::new(
                    name.to_string(),
                    address.to_string(),
                    settings.via_driver,
                )
                .reach()
                .await;
                #[cfg(not(any(target_os = "android", windows, target_os = "linux")))]
                let res: Result<(), String> = Err(format!(
                    "`{printer_type}` printers are not supported on this platform"
                ));
                #[allow(unreachable_code)]
                res
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_stored_type_id_parses() {
        // These are the strings the DB stores in printers.printer_type.
        for id in ["ipp", "raw_tcp", "usb", "bluetooth", "system"] {
            assert!(id.parse::<PrinterType>().is_ok(), "{id} should parse");
        }
    }

    #[test]
    fn type_parsing_is_case_and_space_insensitive() {
        assert!(matches!(
            "  IPP ".parse::<PrinterType>().unwrap(),
            PrinterType::Ipp
        ));
        assert!(matches!(
            "RawTCP".parse::<PrinterType>().unwrap(),
            PrinterType::RawTcp
        ));
    }

    #[test]
    fn unknown_type_is_an_error_not_a_panic() {
        assert!("telepathy".parse::<PrinterType>().is_err());
        assert!(matches!(
            parse_printer_type("telepathy"),
            PrinterType::System
        ));
    }

    #[test]
    fn text_test_escpos_is_init_one_line_and_a_feed() {
        let bytes = text_test_bytes(&PrinterLanguage::Escpos, "B-FP2D", 54.0).unwrap();
        // ESC @, then the line with its newline, then GS d 3 to feed out
        // the last row (receipt printers hold a few lines in the platen).
        assert_eq!(&bytes[..2], &[0x1B, 0x40]);
        let line = b"PrintNinja test: B-FP2D\n";
        assert!(bytes.windows(line.len()).any(|w| w == line));
        assert_eq!(&bytes[bytes.len() - 3..], &[0x1B, 0x64, 0x03]);
    }

    #[test]
    fn text_test_label_languages_keep_their_frame_and_text() {
        let tspl =
            String::from_utf8(text_test_bytes(&PrinterLanguage::Tspl, "X", 40.0).unwrap()).unwrap();
        assert!(tspl.starts_with("SIZE 40 mm,30 mm\r\n"), "{tspl}");
        assert!(tspl.contains("TEXT 0,0,\"2\",0,1,1,\"PrintNinja test\"\r\n"));
        assert!(tspl.trim_end().ends_with("PRINT 1"));

        let zpl =
            String::from_utf8(text_test_bytes(&PrinterLanguage::Zpl, "ZT", 40.0).unwrap()).unwrap();
        assert!(zpl.starts_with("^XA\n"), "{zpl}");
        assert!(zpl.contains("^FDPrintNinja test: ZT^FS\n"));
        assert!(zpl.trim_end().ends_with("^XZ"));

        let cpcl =
            String::from_utf8(text_test_bytes(&PrinterLanguage::Cpcl, "C", 40.0).unwrap()).unwrap();
        assert!(cpcl.starts_with("! 0 200 200 210 1\r\n"), "{cpcl}");
        assert!(cpcl.contains("TEXT 0 20 4 0 0 PrintNinja test\r\n"));
        assert!(cpcl.trim_end().ends_with("PRINT"));
    }

    #[test]
    fn text_test_width_never_drops_below_a_real_label() {
        // A stored 24 mm roll must not produce a 24 mm TSPL label.
        let tspl =
            String::from_utf8(text_test_bytes(&PrinterLanguage::Tspl, "X", 24.0).unwrap()).unwrap();
        assert!(tspl.starts_with("SIZE 30 mm,30 mm\r\n"), "{tspl}");
    }

    #[test]
    fn text_test_has_no_form_for_bitmap_only_languages() {
        assert!(text_test_bytes(&PrinterLanguage::Pdf, "X", 80.0).is_none());
        assert!(text_test_bytes(&PrinterLanguage::Raster, "X", 80.0).is_none());
    }

    #[test]
    fn staged_payload_round_trips_and_cleans_up() {
        // Unique subdir per run: parallel tests must not share filenames.
        let dir = std::env::temp_dir().join(format!("pn-handoff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let data = vec![0xABu8; 300_000];
        let path = stage_plugin_payload(&dir, &data).unwrap();
        assert!(path.starts_with(&dir));
        assert_eq!(std::fs::read(&path).unwrap(), data);
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn staging_names_are_unique() {
        let dir = std::env::temp_dir();
        let a = stage_plugin_payload(&dir, b"one").unwrap();
        let b = stage_plugin_payload(&dir, b"two").unwrap();
        assert_ne!(a, b, "a reused filename would interleave two prints");
        std::fs::remove_file(&a).unwrap();
        std::fs::remove_file(&b).unwrap();
    }

    #[test]
    fn display_round_trips_through_parse() {
        for id in ["ipp", "raw_tcp", "usb", "bluetooth", "system"] {
            let parsed: PrinterType = id.parse().unwrap();
            assert_eq!(parsed.to_string(), id);
        }
    }

    /// The add-printer form reads discovered rows straight off the wire,
    /// so the JSON ids must be the same lowercase words the form, the
    /// schema and the DB use — not the Rust variant names.
    #[test]
    fn printer_rows_serialize_with_lowercase_ids() {
        let info = PrinterInfo {
            id: "net:192.168.1.20:631".into(),
            name: "Lobby".into(),
            address: "192.168.1.20:631".into(),
            printer_type: PrinterType::RawTcp,
            language: PrinterLanguage::Pdf,
            status: "unknown".into(),
            pdf_datatype: None,
        };
        let json = serde_json::to_value(&info).expect("serializes");
        assert_eq!(json["printer_type"], "raw_tcp");
        assert_eq!(json["language"], "pdf");
    }

    /// A row serialized by an older build (no `pdf_datatype` field) must
    /// still parse, as `None` = unknown — never a failed handshake.
    #[test]
    fn rows_without_pdf_datatype_default_to_unknown() {
        let row = serde_json::json!({
            "id": "q",
            "name": "Q",
            "address": "Q",
            "printer_type": "system",
            "language": "pdf",
            "status": "online",
        });
        let info: PrinterInfo = serde_json::from_value(row).expect("old row parses");
        assert_eq!(info.pdf_datatype, None);
    }

    /// P4: the language column decides the encoder, and anything the schema
    /// would not allow (hand-edited row, empty string) behaves like the
    /// pre-dispatch world: PDF.
    #[test]
    fn language_parsing_falls_back_to_pdf() {
        use PrinterLanguage::*;
        assert!(matches!(parse_printer_language("zpl"), Zpl));
        assert!(matches!(parse_printer_language(" ZPL "), Zpl));
        assert!(matches!(parse_printer_language("esc/pos"), Escpos));
        assert!(matches!(parse_printer_language("tspl2"), Tspl));
        assert!(matches!(parse_printer_language("cpcl"), Cpcl));
        assert!(matches!(parse_printer_language("raster"), Raster));
        assert!(matches!(parse_printer_language("pdf"), Pdf));
        assert!(matches!(parse_printer_language("telepathy"), Pdf));
        assert!(matches!(parse_printer_language(""), Pdf));
    }

    /// P4: `pdf` is not routed through the raster encoders — the pipeline
    /// renders PDFs directly and this function refuses them.
    #[test]
    fn encoding_a_pdf_from_a_raster_is_an_error() {
        let image = crate::render::raster::RasterImage::new(8, 1);
        let err = encode_for_language(&PrinterLanguage::Pdf, &image, 40.0, 30.0, 203, None)
            .expect_err("pdf must not be encoded from a raster");
        assert!(err.contains("PDF"), "{err}");
    }

    /// P4: every command language carries its own framing around the same
    /// raster — this is what "each takes its own path" means on the wire.
    #[test]
    fn every_command_language_frames_its_raster() {
        let mut image = crate::render::raster::RasterImage::new(8, 2);
        image.set_bit(0, 0, true);
        image.set_bit(7, 1, true);

        let (zpl, _) =
            encode_for_language(&PrinterLanguage::Zpl, &image, 40.0, 30.0, 203, None).unwrap();
        let zpl = String::from_utf8_lossy(&zpl);
        assert!(zpl.starts_with("^XA"), "{zpl}");
        assert!(zpl.contains("80"), "hex of the first row (0x80): {zpl}");

        let (tspl, _) =
            encode_for_language(&PrinterLanguage::Tspl, &image, 40.0, 30.0, 203, None).unwrap();
        let tspl = String::from_utf8_lossy(&tspl);
        assert!(tspl.starts_with("SIZE 40 mm"), "{tspl}");
        assert!(tspl.contains("BITMAP 0,0,1,2,0"), "{tspl}");

        let (cpcl, _) =
            encode_for_language(&PrinterLanguage::Cpcl, &image, 40.0, 30.0, 203, None).unwrap();
        let cpcl = String::from_utf8_lossy(&cpcl);
        assert!(cpcl.starts_with("! 0 200 200"), "{cpcl}");
        assert!(cpcl.contains("PRINT"), "{cpcl}");

        let (escpos, _) =
            encode_for_language(&PrinterLanguage::Escpos, &image, 40.0, 30.0, 203, None).unwrap();
        assert!(escpos.starts_with(&[0x1B, 0x40]));
        assert!(escpos.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));
        // The frame ends with the feed lines (ESC d 3) and a full cut
        // (GS V 0), so receipts no longer stop short of the tear bar.
        assert!(escpos.windows(3).any(|w| w == [0x1B, 0x64, 0x03]));
        assert!(escpos.ends_with(&[0x1D, 0x56, 0x00]));

        let (raster, _) =
            encode_for_language(&PrinterLanguage::Raster, &image, 40.0, 30.0, 203, None).unwrap();
        assert_eq!(raster, image.to_bytes(), "raster is the bare dots");
    }

    /// Regression for #19: `discover` used to be a static method with no
    /// `self` parameter, so it could not be reached through a
    /// `dyn PrinterTransport`. Build boxed transports and call every trait
    /// method through the trait object.
    #[tokio::test]
    async fn transports_are_dyn_dispatchable() {
        let transports: Vec<Box<dyn PrinterTransport>> = vec![
            Box::new(ipp::IppPrinter::new("ip".into(), "127.0.0.1".into())),
            Box::new(raw_tcp::RawTcpPrinter::new(
                "tcp".into(),
                "127.0.0.1".into(),
            )),
        ];
        // Empty discovery is fine (mDNS is platform-specific); the point is
        // that the call compiles and dispatches at all.
        for t in &transports {
            let _found: Vec<PrinterInfo> = t.discover().await;
        }
    }

    #[tokio::test]
    async fn send_to_an_unreachable_ipprinter_fails_rather_than_hangs() {
        let t = ipp::IppPrinter::new("ip".into(), "127.0.0.1".into());
        let job = RenderedJob {
            job_id: "j1".into(),
            printer_id: "p1".into(),
            data: vec![0x25, 0x50, 0x44, 0x46],
            mime_type: "application/pdf".into(),
            copies: 1,
            language: PrinterLanguage::Pdf,
            raw: None,
        };
        // No IPP server on the loopback test port: must be Err, not Ok.
        assert!(t.send(job).await.is_err());
    }

    #[cfg(all(not(windows), not(target_os = "linux")))]
    #[tokio::test]
    async fn unsupported_platform_names_the_type_that_failed() {
        // Off Windows (and off Linux, which serves system printers
        // through CUPS) there is no spooler, so `system` must say so
        // rather than reporting a successful print.
        let err = TransportRegistry::test_printer(
            &PrinterType::System,
            "p",
            "",
            &TransportSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("system"), "{err}");
        assert!(err.contains("not supported"), "{err}");

        // A probe against the same unsupported row fails the same way:
        // "nothing to dial" must never read as "reachable".
        let err =
            TransportRegistry::probe(&PrinterType::System, "p", "", &TransportSettings::default())
                .await
                .unwrap_err();
        assert!(err.contains("not supported"), "{err}");
    }

    /// The probe is a connection and nothing else: against something
    /// listening it succeeds and leaves the socket untouched (no bytes
    /// written, connection closed), which is what makes it safe to run
    /// before a document is rendered.
    #[tokio::test]
    async fn a_probe_connects_and_prints_nothing() {
        use tokio::io::AsyncReadExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // The raw TCP probe.
        TransportRegistry::probe(
            &PrinterType::RawTcp,
            "p",
            &format!("127.0.0.1:{port}"),
            &TransportSettings::default(),
        )
        .await
        .expect("something is listening");
        // The IPP probe, against the very same listener.
        TransportRegistry::probe(
            &PrinterType::Ipp,
            "p",
            &format!("127.0.0.1:{port}"),
            &TransportSettings::default(),
        )
        .await
        .expect("something is listening");

        // Two connects, two silent connections: EOF on the first, EOF on
        // the second. A probe that wrote or printed would show bytes here.
        for i in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            match tokio::time::timeout(
                std::time::Duration::from_secs(2),
                stream.read(&mut [0u8; 32]),
            )
            .await
            {
                Ok(Ok(0)) => {}
                Ok(Ok(n)) => panic!("probe {i} wrote {n} bytes — a probe must not print"),
                Ok(Err(e)) => panic!("probe {i} connection broke: {e}"),
                Err(_) => panic!("probe {i} left the connection open"),
            }
        }
    }

    /// A port nothing listens on is refused, in the "Could not reach"
    /// wording the UI translates — not as a hang and not as a success.
    #[tokio::test]
    async fn a_probe_against_a_dead_address_says_where_it_failed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // nothing is listening on this port any more

        for kind in [PrinterType::Ipp, PrinterType::RawTcp] {
            let err = TransportRegistry::probe(
                &kind,
                "p",
                &format!("127.0.0.1:{port}"),
                &TransportSettings::default(),
            )
            .await
            .unwrap_err();
            assert!(err.contains("Could not reach"), "{kind}: {err}");
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn system_transport_probes_cups_without_printing() {
        // Read-only probe: absent daemon and unknown queue both fail
        // without submitting anything.
        let err = TransportRegistry::test_printer(
            &PrinterType::System,
            "no-such-queue-printninja",
            "",
            &TransportSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("CUPS"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn usb_on_linux_is_a_cups_raw_queue() {
        // USB has no direct transport on Linux; the app reports the
        // supported route (CUPS raw queue) instead of silently
        // succeeding.
        let err = TransportRegistry::probe(
            &PrinterType::Usb,
            "MyThermal",
            "usb://dummy",
            &TransportSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("CUPS raw queue"), "{err}");
        assert!(err.contains("lpadmin"), "{err}");
        assert!(err.contains("type 'system'"), "{err}");
        // The generic send path still refuses direct USB on Linux.
        let err = TransportRegistry::send_to(
            &PrinterType::Usb,
            "MyThermal",
            "usb://dummy",
            RenderedJob {
                job_id: "j".into(),
                printer_id: "p".into(),
                data: vec![0x1b, 0x40],
                mime_type: "application/octet-stream".into(),
                copies: 1,
                language: PrinterLanguage::Escpos,
                raw: None,
            },
            &TransportSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not supported"), "{err}");
    }

    /// Bluetooth on Linux is direct now: the transport exists and an
    /// address that is not a Bluetooth address fails with the format
    /// message — never with "unsupported" and never with the old CUPS
    /// raw-queue advice.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn bluetooth_on_linux_dials_the_device_directly() {
        assert!(create_transport(
            &PrinterType::Bluetooth,
            "MyThermal",
            "A4:77:17:22:33:44",
            &TransportSettings::default()
        )
        .is_some());

        let err = TransportRegistry::probe(
            &PrinterType::Bluetooth,
            "MyThermal",
            "usb://dummy",
            &TransportSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("A4:77:17:22:33:44"), "{err}");
        assert!(
            !err.contains("CUPS"),
            "no queue advice for a direct wire: {err}"
        );

        let err = TransportRegistry::send_to(
            &PrinterType::Bluetooth,
            "MyThermal",
            "usb://dummy",
            RenderedJob {
                job_id: "j".into(),
                printer_id: "p".into(),
                data: vec![0x1b, 0x40],
                mime_type: "application/octet-stream".into(),
                copies: 1,
                language: PrinterLanguage::Escpos,
                raw: None,
            },
            &TransportSettings::default(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("A4:77:17:22:33:44"), "{err}");
        assert!(!err.contains("not supported"), "{err}");
    }

    #[test]
    fn cups_raw_queue_carries_octet_stream_not_pdf() {
        // A CUPS queue that fronts a thermal head must be told the payload
        // is octet-stream, not PDF, or cupsd would filter it.
        let p = ipp::IppPrinter::new("t".into(), "10.0.0.1".into());
        let pdf = p.build_ipp_request_with_format(b"%PDF", 1, "application/pdf");
        let raw = p.build_ipp_request_with_format(b"\x1b\x40", 1, "application/octet-stream");
        assert!(String::from_utf8_lossy(&pdf).contains("application/pdf"));
        assert!(String::from_utf8_lossy(&raw).contains("application/octet-stream"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn system_transport_exists_on_windows() {
        assert!(create_transport(
            &PrinterType::System,
            "Printer",
            "",
            &TransportSettings::default()
        )
        .is_some());
        assert!(create_transport(
            &PrinterType::Usb,
            "Thermal",
            "",
            &TransportSettings::default()
        )
        .is_some());
        // Bluetooth too: the driverless COM path exists on Windows, and
        // a driver-mode row resolves its spooler queue.
        assert!(create_transport(
            &PrinterType::Bluetooth,
            "Thermal",
            "COM7",
            &TransportSettings::default()
        )
        .is_some());
        assert!(create_transport(
            &PrinterType::Bluetooth,
            "Thermal",
            "A4:77:17:22:33:44",
            &TransportSettings {
                via_driver: true,
                ..Default::default()
            }
        )
        .is_some());
    }

    /// Driver mode is a manual, explicit choice: the same row that
    /// dials the device directly on the default settings must resolve
    /// to the CUPS queue when the flag is on — and never silently
    /// otherwise.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn bluetooth_via_driver_sends_to_the_cups_queue() {
        let err = TransportRegistry::send_to(
            &PrinterType::Bluetooth,
            "MyThermal",
            "A4:77:17:22:33:44",
            RenderedJob {
                job_id: "j".into(),
                printer_id: "p".into(),
                data: vec![0x1b, 0x40],
                mime_type: "application/octet-stream".into(),
                copies: 1,
                language: PrinterLanguage::Escpos,
                raw: None,
            },
            &TransportSettings {
                via_driver: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        // The queue is addressed by name, so the failure is CUPS's —
        // not the driverless wire's address-format complaint.
        assert!(err.contains("MyThermal"), "{err}");
        assert!(
            !err.contains("A4:77:17"),
            "queue path must not dial the MAC: {err}"
        );
    }

    /// The manual flag defaults off: nothing about the other settings
    /// implies driver mode.
    #[test]
    fn driver_mode_defaults_to_the_driverless_wire() {
        assert!(!TransportSettings::default().via_driver);
    }

    /// A stored pacing round-trips: the `bluetooth` key inside
    /// `default_settings_json` is read back byte-for-byte, and anything
    /// missing or out of range falls back to the built-in pace rather
    /// than refusing the print.
    #[test]
    fn bluetooth_delivery_reads_the_stored_key_leniently() {
        let d = BluetoothDelivery {
            chunk_bytes: 256,
            chunk_pause_ms: 100,
        };
        assert_eq!(
            d,
            BluetoothDelivery::from_settings_json(Some(
                r#"{"bluetooth":{"chunkBytes":256,"chunkPauseMs":100}}"#
            ))
        );

        // No key, no row, malformed JSON, wrong shape: all the default.
        let default = BluetoothDelivery::default();
        assert_eq!(
            default,
            BluetoothDelivery::from_settings_json(Some(r#"{"tspl":{}}"#))
        );
        assert_eq!(default, BluetoothDelivery::from_settings_json(None));
        assert_eq!(
            default,
            BluetoothDelivery::from_settings_json(Some("not json"))
        );
        assert_eq!(
            default,
            BluetoothDelivery::from_settings_json(Some(r#"{"bluetooth":"fast"}"#))
        );
    }

    /// A bad stored value can never break a print: out-of-range numbers
    /// validate to the default pace on the read path, but the strict
    /// check refuses them when a person saves them.
    #[test]
    fn bluetooth_delivery_refuses_out_of_range_pace() {
        let bad = BluetoothDelivery {
            chunk_bytes: 1,
            chunk_pause_ms: 50,
        };
        assert!(bad.validate().is_err());
        assert_eq!(
            BluetoothDelivery::default(),
            BluetoothDelivery::from_settings_json(Some(r#"{"bluetooth":{"chunkBytes":1}}"#))
        );
        let big = BluetoothDelivery {
            chunk_bytes: 9000,
            chunk_pause_ms: 50,
        };
        assert!(big.validate().is_err());
        let slow = BluetoothDelivery {
            chunk_bytes: 512,
            chunk_pause_ms: 2001,
        };
        assert!(slow.validate().is_err());
        assert!(BluetoothDelivery {
            chunk_bytes: 32,
            chunk_pause_ms: 0,
        }
        .validate()
        .is_ok());
        assert!(BluetoothDelivery {
            chunk_bytes: 8192,
            chunk_pause_ms: 2000,
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn raw_options_unset_keep_the_stored_pace() {
        let stored = BluetoothDelivery {
            chunk_bytes: 256,
            chunk_pause_ms: 100,
        };
        let d = RawDelivery::resolve(&RawSendOptions::default(), stored);
        assert_eq!(d.chunk_bytes, 256);
        assert_eq!(d.chunk_pause_ms, 100);
        assert_eq!(d.settle_override_ms, None);
        assert_eq!(
            d.desktop_settle_ms(),
            0,
            "no override means today's immediate close"
        );
    }

    #[test]
    fn raw_options_unset_keep_the_built_in_pace() {
        let d = RawDelivery::resolve(&RawSendOptions::default(), BluetoothDelivery::default());
        assert_eq!(d.chunk_bytes, 512);
        assert_eq!(d.chunk_pause_ms, 50);
    }

    #[test]
    fn raw_overrides_win_but_are_clamped_to_the_bluetooth_bounds() {
        let d = RawDelivery::resolve(
            &RawSendOptions {
                chunk_bytes: Some(1),
                chunk_pause_ms: Some(u32::MAX),
                settle_ms: Some(u32::MAX),
            },
            BluetoothDelivery::default(),
        );
        assert_eq!(d.chunk_bytes, BluetoothDelivery::MIN_CHUNK_BYTES);
        assert_eq!(d.chunk_pause_ms, BluetoothDelivery::MAX_PAUSE_MS);
        assert_eq!(d.settle_override_ms, Some(MAX_SETTLE_MS));
    }

    #[test]
    fn raw_overrides_at_the_bounds_pass_through() {
        let d = RawDelivery::resolve(
            &RawSendOptions {
                chunk_bytes: Some(BluetoothDelivery::MAX_CHUNK_BYTES),
                chunk_pause_ms: Some(0),
                settle_ms: Some(300),
            },
            BluetoothDelivery::default(),
        );
        assert_eq!(d.chunk_bytes, BluetoothDelivery::MAX_CHUNK_BYTES);
        assert_eq!(d.chunk_pause_ms, 0);
        assert_eq!(d.settle_override_ms, Some(300));
        assert_eq!(d.desktop_settle_ms(), 300);
    }

    #[test]
    fn raw_recorder_round_trips_and_stays_none_where_unused() {
        let r = RawRecorder::default();
        assert_eq!(r.effective(), None, "nothing applied yet");
        assert_eq!(
            r.timings(),
            RawSendTimings {
                open: None,
                write: None,
                settle: None,
                close: None,
            }
        );
        r.record_open(12);
        r.record_write(340);
        r.record_settle(299);
        r.record_close(1);
        r.record_effective(256, 100, 300);
        assert_eq!(
            r.effective(),
            Some(RawSendOptions {
                chunk_bytes: Some(256),
                chunk_pause_ms: Some(100),
                settle_ms: Some(300),
            })
        );
        assert_eq!(
            r.timings(),
            RawSendTimings {
                open: Some(12),
                write: Some(340),
                settle: Some(299),
                close: Some(1),
            }
        );
    }
}
