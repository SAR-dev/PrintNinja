//! Phase 0 item 0.6 (P4): the print pipeline dispatches on
//! `printers.language`.
//!
//! Byte-level loopback — no hardware and no browser: a raw-TCP printer on a
//! random loopback port receives each command language's own bytes, and the
//! `pdf` language still sends the renderer's PDF untouched. The encoders and
//! `render/raster.rs` are finally called by the pipeline.

use printninja_lib::commands::print::{run_print_with, JobRenderer, PrintRequest};
use printninja_lib::db::Database;
use printninja_lib::queue::PrintQueue;
use printninja_lib::render::raster::RasterImage;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_lang_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    Arc::new(Mutex::new(db))
}

fn cache_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("printninja_p06_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create cache dir");
    dir
}

/// A 16×8 image with a known dot pattern, so every assertion can check the
/// encoded bytes down to the bit.
fn test_raster() -> RasterImage {
    let mut img = RasterImage::new(16, 8);
    // Top row all set, a diagonal, and the bottom-right pixel.
    for x in 0..16 {
        img.set_bit(x, 0, true);
    }
    for i in 0..8 {
        img.set_bit(i, i, true);
    }
    img.set_bit(15, 7, true);
    img
}

/// Substitutes the raster step only: the pipeline still runs the layout,
/// the queue permit, the real encoders and the real TCP transport.
struct StubRenderer {
    raster: RasterImage,
    seen: Arc<Mutex<Option<(usize, usize)>>>,
}

#[async_trait::async_trait]
impl JobRenderer for StubRenderer {
    async fn render(&self, _: &str, _: f64, _: f64, _: &str) -> anyhow::Result<Vec<u8>> {
        panic!("a command-language job must never run the PDF renderer");
    }

    async fn rasterize(
        &self,
        _html: &str,
        w_px: usize,
        h_px: usize,
    ) -> anyhow::Result<RasterImage> {
        *self.seen.lock().unwrap() = Some((w_px, h_px));
        Ok(self.raster.clone())
    }
}

/// A renderer that serves only the PDF path.
struct PdfStub;

#[async_trait::async_trait]
impl JobRenderer for PdfStub {
    async fn render(&self, _: &str, _: f64, _: f64, _: &str) -> anyhow::Result<Vec<u8>> {
        Ok(b"%PDF-1.4 fake".to_vec())
    }
}

fn seed_printer(db: &Db, name: &str, language: &str, port: u16) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO printers (name, type, address, language, paper_width_mm, dpi)
             VALUES (?1, 'raw_tcp', ?2, ?3, 40, 203)",
            rusqlite::params![name, format!("127.0.0.1:{port}"), language],
        )
        .expect("seed printer");
}

fn print_request(printer: &str) -> PrintRequest {
    PrintRequest {
        printer_name: printer.to_string(),
        html: "<html><body><p>label</p></body></html>".to_string(),
        pdf: None,
        page_width_mm: Some(40.0),
        page_height_mm: Some(30.0),
        orientation: Some("portrait".to_string()),
        copies: Some(1),
        records: None,
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        page_range: None,
        grayscale: None,
        template_id: None,
        data: None,
        data_url: None,
        http_method: None,
        test: None,
        source: Some("ui".to_string()),
        idempotency_key: None,
        requested_by_device_id: None,
    }
}

/// What a healthy printer says to a status query, in each dialect that has
/// one — written out by hand, so the assertion about being able to print is
/// not derived from the code under test.
fn healthy_answer(language: &str) -> &'static [u8] {
    match language {
        "escpos" => &[0x12, 0x12, 0x12, 0x12],
        "zpl" => b"\x02030,0,0,0\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n",
        "tspl" => &[0x00],
        _ => &[],
    }
}

