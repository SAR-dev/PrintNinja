use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_android_print);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AndroidPrint<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "com.printninja.android_print",
        "AndroidPrintPlugin",
    )?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_android_print)?;
    Ok(AndroidPrint(handle))
}

/// Access to the android-print APIs.
pub struct AndroidPrint<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidPrint<R> {
    pub fn html_to_pdf(&self, payload: HtmlToPdfRequest) -> crate::Result<HtmlToPdfResponse> {
        self.0.run_mobile_plugin("htmlToPdf", payload).map_err(Into::into)
    }

    /// Kotlin answers `{"printers": [...]}`; the inner list is returned so
    /// callers do not see the wrapper.
    pub fn enumerate_usb_printers(&self) -> crate::Result<Vec<UsbPrinter>> {
        let res: UsbPrinterList = self
            .0
            .run_mobile_plugin("enumerateUsbPrinters", ())
            .map_err(crate::Error::from)?;
        Ok(res.printers)
    }

    /// Open the USB device and close it again: the reachability probe.
    /// Never writes, so looking cannot print.
    pub fn probe_usb(&self, device_name: &str) -> crate::Result<()> {
        let payload = UsbProbeRequest {
            device_name: device_name.to_string(),
        };
        self.0
            .run_mobile_plugin("probeUsb", payload)
            .map_err(Into::into)
    }

    /// Write raw bytes to the USB device (bulk transfer). The Kotlin side
    /// requests the system permission first when it has none.
    pub fn write_usb(&self, payload: UsbWriteRequest) -> crate::Result<UsbWriteResponse> {
        self.0
            .run_mobile_plugin("writeUsb", payload)
            .map_err(Into::into)
    }

    /// Ask the USB device a status question; the reply may be empty when
    /// the device stays silent.
    pub fn query_usb(&self, payload: UsbQueryRequest) -> crate::Result<UsbQueryResponse> {
        self.0
            .run_mobile_plugin("queryUsb", payload)
            .map_err(Into::into)
    }

    /// Paired Bluetooth devices (name + MAC). Needs the OS Bluetooth
    /// permission; the Kotlin side asks for it and waits for the answer.
    ///
    /// Kotlin answers `{"devices": [...]}`; the inner list is returned.
    pub fn list_bluetooth_devices(&self) -> crate::Result<Vec<BluetoothDeviceInfo>> {
        let res: BluetoothDeviceList = self
            .0
            .run_mobile_plugin("listBluetoothDevices", ())
            .map_err(crate::Error::from)?;
        Ok(res.devices)
    }

    /// Open an RFCOMM socket and close it again: the reachability probe.
    pub fn probe_bluetooth(&self, address: &str) -> crate::Result<()> {
        let payload = BluetoothProbeRequest {
            address: address.to_string(),
        };
        self.0
            .run_mobile_plugin("probeBluetooth", payload)
            .map_err(Into::into)
    }

    /// Write raw bytes over an RFCOMM (SPP) socket.
    pub fn write_bluetooth(
        &self,
        payload: BluetoothWriteRequest,
    ) -> crate::Result<BluetoothWriteResponse> {
        self.0
            .run_mobile_plugin("writeBluetooth", payload)
            .map_err(Into::into)
    }

    /// Ask the Bluetooth printer a status question; the reply may be
    /// empty when the printer stays silent.
    pub fn query_bluetooth(
        &self,
        payload: BluetoothQueryRequest,
    ) -> crate::Result<BluetoothQueryResponse> {
        self.0
            .run_mobile_plugin("queryBluetooth", payload)
            .map_err(Into::into)
    }

    /// LAN printers found by mDNS, resolved to IP and port. Empty (not
    /// an error) when nothing answers within the timeout.
    pub fn discover_network_printers(
        &self,
        timeout_sec: Option<u8>,
    ) -> crate::Result<Vec<DiscoveredPrinter>> {
        let payload = DiscoverNetworkRequest { timeout_sec };
        let res: DiscoverNetworkResponse = self
            .0
            .run_mobile_plugin("discoverNetworkPrinters", payload)
            .map_err(crate::Error::from)?;
        Ok(res.printers)
    }

    pub fn start_background_service(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("startBackgroundService", ())
            .map_err(Into::into)
    }

    pub fn stop_background_service(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stopBackgroundService", ())
            .map_err(Into::into)
    }

    pub fn is_background_service_running(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("isBackgroundServiceRunning", ())
            .map_err(Into::into)
    }

    /// Tell the foreground service whether the local API server is up,
    /// so the pinned notification shows the live address.
    pub fn set_api_server_state(&self, state: ApiServerState) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("setApiServerState", state)
            .map_err(Into::into)
    }

    pub fn request_battery_exemption(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("requestBatteryExemption", ())
            .map_err(Into::into)
    }

    pub fn is_battery_exemption_granted(&self) -> crate::Result<bool> {
        self.0
            .run_mobile_plugin("isBatteryExemptionGranted", ())
            .map_err(Into::into)
    }
}
