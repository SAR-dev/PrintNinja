use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlToPdfRequest {
    pub html: String,
    pub page_width_mm: Option<f64>,
    pub page_height_mm: Option<f64>,
    pub orientation: Option<String>,
    pub document_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlToPdfResponse {
    pub path: String,
}

/// Render HTML to a 1-bit raster on the device (thermal printing, PLAN §4):
/// the WebView measures the page at the head's own resolution (1 CSS px =
/// 1 printer dot), thresholds it to dots, and writes the packed bytes to a
/// cache-dir file. `width_px`/`height_px` are dots — the caller computes
/// them from the paper size and the head's dpi (`dots_for_mm`).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlToRasterRequest {
    pub html: String,
    pub width_px: u32,
    pub height_px: u32,
}

/// The packed-dot file the Kotlin `htmlToRaster` command wrote. The caller
/// reads the file and deletes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlToRasterResponse {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// PDF input on Android (PLAN §2): the PDF bytes, base64-encoded — the
/// plugin's big-payload convention (`data_base64` on the USB writes) —
/// plus the head's dot dimensions. Kotlin renders the first page with the
/// platform's own PDFium port (`PdfRenderer`, so no binary ships in the
/// APK), thresholds it to dots and writes them to a cache-dir file.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToRasterRequest {
    pub pdf_base64: String,
    pub width_px: u32,
    pub height_px: u32,
}

/// The packed-dot file the Kotlin `pdfToRaster` command wrote, plus the
/// document's page count — the caller warns when it is over 1. The
/// caller reads the file and deletes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfToRasterResponse {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPrinter {
    pub id: String,
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
}

/// What the Kotlin `enumerateUsbPrinters` command resolves with. Tauri's
/// `Invoke.resolve` takes an object, so the list is wrapped; a bare array
/// is rejected on purpose, because that is the shape the old Rust side
/// wrongly expected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPrinterList {
    pub printers: Vec<UsbPrinter>,
}

/// One LAN printer found by mDNS discovery: the service name the printer
/// advertises, its IP, its port, and which service type answered (`ipp`
/// for `_ipp._tcp`, `raw_tcp` for JetDirect `_pdl-datastream._tcp`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPrinter {
    pub name: String,
    /// IPv4 literal, or an IPv6 literal already wrapped in `[...]` with no
    /// `%interface` scope, so `host:port` can be dialled as is.
    pub host: String,
    pub port: u16,
    pub kind: String,
    /// The `rp` resource path from the service's TXT record, without a
    /// leading slash (e.g. `printers/Office`). Absent for JetDirect and for
    /// IPP printers that do not advertise one.
    #[serde(default)]
    pub resource_path: Option<String>,
}

/// Path used when an IPP printer advertises no `rp`.
pub const DEFAULT_IPP_PATH: &str = "ipp/print";

