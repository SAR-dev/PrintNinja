use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;

/// USB printers on Windows, reached through the spooler.
///
/// There is no direct USB access: the printer must already be installed as a
/// Windows printer, and jobs go to that queue by name. Nothing here
/// enumerates USB devices, so `discover` is empty (installed queues are
/// listed by the spooler transport instead).
pub struct WindowsUsbPrinter {
    pub name: String,
}

impl WindowsUsbPrinter {
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
impl PrinterTransport for WindowsUsbPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Vec::new()
    }

    async fn test(&self) -> Result<(), String> {
        // Status only: no bytes are sent, so no assumption about the language.
        self.spooler().check_ready()
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data).await
    }
}
