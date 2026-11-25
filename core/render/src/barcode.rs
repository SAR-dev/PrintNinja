//! Linear barcodes and QR codes: the module patterns of the `barcoders`
//! and `qrcode` crates, stamped straight into the page as 1-bit dots.
//!
//! The encoders are the old app's print-renderer encoders (REFACTORING
//! decision #13: preview and print must agree on what a symbol is).
//! A value a symbology cannot encode — a check digit that does not
//! match, an odd ITF length, non-ASCII Code 128 — draws nothing, the
//! same as an empty value: an unprintable field must not fail the job.

use barcoders::sym::{code128::Code128, code39::Code39, code93::Code93, ean13::EAN13, tf::TF};
use pn_scene::{Align, BarcodeKind, TextStyle};
use qrcode::{Color, EcLevel, QrCode};

use crate::draw::Renderer;
use crate::geometry::dots_for_mm;

/// Quiet zone on each side of a linear barcode, in modules.
pub const QUIET_MODULES: usize = 10;
/// Quiet zone around a QR code, in modules (the spec asks for 4).
pub const QR_QUIET_MODULES: usize = 4;

impl Renderer {
    /// A 1-D barcode in a box at `(x_mm, y_mm)` of `w_mm` × `h_mm`.
    /// The bars span the box width (quiet zone included) and its height,
    /// or all but the bottom text band when `show_text`; the value is
    /// drawn centered in that band. Nothing is drawn when the value is
    /// empty or the symbology cannot encode it.
    #[allow(clippy::too_many_arguments)] // mirrors PlacedKind::Barcode
    pub fn draw_barcode(
        &mut self,
        x_mm: f32,
        y_mm: f32,
        w_mm: f32,
        h_mm: f32,
        kind: &BarcodeKind,
        value: &str,
        show_text: bool,
    ) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        let Some(modules) = barcode_modules(kind, value) else {
            return;
        };
        let box_w = dots_for_mm(w_mm, self.dpi) as i64;
        let box_h = dots_for_mm(h_mm, self.dpi) as i64;
        if box_w <= 0 || box_h <= 0 {
            return;
        }
        let (bar_h_mm, text_mm) = if show_text {
            let text_mm = (0.3 * h_mm).min(2.5);
            (h_mm - text_mm, text_mm)
        } else {
            (h_mm, 0.0)
        };

        // One module may be a fraction of a dot; round each edge so a
        // dark run never loses a dot to rounding.
        let total = (modules.len() + 2 * QUIET_MODULES) as f64;
        let mod_w = box_w as f64 / total;
        let bar_x = crate::geometry::signed_dots(x_mm, self.dpi);
        let bar_y = crate::geometry::signed_dots(y_mm, self.dpi);
        let bar_h = (bar_h_mm as f64 * self.dpi as f64 / 25.4).round() as i64;
        let mut i = 0;
        while i < modules.len() {
            if modules[i] == 1 {
                let start = i;
                while i < modules.len() && modules[i] == 1 {
                    i += 1;
                }
                let x0 = bar_x + ((start + QUIET_MODULES) as f64 * mod_w).round() as i64;
                let x1 = bar_x + ((i + QUIET_MODULES) as f64 * mod_w).round() as i64;
                self.fill(x0, bar_y, x1, bar_y + bar_h);
            } else {
                i += 1;
            }
        }

