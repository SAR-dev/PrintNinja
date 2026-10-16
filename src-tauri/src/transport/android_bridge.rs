use crate::transport::{PrinterTransport, PrinterInfo, PrinterType, PrinterLanguage, RenderedJob};
use async_trait::async_trait;

#[cfg(mobile)]
mod mobile {
    use super::*;
    use tauri::Manager;

    #[tauri::mobile_entry_point]
    /// Bridge to Kotlin plugin for Android-specific operations
    pub struct AndroidBridge;

    impl AndroidBridge {
        pub fn new() -> Self {
            Self
        }

        pub async fn html_to_pdf(
            &self,
            app: tauri::AppHandle,
            html: &str,
            page_width_mm: f64,
            page_height_mm: f64,
            orientation: &str,
            margins_json: &str,
        ) -> Result<Vec<u8>, String> {
            // Invoke Kotlin command
            let result: serde_json::Value = app
                .invoke("plugin:android-print|html_to_pdf", serde_json::json!({
                    "html": html,
                    "pageWidthMm": page_width_mm,
                    "pageHeightMm": page_height_mm,
                    "orientation": orientation,
                    "margins": margins_json,
                }))
                .await
                .map_err(|e| e.to_string())?;

            // Read PDF from path
            let path = result["path"].as_str().ok_or("No path returned")?;
            tokio::fs::read(path).await.map_err(|e| e.to_string())
        }

        pub async fn enumerate_usb_printers(
            &self,
            app: tauri::AppHandle,
        ) -> Result<Vec<PrinterInfo>, String> {
            let result: serde_json::Value = app
                .invoke("plugin:android-print|enumerate_usb_printers", serde_json::json!({}))
                .await
                .map_err(|e| e.to_string())?;

            // Parse printer list from Kotlin
            let mut printers = Vec::new();
            if let Some(arr) = result.as_array() {
                for item in arr {
                    printers.push(PrinterInfo {
                        id: item["id"].as_str().unwrap_or("").to_string(),
                        name: item["name"].as_str().unwrap_or("").to_string(),
                        address: item["address"].as_str().unwrap_or("").to_string(),
                        printer_type: PrinterType::Usb,
                        language: PrinterLanguage::Pdf,
                    });
                }
            }
            Ok(printers)
        }
    }
}

pub struct AndroidBridge;

impl AndroidBridge {
    pub fn new() -> Self {
        Self
    }
}
