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
}

#[async_trait]
impl PrinterTransport for WindowsUsbPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Vec::new()
    }

    async fn test(&self) -> Result<(), String> {
        // Status only: no bytes are sent, so no assumption about the language.
        // W4: check_ready blocks on the queue; keep it off the tokio workers
        // like the spooler transport's own test does.
        let spooler = self.spooler();
        tokio::task::spawn_blocking(move || spooler.check_ready())
            .await
            .unwrap_or_else(|e| Err(format!("USB test task failed: {e}")))
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        // A USB printer is a Windows queue: run the same datatype-aware,
        // off-tokio send the spooler transport uses (PDF when the queue
        // offers it, RAW otherwise) instead of always-RAW bytes.
        self.spooler().send_job(job).await
    }
}
