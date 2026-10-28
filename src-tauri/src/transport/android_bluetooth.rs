//! Bluetooth printing on Android, through the Kotlin plugin.
//!
//! The printer row's `address` is the MAC the plugin's bonded-device
//! listing reported. Probing connects an RFCOMM (SPP) socket and closes
//! it — no bytes are written, so looking cannot print. Sending writes the
//! job bytes over the same socket. Android 12+ needs the OS Bluetooth
//! permission first; the plugin asks for it and waits for the answer, so
//! the first attempt after granting just works.

use crate::transport::{status, PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::time::{Duration, Instant};

/// How long one Bluetooth round trip may take: connect plus the write.
/// A radio link is slower than a cable, but a printer that answers
/// nothing still fails loudly instead of hanging the queue.
const BT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a status query's answer. Same generosity as the
/// USB path: status replies are specified to be immediate, but the wait
/// is still bounded so a silent printer pays seconds, not a hung job.
const STATUS_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

pub struct AndroidBluetoothPrinter {
    pub name: String,
    pub address: String,
}

impl AndroidBluetoothPrinter {
    pub fn new(name: String, address: String) -> Self {
        Self { name, address }
    }

    /// How every message about this printer names it.
    fn what(&self) -> String {
        format!("Bluetooth printer {}", self.address)
    }

    fn app(&self) -> Result<tauri::AppHandle, String> {
        crate::render::android_app()
            .ok_or_else(|| "Bluetooth printing is only available on Android".to_string())
    }

    /// Is the printer answering? Connects an RFCOMM socket and closes it.
    pub async fn reach(&self) -> Result<(), String> {
        use tauri_plugin_android_print::AndroidPrintExt;

        let app = self.app()?;
        let address = self.address.clone();
        let what = self.what();
        // Phase 0 visibility: probe vs query vs write per print.
        let t = Instant::now();
        let result = tokio::time::timeout(
            BT_TIMEOUT,
            tokio::task::spawn_blocking(move || app.android_print().probe_bluetooth(&address)),
        )
        .await
        .map_err(|_| {
            format!(
                "{what} stopped responding after {}s — check it is paired, powered on and in range",
                BT_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("Bluetooth probe task failed: {e}"))?
        .map_err(|e| format!("Could not reach {what}: {e}"));
        tracing::debug!(
            address = %self.address,
            probe_ms = t.elapsed().as_millis() as u64,
            success = result.is_ok(),
            "Bluetooth probe"
        );
        result?;
        Ok(())
    }

    /// Ask the printer about itself before the job goes out, and refuse to
    /// send if it says it cannot print.
    ///
    /// Same contract as the USB precheck, over RFCOMM: the printer's own
    /// configured language decides which status query, if any, it is asked
    /// (`status::dialect_for`); a language with no query we can stand
    /// behind sends nothing and behaves exactly as it did. An unanswered
    /// query is only a fault once the printer has answered before.
    ///
    /// Runs on the send's held socket (`handle`): the query and the write
    /// below share one RFCOMM connect instead of two (A2/A3).
    async fn send_on(&self, handle: &str, job: &RenderedJob) -> Result<(), String> {
        if let Some(dialect) = status::dialect_for(&job.language) {
            let addr = self.address.clone();
            if status::should_probe(&addr, Instant::now()) {
                let reply = self.query_remote(handle, &dialect.query()).await?;
                let what = self.what();
                if reply.is_empty() {
                    let was_answering = status::had_answered(&addr);
                    status::note_silent(&addr, Instant::now());
                    if was_answering {
                        return Err(status::silence_message(&what, STATUS_REPLY_TIMEOUT));
                    }
                    // Never answered: may not implement status — job goes out.
                } else {
                    status::note_answered(&addr);
                    match status::decode(dialect, &reply) {
                        Some(fault) => return Err(fault.message(&what)),
                        None => status::note_healthy(&addr, Instant::now()),
                    }
                }
            }
        }
        self.write_remote(handle, &job.data).await
    }

    /// Open and hold an RFCOMM socket for one send.
    async fn open_remote(&self) -> Result<String, String> {
        use tauri_plugin_android_print::AndroidPrintExt;

        let app = self.app()?;
        let address = self.address.clone();
        let what = self.what();
        let t = Instant::now();
        let opened = tokio::time::timeout(
            BT_TIMEOUT,
            tokio::task::spawn_blocking(move || {
                app.android_print().open_bluetooth_connection(&address)
            }),
        )
        .await
        .map_err(|_| format!("{what} stopped responding while opening"))?
        .map_err(|e| format!("Bluetooth open task failed: {e}"))?
        .map_err(|e| format!("Could not open {what}: {e}"))?;
        tracing::debug!(
            address = %self.address,
            open_ms = t.elapsed().as_millis() as u64,
            "Bluetooth open"
        );
        Ok(opened.handle)
    }

    /// Best-effort release of a held socket. Close errors never fail a
    /// print — the Kotlin side also reaps idle sockets.
    async fn close_remote(&self, handle: &str) {
        use tauri_plugin_android_print::AndroidPrintExt;

        let Ok(app) = self.app() else { return };
        let handle = handle.to_string();
        let _ = tokio::task::spawn_blocking(move || {
            app.android_print().close_bluetooth_connection(&handle)
        })
        .await;
    }

    /// Write the job bytes over an RFCOMM (SPP) socket, on the send's
    /// held socket.
    async fn write_remote(&self, handle: &str, data: &[u8]) -> Result<(), String> {
        use tauri::Manager;
        use tauri_plugin_android_print::{AndroidPrintExt, BluetoothWriteOnRequest};

        let app = self.app()?;
        let what = self.what();
        // A4: payloads past the handoff size travel by file so a large
        // raster does not inflate by a third into one giant JSON string.
        let via_file = data.len() > crate::transport::PLUGIN_FILE_HANDOFF_BYTES;
        let staged = if via_file {
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("no app cache dir for payload handoff: {e}"))?;
            Some(crate::transport::stage_plugin_payload(&dir, data)?)
        } else {
            None
        };
        let req = BluetoothWriteOnRequest {
            handle: handle.to_string(),
            data_base64: if staged.is_some() {
                None
            } else {
                Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    data,
                ))
            },
            data_path: staged.as_ref().map(|p| p.to_string_lossy().into_owned()),
        };
        let t = Instant::now();
        let result = tokio::time::timeout(
            BT_TIMEOUT,
            tokio::task::spawn_blocking(move || app.android_print().write_bluetooth_on(req)),
        )
        .await
        .map_err(|_| {
            format!(
                "{what} stopped responding after {}s — check it is paired, powered on and in range",
                BT_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("Bluetooth write task failed: {e}"))?
        .map_err(|e| format!("{what} did not print the job: {e}"))?;
        // Our side of the handoff cleanup runs on every exit; the Kotlin
        // side deletes after reading.
        if let Some(path) = staged {
            let _ = std::fs::remove_file(path);
        }
        let bytes = result?;
        tracing::debug!(
            address = %self.address,
            bytes = data.len(),
            via_file,
            write_ms = t.elapsed().as_millis() as u64,
            "Bluetooth write"
        );
        if bytes.bytes_written == 0 && !data.is_empty() {
            return Err(format!("{what} accepted no bytes"));
        }
        Ok(())
    }

    /// Ask a status question over RFCOMM and return the reply bytes
    /// (empty when the printer stays silent), on the send's held socket.
    /// The Kotlin side bounds the wait, so a printer that never answers
    /// still resolves.
    async fn query_remote(&self, handle: &str, request: &[u8]) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        use tauri_plugin_android_print::{AndroidPrintExt, BluetoothQueryOnRequest};

        let app = self.app()?;
        let what = self.what();
        let req = BluetoothQueryOnRequest {
            handle: handle.to_string(),
            request_base64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                request,
            ),
            reply_timeout_ms: Some(STATUS_REPLY_TIMEOUT.as_millis() as u64),
        };
        let t = Instant::now();
        let reply = tokio::time::timeout(
            BT_TIMEOUT,
            tokio::task::spawn_blocking(move || app.android_print().query_bluetooth_on(req)),
        )
        .await
        .map_err(|_| format!("{what} stopped responding while the status was asked"))?
        .map_err(|e| format!("Bluetooth status query task failed: {e}"))?
        .map_err(|e| format!("Bluetooth status query to {what} failed: {e}"))?;
        tracing::debug!(
            address = %self.address,
            query_ms = t.elapsed().as_millis() as u64,
            "Bluetooth status query"
        );
        base64::engine::general_purpose::STANDARD
            .decode(&reply.reply_base64)
            .map_err(|e| format!("Bluetooth status reply from {what} is not base64: {e}"))
    }
}

