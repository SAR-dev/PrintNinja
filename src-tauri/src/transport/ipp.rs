use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::time::Duration;

/// IPP (Internet Printing Protocol) sender for Wi-Fi/LAN printers
pub struct IppPrinter {
    pub name: String,
    pub address: String,
    pub port: u16,
}

impl IppPrinter {
    pub fn new(name: String, address: String) -> Self {
        Self {
            name,
            address,
            port: 631,
        }
    }

    /// Send an IPP Print-Job request with PDF data
    pub async fn send_pdf(&self, pdf_data: &[u8], copies: u32) -> Result<(), String> {
        use reqwest::Client;

        // Build IPP request body
        let ipp_body = self.build_ipp_request(pdf_data, copies);

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        let url = format!("http://{}:{}/ipp/print", self.address, self.port);

        let response = client
            .post(&url)
            .header("Content-Type", "application/ipp")
            .body(ipp_body)
            .send()
            .await
            .map_err(|e| format!("IPP request failed: {}", e))?;

        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("IPP server returned {}", response.status()))
        }
    }

    fn build_ipp_request(&self, pdf_data: &[u8], copies: u32) -> Vec<u8> {
        // RFC 8011 §3.2.1 Print-Job — minimal but valid attribute set.
        // Previously this only wrote version+operation+request-id+group tag,
        // so every IPP server rejected it (no charset, printer-uri, copies).
        let mut body = Vec::new();

        // IPP version 1.1
        body.extend_from_slice(&[0x01, 0x01]);
        // Operation ID: Print-Job = 0x0002
        body.extend_from_slice(&[0x00, 0x02]);
        // Request ID
        body.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);

        // Operation attributes group
        body.push(0x01);

        // RFC 8011 requires these three first in order
        Self::push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
        Self::push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
        let uri = format!("ipp://{}:{}/ipp/print", self.address, self.port);
        Self::push_attr(&mut body, 0x45, "printer-uri", uri.as_bytes());

        // Optional but expected by most servers
        Self::push_attr(&mut body, 0x42, "requesting-user-name", b"PrintNinja");
        Self::push_attr(&mut body, 0x42, "job-name", b"PrintNinja Job");
        Self::push_attr(&mut body, 0x44, "document-format", b"application/pdf");
        if copies > 1 {
            Self::push_integer(&mut body, "copies", copies as i32);
        }
        // ipp-attribute-fidelity = false (boolean 0x22)
        Self::push_attr(&mut body, 0x22, "ipp-attribute-fidelity", &[0x00]);

        // End-of-attributes
        body.push(0x03);

        // Document content follows directly
        body.extend_from_slice(pdf_data);
        body
    }

    fn push_attr(body: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
        body.push(tag);
        body.extend_from_slice(&(name.len() as u16).to_be_bytes());
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(&(value.len() as u16).to_be_bytes());
        body.extend_from_slice(value);
    }

    fn push_integer(body: &mut Vec<u8>, name: &str, value: i32) {
        body.push(0x21); // integer
        body.extend_from_slice(&(name.len() as u16).to_be_bytes());
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(&4u16.to_be_bytes());
        body.extend_from_slice(&value.to_be_bytes());
    }
}

#[async_trait]
impl PrinterTransport for IppPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        // mDNS discovery handled by Android NsdManager or system tools
        vec![]
    }

    async fn test(&self) -> Result<(), String> {
        // Send test page
        let test_pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 210 297] >>\nendobj\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n140\n%%EOF";
        self.send_pdf(test_pdf, 1).await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_pdf(&job.data, job.copies).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(copies: u32) -> Vec<u8> {
        IppPrinter::new("test".into(), "192.168.1.10".into()).build_ipp_request(b"%PDF-1.4", copies)
    }

    #[test]
    fn encodes_version_and_operation() {
        let b = body(1);
        assert_eq!(&b[0..2], &[0x01, 0x01]); // 1.1
        assert_eq!(&b[2..4], &[0x00, 0x02]); // Print-Job
    }

    #[test]
    fn includes_required_attributes() {
        let b = body(1);
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains("attributes-charset"));
        assert!(s.contains("utf-8"));
        assert!(s.contains("attributes-natural-language"));
        assert!(s.contains("printer-uri"));
        assert!(s.contains("ipp://192.168.1.10:631/ipp/print"));
        assert!(s.contains("document-format"));
        assert!(s.contains("application/pdf"));
    }

    #[test]
    fn copies_attribute_only_when_needed() {
        let b1 = body(1);
        let s1 = String::from_utf8_lossy(&b1);
        // copies=1 is the default — omit to avoid surprising servers that treat 1 as explicit
        assert!(!s1.contains("copies"));

        let b2 = body(3);
        let s2 = String::from_utf8_lossy(&b2);
        assert!(s2.contains("copies"));
        // integer value 3 encoded as 4-byte BE
        assert!(b2.windows(4).any(|w| w == 3i32.to_be_bytes()));
    }

    #[test]
    fn ends_with_end_tag_and_document() {
        let pdf = b"%PDF-1.4 fake";
        let b = IppPrinter::new("t".into(), "10.0.0.1".into()).build_ipp_request(pdf, 1);
        // Find end-of-attributes 0x03 before the PDF starts
        let pos = b.iter().position(|&x| x == 0x03).expect("end tag");
        assert_eq!(&b[pos + 1..pos + 1 + pdf.len()], pdf);
    }

    #[test]
    fn operation_attributes_group_present() {
        let b = body(1);
        // After request-id (8 bytes), group tag 0x01
        assert_eq!(b[8], 0x01);
    }
}
