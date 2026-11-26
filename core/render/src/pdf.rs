//! PDF output for `page` media (plan §5.2): the same rendered dots the
//! thermal path prints, wrapped in a document the OS print path can send
//! to a page printer (spooler or IPP). One renderer drives both.
//!
//! The PDF is a container, not a second renderer: each page is the page's
//! own 1-bit bitmap, Flate-compressed and scaled to the physical page
//! size. The bytes are deterministic — a fixed compression level and no
//! timestamps — so they are golden-pinnable, like the raster output.

use std::io::Write;

use flate2::{write::DeflateEncoder, Compression};

use crate::bitmap::Bitmap;

/// A rendered document page: the dots and the physical page size in mm.
#[derive(Debug, Clone)]
pub struct RasterPage {
    pub bitmap: Bitmap,
    pub width_mm: f32,
    pub height_mm: f32,
}

impl RasterPage {
    pub fn new(bitmap: Bitmap, width_mm: f32, height_mm: f32) -> Self {
        Self {
            bitmap,
            width_mm,
            height_mm,
        }
    }
}

/// The pages as a PDF: one page object per rendered page, each carrying
/// its 1-bit bitmap as a Flate image stretched to the physical page size
/// (the bitmap was rendered from the same millimetres, so the aspect
/// ratio already matches).
///
/// # Panics
/// An empty document, or a page without a size or dots, is a bug in the
/// caller — the job layer guarantees at least one page.
pub fn render_pdf(pages: &[RasterPage]) -> Vec<u8> {
    assert!(!pages.is_empty(), "a document has at least one page");
    for (i, p) in pages.iter().enumerate() {
        assert!(
            p.width_mm > 0.0 && p.height_mm > 0.0,
            "page {i} has no size"
        );
        assert!(
            p.bitmap.width() > 0 && p.bitmap.height() > 0,
            "page {i} has no dots"
        );
    }

    let n = pages.len();
    // Object numbers: 1 catalog, 2 pages tree, then per page — page,
    // content stream, image — in document order.
    let page_obj = |i: usize| 3 + 3 * i;
    let content_obj = |i: usize| 4 + 3 * i;
    let image_obj = |i: usize| 5 + 3 * i;

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    // Object numbers are pushed in order, so the xref needs only offsets.
    let mut offsets: Vec<usize> = Vec::new();
    let obj = |num: u32, body: &str| -> String { format!("{num} 0 obj\n{body}\nendobj\n") };

    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", page_obj(i))).collect();

    offsets.push(out.len());
    out.extend_from_slice(
        obj(
            1,
            "<< /Type /Catalog /Pages 2 0 R /Producer (PrintNinja) >>",
        )
        .as_bytes(),
    );
    offsets.push(out.len());
    out.extend_from_slice(
        obj(
            2,
            &format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), n),
        )
        .as_bytes(),
    );

    for (i, page) in pages.iter().enumerate() {
        let (w_pt, h_pt) = (mm_to_pt(page.width_mm), mm_to_pt(page.height_mm));
        let content = format!("q {w_pt} 0 0 {h_pt} cm /Im0 Do Q");
        let packed = page.bitmap.to_bytes();
        let image = flate(packed);

        offsets.push(out.len());
        out.extend_from_slice(
            obj(
                page_obj(i) as u32,
                &format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w_pt} {h_pt}] \
                     /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 {img} 0 R >> >> \
                     /Contents {c} 0 R >>",
                    img = image_obj(i),
                    c = content_obj(i)
                ),
            )
            .as_bytes(),
        );

        offsets.push(out.len());
        out.extend_from_slice(
            obj(
                content_obj(i) as u32,
                &format!(
                    "<< /Length {} >>\nstream\n{content}\nendstream",
                    content.len()
                ),
            )
            .as_bytes(),
        );

        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", image_obj(i)).as_bytes());
        let image_body = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} \
             /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode \
             /Length {} >>\nstream\n",
            page.bitmap.width(),
            page.bitmap.height(),
            image.len()
        );
        out.extend_from_slice(image_body.as_bytes());
        out.extend_from_slice(&image);
        out.extend_from_slice(b"\nendstream\nendobj\n");
    }

    // Object 0 plus the catalog, the pages tree and three objects per page.
    let size = 3 * n + 3;
    let xref_at = out.len();
    out.extend_from_slice(format!("xref\n0 {size}\n").as_bytes());
    out.extend_from_slice(b"00000000000 65535 f \n");
    for at in &offsets {
        out.extend_from_slice(format!("{at:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n")
            .as_bytes(),
    );

    out
}

/// Millimetres to PDF points (1 pt = 1/72 in), to two decimals.
fn mm_to_pt(mm: f32) -> String {
    format!("{:.2}", mm as f64 * 72.0 / 25.4)
}

