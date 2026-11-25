//! ESC/POS raster wrapper: a byte-for-byte port of the old app's
//! `escpos.rs` defaults (the per-printer band-height tuning had no
//! profile field in the new schema, so the default 256-row bands are
//! what every profile gets).
//!
//! One job: `ESC @`, then per page — the raster as a run of `GS v 0`
//! bands (at most [`RASTER_BAND_ROWS`] rows each; short bands print
//! back to back as one image), a 3-line feed and a full cut. A
//! single-page job is the old app's `build_receipt` byte for byte.

use pn_render::{barcode_module_count, dots_for_mm, qr_module_side, Bitmap, RasterPage};
use pn_scene::{Align, BarcodeKind, ExpandedJob, Placed, PlacedKind};

use crate::NativeCtx;

/// Most rows one `GS v 0` command carries.
///
/// A whole page as one command is a bad bet on receipt printers: the
/// spec caps the height (Epson documents 2303 rows) and cheap
/// Bluetooth heads have a small receive buffer, so an oversized command
/// is dropped or ignored and nothing prints.
pub const RASTER_BAND_ROWS: usize = 256;

/// The image without its all-white bottom rows (at least one row is
/// kept). A receipt is printed on a continuous roll, so blank rows at
/// the end are only wasted paper and transfer time: a test page laid
/// out on an A4-tall canvas would otherwise send ~30 cm of nothing.
fn trim_trailing_blank_rows(dots: &[u8], width: u32, height: u32) -> Vec<u8> {
    let wb = Bitmap::bytes_per_row(width) as usize;
    let last_ink_row = dots.chunks(wb).rposition(|row| row.iter().any(|&b| b != 0));
    let keep = last_ink_row.map_or(1, |r| r + 1).min(height as usize);
    dots[..keep * wb].to_vec()
}

/// All the pages as one ESC/POS job.
pub(crate) fn raster(pages: &[RasterPage]) -> Vec<u8> {
    let mut out = vec![0x1B, 0x40]; // init
    for page in pages {
        let width = page.bitmap.width();
        let wb = Bitmap::bytes_per_row(width) as usize;
        let dots = trim_trailing_blank_rows(page.bitmap.to_bytes(), width, page.bitmap.height());
        for band in dots.chunks(wb * RASTER_BAND_ROWS) {
            let rows = band.len() / wb;
            out.extend_from_slice(&[
                0x1D,
                0x76,
                0x30,
                0x00, // GS v 0, mode: normal
                (wb & 0xFF) as u8,
                ((wb >> 8) & 0xFF) as u8,
                (rows & 0xFF) as u8,
                ((rows >> 8) & 0xFF) as u8,
            ]);
            out.extend_from_slice(band);
        }
        out.extend_from_slice(&[0x1B, 0x64, 0x03]); // feed 3 lines
        out.extend_from_slice(&[0x1D, 0x56, 0x00]); // full cut
    }
    out
}