#[async_trait]
impl PrinterTransport for AndroidBluetoothPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        use tauri_plugin_android_print::AndroidPrintExt;

        let Ok(app) = self.app() else { return vec![] };
        // Log the failure: an empty list and a failed call look the same to
        // the user, and only the log can tell them apart.
        let list = match app.android_print().list_bluetooth_devices() {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("Bluetooth device listing failed: {e}");
                return vec![];
            }
        };
        list.into_iter()
            .map(|d| PrinterInfo {
                id: d.id.clone(),
                name: d.name,
                address: d.id,
                printer_type: crate::transport::PrinterType::Bluetooth,
                language: crate::transport::PrinterLanguage::Pdf,
                status: "unknown".to_string(),
            })
            .collect()
    }

    async fn test(&self) -> Result<(), String> {
        // Connectivity only: the socket open proves the printer answers,
        // and writing probe bytes could put marks on paper.
        self.reach().await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        // One socket for the whole send (A2/A3): open, status query,
        // write, close. The held socket is always released below —
        // success, fault refusal, or transport error.
        let handle = self.open_remote().await?;
        let outcome = self.send_on(&handle, &job).await;
        self.close_remote(&handle).await;
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Off Android there is no plugin, so every operation names the
    /// platform limit instead of hanging or panicking.
    #[cfg(not(target_os = "android"))]
    #[tokio::test]
    async fn bluetooth_is_android_only() {
        let p = AndroidBluetoothPrinter::new("t".into(), "00:11:22:33:44:55".into());
        let err = p.reach().await.unwrap_err();
        assert!(err.contains("Android"), "{err}");
        assert!(p.discover().await.is_empty());
    }

    #[test]
    fn the_address_names_the_printer() {
        let p = AndroidBluetoothPrinter::new("t".into(), "00:11:22:33:44:55".into());
        assert!(p.what().contains("00:11:22:33:44:55"));
    }
}
