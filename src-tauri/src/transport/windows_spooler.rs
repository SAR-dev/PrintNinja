use crate::transport::{PrinterTransport, PrinterInfo, PrinterType, PrinterLanguage, RenderedJob};
use async_trait::async_trait;
use std::ffi::CString;
use std::ptr::null_mut;

// Windows API types for spooler
#[cfg(windows)]
mod winapi {
    use std::os::raw::{c_char, c_void};
    
    pub type HANDLE = *mut c_void;
    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type LPSTR = *mut c_char;
    pub type LPCSTR = *const c_char;
    pub type LPVOID = *mut c_void;
    pub type LPDWORD = *mut DWORD;
    pub type LPBYTE = *mut u8;

    #[repr(C)]
    pub struct DOC_INFO_1A {
        pub pDocName: LPSTR,
        pub pOutputFile: LPSTR,
        pub pDatatype: LPSTR,
    }

    extern "system" {
        pub fn OpenPrinterA(pPrinterName: LPSTR, phPrinter: *mut HANDLE, pDefault: *mut c_void) -> BOOL;
        pub fn ClosePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartDocPrinterA(hPrinter: HANDLE, Level: DWORD, pDocInfo: *mut DOC_INFO_1A) -> DWORD;
        pub fn EndDocPrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartPagePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn EndPagePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn WritePrinter(hPrinter: HANDLE, pBuf: LPVOID, cbBuf: DWORD, pcWritten: LPDWORD) -> BOOL;
        pub fn EnumPrintersA(
            Flags: DWORD,
            Name: LPSTR,
            Level: DWORD,
            pPrinterEnum: LPBYTE,
            cbBuf: DWORD,
            pcbNeeded: LPDWORD,
            pcReturned: LPDWORD,
        ) -> BOOL;
        pub fn GetLastError() -> DWORD;
    }

    pub const PRINTER_ENUM_LOCAL: DWORD = 0x00000002;
    pub const PRINTER_ENUM_CONNECTIONS: DWORD = 0x00000004;
}

#[cfg(windows)]
pub struct WindowsSpooler {
    printer_name: String,
}

#[cfg(windows)]
impl WindowsSpooler {
    pub fn new(printer_name: String) -> Self {
        Self { printer_name }
    }

    /// Enumerate all local system printers
    pub fn enumerate_printers() -> Vec<PrinterInfo> {
        use winapi::*;
        use std::ffi::CStr;

        let mut printers = Vec::new();
        let mut bytes_needed: DWORD = 0;
        let mut num_printers: DWORD = 0;

        // First call to get buffer size
        unsafe {
            EnumPrintersA(
                PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
                null_mut(),
                2,
                null_mut(),
                0,
                &mut bytes_needed,
                &mut num_printers,
            );
        }

        if bytes_needed == 0 {
            return printers;
        }

        let mut buffer = vec![0u8; bytes_needed as usize];

        unsafe {
            let result = EnumPrintersA(
                PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
                null_mut(),
                2,
                buffer.as_mut_ptr(),
                bytes_needed,
                &mut bytes_needed,
                &mut num_printers,
            );

            if result == 0 {
                return printers;
            }

            // PRINTER_INFO_2A layout: DWORD pServerName, pPrinterName, pShareName, pPortName, pDriverName, pComment, pLocation, pDevMode, pSepFile, pPrintProcessor, pDatatype, pParameters, pSecurityDescriptor, Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, cJobs, AveragePPM
            // We need to parse the pointers correctly
            let base = buffer.as_ptr() as usize;
            for i in 0..num_printers as usize {
                let offset = i * std::mem::size_of::<usize>() * 10; // Approximate
                let ptr = base + offset;
                
                // pPrinterName is at offset 8 (after pServerName)
                let name_ptr = *(ptr as *const *const u8) as *const i8;
                if !name_ptr.is_null() {
                    let name = CStr::from_ptr(name_ptr).to_string_lossy().to_string();
                    printers.push(PrinterInfo {
                        id: name.clone(),
                        name: name.clone(),
                        address: name.clone(),
                        printer_type: PrinterType::System,
                        language: PrinterLanguage::Pdf,
                    });
                }
            }
        }

        printers
    }

    /// Send raw bytes to the printer via the spooler
    pub fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        use winapi::*;
        use std::ffi::CStr;

        let printer_name = CString::new(self.printer_name.clone()).map_err(|e| e.to_string())?;
        let doc_name = CString::new("PrintNinja Job").map_err(|e| e.to_string())?;
        let datatype = CString::new("RAW").map_err(|e| e.to_string())?;

        unsafe {
            let mut hPrinter: HANDLE = null_mut();
            let result = OpenPrinterA(printer_name.as_ptr() as *mut _, &mut hPrinter, null_mut());
            if result == 0 {
                return Err(format!("OpenPrinter failed: {}", GetLastError()));
            }

            let doc_info = DOC_INFO_1A {
                pDocName: doc_name.as_ptr() as *mut _,
                pOutputFile: null_mut(),
                pDatatype: datatype.as_ptr() as *mut _,
            };

            let result = StartDocPrinterA(hPrinter, 1, &doc_info as *const _ as *mut _);
            if result == 0 {
                ClosePrinter(hPrinter);
                return Err(format!("StartDocPrinter failed: {}", GetLastError()));
            }

            let result = StartPagePrinter(hPrinter);
            if result == 0 {
                EndDocPrinter(hPrinter);
                ClosePrinter(hPrinter);
                return Err(format!("StartPagePrinter failed: {}", GetLastError()));
            }

            let mut written: DWORD = 0;
            let result = WritePrinter(
                hPrinter,
                data.as_ptr() as *mut _,
                data.len() as DWORD,
                &mut written,
            );

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);
            ClosePrinter(hPrinter);

            if result == 0 {
                return Err(format!("WritePrinter failed: {}", GetLastError()));
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
#[async_trait]
impl PrinterTransport for WindowsSpooler {
    async fn discover() -> Vec<PrinterInfo> {
        Self::enumerate_printers()
    }

    async fn test(&self) -> Result<(), String> {
        // Test by sending a minimal ESC/POS or PDF
        self.send_raw(b"\x1B@") // ESC/POS init
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data)
    }
}

#[cfg(not(windows))]
pub struct WindowsSpooler;

#[cfg(not(windows))]
impl WindowsSpooler {
    pub fn new(_printer_name: String) -> Self {
        Self
    }

    pub fn send_raw(&self, _data: &[u8]) -> Result<(), String> {
        Err("Windows spooler not available on this platform".to_string())
    }
}
