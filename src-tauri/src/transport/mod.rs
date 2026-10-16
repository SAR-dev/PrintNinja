use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub address: String,
    pub printer_type: PrinterType,
    pub language: PrinterLanguage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PrinterType {
    Ipp,
    RawTcp,
    Usb,
    Bluetooth,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PrinterLanguage {
    Pdf,
    Escpos,
    Tspl,
    Zpl,
    Cpcl,
    Raster,
}

#[derive(Debug, Clone)]
pub struct RenderedJob {
    pub job_id: String,
    pub printer_id: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub copies: u32,
}

#[async_trait]
pub trait PrinterTransport: Send + Sync {
    async fn discover() -> Vec<PrinterInfo>;
    async fn test(&self) -> Result<(), String>;
    async fn send(&self, job: RenderedJob) -> Result<(), String>;
}

pub mod windows_spooler;
pub mod ipp;
pub mod raw_tcp;
pub mod android_bridge;
pub mod windows_usb;
pub mod windows_bluetooth;
pub mod escpos;
pub mod label_langs;

pub struct TransportRegistry;

impl TransportRegistry {
    pub fn new() -> Self {
        Self
    }
}
