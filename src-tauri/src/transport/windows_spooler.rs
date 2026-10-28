/// `PRINTER_INFO_2` status bits (winspool.h) that mean a job cannot print.
///
/// Returns the reason, or `None` when the queue looks ready. Kept free of
/// Windows types so it is unit-tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn spooler_status_problem(status: u32) -> Option<&'static str> {
    const ERROR: u32 = 0x0000_0002;
    const PAPER_JAM: u32 = 0x0000_0008;
    const PAPER_OUT: u32 = 0x0000_0010;
    const OFFLINE: u32 = 0x0000_0080;
    const NOT_AVAILABLE: u32 = 0x0000_1000;
    const NO_TONER: u32 = 0x0004_0000;
    const DOOR_OPEN: u32 = 0x0040_0000;

    if status & OFFLINE != 0 {
        Some("offline")
    } else if status & NOT_AVAILABLE != 0 {
        Some("not available")
    } else if status & PAPER_OUT != 0 {
        Some("out of paper")
    } else if status & PAPER_JAM != 0 {
        Some("paper jammed")
    } else if status & DOOR_OPEN != 0 {
        Some("cover open")
    } else if status & NO_TONER != 0 {
        Some("out of toner")
    } else if status & ERROR != 0 {
        Some("reporting an error")
    } else {
        None
    }
}

/// `WritePrinter` can return success having taken fewer bytes than offered,
/// which would print a truncated job as if it were complete.
#[cfg_attr(not(windows), allow(dead_code))]
fn ensure_fully_written(written: u32, expected: usize) -> Result<(), String> {
    if written as usize == expected {
        Ok(())
    } else {
        Err(format!(
            "WritePrinter wrote {written} of {expected} bytes; the job is incomplete"
        ))
    }
}

/// Which spooler datatype to declare for a job.
///
/// `RAW` passes bytes unchanged; `PDF` tells a PDF-aware driver the
/// payload is a PDF. A PDF sent as `RAW` to a GDI-only queue prints as
/// garbage, and `RAW` is correct for every command language (ESC/POS,
/// ZPL, TSPL, CPCL, bare raster) which must reach the head unaltered.
#[cfg_attr(not(windows), allow(dead_code))]
fn spool_datatype(mime_type: &str) -> &'static str {
    if mime_type == "application/pdf" {
        "PDF"
    } else {
        "RAW"
    }
}

/// The datatype to declare for a job, given what the queue's print
/// processor offers.
///
/// `spool_datatype` says what a job *wants*; this says what the queue
/// *can take*. The stock `winprint` processor lists `RAW`, `NT EMF` and
/// `TEXT`, so declaring `PDF` there makes `StartDocPrinter` fail with
/// error 1804. `PDF` is used only when the queue offers it.
///
/// - `offered` is `None` when the list could not be read (remote queue,
///   access denied): the wanted datatype is kept, and a refusal is
///   reported readably by [`describe_start_doc_error`].
/// - A PDF for a queue that offers no `PDF` falls back to `RAW`, which is
///   what worked before on printers that read PDF directly. On a queue
///   whose driver only understands GDI that prints the PDF source, so the
///   caller logs the fallback.
///
/// Command languages are always `RAW` and never consult the list.
#[cfg_attr(not(windows), allow(dead_code))]
fn choose_datatype(mime_type: &str, offered: Option<&[String]>) -> &'static str {
    let wanted = spool_datatype(mime_type);
    if wanted != "PDF" {
        return wanted;
    }
    match offered {
        None => wanted,
        Some(list) if list.iter().any(|d| d.trim().eq_ignore_ascii_case("PDF")) => wanted,
        Some(_) => "RAW",
    }
}

