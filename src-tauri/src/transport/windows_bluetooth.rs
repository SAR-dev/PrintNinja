use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;

/// Bluetooth printers on Windows, reached through the spooler.
///
/// A paired printer must already appear as a Windows printer; jobs go to
/// that queue by name. The COM port is never opened and the stored address
/// is not used, and nothing here scans for paired devices, so `discover` is
/// empty.
pub struct WindowsBluetoothPrinter {
    pub name: String,
}

impl WindowsBluetoothPrinter {
    pub fn new(name: String) -> Self {
        Self { name }
    }

    fn spooler(&self) -> crate::transport::windows_spooler::WindowsSpooler {
        crate::transport::windows_spooler::WindowsSpooler::new(self.name.clone())
    }

    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        self.spooler().send_raw(data)
    }
}

#[async_trait]
impl PrinterTransport for WindowsBluetoothPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Vec::new()
    }

    async fn test(&self) -> Result<(), String> {
        self.spooler().check_ready()
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data).await
    }
}