impl DiscoveredPrinter {
    /// The address to store for this printer. IPP gets a full URL with the
    /// advertised resource path (`http://host:port/rp`, defaulting to
    /// `ipp/print`); JetDirect has no path and stays `host:port`.
    pub fn address(&self) -> String {
        if self.kind == "raw_tcp" {
            return format!("{}:{}", self.host, self.port);
        }
        let path = self
            .resource_path
            .as_deref()
            .map(|p| p.trim().trim_start_matches('/'))
            .filter(|p| !p.is_empty())
            .unwrap_or(DEFAULT_IPP_PATH);
        format!("http://{}:{}/{}", self.host, self.port, path)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverNetworkRequest {
    pub timeout_sec: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverNetworkResponse {
    pub printers: Vec<DiscoveredPrinter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestPrinterRequest {
    pub printer_id: String,
}

/// Open the USB device and close it again: the reachability probe.
/// Never writes, so looking cannot print.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbProbeRequest {
    pub device_name: String,
}

/// What the Kotlin `probeUsb` command resolves with: `{"opened": true}` —
/// an object, never a bare boolean, like [`RunningResponse`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbProbeResponse {
    pub opened: bool,
}

/// Write raw bytes to a USB device. `data_base64` is base64 because the
/// mobile-plugin boundary is JSON; the Kotlin side decodes it before the
/// bulk transfer. `device_name` is the `UsbDevice.deviceName` from
/// [`UsbPrinter::id`] (e.g. `/dev/bus/usb/001/002`).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbWriteRequest {
    pub device_name: String,
    pub data_base64: String,
}

/// Ask the USB device a status question (ESC/POS `DLE EOT`, Zebra `~HS`,
/// …). `request_base64` is the query bytes; the reply comes back base64
/// too, possibly empty when the device stays silent.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbQueryRequest {
    pub device_name: String,
    pub request_base64: String,
    /// How long the Kotlin side waits for the reply. Defaults to 3000.
    pub reply_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbQueryResponse {
    pub reply_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbWriteResponse {
    pub bytes_written: usize,
}

/// Open a USB device and hold the connection under a minted handle, so
/// one print's status query and write share a single connect instead of
/// opening twice. The caller must close the handle on every path.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbOpenRequest {
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbOpenResponse {
    pub handle: String,
}

/// Status query on a held USB connection (`openUsbConnection` handle).
/// Same base64 convention as [`UsbQueryRequest`]; the connection stays
/// open.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbQueryOnRequest {
    pub handle: String,
    pub request_base64: String,
    /// How long the Kotlin side waits for the reply. Defaults to 3000.
    pub reply_timeout_ms: Option<u64>,
}

/// Write on a held USB connection. Same convention as
/// [`UsbWriteRequest`]; the connection stays open.
///
/// Large payloads travel by file instead of base64 (A4): exactly one of
/// `data_base64` / `data_path` is set. The Kotlin side reads and deletes
/// the file.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbWriteOnRequest {
    pub handle: String,
    pub data_base64: Option<String>,
    pub data_path: Option<String>,
}

/// Release a held USB connection. Idempotent: unknown handles resolve
/// `closed: false` rather than erroring.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbCloseRequest {
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbCloseResponse {
    pub closed: bool,
}

/// One paired Bluetooth device, as listed by the Kotlin plugin.
/// `id` is the MAC address — the stable handle a stored printer row keeps.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDeviceInfo {
    pub id: String,
    pub name: String,
}

/// What the Kotlin `listBluetoothDevices` command resolves with: an object
/// wrapping the list, for the same reason as [`UsbPrinterList`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDeviceList {
    pub devices: Vec<BluetoothDeviceInfo>,
}

/// Open an RFCOMM socket and close it again: the reachability probe.
/// `address` is the MAC from [`BluetoothDeviceInfo::id`].
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothProbeRequest {
    pub address: String,
}

/// What the Kotlin `probeBluetooth` command resolves with:
/// `{"reachable": true}` — an object, never a bare boolean, like
/// [`RunningResponse`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothProbeResponse {
    pub reachable: bool,
}

/// Write raw bytes over an RFCOMM (SPP) socket. Same base64 convention as
/// [`UsbWriteRequest`]; `address` is the MAC from [`BluetoothDeviceInfo::id`].
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothWriteRequest {
    pub address: String,
    pub data_base64: String,
}

/// Ask the Bluetooth printer a status question over RFCOMM. Same
/// convention as [`UsbQueryRequest`]: base64 in, base64 out, possibly
/// empty when the printer stays silent.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothQueryRequest {
    pub address: String,
    pub request_base64: String,
    /// How long the Kotlin side waits for the reply. Defaults to 3000.
    pub reply_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothQueryResponse {
    pub reply_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothWriteResponse {
    pub bytes_written: usize,
}

/// Open an RFCOMM socket and hold it under a minted handle, so one
/// print's status query and write share a single connect instead of
/// opening twice. The caller must close the handle on every path.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothOpenRequest {
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothOpenResponse {
    pub handle: String,
}

/// Status query on a held RFCOMM socket (`openBluetoothConnection`
/// handle). Same convention as [`BluetoothQueryRequest`]; the socket
/// stays open.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothQueryOnRequest {
    pub handle: String,
    pub request_base64: String,
    /// How long the Kotlin side waits for the reply. Defaults to 3000.
    pub reply_timeout_ms: Option<u64>,
}