/// `StartDocPrinter` failed with `code`: say what it means.
///
/// 1804 is `ERROR_INVALID_DATATYPE`, the spooler's answer when the print
/// processor does not offer the declared datatype. Other codes keep the
/// raw number, which is all that is known.
#[cfg_attr(not(windows), allow(dead_code))]
fn describe_start_doc_error(printer: &str, datatype: &str, code: u32) -> String {
    const ERROR_INVALID_DATATYPE: u32 = 1804;
    if code == ERROR_INVALID_DATATYPE {
        format!(
            "Printer `{printer}` does not accept {datatype} jobs (Windows error 1804, invalid data type): its print processor does not offer that datatype"
        )
    } else {
        format!("StartDocPrinter failed: {code}")
    }
}

#[cfg(windows)]
use crate::transport::{PrinterInfo, PrinterLanguage, PrinterTransport, PrinterType, RenderedJob};
#[cfg(windows)]
use async_trait::async_trait;
#[cfg(windows)]
use std::ffi::CString;
#[cfg(windows)]
use std::ptr::null_mut;

// Windows API types for spooler
#[cfg(windows)]
#[allow(clippy::upper_case_acronyms)]
mod winapi {
    use std::os::raw::{c_char, c_void};

    pub type HANDLE = *mut c_void;
    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type LPSTR = *mut c_char;
    pub type LPVOID = *mut c_void;
    pub type LPDWORD = *mut DWORD;
    pub type LPBYTE = *mut u8;

    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct DOC_INFO_1A {
        pub pDocName: LPSTR,
        pub pOutputFile: LPSTR,
        pub pDatatype: LPSTR,
    }

    /// `DATATYPES_INFO_1A` (winspool.h): one datatype name per entry.
    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct DATATYPES_INFO_1A {
        pub pName: LPSTR,
    }

    /// `PRINTER_INFO_2A` as documented in winspool.h.
    ///
    /// This MUST be laid out exactly or we read garbage pointers and crash.
    /// Field order per MSDN, each pointer is 8 bytes on 64-bit.
    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct PRINTER_INFO_2A {
        pub pServerName: LPSTR,
        pub pPrinterName: LPSTR,
        pub pShareName: LPSTR,
        pub pPortName: LPSTR,
        pub pDriverName: LPSTR,
        pub pComment: LPSTR,
        pub pLocation: LPSTR,
        pub pDevMode: LPVOID,
        pub pSepFile: LPSTR,
        pub pPrintProcessor: LPSTR,
        pub pDatatype: LPSTR,
        pub pParameters: LPSTR,
        pub pSecurityDescriptor: LPVOID,
        pub Attributes: DWORD,
        pub Priority: DWORD,
        pub DefaultPriority: DWORD,
        pub StartTime: DWORD,
        pub UntilTime: DWORD,
        pub Status: DWORD,
        pub cJobs: DWORD,
        pub AveragePPM: DWORD,
    }

