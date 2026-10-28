//! USB printing on Android, through the Kotlin plugin.
//!
//! The printer row's `address` is the `UsbDevice.deviceName` the plugin's
//! enumeration reported (e.g. `/dev/bus/usb/001/002`). Probing opens the
//! device and closes it — no bytes are written, so looking cannot print.
//! Sending writes the job bytes over a bulk-OUT endpoint; when the OS has
//! no permission yet the plugin shows the system dialog and waits for the
//! answer, so the first send may take as long as the user takes.

use crate::transport::{status, PrinterInfo, PrinterLanguage, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::time::{Duration, Instant};

/// How long one USB round trip may take: permission dialog aside, the
/// transfer itself is fast, but a wedged device must still fail loudly.
const USB_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a status query's answer.
///
/// Status replies are immediate by specification — `DLE EOT` is answered
/// even while offline or with a full buffer, TSPL says "at any time" — so
/// this is generous rather than tight. It is still bounded, because a
/// printer that never answers pays it: on the first job, and after that
/// once an hour instead of once per job (see `status::should_probe`).
const STATUS_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

pub struct AndroidUsbPrinter {
    pub name: String,
    pub device: String,
}

impl AndroidUsbPrinter {
    pub fn new(name: String, device: String) -> Self {
        Self { name, device }
    }

    /// How every message about this printer names it.
    fn what(&self) -> String {
        format!("USB device {}", self.device)
    }

    fn app(&self) -> Result<tauri::AppHandle, String> {
        crate::render::android_app()
            .ok_or_else(|| "USB printing is only available on Android".to_string())
    }

    /// Is the device there? Opens it and closes it — nothing is written.
    pub async fn reach(&self) -> Result<(), String> {
        use tauri_plugin_android_print::AndroidPrintExt;

        let app = self.app()?;
        let device = self.device.clone();
        let what = self.what();
        tokio::time::timeout(USB_TIMEOUT, tokio::task::spawn_blocking(move || {
            app.android_print().probe_usb(&device)
        }))
        .await
        .map_err(|_| {
            format!(
                "{what} stopped responding after {}s — check the cable and that the printer is powered on",
                USB_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("USB probe task failed: {e}"))?
        .map_err(|e| format!("Could not reach {what}: {e}"))?;
        Ok(())
    }

    /// Ask the printer about itself before the job goes out, and refuse to
    /// send if it says it cannot print.
    ///
    /// Same contract as the raw TCP precheck, over a different wire: the
    /// printer's own configured language decides which status query, if
    /// any, it is asked (`status::dialect_for`); a language with no query
    /// we can stand behind sends nothing and behaves exactly as it did.
    /// An unanswered query is only a fault once the printer has answered
    /// before — a printer that never replies may simply not implement the
    /// query, and refusing every job over a mis-set language column would
    /// stop printing outright.
    async fn precheck(&self, language: &PrinterLanguage) -> Result<(), String> {
        let Some(dialect) = status::dialect_for(language) else {
            return Ok(());
        };
        let addr = self.device.clone();
        if !status::should_probe(&addr, Instant::now()) {
            return Ok(());
        }

        let reply = self.query(&dialect.query()).await?;
        let what = self.what();
        if reply.is_empty() {
            let was_answering = status::had_answered(&addr);
            status::note_silent(&addr, Instant::now());
            return if was_answering {
                Err(status::silence_message(&what, STATUS_REPLY_TIMEOUT))
            } else {
                Ok(())
            };
        }

        status::note_answered(&addr);
        match status::decode(dialect, &reply) {
            Some(fault) => Err(fault.message(&what)),
            None => Ok(()),
        }
    }

    /// Write the job bytes over a bulk-OUT endpoint.
    async fn write(&self, data: &[u8]) -> Result<(), String> {
        use tauri_plugin_android_print::{AndroidPrintExt, UsbWriteRequest};

        let app = self.app()?;
        let what = self.what();
        let req = UsbWriteRequest {
            device_name: self.device.clone(),
            data_base64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data),
        };
        let bytes = tokio::time::timeout(
            USB_TIMEOUT,
            tokio::task::spawn_blocking(move || app.android_print().write_usb(req)),
        )
        .await
        .map_err(|_| {
            format!(
                "{what} stopped responding after {}s — check the cable and that the printer is powered on",
                USB_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("USB write task failed: {e}"))?
        .map_err(|e| format!("{what} did not print the job: {e}"))?;
        if bytes.bytes_written == 0 && !data.is_empty() {
            return Err(format!("{what} accepted no bytes"));
        }
        Ok(())
    }

    /// Ask a status question and return the reply bytes (empty when the
    /// device stays silent). The Kotlin side bounds the wait, so a
    /// printer that never answers still resolves.
    async fn query(&self, request: &[u8]) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        use tauri_plugin_android_print::{AndroidPrintExt, UsbQueryRequest};

        let app = self.app()?;
        let what = self.what();
        let req = UsbQueryRequest {
            device_name: self.device.clone(),
            request_base64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                request,
            ),
            reply_timeout_ms: Some(STATUS_REPLY_TIMEOUT.as_millis() as u64),
        };
        let reply = tokio::time::timeout(
            USB_TIMEOUT,
            tokio::task::spawn_blocking(move || app.android_print().query_usb(req)),
        )
        .await
        .map_err(|_| format!("{what} stopped responding while the status was asked"))?
        .map_err(|e| format!("USB status query task failed: {e}"))?
        .map_err(|e| format!("USB status query to {what} failed: {e}"))?;
        base64::engine::general_purpose::STANDARD
            .decode(&reply.reply_base64)
            .map_err(|e| format!("USB status reply from {what} is not base64: {e}"))
    }
}

#[async_trait]
impl PrinterTransport for AndroidUsbPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        use tauri_plugin_android_print::AndroidPrintExt;

        let Ok(app) = self.app() else { return vec![] };
        // Log the failure: an empty list and a failed call look the same to
        // the user, and only the log can tell them apart.
        let list = match app.android_print().enumerate_usb_printers() {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("USB printer enumeration failed: {e}");
                return vec![];
            }
        };
        list.into_iter()
            .map(|d| PrinterInfo {
                id: d.id.clone(),
                name: d.name,
                address: d.id,
                printer_type: crate::transport::PrinterType::Usb,
                language: crate::transport::PrinterLanguage::Pdf,
                status: "unknown".to_string(),
            })
            .collect()
    }

    async fn test(&self) -> Result<(), String> {
        // Connectivity only: opening the device proves it is there, and
        // writing probe bytes to a label printer could put marks on paper.
        self.reach().await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.precheck(&job.language).await?;
        self.write(&job.data).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Off Android there is no plugin, so every operation names the
    /// platform limit instead of hanging or panicking.
    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    async fn usb_is_android_only() {
        let p = AndroidUsbPrinter::new("t".into(), "/dev/bus/usb/001/002".into());
        let err = p.reach().await.unwrap_err();
        assert!(err.contains("Android"), "{err}");
        assert!(p.discover().await.is_empty());
    }

    #[test]
    fn the_device_names_the_printer() {
        let p = AndroidUsbPrinter::new("t".into(), "/dev/bus/usb/001/002".into());
        assert!(p.what().contains("/dev/bus/usb/001/002"));
    }
}
