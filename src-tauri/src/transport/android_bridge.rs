use crate::transport::PrinterInfo;

pub struct AndroidBridge;

impl AndroidBridge {
    pub fn new() -> Self {
        Self
    }

    /// IPP printers visible on the local network.
    ///
    /// On Android this is NsdManager (`_ipp._tcp`); the stub build returns
    /// an empty list rather than an error so the Discovery screen still
    /// renders and simply shows "no printers found".
    pub async fn discover(&self) -> Vec<PrinterInfo> {
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_android_print::AndroidPrintExt;

            let Some(app) = crate::render::android_app() else {
                return vec![];
            };
            let found = match tokio::task::spawn_blocking(move || {
                app.android_print().discover_network_printers(Some(8))
            })
            .await
            {
                Ok(Ok(found)) => found,
                Ok(Err(e)) => {
                    tracing::warn!("network printer discovery failed: {e}");
                    vec![]
                }
                Err(e) => {
                    tracing::warn!("network printer discovery task failed: {e}");
                    vec![]
                }
            };
            found
                .into_iter()
                .filter(|d| d.kind != "raw_tcp")
                .map(|d| PrinterInfo {
                    id: format!("net:{}:{}", d.host, d.port),
                    address: d.address(),
                    name: d.name,
                    printer_type: crate::transport::PrinterType::Ipp,
                    language: crate::transport::PrinterLanguage::Pdf,
                    status: "unknown".to_string(),
                })
                .collect()
        }
        #[cfg(not(target_os = "android"))]
        {
            Vec::new()
        }
    }
}

impl Default for AndroidBridge {
    fn default() -> Self {
        Self::new()
    }
}