/// All the pages as one ESC/POS job in the printer's own language:
/// text in the built-in fonts, a printer-generated `GS k` barcode and
/// a `GS ( k` QR — no raster at all.
///
/// ESC/POS prints top to bottom in one column, so the elements of each
/// page are emitted in their layout order (top to bottom, left to
/// right) and their horizontal position is carried by alignment rather
/// than by x — the shared check already refused overlapping y-ranges
/// and placed shapes.
pub(crate) fn native(job: &ExpandedJob, ctx: &NativeCtx) -> Vec<u8> {
    let mut out = vec![0x1B, 0x40]; // init
    for output in &job.outputs {
        for page in &output.pages {
            // Layout order: top to bottom, left to right.
            let mut els: Vec<&Placed> = page.elements.iter().collect();
            els.sort_by(|a, b| {
                a.y_mm
                    .partial_cmp(&b.y_mm)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| {
                        a.x_mm
                            .partial_cmp(&b.x_mm)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            });
            for el in els {
                emit(el, ctx, &mut out);
            }
            out.extend_from_slice(&[0x1B, 0x64, 0x03]); // feed 3 lines
            out.extend_from_slice(&[0x1D, 0x56, 0x00]); // full cut
        }
    }
    out
}

/// The `GS k` code type for a symbology (the Epson letters).
///
/// The old app's raw console tested `0x4E` for Code 128 on its
/// hardware; the letter form is the standard `ESC/POS` spec and no
/// shipped profile lists ESC/POS native barcodes yet, so the choice
/// costs nothing today — phase 10 reconciles it per printer on real
/// hardware through the raw console.
fn gs_k_code(kind: &BarcodeKind) -> u8 {
    match kind {
        BarcodeKind::Upca => b'A',  // UPC-A
        BarcodeKind::Ean13 => b'C', // EAN-13
        BarcodeKind::Code39 => b'E',
        BarcodeKind::Code93 => b'F',
        BarcodeKind::Code128 => b'G',
        BarcodeKind::Itf => b'H',
    }
}

/// One line of the stream for a placed element.
fn emit(el: &Placed, ctx: &NativeCtx, out: &mut Vec<u8>) {
    match &el.kind {
        PlacedKind::Text { content, style, .. } => {
            if content.trim().is_empty() {
                return;
            }
            out.extend_from_slice(&[0x1B, 0x61, align_byte(style.align)]);
            let mut n: u8 = 0;
            if style.bold {
                n |= 0x80;
            }
            // The built-in font is 3 mm tall; anything larger doubles
            // (the spec's double-width + double-height).
            if style.size_mm > 2.5 {
                n |= 0x03;
            }
            out.extend_from_slice(&[0x1B, 0x21, n]);
            // ASCII: the shared check refused non-ASCII text.
            out.extend_from_slice(content.as_bytes());
            out.push(0x0A);
        }
        PlacedKind::Barcode {
            h_mm,
            kind,
            value,
            show_text,
            ..
        } => {
            // The shared check passed, so the value encodes; the guard
            // only keeps this function total.
            if barcode_module_count(kind, value).is_none() {
                return;
            }
            let h = dots_for_mm(*h_mm, ctx.dpi).max(1);
            let pn = if *show_text { 1 } else { 0 };
            out.extend_from_slice(&[
                0x1D,
                0x6B,
                gs_k_code(kind),
                pn,
                (h & 0xFF) as u8,
                ((h >> 8) & 0xFF) as u8,
                value.len() as u8,
            ]);
            out.extend_from_slice(value.as_bytes());
            out.push(0x00);
        }
        PlacedKind::Qr { value, .. } => {
            let Some(_side) = qr_module_side(value) else {
                return;
            };
            // The `GS ( k` model-2 sequence the raw console tested on
            // real hardware, byte for byte: store the payload as the
            // string "P", error correction M, magnification 3, then
            // print "Q20" (the model the string belongs to).
            out.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
            out.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x03]);
            out.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x33]);
            let payload = format!("P{value}");
            out.extend_from_slice(&[0x1D, 0x28, 0x6B, payload.len() as u8, 0x00, 0x31, 0x50]);
            out.extend_from_slice(payload.as_bytes());
            out.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30, 0x32, 0x30]);
        }
        // Lines, rects and images: refused by the shared check (ESC/POS
        // cannot place a shape at a point), nothing to emit.
        PlacedKind::Line { .. } | PlacedKind::Rect { .. } | PlacedKind::Image { .. } => {}
    }
}