/// Write on a held RFCOMM socket. Same convention as
/// [`BluetoothWriteRequest`]; the socket stays open.
///
/// Large payloads travel by file instead of base64 (A4): exactly one of
/// `data_base64` / `data_path` is set. The Kotlin side reads and deletes
/// the file.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothWriteOnRequest {
    pub handle: String,
    pub data_base64: Option<String>,
    pub data_path: Option<String>,
}

/// Release a held RFCOMM socket. Idempotent: unknown handles resolve
/// `closed: false` rather than erroring.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothCloseRequest {
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothCloseResponse {
    pub closed: bool,
}

/// The local API server's state, mirrored into the Android foreground
/// service so the pinned notification can show the live `host:port`.
/// Sent to Kotlin by `setApiServerState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiServerState {
    pub running: bool,
    /// Bound `host:port` while `running`, ignored otherwise.
    pub address: Option<String>,
}

/// What `startBackgroundService` / `isBackgroundServiceRunning` resolve
/// with on the Kotlin side: `{"running": bool}`, never a bare boolean.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningResponse {
    pub running: bool,
}

/// What the Kotlin `drainCrashReports` command resolves with:
/// `{"reports": ["...", ...]}`. Each entry is one Android crash stack
/// trace or process-exit record, ready to write to the app log.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReports {
    #[serde(default)]
    pub reports: Vec<String>,
}

