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
}