/// Bind a loopback listener on a random port: `(port, capture task)`.
///
/// A job does not arrive on the connection that opens the conversation
/// anymore: a printer that speaks a status dialect is asked whether it can
/// print first, on its own connection. So this accepts until the client goes
/// away and returns the last thing it was sent — the job — while answering
/// the probe healthily, which is what lets the job go out at all.
async fn loopback(language: &str) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let answer = healthy_answer(language).to_vec();
    let handle = tokio::spawn(async move {
        let mut last = Vec::new();
        let mut first = true;
        loop {
            let accepted =
                tokio::time::timeout(Duration::from_millis(250), listener.accept()).await;
            let Ok(Ok((mut sock, _))) = accepted else {
                break;
            };
            if first && !answer.is_empty() {
                sock.write_all(&answer)
                    .await
                    .expect("answer the status query");
            }
            first = false;
            let mut buf = Vec::new();
            sock.read_to_end(&mut buf).await.expect("read");
            if !buf.is_empty() {
                last = buf;
            }
        }
        last
    });
    (port, handle)
}

/// Print one job to a loopback printer speaking `language` and return the
/// exact bytes of the job.
///
/// The status query that a dialect-speaking printer is asked first comes on
/// its own connection and is answered, not returned: what is asserted here
/// is what the printer was sent to print.
async fn capture(language: &str) -> (Vec<u8>, Option<(usize, usize)>) {
    let db = test_db();
    let (port, capture) = loopback(language).await;
    seed_printer(&db, "Thermal", language, port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let seen = Arc::new(Mutex::new(None));
    let renderer = StubRenderer {
        raster: test_raster(),
        seen: seen.clone(),
    };
    let res = run_print_with(&cache, &db, &queue, print_request("Thermal"), &renderer)
        .await
        .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    let seen = seen.lock().unwrap().take();
    (bytes, seen)
}

#[tokio::test]
async fn zpl_printers_receive_zpl() {
    let (bytes, _) = capture("zpl").await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("^XA"), "{text}");
    assert!(text.contains("^GFA"), "{text}");
    assert!(text.trim_end().ends_with("^XZ"), "{text}");
    // ^GFA wants the packed dots as hex — the exact raster, byte for byte.
    let hex: String = test_raster()
        .dots
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    assert!(
        text.contains(&hex),
        "bitmap hex must be the raster's dots: {text}"
    );
}

#[tokio::test]
async fn tspl_printers_receive_tspl_with_raw_bitmap() {
    let (bytes, _) = capture("tspl").await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("SIZE 40 mm"), "{text}");
    assert!(text.contains("BITMAP "), "{text}");
    assert!(text.contains("PRINT 1"), "{text}");
    // Canonical TSPL: the BITMAP command is followed by the raw packed
    // dots, not their hex.
    let marker = text.find("BITMAP").expect("BITMAP command");
    let after = &bytes[marker..];
    let newline = after
        .iter()
        .position(|b| *b == b'\n')
        .expect("BITMAP line ends");
    let body = &after[newline + 1..];
    assert!(
        body.starts_with(&test_raster().dots),
        "raw bitmap bytes must follow the BITMAP command"
    );
}

#[tokio::test]
async fn escpos_printers_receive_escpos() {
    let (bytes, _) = capture("escpos").await;
    assert!(
        bytes.starts_with(&[0x1B, 0x40]),
        "must open with ESC @ init: {bytes:?}"
    );
    assert!(
        bytes.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]),
        "must carry the GS v 0 raster command: {bytes:?}"
    );
    // Item 5: the job is the full receipt frame, so the stream now
    // closes with the feed lines and a full cut, not the bare dots.
    assert!(
        bytes.ends_with(&[0x1B, 0x64, 0x03, 0x1D, 0x56, 0x00]),
        "the receipt must close with the feed lines and a full cut: {bytes:?}"
    );
}

#[tokio::test]
async fn cpcl_printers_receive_cpcl() {
    let (bytes, _) = capture("cpcl").await;
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.starts_with("! 0 200 200"), "{text}");
    assert!(text.contains("CG "), "{text}");
    assert!(text.trim_end().ends_with("PRINT"), "{text}");
    let hex: String = test_raster()
        .dots
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
    assert!(
        text.contains(&hex),
        "bitmap hex must be the raster's dots: {text}"
    );
}

#[tokio::test]
async fn raster_language_sends_the_packed_dots_alone() {
    let (bytes, _) = capture("raster").await;
    assert_eq!(bytes, test_raster().dots, "raster is the bare 1-bit dump");
}