        if text_mm > 0.0 {
            let style = TextStyle {
                size_mm: (0.2 * h_mm).clamp(1.2, 2.5),
                font: None,
                bold: false,
                italic: false,
                align: Align::Center,
            };
            self.draw_text(x_mm, y_mm + bar_h_mm, w_mm, text_mm, value, &style);
        }
    }

    /// A QR code, `h_mm` square at `(x_mm, y_mm)` — error correction M,
    /// quiet zone included. Nothing is drawn when the value is empty or
    /// too long for the smallest code.
    pub fn draw_qr(&mut self, x_mm: f32, y_mm: f32, h_mm: f32, value: &str) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        let Some(m) = qr_matrix(value) else {
            return;
        };
        let box_dots = dots_for_mm(h_mm, self.dpi) as i64;
        if box_dots <= 0 {
            return;
        }
        let side = m.side as i64;
        let total = (side + 2 * QR_QUIET_MODULES as i64) as f64;
        let cell = box_dots as f64 / total;
        let x0 = crate::geometry::signed_dots(x_mm, self.dpi);
        let y0 = crate::geometry::signed_dots(y_mm, self.dpi);
        for y in 0..side {
            for x in 0..side {
                if m.modules[(y as usize) * (side as usize) + x as usize] == 0 {
                    continue;
                }
                let cx = x + QR_QUIET_MODULES as i64;
                let cy = y + QR_QUIET_MODULES as i64;
                let x = x0 + (cx as f64 * cell).round() as i64;
                let y = y0 + (cy as f64 * cell).round() as i64;
                let x1 = x0 + ((cx + 1) as f64 * cell).round() as i64;
                let y1 = y0 + ((cy + 1) as f64 * cell).round() as i64;
                self.fill(x, y, x1, y1);
            }
        }
    }
}

/// The module width of a linear symbol at the renderer's quiet zones:
/// the pattern's dark/light runs plus 10 quiet modules on each side.
/// `None` when the value is empty or the symbology cannot carry it —
/// the same rules the raster renderer applies, so the native encoders'
/// sizing agrees with the preview.
pub fn barcode_module_count(kind: &BarcodeKind, value: &str) -> Option<usize> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    barcode_modules(kind, value).map(|m| m.len() + 2 * QUIET_MODULES)
}

/// A QR code's matrix at error correction M: its side in modules and
/// the dark/light cells, row-major (`1` dark, `0` light), quiet zone
/// excluded. `None` when the value is empty or too long for the
/// largest code.
#[derive(Debug, PartialEq)]
pub struct QrMatrix {
    pub side: usize,
    pub modules: Vec<u8>,
}

/// The side of a QR matrix in modules, at error correction M (the
/// renderer's level), quiet zone excluded. `None` when the value is
/// empty or too long for the largest code.
pub fn qr_module_side(value: &str) -> Option<usize> {
    qr_matrix(value).map(|m| m.side)
}

/// The QR matrix a value draws at, at the renderer's error correction
/// level (M). `draw_qr` draws from this, so the editor's canvas and
/// the print cannot disagree.
pub fn qr_matrix(value: &str) -> Option<QrMatrix> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let code = QrCode::with_error_correction_level(value.as_bytes(), EcLevel::M).ok()?;
    let side = code.width();
    let modules = code
        .to_colors()
        .into_iter()
        .map(|c| (c == Color::Dark) as u8)
        .collect();
    Some(QrMatrix { side, modules })
}

