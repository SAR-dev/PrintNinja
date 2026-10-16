use crate::transport::{PrinterTransport, PrinterInfo, PrinterType, PrinterLanguage, RenderedJob};
use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub struct RawTcpPrinter {
    pub name: String,
    pub address: String,
    pub port: u16,
}

impl RawTcpPrinter {
    pub fn new(name: String, address: String) -> Self {
        Self {
            name,
            address,
            port: 9100,
        }
    }

    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        let addr = format!("{}:{}", self.address, self.port);
        let mut stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| format!("TCP connect failed: {}", e))?;

        stream
            .write_all(data)
            .await
            .map_err(|e| format!("TCP write failed: {}", e))?;

        stream
            .flush()
            .await
            .map_err(|e| format!("TCP flush failed: {}", e))?;

        Ok(())
    }
}

#[async_trait]
impl PrinterTransport for RawTcpPrinter {
    async fn discover() -> Vec<PrinterInfo> {
        vec![]
    }

    async fn test(&self) -> Result<(), String> {
        self.send_raw(&[0x1B, 0x40]).await // ESC/POS init
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data).await
    }
}