    extern "system" {
        pub fn OpenPrinterA(
            pPrinterName: LPSTR,
            phPrinter: *mut HANDLE,
            pDefault: *mut c_void,
        ) -> BOOL;
        pub fn ClosePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartDocPrinterA(
            hPrinter: HANDLE,
            Level: DWORD,
            pDocInfo: *mut DOC_INFO_1A,
        ) -> DWORD;
        pub fn EndDocPrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartPagePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn EndPagePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn WritePrinter(
            hPrinter: HANDLE,
            pBuf: LPVOID,
            cbBuf: DWORD,
            pcWritten: LPDWORD,
        ) -> BOOL;
        pub fn EnumPrintersA(
            Flags: DWORD,
            Name: LPSTR,
            Level: DWORD,
            pPrinterEnum: LPBYTE,
            cbBuf: DWORD,
            pcbNeeded: LPDWORD,
            pcReturned: LPDWORD,
        ) -> BOOL;
        pub fn GetPrinterA(
            hPrinter: HANDLE,
            Level: DWORD,
            pPrinter: LPBYTE,
            cbBuf: DWORD,
            pcbNeeded: LPDWORD,
        ) -> BOOL;
        pub fn EnumPrintProcessorDatatypesA(
            pName: LPSTR,
            pPrintProcessorName: LPSTR,
            Level: DWORD,
            pDatatypes: LPBYTE,
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

/// Offered-datatype lists change only on driver/processor reinstall, so
/// successful listings are cached per queue for an hour (W3). Failures
/// (`None`) are never cached: a transient denial must recover on the next
/// job, not stick for the TTL.
#[cfg(windows)]
static OFFERED_DATATYPES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<String>)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

#[cfg(windows)]
const DATATYPES_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[cfg(windows)]
impl WindowsSpooler {
    pub fn new(printer_name: String) -> Self {
        Self { printer_name }
    }

    /// Enumerate all local system printers
    pub fn enumerate_printers() -> Vec<PrinterInfo> {
        use std::ffi::CStr;
        use winapi::*;

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

            // Cast the buffer to an array of PRINTER_INFO_2A and read fields
            // by name instead of guessing byte offsets (the old code used
            // `size_of::<usize>() * 10` which read garbage / could fault).
            let stride = std::mem::size_of::<PRINTER_INFO_2A>();
            let capacity = bytes_needed as usize / stride;

            let (_prefix, infos, _suffix) = buffer.as_slice().align_to::<PRINTER_INFO_2A>();
            for info in infos.iter().take(capacity.min(num_printers as usize)) {
                if info.pPrinterName.is_null() {
                    continue;
                }
                let name = CStr::from_ptr(info.pPrinterName as *const i8)
                    .to_string_lossy()
                    .to_string();
                let port = if info.pPortName.is_null() {
                    name.clone()
                } else {
                    CStr::from_ptr(info.pPortName as *const i8)
                        .to_string_lossy()
                        .to_string()
                };

                let offline = spooler_status_problem(info.Status).is_some();

                printers.push(PrinterInfo {
                    id: name.clone(),
                    name,
                    address: port,
                    printer_type: PrinterType::System,
                    language: PrinterLanguage::Pdf,
                    status: if offline { "offline" } else { "online" }.to_string(),
                });
            }
        }

        printers
    }

    /// The datatypes this queue's print processor offers, or `None` when
    /// they cannot be listed (the queue is remote, access is denied, or
    /// the call failed). An empty list counts as unknown. Results are
    /// cached per queue (see `OFFERED_DATATYPES`); only the live query
    /// below touches the spooler.
    fn offered_datatypes(&self) -> Option<Vec<String>> {
        if let Ok(guard) = OFFERED_DATATYPES.lock() {
            if let Some((at, names)) = guard.get(&self.printer_name) {
                if at.elapsed() < DATATYPES_TTL {
                    return Some(names.clone());
                }
            }
        }
        let found = self.query_offered_datatypes();
        if let Some(names) = &found {
            if let Ok(mut guard) = OFFERED_DATATYPES.lock() {
                guard.insert(
                    self.printer_name.clone(),
                    (std::time::Instant::now(), names.clone()),
                );
            }
        }
        found
    }

    fn query_offered_datatypes(&self) -> Option<Vec<String>> {
        use std::ffi::CStr;
        use winapi::*;

        let printer_name = CString::new(self.printer_name.clone()).ok()?;

        unsafe {
            let mut h_printer: HANDLE = null_mut();
            if OpenPrinterA(printer_name.as_ptr() as *mut _, &mut h_printer, null_mut()) == 0 {
                return None;
            }

            // The processor's name ("winprint", usually) is in PRINTER_INFO_2.
            let mut needed: DWORD = 0;
            GetPrinterA(h_printer, 2, null_mut(), 0, &mut needed);
            if needed == 0 {
                ClosePrinter(h_printer);
                return None;
            }
            let mut buffer = vec![0u8; needed as usize];
            let ok = GetPrinterA(h_printer, 2, buffer.as_mut_ptr(), needed, &mut needed);
            ClosePrinter(h_printer);
            if ok == 0 {
                return None;
            }
            // The buffer is a byte array, so read the struct unaligned. The
            // strings it points at live in `buffer`, which is still alive.
            let info = std::ptr::read_unaligned(buffer.as_ptr() as *const PRINTER_INFO_2A);
            if info.pPrintProcessor.is_null() {
                return None;
            }
            let processor = CStr::from_ptr(info.pPrintProcessor as *const i8).to_owned();

            let mut bytes_needed: DWORD = 0;
            let mut returned: DWORD = 0;
            EnumPrintProcessorDatatypesA(
                null_mut(),
                processor.as_ptr() as *mut _,
                1,
                null_mut(),
                0,
                &mut bytes_needed,
                &mut returned,
            );
            if bytes_needed == 0 {
                return None;
            }
            let mut list = vec![0u8; bytes_needed as usize];
            let ok = EnumPrintProcessorDatatypesA(
                null_mut(),
                processor.as_ptr() as *mut _,
                1,
                list.as_mut_ptr(),
                bytes_needed,
                &mut bytes_needed,
                &mut returned,
            );
            if ok == 0 {
                return None;
            }

            let stride = std::mem::size_of::<DATATYPES_INFO_1A>();
            let mut names = Vec::new();
            for i in 0..returned as usize {
                let at = i * stride;
                if at + stride > list.len() {
                    break;
                }
                let entry =
                    std::ptr::read_unaligned(list.as_ptr().add(at) as *const DATATYPES_INFO_1A);
                if !entry.pName.is_null() {
                    names.push(
                        CStr::from_ptr(entry.pName as *const i8)
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
            }
            (!names.is_empty()).then_some(names)
        }
    }

    /// Send raw bytes to the printer via the spooler (always RAW).
    pub fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        self.send_raw_with_datatype(data, "RAW")
    }

    /// Send bytes with an explicit spooler datatype — `RAW` for command
    /// languages, `PDF` for PDFs. Public for the `PDF` path below and for
    /// direct tests.
    pub fn send_raw_with_datatype(&self, data: &[u8], datatype_str: &str) -> Result<(), String> {
        use winapi::*;

        let printer_name = CString::new(self.printer_name.clone()).map_err(|e| e.to_string())?;
        let doc_name = CString::new("PrintNinja Job").map_err(|e| e.to_string())?;
        let datatype = CString::new(datatype_str).map_err(|e| e.to_string())?;

        unsafe {
            let mut h_printer: HANDLE = null_mut();
            let result = OpenPrinterA(printer_name.as_ptr() as *mut _, &mut h_printer, null_mut());
            if result == 0 {
                return Err(format!("OpenPrinter failed: {}", GetLastError()));
            }

            let doc_info = DOC_INFO_1A {
                pDocName: doc_name.as_ptr() as *mut _,
                pOutputFile: null_mut(),
                pDatatype: datatype.as_ptr() as *mut _,
            };

            let result = StartDocPrinterA(h_printer, 1, &doc_info as *const _ as *mut _);
            if result == 0 {
                // Read the code before ClosePrinter can overwrite it.
                let code = GetLastError();
                ClosePrinter(h_printer);
                return Err(describe_start_doc_error(
                    &self.printer_name,
                    datatype_str,
                    code,
                ));
            }

            // W5: no StartPagePrinter/EndPagePrinter. They bracket EMF
            // pages; for RAW and PDF spooling they are no-ops on the
            // success path — two fewer spooler round trips per job.
            let mut written: DWORD = 0;
            let result = WritePrinter(
                h_printer,
                data.as_ptr() as *mut _,
                data.len() as DWORD,
                &mut written,
            );

            // Read the error before the cleanup calls below can overwrite it.
            let write_error = if result == 0 {
                Some(GetLastError())
            } else {
                None
            };

            EndDocPrinter(h_printer);
            ClosePrinter(h_printer);

            if let Some(code) = write_error {
                return Err(format!("WritePrinter failed: {code}"));
            }
            ensure_fully_written(written, data.len())?;
        }

        Ok(())
    }

    /// Open the queue and read its status without sending a byte, so a
    /// connectivity test never prints (and never assumes the printer speaks
    /// ESC/POS, which a laser or inkjet queue does not).
    pub fn check_ready(&self) -> Result<(), String> {
        use winapi::*;

        let printer_name = CString::new(self.printer_name.clone()).map_err(|e| e.to_string())?;

        unsafe {
            let mut h_printer: HANDLE = null_mut();
            if OpenPrinterA(printer_name.as_ptr() as *mut _, &mut h_printer, null_mut()) == 0 {
                return Err(format!("OpenPrinter failed: {}", GetLastError()));
            }

            let mut needed: DWORD = 0;
            GetPrinterA(h_printer, 2, null_mut(), 0, &mut needed);
            if needed == 0 {
                ClosePrinter(h_printer);
                return Err(format!("GetPrinter failed: {}", GetLastError()));
            }

            let mut buffer = vec![0u8; needed as usize];
            let ok = GetPrinterA(h_printer, 2, buffer.as_mut_ptr(), needed, &mut needed);
            let error = if ok == 0 { Some(GetLastError()) } else { None };
            ClosePrinter(h_printer);
            if let Some(code) = error {
                return Err(format!("GetPrinter failed: {code}"));
            }

            // The buffer is a byte array, so read the struct unaligned.
            let info = std::ptr::read_unaligned(buffer.as_ptr() as *const PRINTER_INFO_2A);
            match spooler_status_problem(info.Status) {
                Some(problem) => Err(format!("Printer `{}` is {problem}", self.printer_name)),
                None => Ok(()),
            }
        }
    }
}

#[cfg(windows)]
#[async_trait]
impl PrinterTransport for WindowsSpooler {
    async fn discover(&self) -> Vec<PrinterInfo> {
        // W4: enumeration opens every queue; a wedged one must not stall a
        // tokio worker. Discovery must never fail the Setup page either,
        // so a panicked task degrades to an empty list.
        tokio::task::spawn_blocking(WindowsSpooler::enumerate_printers)
            .await
            .unwrap_or_default()
    }

    async fn test(&self) -> Result<(), String> {
        // Status only: the queue's language is unknown here, and ESC/POS
        // bytes sent to a laser or inkjet queue print as garbage.
        // W4: check_ready blocks on the queue; keep it off tokio workers.
        let spooler = WindowsSpooler::new(self.printer_name.clone());
        tokio::task::spawn_blocking(move || spooler.check_ready())
            .await
            .unwrap_or_else(|e| Err(format!("spooler test task failed: {e}")))
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        // W4: the Win32 spooler calls below block (a wedged queue can stall
        // them), so the whole send runs on the blocking pool instead of a
        // tokio worker.
        let spooler = WindowsSpooler::new(self.printer_name.clone());
        tokio::task::spawn_blocking(move || {
            let wanted = spool_datatype(&job.mime_type);
            let offered = if wanted == "PDF" {
                spooler.offered_datatypes()
            } else {
                None
            };
            let datatype = choose_datatype(&job.mime_type, offered.as_deref());
            if datatype != wanted {
                tracing::warn!(
                    "queue `{}` offers no {wanted} datatype; sending as {datatype}",
                    spooler.printer_name
                );
            }
            spooler.send_raw_with_datatype(&job.data, datatype)
        })
        .await
        .unwrap_or_else(|e| Err(format!("spooler send task failed: {e}")))
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

    pub fn send_raw_with_datatype(&self, _data: &[u8], _datatype: &str) -> Result<(), String> {
        Err("Windows spooler not available on this platform".to_string())
    }

    pub fn check_ready(&self) -> Result<(), String> {
        Err("Windows spooler not available on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_status_is_ready() {
        assert_eq!(spooler_status_problem(0), None);
        // Printing, busy and warming up are not faults.
        assert_eq!(spooler_status_problem(0x400 | 0x200 | 0x1_0000), None);
    }

    #[test]
    fn the_offline_and_paper_out_bits_are_the_documented_ones() {
        // PRINTER_STATUS_OFFLINE = 0x80, PRINTER_STATUS_PAPER_OUT = 0x10.
        assert_eq!(spooler_status_problem(0x80), Some("offline"));
        assert_eq!(spooler_status_problem(0x10), Some("out of paper"));
        assert_eq!(spooler_status_problem(0x08), Some("paper jammed"));
        assert_eq!(spooler_status_problem(0x0040_0000), Some("cover open"));
        assert_eq!(spooler_status_problem(0x02), Some("reporting an error"));
    }

    #[test]
    fn each_fault_bit_reports_its_reason() {
        // Every bit that should block a job, one at a time.
        assert_eq!(
            spooler_status_problem(0x0000_0002),
            Some("reporting an error")
        );
        assert_eq!(spooler_status_problem(0x0000_0008), Some("paper jammed"));
        assert_eq!(spooler_status_problem(0x0000_0010), Some("out of paper"));
        assert_eq!(spooler_status_problem(0x0000_0080), Some("offline"));
        assert_eq!(spooler_status_problem(0x0000_1000), Some("not available"));
        assert_eq!(spooler_status_problem(0x0004_0000), Some("out of toner"));
        assert_eq!(spooler_status_problem(0x0040_0000), Some("cover open"));
    }

    #[test]
    fn non_fault_status_bits_are_ignored() {
        // Bits that describe activity, not faults, must not block a probe.
        // PRINTER_STATUS_PAUSED=1, PRINTING=0x400, PROCESSING=0x4000, BUSY=0x200,
        // WAITING=0x20, IO_ACTIVE=0x100, OUTPUT_BIN_FULL=0x800, etc.
        const NON_FAULT: u32 = 0x0000_0001
            | 0x0000_0020
            | 0x0000_0040
            | 0x0000_0200
            | 0x0000_0400
            | 0x0000_0800
            | 0x0000_4000
            | 0x0001_0000
            | 0x0002_0000;
        assert_eq!(spooler_status_problem(NON_FAULT), None);
        assert_eq!(
            spooler_status_problem(NON_FAULT | 0x400 | 0x200),
            None,
            "adding more non-fault bits must stay ready"
        );
    }

    #[test]
    fn combined_faults_respect_priority() {
        // Priority is offline > not available > paper out > jam > door > toner > error,
        // so the operator sees the most actionable reason first.
        assert_eq!(spooler_status_problem(0x80 | 0x10), Some("offline"));
        assert_eq!(spooler_status_problem(0x80 | 0x08), Some("offline"));
        assert_eq!(spooler_status_problem(0x1000 | 0x10), Some("not available"));
        assert_eq!(spooler_status_problem(0x10 | 0x08), Some("out of paper"));
        assert_eq!(
            spooler_status_problem(0x08 | 0x0040_0000),
            Some("paper jammed")
        );
        assert_eq!(
            spooler_status_problem(0x0040_0000 | 0x0004_0000),
            Some("cover open")
        );
        assert_eq!(
            spooler_status_problem(0x0004_0000 | 0x0000_0002),
            Some("out of toner")
        );
        // All faults at once still reports offline.
        assert_eq!(
            spooler_status_problem(
                0x0000_0002
                    | 0x0000_0008
                    | 0x0000_0010
                    | 0x0000_0080
                    | 0x0000_1000
                    | 0x0004_0000
                    | 0x0040_0000
            ),
            Some("offline")
        );
    }

    #[test]
    fn offline_wins_over_other_faults() {
        assert_eq!(spooler_status_problem(0x80 | 0x10), Some("offline"));
    }

    #[test]
    fn a_short_write_is_an_error() {
        assert!(ensure_fully_written(10, 10).is_ok());
        assert!(ensure_fully_written(0, 0).is_ok());
        let err = ensure_fully_written(4, 10).unwrap_err();
        assert!(err.contains("4 of 10"), "{err}");
    }

    #[test]
    fn short_write_errors_are_operator_readable() {
        let err = ensure_fully_written(0, 1024).unwrap_err();
        assert!(err.contains("0 of 1024"), "{err}");
        assert!(err.contains("incomplete"), "{err}");
        let err = ensure_fully_written(u32::MAX, 10).unwrap_err();
        assert!(err.contains("incomplete"), "{err}");
    }

    #[test]
    fn probe_reasons_are_operator_readable() {
        // The strings from spooler_status_problem end up in History and in the
        // API error. They must not leak hex codes or "IPP status".
        for (bits, want) in [
            (0x80u32, "offline"),
            (0x10, "out of paper"),
            (0x08, "paper jammed"),
            (0x0040_0000, "cover open"),
        ] {
            let reason = spooler_status_problem(bits).unwrap();
            assert_eq!(reason, want);
            assert!(!reason.contains("0x"), "{reason}");
            assert!(!reason.contains("IPP"), "{reason}");
        }
    }

    #[test]
    fn pdf_uses_pdf_datatype_and_others_use_raw() {
        assert_eq!(spool_datatype("application/pdf"), "PDF");
        assert_eq!(spool_datatype("application/octet-stream"), "RAW");
        assert_eq!(spool_datatype("text/plain"), "RAW");
        assert_eq!(spool_datatype(""), "RAW");
    }

    fn list(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn pdf_is_declared_only_when_the_queue_offers_it() {
        let stock = list(&["RAW", "RAW [FF appended]", "NT EMF 1.008", "TEXT"]);
        assert_eq!(choose_datatype("application/pdf", Some(&stock)), "RAW");
        let with_pdf = list(&["RAW", "PDF", "NT EMF 1.008"]);
        assert_eq!(choose_datatype("application/pdf", Some(&with_pdf)), "PDF");
    }

    #[test]
    fn the_pdf_match_ignores_case_and_padding() {
        let odd = list(&["raw", " Pdf "]);
        assert_eq!(choose_datatype("application/pdf", Some(&odd)), "PDF");
    }

    #[test]
    fn an_unreadable_datatype_list_keeps_the_wanted_datatype() {
        assert_eq!(choose_datatype("application/pdf", None), "PDF");
    }

    #[test]
    fn command_languages_are_raw_whatever_the_queue_offers() {
        let with_pdf = list(&["RAW", "PDF"]);
        let none_raw = list(&["NT EMF 1.008"]);
        for mime in ["application/octet-stream", "text/plain", ""] {
            assert_eq!(choose_datatype(mime, Some(&with_pdf)), "RAW");
            assert_eq!(choose_datatype(mime, Some(&none_raw)), "RAW");
            assert_eq!(choose_datatype(mime, None), "RAW");
        }
    }

    #[test]
    fn error_1804_reads_as_an_unsupported_datatype() {
        let msg = describe_start_doc_error("Front Desk", "PDF", 1804);
        assert!(msg.contains("Front Desk"), "{msg}");
        assert!(msg.contains("PDF"), "{msg}");
        assert!(msg.contains("1804"), "{msg}");
        assert!(msg.contains("data type"), "{msg}");
    }

    #[test]
    fn other_start_doc_errors_keep_the_code() {
        assert_eq!(
            describe_start_doc_error("P", "RAW", 5),
            "StartDocPrinter failed: 5"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn stub_spooler_refuses_on_this_platform() {
        let s = WindowsSpooler::new("Any Printer".into());
        assert!(s.send_raw(b"hello").is_err());
        assert!(s.check_ready().is_err());
        let msg = s.send_raw(b"hello").unwrap_err();
        assert!(msg.contains("not available on this platform"), "{msg}");
    }

    #[cfg(windows)]
    #[test]
    fn printer_info_2a_layout_matches_winspl() {
        // The struct is read from a raw byte buffer via align_to/read_unaligned.
        // If the layout drifts, EnumPrinters/GetPrinter return garbage.
        // 13 pointers (LPSTR/LPVOID) + 8 DWORDs (Attributes..AveragePPM).
        assert_eq!(
            std::mem::size_of::<winapi::PRINTER_INFO_2A>(),
            std::mem::size_of::<usize>() * 13 + 4 * 8,
            "PRINTER_INFO_2A size must match 13 pointers + 8 DWORDs"
        );
        assert_eq!(
            std::mem::align_of::<winapi::PRINTER_INFO_2A>(),
            std::mem::align_of::<usize>()
        );
    }
}
