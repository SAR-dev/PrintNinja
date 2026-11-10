//! PDF → raster for PDF-input print jobs, via the PDFium engine.
//!
//! A job that carries raw PDF bytes instead of HTML goes one of two ways:
//!
//! * **Pdf-language printers** (IPP / system spooler) take the bytes as-is —
//!   no engine involved.
//! * **Command-language printers** (ESC/POS, TSPL, ZPL, CPCL) cannot consume
//!   PDF, so this module rasterises the document's *first* page to the
//!   printer's dot dimensions and feeds the `RasterImage` through the same
//!   `encode_for_language` path as HTML-derived rasters.
//!
//! The PDFium binary is vendored in `resources/pdfium/` — `pdfium.dll`
//! on Windows, `libpdfium.so` on Linux (Apache-2.0 — see the
//! `LICENSE.txt` there) — and bundled as a Tauri resource. Tauri
//! bundles the whole directory to every platform, so each installer
//! carries the other platform's ~7 MB binary too (accepted dead weight,
//! cheaper than a per-platform build).
//! At runtime the library is bound once from the first candidate that
//! loads:
//!
//! 1. `PDFIUM_LIBRARY_PATH` — explicit override (file, or a directory
//!    containing the platform library);
//! 2. the executable directory: `resources/pdfium/`, the directory itself,
//!    then `../resources/pdfium/` (a dev checkout puts the exe in
//!    `target/debug/`);
//! 3. `CARGO_MANIFEST_DIR/resources/pdfium` — the `cargo run` / `cargo test`
//!    layout, where no bundle is built;
//! 4. the system library (`libpdfium.so` on a Linux box that installed it).
//!
//! Multi-page documents print only the first page — the job carries a
//! warning when more pages exist. This mirrors the label use case (one
//! page, one label); whole-document rastering is a v2 concern.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::render::raster::RasterImage;

use pdfium_render::prelude::*;