#[tokio::test]
async fn pdf_printers_still_receive_pdf() {
    let db = test_db();
    let (port, capture) = loopback("pdf").await;
    seed_printer(&db, "Office", "pdf", port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let res = run_print_with(&cache, &db, &queue, print_request("Office"), &PdfStub)
        .await
        .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    assert_eq!(
        bytes, b"%PDF-1.4 fake",
        "pdf language sends the PDF untouched"
    );
}

#[tokio::test]
async fn an_unrecognised_language_falls_back_to_the_pdf_path() {
    // The schema's CHECK constraint stops this through the app; a hand-edited
    // row can still carry anything. It must behave like `pdf`, not crash.
    let db = test_db();
    let (port, capture) = loopback("telepathy").await;
    {
        let guard = db.lock().unwrap();
        // The schema's CHECK stops 'telepathy' through the app; a hand-edited
        // row (sqlite3 CLI, another connection) can carry anything, and this
        // is exactly how it would get there. The pragma is per-connection —
        // `Database` holds one — and is re-armed immediately, so only this
        // INSERT sees it; the row itself survives validation-free.
        guard
            .connection()
            .execute_batch("PRAGMA ignore_check_constraints = ON;")
            .expect("relax check for a hand-edited row");
        guard
            .connection()
            .execute(
                "INSERT INTO printers (name, type, address, language)
                 VALUES ('Odd', 'raw_tcp', ?1, 'telepathy')",
                [format!("127.0.0.1:{port}")],
            )
            .expect("seed odd printer");
        guard
            .connection()
            .execute_batch("PRAGMA ignore_check_constraints = OFF;")
            .expect("re-arm check");
    }
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let res = run_print_with(&cache, &db, &queue, print_request("Odd"), &PdfStub)
        .await
        .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    assert_eq!(bytes, b"%PDF-1.4 fake");
}

#[tokio::test]
async fn the_raster_is_sized_in_the_printers_own_dots() {
    // 40 mm × 30 mm at 203 dpi = 319.69 × 239.76 → 320 × 240 dots: the
    // browser must be asked for the printer's resolution, not the screen's.
    let (_, seen) = capture("zpl").await;
    assert_eq!(seen, Some((320, 240)));
}

// ── PDF input (TODO item 3) ─────────────────────────────────────────────────
//
// A job can carry an existing PDF instead of HTML: pdf-language printers
// take the bytes as-is, command-language printers get the first page
// rasterised to their own dot dimensions and encoded like any other image.

/// The document a PDF-input job prints in these tests.
const SAMPLE_PDF: &[u8] = b"%PDF-1.4 fake document";

/// Serves the PDF-input path with a fixed raster: the pipeline still runs
/// the layout, the queue permit, the real encoders and the real TCP
/// transport. It records the document it was given so a test can assert the
/// exact bytes reached the rasterizer.
struct PdfInStub {
    raster: RasterImage,
    pages: u32,
    pdf_seen: Arc<Mutex<Option<Vec<u8>>>>,
}

#[async_trait::async_trait]
impl JobRenderer for PdfInStub {
    async fn render(&self, _: &str, _: f64, _: f64, _: &str) -> anyhow::Result<Vec<u8>> {
        panic!("a pdf job must never run the HTML renderer");
    }

    async fn rasterize_pdf(
        &self,
        pdf: &[u8],
        _: usize,
        _: usize,
    ) -> anyhow::Result<(RasterImage, u32)> {
        self.pdf_seen.lock().unwrap().replace(pdf.to_vec());
        Ok((self.raster.clone(), self.pages))
    }
}

/// A PDF-input request: the document, and no HTML (the two conflict).
fn pdf_request(printer: &str, pdf: Vec<u8>) -> PrintRequest {
    let mut req = print_request(printer);
    req.html = String::new();
    req.pdf = Some(pdf);
    req
}

/// Print one PDF-input job to a loopback printer speaking `language` and
/// return the exact job bytes plus the document the stub rasterizer saw.
async fn capture_pdf(language: &str, pages: u32) -> (Vec<u8>, Option<Vec<u8>>, Vec<String>) {
    let db = test_db();
    let (port, capture) = loopback(language).await;
    seed_printer(&db, "Thermal", language, port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let pdf_seen = Arc::new(Mutex::new(None));
    let renderer = PdfInStub {
        raster: test_raster(),
        pages,
        pdf_seen: pdf_seen.clone(),
    };
    let res = run_print_with(
        &cache,
        &db,
        &queue,
        pdf_request("Thermal", SAMPLE_PDF.to_vec()),
        &renderer,
    )
    .await
    .expect("pipeline");
    assert!(res.success, "job must succeed: {:?}", res.error);
    let bytes = capture.await.expect("capture");
    let pdf_seen = pdf_seen.lock().unwrap().take();
    (bytes, pdf_seen, res.warnings)
}

#[tokio::test]
async fn pdf_jobs_on_pdf_printers_send_the_document_untouched() {
    // The document is the job: no engine in between.
    let (bytes, pdf_seen, _) = capture_pdf("pdf", 1).await;
    assert_eq!(
        bytes, SAMPLE_PDF,
        "pdf language sends the document untouched"
    );
    // The document is the job: the Pdf-language branch passes the bytes
    // straight through and never consults the renderer (no engine in
    // between) — only command-language jobs hand the PDF to it.
    assert_eq!(
        pdf_seen, None,
        "pdf language must not ask the renderer for anything"
    );
}

#[tokio::test]
async fn pdf_jobs_on_command_printers_encode_the_same_raster_as_html() {
    // Same fixed raster in, same encoder out: the job bytes for a PDF must
    // be identical to the HTML job that rasterises to the same dots.
    for language in ["escpos", "tspl", "zpl", "cpcl"] {
        let (html_bytes, _) = capture(language).await;
        let (pdf_bytes, pdf_seen, _) = capture_pdf(language, 1).await;
        assert_eq!(
            pdf_seen,
            Some(SAMPLE_PDF.to_vec()),
            "{language}: the rasterizer must get the document itself"
        );
        assert_eq!(
            html_bytes, pdf_bytes,
            "{language}: the pdf path must encode the raster exactly like the html path"
        );
    }
}

#[tokio::test]
async fn pdf_jobs_warn_when_only_the_first_page_prints() {
    let (_, _, warnings) = capture_pdf("escpos", 3).await;
    assert!(
        warnings.iter().any(|w| w.contains("3 pages")),
        "a multi-page pdf must warn that only page 1 printed: {warnings:?}"
    );
}

#[tokio::test]
async fn pdf_jobs_over_the_size_cap_are_refused_before_anything_runs() {
    let db = test_db();
    let (port, _capture) = loopback("escpos").await;
    seed_printer(&db, "Thermal", "escpos", port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let big = vec![0u8; printninja_lib::commands::print::MAX_PDF_BYTES + 1];
    let res = run_print_with(
        &cache,
        &db,
        &queue,
        pdf_request("Thermal", big),
        &PdfInStub {
            raster: test_raster(),
            pages: 1,
            pdf_seen: Arc::new(Mutex::new(None)),
        },
    )
    .await;
    assert!(res.is_err(), "an oversize pdf must be refused");
    // Intake refused it: no job row exists, so nothing would retry or
    // reprint it later.
    let guard = db.lock().unwrap();
    let jobs: i64 = guard
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .expect("count");
    assert_eq!(jobs, 0, "a refused job must not create a row");
}

#[tokio::test]
async fn a_pdf_conflicting_with_html_is_refused() {
    let db = test_db();
    let (port, _capture) = loopback("escpos").await;
    seed_printer(&db, "Thermal", "escpos", port);
    let queue = PrintQueue::new();
    let cache = cache_dir();
    let mut req = print_request("Thermal");
    req.pdf = Some(SAMPLE_PDF.to_vec()); // html stays set
    let res = run_print_with(
        &cache,
        &db,
        &queue,
        req,
        &PdfInStub {
            raster: test_raster(),
            pages: 1,
            pdf_seen: Arc::new(Mutex::new(None)),
        },
    )
    .await;
    assert!(res.is_err(), "a job takes one content source");
}