/// What `requestBatteryExemption` / `isBatteryExemptionGranted` resolve
/// with on the Kotlin side: `{"granted": bool}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantedResponse {
    pub granted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    // The JSON below is exactly what AndroidPrintPlugin.kt resolves with.

    #[test]
    fn usb_list_parses_the_object_kotlin_sends() {
        let json = r#"{"printers":[{"id":"/dev/bus/usb/001/002","name":"/dev/bus/usb/001/002","vendorId":1208,"productId":514}]}"#;
        let list: UsbPrinterList = serde_json::from_str(json).unwrap();
        assert_eq!(list.printers.len(), 1);
        assert_eq!(list.printers[0].id, "/dev/bus/usb/001/002");
        assert_eq!(list.printers[0].vendor_id, 1208);
        assert_eq!(list.printers[0].product_id, 514);
    }

    #[test]
    fn usb_list_accepts_an_empty_list() {
        let list: UsbPrinterList = serde_json::from_str(r#"{"printers":[]}"#).unwrap();
        assert!(list.printers.is_empty());
    }

    #[test]
    fn usb_list_rejects_a_bare_array() {
        let json = r#"[{"id":"a","name":"a","vendorId":1,"productId":2}]"#;
        assert!(serde_json::from_str::<UsbPrinterList>(json).is_err());
        // ...which is why the old `Vec<UsbPrinter>` target could never work.
        let wrapped = r#"{"printers":[{"id":"a","name":"a","vendorId":1,"productId":2}]}"#;
        assert!(serde_json::from_str::<Vec<UsbPrinter>>(wrapped).is_err());
    }

    #[test]
    fn bluetooth_list_parses_the_object_kotlin_sends() {
        let json = r#"{"devices":[{"id":"AA:BB:CC:DD:EE:FF","name":"Receipt printer"}]}"#;
        let list: BluetoothDeviceList = serde_json::from_str(json).unwrap();
        assert_eq!(list.devices.len(), 1);
        assert_eq!(list.devices[0].id, "AA:BB:CC:DD:EE:FF");
        assert_eq!(list.devices[0].name, "Receipt printer");
    }

    #[test]
    fn bluetooth_list_rejects_a_bare_array() {
        let json = r#"[{"id":"AA:BB:CC:DD:EE:FF","name":"x"}]"#;
        assert!(serde_json::from_str::<BluetoothDeviceList>(json).is_err());
        let wrapped = r#"{"devices":[{"id":"AA:BB:CC:DD:EE:FF","name":"x"}]}"#;
        assert!(serde_json::from_str::<Vec<BluetoothDeviceInfo>>(wrapped).is_err());
    }

    // Held-connection responses: exactly what the *On Kotlin commands
    // resolve with (`{"handle": ...}` / `{"closed": ...}`).

    #[test]
    fn usb_open_response_carries_the_handle() {
        let res: UsbOpenResponse =
            serde_json::from_str(r#"{"handle":"550e8400-e29b-41d4-a716-446655440000"}"#).unwrap();
        assert_eq!(res.handle, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn usb_close_response_carries_closed() {
        let res: UsbCloseResponse = serde_json::from_str(r#"{"closed":true}"#).unwrap();
        assert!(res.closed);
        let res: UsbCloseResponse = serde_json::from_str(r#"{"closed":false}"#).unwrap();
        assert!(!res.closed);
    }

    #[test]
    fn bluetooth_open_response_carries_the_handle() {
        let res: BluetoothOpenResponse =
            serde_json::from_str(r#"{"handle":"abc123"}"#).unwrap();
        assert_eq!(res.handle, "abc123");
    }

    #[test]
    fn bluetooth_close_response_carries_closed() {
        let res: BluetoothCloseResponse = serde_json::from_str(r#"{"closed":true}"#).unwrap();
        assert!(res.closed);
    }

    #[test]
    fn handle_requests_serialize_camel_case() {
        let req = UsbQueryOnRequest {
            handle: "h".into(),
            request_base64: "AA==".into(),
            reply_timeout_ms: Some(3000),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"requestBase64\""), "{json}");
        assert!(json.contains("\"replyTimeoutMs\""), "{json}");
        let req = BluetoothWriteOnRequest {
            handle: "h".into(),
            data_base64: Some("AA==".into()),
            data_path: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"dataBase64\""), "{json}");
        let req = BluetoothWriteOnRequest {
            handle: "h".into(),
            data_base64: None,
            data_path: Some("/cache/payload.bin".into()),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"dataPath\""), "{json}");
        // Absent side serializes as null, like the existing Option fields
        // (reply_timeout_ms) the Kotlin side already defaults.
        assert!(json.contains("\"dataBase64\":null"), "{json}");
    }

    fn printer(kind: &str, host: &str, rp: Option<&str>) -> DiscoveredPrinter {
        DiscoveredPrinter {
            name: "p".into(),
            host: host.into(),
            port: 631,
            kind: kind.into(),
            resource_path: rp.map(str::to_string),
        }
    }

    #[test]
    fn ipp_address_uses_the_advertised_resource_path() {
        let p = printer("ipp", "192.168.1.20", Some("printers/Office"));
        assert_eq!(p.address(), "http://192.168.1.20:631/printers/Office");
    }

    #[test]
    fn ipp_address_defaults_the_path_when_rp_is_missing_or_blank() {
        assert_eq!(
            printer("ipp", "192.168.1.20", None).address(),
            "http://192.168.1.20:631/ipp/print"
        );
        assert_eq!(
            printer("ipp", "192.168.1.20", Some("  ")).address(),
            "http://192.168.1.20:631/ipp/print"
        );
    }

    #[test]
    fn ipp_address_does_not_double_a_leading_slash() {
        let p = printer("ipp", "10.0.0.5", Some("/printers/x"));
        assert_eq!(p.address(), "http://10.0.0.5:631/printers/x");
    }

    #[test]
    fn ipv6_host_arrives_bracketed_and_stays_dialable() {
        let p = printer("ipp", "[fe80::1]", Some("ipp/print"));
        assert_eq!(p.address(), "http://[fe80::1]:631/ipp/print");
    }

    #[test]
    fn raw_tcp_address_has_no_path() {
        let p = printer("raw_tcp", "192.168.1.30", Some("ignored"));
        assert_eq!(p.address(), "192.168.1.30:631");
    }

    #[test]
    fn discovered_printer_without_resource_path_still_parses() {
        let json = r#"{"name":"p","host":"1.2.3.4","port":631,"kind":"ipp"}"#;
        let p: DiscoveredPrinter = serde_json::from_str(json).unwrap();
        assert!(p.resource_path.is_none());
    }

    #[test]
    fn crash_reports_parse_the_object_kotlin_sends() {
        let r: CrashReports =
            serde_json::from_str(r#"{"reports":["a","b"]}"#).unwrap();
        assert_eq!(r.reports, vec!["a", "b"]);
        let empty: CrashReports = serde_json::from_str("{}").unwrap();
        assert!(empty.reports.is_empty());
    }

    #[test]
    fn running_response_parses_the_object_kotlin_sends() {
        let r: RunningResponse = serde_json::from_str(r#"{"running":true}"#).unwrap();
        assert!(r.running);
    }

    #[test]
    fn usb_probe_response_parses_the_object_kotlin_sends() {
        let r: UsbProbeResponse = serde_json::from_str(r#"{"opened":true}"#).unwrap();
        assert!(r.opened);
        // A bare unit is what the old accessor wrongly expected — it must
        // not parse, or the regression comes back silently.
        assert!(serde_json::from_str::<UsbProbeResponse>("null").is_err());
    }

    #[test]
    fn bluetooth_probe_response_parses_the_object_kotlin_sends() {
        let r: BluetoothProbeResponse = serde_json::from_str(r#"{"reachable":true}"#).unwrap();
        assert!(r.reachable);
        assert!(serde_json::from_str::<BluetoothProbeResponse>("null").is_err());
    }

    #[test]
    fn granted_response_parses_the_object_kotlin_sends() {
        let r: GrantedResponse = serde_json::from_str(r#"{"granted":false}"#).unwrap();
        assert!(!r.granted);
    }

    #[test]
    fn html_to_raster_request_sends_camel_case_keys() {
        let json = serde_json::to_value(HtmlToRasterRequest {
            html: "<p>x</p>".to_string(),
            width_px: 320,
            height_px: 240,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"html": "<p>x</p>", "widthPx": 320, "heightPx": 240})
        );
    }

    #[test]
    fn html_to_raster_response_parses_the_object_kotlin_sends() {
        let r: HtmlToRasterResponse =
            serde_json::from_str(r#"{"path":"/data/user/0/com.printninja/cache/pn_raster_1.bin","width":320,"height":240}"#)
                .unwrap();
        assert_eq!(r.path, "/data/user/0/com.printninja/cache/pn_raster_1.bin");
        assert_eq!(r.width, 320);
        assert_eq!(r.height, 240);
    }

    #[test]
    fn pdf_to_raster_request_sends_camel_case_keys() {
        let json = serde_json::to_value(PdfToRasterRequest {
            pdf_base64: "JVBERi0xLjQ=".to_string(),
            width_px: 320,
            height_px: 240,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"pdfBase64": "JVBERi0xLjQ=", "widthPx": 320, "heightPx": 240})
        );
    }

    #[test]
    fn pdf_to_raster_response_parses_the_object_kotlin_sends() {
        let r: PdfToRasterResponse = serde_json::from_str(
            r#"{"path":"/data/user/0/com.printninja/cache/pn_raster_2.bin","width":320,"height":240,"pageCount":2}"#,
        )
        .unwrap();
        assert_eq!(r.path, "/data/user/0/com.printninja/cache/pn_raster_2.bin");
        assert_eq!(r.width, 320);
        assert_eq!(r.height, 240);
        assert_eq!(r.page_count, 2);
    }
}
