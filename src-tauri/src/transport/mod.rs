use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub address: String,
    pub printer_type: PrinterType,
    pub language: PrinterLanguage,
    pub status: String,
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
pub fn encode_for_language(
    language: &PrinterLanguage,
    image: &crate::render::raster::RasterImage,
    label_w_mm: f64,
    label_h_mm: f64,
    dpi: u32,
) -> Result<(Vec<u8>, &'static str), String> {
    // Default media gap for TSPL when the printer row carries none — the
    // printers table has no gap column (2 mm is the common label gap).
    const DEFAULT_GAP_MM: f64 = 2.0;

    match language {
        PrinterLanguage::Pdf => Err(
            "PDF is not a command language: the document is rendered and sent as PDF bytes"
                .to_string(),
        ),
        PrinterLanguage::Escpos => {
            let mut data = escpos::EscPosEncoder::init();
            data.extend_from_slice(&escpos::EscPosEncoder::print_raster(image));
            Ok((data, "application/octet-stream"))
        }
        PrinterLanguage::Tspl => Ok((
            label_langs::tspl::print_bitmap(image, label_w_mm, label_h_mm, DEFAULT_GAP_MM, dpi),
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
pub mod cups;
pub mod escpos;
pub mod ipp;
pub mod label_langs;
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
) -> Option<Box<dyn PrinterTransport>> {
    match printer_type {
        PrinterType::Ipp => Some(Box::new(ipp::IppPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
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
        ))),
        // Off Windows (and off Android, which drives USB/Bluetooth through
        // the Kotlin plugin above) there is no spooler and no USB/Bluetooth
        // transport (Linux serves system printers through CUPS, matched
        // above), so every other variant is unsupported here.
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
            match create_transport(&PrinterType::System, "", "") {
                Some(t) => t.discover().await,
                None => Vec::new(),
            }
        }
        #[cfg(target_os = "linux")]
        {
            // CUPS queues are the system printers.
            match create_transport(&PrinterType::System, "", "") {
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
    ) -> Result<(), String> {
        let transport = create_transport(printer_type, name, address).ok_or_else(|| {
            format!("`{printer_type}` printers are not supported on this platform")
        })?;
        transport.send(job).await
    }

    /// Connectivity check for a stored printer row.
    pub async fn test_printer(
        printer_type: &PrinterType,
        name: &str,
        address: &str,
    ) -> Result<(), String> {
        let transport = create_transport(printer_type, name, address).ok_or_else(|| {
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
    ) -> Result<(), String> {
        match printer_type {
            PrinterType::Ipp => {
                ipp::IppPrinter::new(name.to_string(), address.to_string())
                    .reach()
                    .await
            }
            PrinterType::RawTcp => {
                raw_tcp::RawTcpPrinter::new(name.to_string(), address.to_string())
                    .reach()
                    .await
            }
            PrinterType::System => {
                #[cfg(windows)]
                let res = windows_spooler::WindowsSpooler::new(name.to_string()).check_ready();
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
                #[cfg(target_os = "android")]
                let res = android_bluetooth::AndroidBluetoothPrinter::new(
                    name.to_string(),
                    address.to_string(),
                )
                .reach()
                .await;
                #[cfg(windows)]
                let res = windows_spooler::WindowsSpooler::new(name.to_string()).check_ready();
                #[cfg(target_os = "linux")]
                let res: Result<(), String> = Err(format!(
                    "Bluetooth printers on Linux are not driven directly; install the device as a CUPS raw queue (sudo lpadmin -p '{}' -m raw -v bluetooth://... -E) and add it as type 'system'",
                    name
                ));
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
        };
        let json = serde_json::to_value(&info).expect("serializes");
        assert_eq!(json["printer_type"], "raw_tcp");
        assert_eq!(json["language"], "pdf");
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
        let err = encode_for_language(&PrinterLanguage::Pdf, &image, 40.0, 30.0, 203)
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

        let (zpl, _) = encode_for_language(&PrinterLanguage::Zpl, &image, 40.0, 30.0, 203).unwrap();
        let zpl = String::from_utf8_lossy(&zpl);
        assert!(zpl.starts_with("^XA"), "{zpl}");
        assert!(zpl.contains("80"), "hex of the first row (0x80): {zpl}");

        let (tspl, _) =
            encode_for_language(&PrinterLanguage::Tspl, &image, 40.0, 30.0, 203).unwrap();
        let tspl = String::from_utf8_lossy(&tspl);
        assert!(tspl.starts_with("SIZE 40 mm"), "{tspl}");
        assert!(tspl.contains("BITMAP 0,0,1,2,0"), "{tspl}");

        let (cpcl, _) =
            encode_for_language(&PrinterLanguage::Cpcl, &image, 40.0, 30.0, 203).unwrap();
        let cpcl = String::from_utf8_lossy(&cpcl);
        assert!(cpcl.starts_with("! 0 200 200"), "{cpcl}");
        assert!(cpcl.contains("PRINT"), "{cpcl}");

        let (escpos, _) =
            encode_for_language(&PrinterLanguage::Escpos, &image, 40.0, 30.0, 203).unwrap();
        assert!(escpos.starts_with(&[0x1B, 0x40]));
        assert!(escpos.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));

        let (raster, _) =
            encode_for_language(&PrinterLanguage::Raster, &image, 40.0, 30.0, 203).unwrap();
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
        let err = TransportRegistry::test_printer(&PrinterType::System, "p", "")
            .await
            .unwrap_err();
        assert!(err.contains("system"), "{err}");
        assert!(err.contains("not supported"), "{err}");

        // A probe against the same unsupported row fails the same way:
        // "nothing to dial" must never read as "reachable".
        let err = TransportRegistry::probe(&PrinterType::System, "p", "")
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
        TransportRegistry::probe(&PrinterType::RawTcp, "p", &format!("127.0.0.1:{port}"))
            .await
            .expect("something is listening");
        // The IPP probe, against the very same listener.
        TransportRegistry::probe(&PrinterType::Ipp, "p", &format!("127.0.0.1:{port}"))
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
            let err = TransportRegistry::probe(&kind, "p", &format!("127.0.0.1:{port}"))
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
        let err =
            TransportRegistry::test_printer(&PrinterType::System, "no-such-queue-printninja", "")
                .await
                .unwrap_err();
        assert!(err.contains("CUPS"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn usb_and_bluetooth_on_linux_are_cups_raw_queues() {
        // Linux does not drive USB/Bluetooth directly; the app reports the
        // supported route (CUPS raw queue) instead of silently succeeding.
        for kind in [PrinterType::Usb, PrinterType::Bluetooth] {
            let err = TransportRegistry::probe(&kind, "MyThermal", "usb://dummy")
                .await
                .unwrap_err();
            assert!(err.contains("CUPS raw queue"), "{kind}: {err}");
            assert!(err.contains("lpadmin"), "{kind}: {err}");
            assert!(err.contains("type 'system'"), "{kind}: {err}");
        }
        // The generic send path also refuses direct USB/Bluetooth on Linux.
        for kind in [PrinterType::Usb, PrinterType::Bluetooth] {
            let err = TransportRegistry::send_to(
                &kind,
                "MyThermal",
                "usb://dummy",
                RenderedJob {
                    job_id: "j".into(),
                    printer_id: "p".into(),
                    data: vec![0x1b, 0x40],
                    mime_type: "application/octet-stream".into(),
                    copies: 1,
                    language: PrinterLanguage::Escpos,
                },
            )
            .await
            .unwrap_err();
            assert!(err.contains("not supported"), "{kind}: {err}");
        }
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
        assert!(create_transport(&PrinterType::System, "Printer", "").is_some());
        assert!(create_transport(&PrinterType::Usb, "Thermal", "").is_some());
    }
}