/// Raw (unframed) Flate, what PDF `/FlateDecode` expects.
fn flate(bytes: &[u8]) -> Vec<u8> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(bytes).expect("flate encode");
    enc.finish().expect("flate encode")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::draw::Renderer;
    use flate2::read::DeflateDecoder;
    use std::io::Read;

    /// The PDF carries binary image streams, so structural checks work on
    /// bytes, not text.
    fn has(pdf: &[u8], needle: &str) {
        let n = needle.as_bytes();
        assert!(
            pdf.windows(n.len()).any(|w| w == n),
            "missing {needle:?} in the pdf"
        );
    }

    /// `find`/`rfind` for byte slices: a windows scan in each direction.
    fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }
    fn rfind_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).rposition(|w| w == needle)
    }

    /// Every xref offset points at its own `N 0 obj`: the cross-reference
    /// table is honest.
    fn assert_xref_is_honest(pdf: &[u8]) {
        let trailer = pdf
            .windows(8)
            .position(|w| w == b"trailer\n")
            .expect("trailer");
        let head = &pdf[..trailer];
        // The last `xref` before the trailer: image streams may contain
        // the bytes by chance, but never after the section itself.
        let xref_at = rfind_bytes(head, b"xref\n").expect("xref section");
        let rest = &head[xref_at + b"xref\n".len()..];
        let mut lines = rest.split(|&b| b == b'\n');
        assert_eq!(
            lines.next().unwrap(),
            &b"0 6"[..],
            "single page: five objects"
        );
        for (idx, entry) in lines.take(6).enumerate() {
            if idx == 0 {
                assert_eq!(entry, &b"00000000000 65535 f "[..]);
                continue;
            }
            let num = idx as u32;
            let at: usize = std::str::from_utf8(&entry[..10]).unwrap().parse().unwrap();
            assert!(
                pdf[at..].starts_with(format!("{num} 0 obj").as_bytes()),
                "xref {num} points at the wrong object"
            );
        }
    }

    /// The page's image stream, inflated, is the packed bitmap.
    fn image_bytes(pdf: &[u8]) -> Vec<u8> {
        let at = find_bytes(pdf, b"/Filter /FlateDecode").expect("image xobject");
        let stream = find_bytes(&pdf[at..], b"stream\n").unwrap() + at + b"stream\n".len();
        let end = find_bytes(&pdf[stream..], b"\nendstream").unwrap() + stream;
        let mut dec = DeflateDecoder::new(&pdf[stream..end]);
        let mut out = Vec::new();
        dec.read_to_end(&mut out).unwrap();
        out
    }

    fn blank_page(w_mm: f32, h_mm: f32) -> RasterPage {
        RasterPage::new(Bitmap::new(200, 100), w_mm, h_mm)
    }

    /// A single blank page: the skeleton is a valid PDF, the page size is
    /// the physical size in points, and the image is the packed dots.
    #[test]
    fn a_single_blank_page_is_a_valid_pdf() {
        let pdf = render_pdf(&[blank_page(50.0, 25.0)]);
        assert!(pdf.starts_with(b"%PDF-1.4\n"));
        has(&pdf, "/Type /Catalog");
        has(&pdf, "/Count 1");
        // 50 mm = 141.73 pt, 25 mm = 70.87 pt
        has(&pdf, "[0 0 141.73 70.87]");
        assert!(pdf.ends_with(b"%%EOF\n"));
        assert_xref_is_honest(&pdf);
        assert_eq!(image_bytes(&pdf), Bitmap::new(200, 100).to_bytes());
    }

    /// Two pages keep their order and their inks: the Kids list is the
    /// page objects in order, and each image inflates back to its page's
    /// dots.
    #[test]
    fn a_multi_page_document_keeps_its_pages_in_order() {
        let mut one = Renderer::new(203, 200, 100);
        one.draw_line(10.0, 10.0, 50.0, 0.25, false);
        let mut two = Renderer::new(203, 200, 100);
        two.draw_rect(10.0, 10.0, 20.0, 10.0, 0.25, true);
        let pages = vec![
            RasterPage::new(one.into_page(), 100.0, 50.0),
            RasterPage::new(two.into_page(), 100.0, 50.0),
        ];
        let pdf = render_pdf(&pages);
        has(&pdf, "/Count 2");
        has(&pdf, "/Kids [3 0 R 6 0 R]");
        has(&pdf, "/Width 200");

        // both images: inflate each stream in document order
        let mut pos = 0usize;
        for page in &pages {
            let at = find_bytes(&pdf[pos..], b"/Filter /FlateDecode").unwrap() + pos;
            let stream = find_bytes(&pdf[at..], b"stream\n").unwrap() + at + b"stream\n".len();
            let end = find_bytes(&pdf[stream..], b"\nendstream").unwrap() + stream;
            let mut dec = DeflateDecoder::new(&pdf[stream..end]);
            let mut out = Vec::new();
            dec.read_to_end(&mut out).unwrap();
            assert_eq!(out, page.bitmap.to_bytes());
            pos = end;
        }
    }

    /// The content stream stretches the image to the physical page size.
    #[test]
    fn the_content_stream_stretches_the_image_to_the_page_size() {
        let pdf = render_pdf(&[blank_page(100.0, 50.0)]);
        // 100 mm = 283.46 pt, 50 mm = 141.73 pt
        has(&pdf, "q 283.46 0 0 141.73 cm /Im0 Do Q");
    }
}