/// `ESC a` — 0 left, 1 center, 2 right.
fn align_byte(align: Align) -> u8 {
    match align {
        Align::Left => 0,
        Align::Center => 1,
        Align::Right => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pn_render::Renderer;

    /// The trailing feed and cut after every page.
    const TAIL: &[u8] = &[0x1B, 0x64, 0x03, 0x1D, 0x56, 0x00];

    fn page(w: u32, h: u32) -> RasterPage {
        RasterPage::new(Bitmap::new(w, h), 0.0, 0.0)
    }

    /// Walk the stream and return (the row counts of every `GS v 0`
    /// band, the bytes left after the last band).
    fn bands(bytes: &[u8], width_bytes: usize) -> (Vec<usize>, &[u8]) {
        let mut rows = Vec::new();
        let mut i = 2; // skip the init
        while i + 8 <= bytes.len() && bytes[i..i + 4] == [0x1D, 0x76, 0x30, 0x00] {
            let wb = bytes[i + 4] as usize | (bytes[i + 5] as usize) << 8;
            assert_eq!(wb, width_bytes, "band width must be the page width");
            let rows_n = bytes[i + 6] as usize | (bytes[i + 7] as usize) << 8;
            rows.push(rows_n);
            i += 8 + rows_n * width_bytes;
        }
        (rows, &bytes[i..])
    }

    #[test]
    fn a_tall_page_is_split_into_bands_that_cover_every_row() {
        // Ink in every row: nothing to trim, all 2374 rows must go out
        // in bands of at most RASTER_BAND_ROWS rows.
        let mut b = Bitmap::new(384, 2374);
        for y in 0..2374 {
            b.set(0, y, true);
        }
        let out = raster(&[RasterPage::new(b, 0.0, 0.0)]);
        let (rows, tail) = bands(&out, 48);
        assert!(rows.iter().all(|&r| r <= RASTER_BAND_ROWS));
        assert_eq!(rows.iter().sum::<usize>(), 2374);
        assert_eq!(tail, TAIL);
    }

    #[test]
    fn a_short_page_stays_one_command() {
        // Ink in both rows, so the trim keeps the whole 2-row image in
        // a single `GS v 0`.
        let mut b = Bitmap::new(16, 2);
        b.set(0, 1, true);
        let out = raster(&[RasterPage::new(b, 0.0, 0.0)]);
        let (rows, tail) = bands(&out, 2);
        assert_eq!(rows, vec![2]);
        assert_eq!(tail, TAIL);
    }

    #[test]
    fn the_tiny_known_page_is_exactly_the_old_apps_bytes() {
        // 16 x 2 dots with only the top-left set: the blank second row
        // is trimmed (the old app did the same), so the job is the old
        // app's build_receipt for this image — no drawer.
        let mut b = Bitmap::new(16, 2);
        b.set(0, 0, true);
        let out = raster(&[RasterPage::new(b, 0.0, 0.0)]);
        assert_eq!(
            out,
            vec![
                0x1B, 0x40, // init
                0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x01, 0x00, // GS v 0, one row
                0x80, 0x00, // the dots
                0x1B, 0x64, 0x03, // feed 3
                0x1D, 0x56, 0x00, // full cut
            ]
        );
    }

    #[test]
    fn a_blank_tail_is_trimmed_but_at_least_one_row_remains() {
        // Ink only near the top of a 384 x 400 canvas (20 mm at 203 dpi
        // is row ~157), so the ~240 blank rows below are trimmed away.
        let mut r = Renderer::new(203, 384, 400);
        r.draw_line(0.0, 20.0, 50.0, 0.5, false);
        let out = raster(&[RasterPage::new(r.into_page(), 58.0, 50.0)]);
        let (rows, tail) = bands(&out, 48);
        assert!(rows.iter().sum::<usize>() < 400);
        assert!(rows.iter().sum::<usize>() > 150);
        assert_eq!(tail, TAIL);

        // A fully blank page keeps one row rather than sending nothing.
        let out = raster(&[page(16, 50)]);
        let (rows, tail) = bands(&out, 2);
        assert_eq!(rows, vec![1]);
        assert_eq!(tail, TAIL);
    }

    #[test]
    fn a_batch_prints_every_page_in_order_with_its_own_cut() {
        let mut one = Renderer::new(203, 384, 80);
        one.draw_line(0.0, 10.0, 50.0, 0.5, false);
        let mut two = Renderer::new(203, 384, 80);
        two.draw_line(0.0, 70.0, 50.0, 0.5, false);
        let out = raster(&[
            RasterPage::new(one.into_page(), 58.0, 10.0),
            RasterPage::new(two.into_page(), 58.0, 10.0),
        ]);
        // Exactly one init, two feeds, two cuts.
        assert_eq!(out.windows(2).filter(|w| w == &[0x1B, 0x40]).count(), 1);
        assert_eq!(
            out.windows(3).filter(|w| w == &[0x1B, 0x64, 0x03]).count(),
            2
        );
        assert_eq!(
            out.windows(3).filter(|w| w == &[0x1D, 0x56, 0x00]).count(),
            2
        );
    }

    // ── native ──────────────────────────────────────────────────────

    use pn_profiles::Profile;
    use pn_render::fit_to_head;
    use pn_scene::{
        expand, At, Element, Format, Media as SceneMedia, Placement, Records, Size, Template,
        TextStyle,
    };

    /// A receipt printer that lists a built-in font and the Code 128
    /// generator — the shapes the native path covers on ESC/POS.
    fn receipt_printer() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "Test Receipt Printer"
language = "escpos"
dpi = 180
head_width_dots = 384
media = ["continuous"]
[fonts]
native = ["default"]
[barcodes]
native = ["CODE128"]
"#,
        )
        .expect("test profile is valid")
    }

    fn ctx_for(profile: &Profile, w_mm: f32, h_mm: f32) -> NativeCtx<'_> {
        NativeCtx {
            lang: profile.profile.language,
            profile,
            dpi: 180,
            page_w_dots: fit_to_head(dots_for_mm(w_mm, 180), profile.profile.head_width_dots),
            page_h_dots: dots_for_mm(h_mm, 180),
            page_w_mm: w_mm,
            page_h_mm: h_mm,
        }
    }

    /// A 58 × 40 mm cut: two lines of text and a Code 128 — rows that
    /// do not overlap, the layout a one-column stream can keep.
    fn native_receipt() -> (Profile, ExpandedJob) {
        let profile = receipt_printer();
        let template = Template {
            format: Format::Scene,
            html: None,
            media: SceneMedia::Roll {
                width_mm: 58.0,
                label_height_mm: 40.0,
            },
            fields: vec![],
            elements: vec![
                Element::Text {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 5.0,
                    },
                    size: Size {
                        w_mm: 40.0,
                        h_mm: 6.0,
                    },
                    content: "TEST".into(),
                    style: TextStyle {
                        size_mm: 3.0,
                        font: None,
                        bold: false,
                        italic: false,
                        align: Align::Left,
                    },
                    page: Placement::Every,
                },
                Element::Text {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 15.0,
                    },
                    size: Size {
                        w_mm: 40.0,
                        h_mm: 6.0,
                    },
                    content: "LINE 2".into(),
                    style: TextStyle {
                        size_mm: 3.0,
                        font: None,
                        bold: false,
                        italic: false,
                        align: Align::Right,
                    },
                    page: Placement::Every,
                },
                Element::Barcode {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 25.0,
                    },
                    size: Size {
                        w_mm: 40.0,
                        h_mm: 8.0,
                    },
                    kind: BarcodeKind::Code128,
                    value: "1234567890".into(),
                    show_text: false,
                    page: Placement::Every,
                },
            ],
            fonts: vec![],
        };
        let records = Records::from_json("[{}]").unwrap();
        (profile, expand(&template, &records).unwrap())
    }

    /// The native receipt is the printer's own commands — `ESC a`
    /// alignment, `ESC !` size, a `GS k` barcode — and no `GS v 0`
    /// raster band.
    #[test]
    fn a_native_receipt_is_fonts_and_barcode_not_a_raster() {
        let (profile, job) = native_receipt();
        let out = native(&job, &ctx_for(&profile, 58.0, 40.0));
        assert!(out.starts_with(&[0x1B, 0x40]), "the stream inits");
        assert!(
            out.windows(3).any(|w| w == [0x1B, 0x61, 0]),
            "left alignment is set (ESC a 0)"
        );
        assert!(
            out.windows(3).any(|w| w == [0x1B, 0x61, 2]),
            "right alignment is set (ESC a 2)"
        );
        assert!(
            out.windows(3).any(|w| w == [0x1B, 0x21, 0x03]),
            "the size doubles (ESC ! 3)"
        );
        assert!(
            out.windows(8)
                .any(|w| w == [0x1D, 0x6B, b'G', 0, 57, 0, 10, b'1']),
            "the Code 128 is printer-generated (GS k G)"
        );
        assert!(
            !out.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]),
            "native output has no raster band"
        );
        assert!(out.ends_with(TAIL), "the page ends with feed and cut");
    }

    /// The native receipt's exact bytes are pinned, the way the
    /// raster's are.
    #[test]
    fn the_native_receipt_matches_the_pinned_golden_bytes() {
        let (profile, job) = native_receipt();
        let out = native(&job, &ctx_for(&profile, 58.0, 40.0));
        golden_harness::assert_matches_golden("encoders/escpos-native.bin", &out);
    }
}