/// Encode `value` as the dark/light module pattern of a linear
/// symbology: `1` dark, `0` light, quiet zone excluded. `None` when the
/// symbology cannot carry the value. `draw_barcode` draws from this, so
/// the editor's canvas and the print cannot disagree.
pub fn barcode_modules(kind: &BarcodeKind, value: &str) -> Option<Vec<u8>> {
    let all_digits = value.chars().all(|c| c.is_ascii_digit());
    match kind {
        // Code 128 needs a character-set prefix; Ɓ selects set B
        // (ASCII 32–127).
        BarcodeKind::Code128 => {
            if !value.is_ascii() {
                return None;
            }
            Code128::new(format!("\u{0181}{value}"))
                .ok()
                .map(|b| b.encode())
        }
        BarcodeKind::Code39 => Code39::new(value.to_uppercase()).ok().map(|b| b.encode()),
        BarcodeKind::Code93 => Code93::new(value.to_uppercase()).ok().map(|b| b.encode()),
        // The encoders accept a missing check digit and add it; templates
        // must supply the full number, as the scene's validation requires.
        BarcodeKind::Ean13 if all_digits && value.len() == 13 => {
            EAN13::new(value).ok().map(|b| b.encode())
        }
        // UPC-A is EAN-13 with a leading zero.
        BarcodeKind::Upca if all_digits && value.len() == 12 => {
            EAN13::new(format!("0{value}")).ok().map(|b| b.encode())
        }
        BarcodeKind::Itf if all_digits && value.len().is_multiple_of(2) => {
            TF::interleaved(value).ok().map(|b| b.encode())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bitmap::Bitmap;
    use crate::draw::Renderer;
    use rxing::{
        common::GlobalHistogramBinarizer, BinaryBitmap, MultiFormatReader, RGBLuminanceSource,
        Reader,
    };

    fn parse_kind(s: &str) -> BarcodeKind {
        match s {
            "code128" => BarcodeKind::Code128,
            "code39" => BarcodeKind::Code39,
            "code93" => BarcodeKind::Code93,
            "ean13" => BarcodeKind::Ean13,
            "upca" => BarcodeKind::Upca,
            "itf" => BarcodeKind::Itf,
            other => panic!("no such kind: {other}"),
        }
    }

    /// The page's dots as ARGB pixels upscaled `K` times: what a scanner
    /// would see.
    fn page_pixels(p: &Bitmap, k: u32) -> Vec<u32> {
        let (w, h) = (p.width() * k, p.height() * k);
        let mut out = vec![0xFFFF_FFFFu32; (w * h) as usize];
        for y in 0..p.height() {
            for x in 0..p.width() {
                if p.get(x, y) {
                    for ky in 0..k {
                        for kx in 0..k {
                            out[((y * k + ky) as usize) * w as usize + (x * k + kx) as usize] =
                                0xFF_00_00_00;
                        }
                    }
                }
            }
        }
        out
    }

    /// Decode a rendered page with a multi-format reader: the round-trip
    /// proof that what the renderer draws is a scannable symbol.
    fn decode(p: &Bitmap) -> String {
        let pixels = page_pixels(p, 8);
        let w = (p.width() * 8) as usize;
        let h = (p.height() * 8) as usize;
        let source = RGBLuminanceSource::new_with_width_height_pixels(w, h, &pixels)
            .unwrap_or_else(|e| panic!("rasterize the page: {e}"));
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        MultiFormatReader::default()
            .decode(&mut bitmap)
            .unwrap_or_else(|e| panic!("decode the page: {e}"))
            .getText()
            .to_string()
    }

    /// The expected scanner payload for a rendered barcode box.
    fn render_barcode(kind: &str, value: &str, show_text: bool) -> Bitmap {
        let mut r = Renderer::new(203, dots_for_mm(60.0, 203), dots_for_mm(20.0, 203));
        r.draw_barcode(2.0, 2.0, 50.0, 10.0, &parse_kind(kind), value, show_text);
        r.into_page()
    }

    /// Every shipped symbology renders a scannable symbol that decodes
    /// back to the value.
    #[test]
    fn every_symbology_round_trips_through_a_scanner() {
        for (kind, value) in [
            ("code128", "HELLO123"),
            ("code39", "HELLO-123"),
            ("code93", "HELLO123"),
            ("ean13", "5901234123457"),
            ("upca", "036000291452"),
            ("itf", "1234567890"),
        ] {
            let page = render_barcode(kind, value, false);
            assert_eq!(decode(&page), value, "{kind} ({value})");
        }
    }

    /// A QR code renders a scannable code that decodes back to the value.
    #[test]
    fn a_qr_code_round_trips_through_a_scanner() {
        let mut r = Renderer::new(203, dots_for_mm(30.0, 203), dots_for_mm(30.0, 203));
        r.draw_qr(2.0, 2.0, 20.0, "https://example.com/o/1042");
        assert_eq!(decode(&r.into_page()), "https://example.com/o/1042");
    }

    /// An empty or unencodable value draws nothing rather than failing
    /// the job.
    #[test]
    fn empty_or_unencodable_values_draw_nothing() {
        let blank = || Renderer::new(203, 200, 100);
        let mut r = blank();
        r.draw_barcode(2.0, 2.0, 50.0, 10.0, &BarcodeKind::Code128, "   ", false);
        assert_eq!(r.page().to_bytes(), &[0; 2500]);
        let mut r = blank();
        r.draw_barcode(
            2.0,
            2.0,
            50.0,
            10.0,
            &BarcodeKind::Ean13,
            "59012341234",
            false,
        );
        assert_eq!(r.page().to_bytes(), &[0; 2500]);
        let mut r = blank();
        r.draw_barcode(
            2.0,
            2.0,
            50.0,
            10.0,
            &BarcodeKind::Code128,
            "プリント",
            false,
        );
        assert_eq!(r.page().to_bytes(), &[0; 2500]);
        let mut r = blank();
        r.draw_qr(2.0, 2.0, 20.0, "  ");
        assert_eq!(r.page().to_bytes(), &[0; 2500]);
    }

    /// The digit symbologies keep the scene's validation: EAN-13 and
    /// UPC-A want their full numbers with a matching check digit, ITF an
    /// even count of digits.
    #[test]
    fn digit_symbologies_validate_length_and_check_digit() {
        let inks = |kind, value| {
            let p = render_barcode(kind, value, false);
            p.to_bytes().iter().any(|&b| b != 0)
        };
        assert!(inks("ean13", "5901234123457"));
        assert!(!inks("ean13", "5901234123458")); // check digit off by one
        assert!(!inks("ean13", "590123412345")); // 12 digits
        assert!(inks("upca", "036000291452"));
        assert!(!inks("upca", "03600029145")); // 11 digits
        assert!(inks("itf", "1234567890"));
        assert!(!inks("itf", "123456789")); // odd count
    }

    /// The module-count helpers agree with the renderer's rules: a
    /// scannable value counts pattern plus 20 quiet modules, and an
    /// empty or unencodable value is `None` — the same value the
    /// native encoders will skip rather than emit.
    #[test]
    fn the_module_helpers_match_the_renderers_rules() {
        assert!(barcode_module_count(&BarcodeKind::Code128, "HELLO123").is_some());
        assert!(barcode_module_count(&BarcodeKind::Ean13, "5901234123457").is_some());
        assert!(barcode_module_count(&BarcodeKind::Code128, "").is_none());
        assert!(barcode_module_count(&BarcodeKind::Code128, "   ").is_none());
        assert!(barcode_module_count(&BarcodeKind::Ean13, "59012341234").is_none());
        assert!(barcode_module_count(&BarcodeKind::Code128, "プリント").is_none());
        // The count is pattern plus the two quiet zones.
        let count = barcode_module_count(&BarcodeKind::Code128, "HELLO123").unwrap();
        let pattern = barcode_modules(&BarcodeKind::Code128, "HELLO123").unwrap();
        assert_eq!(count, pattern.len() + 2 * QUIET_MODULES);

        assert_eq!(qr_module_side(""), None);
        assert_eq!(qr_module_side("  "), None);
        // The same level the renderer draws at (M).
        let side = qr_module_side("https://example.com/o/1042").unwrap();
        let code =
            QrCode::with_error_correction_level(b"https://example.com/o/1042", EcLevel::M).unwrap();
        assert_eq!(side, code.width());
    }

    /// The known values give the module counts the symbologies define:
    /// Code 128 is 11 modules per character plus a 13-module stop,
    /// EAN-13 a fixed 95.
    #[test]
    fn known_values_give_their_module_counts() {
        // Start B + 8 data + check, each 11 modules, plus the 13 stop.
        assert_eq!(
            barcode_modules(&BarcodeKind::Code128, "HELLO123")
                .unwrap()
                .len(),
            123
        );
        assert_eq!(
            barcode_module_count(&BarcodeKind::Code128, "HELLO123"),
            Some(143)
        );
        assert_eq!(
            barcode_modules(&BarcodeKind::Ean13, "5901234123457")
                .unwrap()
                .len(),
            95
        );
        // The same rules as the renderer: unencodable is `None`.
        assert_eq!(barcode_modules(&BarcodeKind::Ean13, "5901234123458"), None);
        assert_eq!(barcode_modules(&BarcodeKind::Itf, "12345"), None);
        assert_eq!(barcode_modules(&BarcodeKind::Code128, "プリント"), None);
    }

    /// A short value is a version-one QR: a 21-module side whose
    /// corners carry the finder pattern the scanner locks onto.
    #[test]
    fn a_short_value_is_a_version_one_qr() {
        let m = qr_matrix("HELLO").unwrap();
        assert_eq!(m.side, 21);
        assert_eq!(m.modules.len(), 21 * 21);
        // Top-left finder: a 7-module ring on a light border.
        assert_eq!(&m.modules[0..8], &[1, 1, 1, 1, 1, 1, 1, 0]);
        assert_eq!(&m.modules[21..29], &[1, 0, 0, 0, 0, 0, 1, 0]);
        // Bottom edge of the same finder, six rows down.
        assert_eq!(&m.modules[6 * 21..6 * 21 + 8], &[1, 1, 1, 1, 1, 1, 1, 0]);
        // Byte-mode data past the largest code (2331 bytes at M) is
        // `None` — an é keeps the value out of the more roomy
        // alphanumeric mode.
        assert_eq!(qr_matrix(&"é".repeat(1200)), None);
    }

    /// `draw_barcode` inks exactly the pattern `barcode_modules` gives:
    /// at a box width where one module is a whole number of dots, the
    /// dark runs cover 2 × (the pattern's dark modules) columns.
    #[test]
    fn draw_barcode_inks_the_pattern_it_is_given() {
        let pattern = barcode_modules(&BarcodeKind::Code128, "HELLO123").unwrap();
        let dark = pattern.iter().filter(|&&b| b == 1).count();
        let total = pattern.len() + 2 * QUIET_MODULES; // 143
                                                       // 286 dots wide: exactly two dots per module, no rounding drift.
        let w_mm = (2 * total) as f32 * 25.4 / 203.0;
        let mut r = Renderer::new(203, 320, 100);
        r.draw_barcode(
            2.0,
            1.0,
            w_mm,
            10.0,
            &BarcodeKind::Code128,
            "HELLO123",
            false,
        );
        let p = r.page();
        let mid = 8 + 40; // into the bar band
        let inked = (0..p.width()).filter(|&x| p.get(x, mid)).count();
        assert_eq!(inked, 2 * dark);
    }

    /// And the same for `draw_qr`: at a whole-dots cell size the ink
    /// covers 2×2 dots per dark module of the matrix.
    #[test]
    fn draw_qr_inks_the_matrix_it_is_given() {
        let m = qr_matrix("HELLO").unwrap();
        let dark = m.modules.iter().filter(|&&b| b == 1).count();
        // 58 dots across 29 modules (21 + 2×4 quiet): two dots a cell.
        let h_mm = (2 * (m.side + 2 * QR_QUIET_MODULES)) as f32 * 25.4 / 203.0;
        let mut r = Renderer::new(203, 80, 80);
        r.draw_qr(2.0, 2.0, h_mm, "HELLO");
        let p = r.page();
        let inked = (0..p.height())
            .flat_map(|y| (0..p.width()).map(move |x| (x, y)))
            .filter(|&(x, y)| p.get(x, y))
            .count();
        assert_eq!(inked, 4 * dark);
    }

    /// The symbol stays inside its box, quiet zone and all.
    #[test]
    fn the_barcode_stays_inside_its_box() {
        let mut r = Renderer::new(203, 400, 100);
        r.draw_barcode(
            10.0,
            5.0,
            50.0,
            10.0,
            &BarcodeKind::Code128,
            "HELLO123",
            true,
        );
        let p = r.page();
        let x0 = crate::geometry::signed_dots(10.0, 203) as u32;
        let x1 = crate::geometry::signed_dots(60.0, 203) as u32;
        let y0 = crate::geometry::signed_dots(5.0, 203) as u32;
        for y in 0..p.height() {
            for x in 0..p.width() {
                if p.get(x, y) {
                    assert!(
                        (x0..=x1).contains(&x) && (y0..=y0 + 80).contains(&y),
                        "ink at ({x}, {y}) escapes the box"
                    );
                }
            }
        }
        // and the box is not empty
        assert!(p.to_bytes().iter().any(|&b| b != 0));
    }
}