/// The PDFium engine, bound at most once per process. The `pdfium-render`
/// crate keeps a global bindings slot, so the first successful bind wins
/// and later attempts error — the candidate loop therefore stops at the
/// first load.
static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// Load (or re-throw the stored error for) the PDFium engine.
fn pdfium() -> Result<&'static Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            let candidates = candidate_paths();
            for path in &candidates {
                if path.is_file() {
                    if let Ok(bindings) = Pdfium::bind_to_library(path) {
                        return Ok(Pdfium::new(bindings));
                    }
                    // A present-but-unloadable copy (corrupt file, wrong
                    // architecture) must not shadow the remaining
                    // candidates or the system library.
                }
            }
            match Pdfium::bind_to_system_library() {
                Ok(bindings) => Ok(Pdfium::new(bindings)),
                Err(_) => Err(format!(
                    "PDFium could not be loaded; tried: {} \
                     (set PDFIUM_LIBRARY_PATH to a pdfium library to override)",
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            }
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Ordered library candidates, best first.
fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Ok(raw) = std::env::var("PDFIUM_LIBRARY_PATH") {
        let p = PathBuf::from(raw.trim());
        if p.is_dir() {
            out.push(Pdfium::pdfium_platform_library_name_at_path(&p));
        } else {
            out.push(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for base in [
                dir.join("resources").join("pdfium"),
                dir.to_path_buf(),
                dir.join("..").join("resources").join("pdfium"),
            ] {
                out.push(Pdfium::pdfium_platform_library_name_at_path(&base));
            }
        }
    }

    // `cargo run` / `cargo test`: no bundle, the manifest dir is known at
    // compile time.
    let manifest_pdfium = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("pdfium");
    out.push(Pdfium::pdfium_platform_library_name_at_path(
        &manifest_pdfium,
    ));

    out
}

/// Rasterise the *first* page of `pdf` into a `w_px` × `h_px` 1-bit image.
///
/// The page is scaled to fit within the target with its aspect ratio kept
/// (PDFium additionally rotates landscape pages 90° so they fill the
/// label width), and is anchored top-left. Unrendered area is white.
/// Returns the raster and the document's total page count so callers can
/// warn about the pages that did not print.
///
/// The luminance convention matches the PNG screenshot path exactly
/// (`0.299 R + 0.587 G + 0.114 B`, threshold 128), so a PDF and an HTML
/// page printing the same picture rasterise identically.
pub fn pdf_to_raster(pdf: &[u8], w_px: usize, h_px: usize) -> Result<(RasterImage, u32), String> {
    if w_px == 0 || h_px == 0 {
        return Err("raster target size is zero".into());
    }
    let pdfium = pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(pdf, None)
        .map_err(|e| format!("PDF could not be parsed: {e}"))?;
    let pages = doc.pages();
    let page_count = pages.len() as u32;
    if page_count == 0 {
        return Err("PDF has no pages".into());
    }
    let page = pages
        .first()
        .map_err(|e| format!("PDF page could not be read: {e}"))?;
    let config = PdfRenderConfig::new().scale_page_to_display_size(w_px as i32, h_px as i32);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("PDF page could not be rendered: {e}"))?;
    let bw = bitmap.width() as usize;
    let bh = bitmap.height() as usize;
    let rgba = bitmap.as_rgba_bytes();

    // White everywhere, then luminance over the rendered region.
    let mut gray = vec![255u8; w_px * h_px];
    for y in 0..h_px.min(bh) {
        let src_row = y * bw * 4;
        let dst_row = y * w_px;
        for x in 0..w_px.min(bw) {
            let i = src_row + x * 4;
            gray[dst_row + x] = (0.299 * rgba[i] as f32
                + 0.587 * rgba[i + 1] as f32
                + 0.114 * rgba[i + 2] as f32) as u8;
        }
    }

    let mut raster = RasterImage::new(w_px, h_px);
    raster.threshold(&gray, w_px, h_px, 128);
    Ok((raster, page_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal single-page PDF, built with exact xref offsets: a
    /// portrait 150×200 pt page with one black filled rectangle covering
    /// its top-left quarter (PDF coordinates have their origin at
    /// bottom-left, so the *top-left* of the raster is x∈[0,75), y∈[100,200)).
    fn minimal_pdf() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"%PDF-1.4\n");
        let o1 = out.len();
        out.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        let o2 = out.len();
        out.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
        let o3 = out.len();
        out.extend_from_slice(
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 150 200] /Contents 4 0 R >>\nendobj\n",
        );
        let stream = b"0 100 75 100 re f";
        let o4 = out.len();
        out.extend_from_slice(b"4 0 obj\n<< /Length ");
        out.extend_from_slice(stream.len().to_string().as_bytes());
        out.extend_from_slice(b" >>\nstream\n");
        out.extend_from_slice(stream);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        let xref_pos = out.len();
        out.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
        for o in [o1, o2, o3, o4] {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(b"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n");
        out.extend_from_slice(xref_pos.to_string().as_bytes());
        out.extend_from_slice(b"\n%%EOF\n");
        out
    }

    /// Bind the vendored library, or skip when it cannot be loaded (e.g.
    /// a non-Windows CI without libpdfium).
    fn pdfium_or_skip() -> Option<&'static Pdfium> {
        match pdfium() {
            Ok(p) => Some(p),
            Err(e) => {
                eprintln!("test skipped: {e}");
                None
            }
        }
    }

    #[test]
    fn rasterises_the_first_page_into_the_requested_dots() {
        if pdfium_or_skip().is_none() {
            return;
        }
        let pdf = minimal_pdf();
        let (raster, pages) = pdf_to_raster(&pdf, 320, 240).expect("valid PDF");
        assert_eq!(pages, 1);
        // The 150×200 page scales to fit 320×240 at 1.2× → 180×240 px,
        // anchored top-left. The rect (75×100 pt top-left quarter) covers
        // raster x∈[0,90), y∈[0,120).
        assert!(
            raster.get_bit(0, 0),
            "top-left corner is inside the black rect"
        );
        assert!(raster.get_bit(80, 110), "inside the black rect");
        assert!(!raster.get_bit(100, 110), "right of the rect is white");
        assert!(!raster.get_bit(10, 130), "below the rect is white");
        assert!(
            !raster.get_bit(200, 10),
            "outside the rendered 180px width is white"
        );
        assert!(!raster.get_bit(319, 239), "bottom-right corner is white");
    }

    #[test]
    fn reports_the_page_count_for_multipage_warnings() {
        if pdfium_or_skip().is_none() {
            return;
        }
        let pdf = minimal_pdf();
        let (_, pages) = pdf_to_raster(&pdf, 100, 100).expect("valid PDF");
        assert_eq!(pages, 1);
    }

    #[test]
    fn garbage_bytes_refuse_cleanly() {
        if pdfium_or_skip().is_none() {
            return;
        }
        let err =
            pdf_to_raster(b"this is not a pdf at all", 320, 240).expect_err("must not succeed");
        assert!(err.contains("could not be parsed"), "got: {err}");
    }
}
