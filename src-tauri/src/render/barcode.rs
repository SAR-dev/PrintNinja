//! Inline-SVG barcodes and QR codes for the `{{barcode}}` / `{{qrcode}}`
//! template helpers.
//!
//! The Designer preview renders with handlebars.js and printing renders here,
//! so both sides must register the same helpers (REFACTORING.md decision #13).
//! The symbology ids are the ones in `src/lib/utils/barcode.ts`
//! (`PRINT_SYMBOLOGIES`); anything else renders nothing rather than failing the
//! whole print job.
//!
//! The SVG is drawn here from the encoder's module pattern instead of using a
//! crate's SVG generator, so the output has no external dependency, scales to
//! a physical width, and escapes the human-readable text.
//!
//! Encoders: `barcoders` and `qrcode` cover most linear symbologies; `rxing`
//! (a ZXing port) supplies Data Matrix, PDF417, Aztec and UPC-E, which no
//! standalone Rust crate covers. ITF-14 is `barcoders`' ITF plus the GTIN-14
//! check and a 2221 bearer bar drawn here.

use barcoders::sym::{
    codabar::Codabar, code128::Code128, code39::Code39, code93::Code93, ean13::EAN13, ean8::EAN8,
    tf::TF,
};
use qrcode::{Color, EcLevel, QrCode};
use rxing::{BarcodeFormat, MultiFormatWriter, Writer};

/// Default printed width of a linear barcode, in millimetres.
pub const DEFAULT_BARCODE_WIDTH_MM: f64 = 40.0;
/// Default printed size of a QR code, in millimetres.
pub const DEFAULT_QR_SIZE_MM: f64 = 25.0;

const MIN_MM: f64 = 5.0;
const MAX_MM: f64 = 200.0;
/// Quiet zone on each side of a linear barcode, in modules.
const QUIET_MODULES: usize = 10;
/// Quiet zone around a QR code, in modules (the spec asks for 4).
const QR_QUIET_MODULES: usize = 4;
/// Quiet zone around a 2D symbol, in modules (the strictest spec minimum is 2).
const MATRIX_QUIET_MODULES: usize = 4;
/// Height of the human-readable text line, in modules.
const TEXT_HEIGHT: f64 = 9.0;
/// Height of an ITF-14 bearer bar, in modules.
const BEARER_MODULES: f64 = 2.0;
/// Gap between an ITF-14 bearer bar and the data, in modules.
const BEARER_GAP_MODULES: f64 = 1.0;

/// The symbology ids a template may pass to `{{barcode}}`.
pub const SYMBOLOGIES: &[&str] = &[
    "code128",
    "code39",
    "code93",
    "ean13",
    "ean8",
    "upca",
    "itf",
    "codabar",
    "upce",
    "itf14",
    "datamatrix",
    "pdf417",
    "aztec",
];

/// Render a barcode as a `<div class="barcode">` holding an inline SVG.
///
/// Returns `None` for an unknown symbology, an empty value, or a value the
/// symbology cannot encode, so the caller can print an empty spot.
pub fn barcode_html(kind: &str, value: &str, width_mm: f64, show_text: bool) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let width_mm = clamp_mm(width_mm);
    let svg = match kind {
        // 2D: rxing's module matrix, cropped, rendered at the writer's scale.
        "datamatrix" | "pdf417" | "aztec" => {
            let matrix = encode_matrix(kind, value)?;
            matrix2d_svg(&matrix, width_mm, value)
        }
        // UPC-E: downsampled to native modules so it shares the linear path.
        "upce" => {
            let modules = upce_modules(value)?;
            linear_svg(&modules, value, width_mm, show_text)
        }
        // ITF-14: GTIN-14 check plus our own 2221 bearer bars.
        "itf14" => {
            let digits = itf14_digits(value)?;
            let modules = TF::interleaved(&digits).ok()?.encode();
            itf14_svg(&modules, &digits, width_mm, show_text)
        }
        _ => {
            let modules = encode_linear(kind, value)?;
            linear_svg(&modules, value, width_mm, show_text)
        }
    };
    Some(wrap(&svg))
}

/// Render a QR code as a `<div class="barcode">` holding an inline SVG.
pub fn qr_html(value: &str, size_mm: f64) -> Option<String> {
    let size = clamp_mm(size_mm);
    let svg = qr_svg_with_size(value, Some(&format!("{size}mm")))?;
    Some(wrap(&svg))
}

/// A QR code as a bare `<svg>` that scales to its container (no fixed
/// width/height): for on-screen use such as the pairing QR in Settings.
pub fn qr_svg(value: &str) -> Option<String> {
    qr_svg_with_size(value, None)
}

fn qr_svg_with_size(value: &str, size: Option<&str>) -> Option<String> {
    if value.trim().is_empty() {
        return None;
    }
    let code = QrCode::with_error_correction_level(value.as_bytes(), EcLevel::M).ok()?;
    let side = code.width();
    let colors = code.to_colors();
    let total = side + 2 * QR_QUIET_MODULES;

    // One rectangle per horizontal run of dark modules keeps the SVG small.
    let mut path = String::new();
    for y in 0..side {
        let mut x = 0;
        while x < side {
            if colors[y * side + x] == Color::Dark {
                let start = x;
                while x < side && colors[y * side + x] == Color::Dark {
                    x += 1;
                }
                path.push_str(&format!(
                    "M{},{}h{}v1h-{}z",
                    start + QR_QUIET_MODULES,
                    y + QR_QUIET_MODULES,
                    x - start,
                    x - start
                ));
            } else {
                x += 1;
            }
        }
    }

    let dims = size
        .map(|s| format!(" width=\"{s}\" height=\"{s}\""))
        .unwrap_or_default();
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {total}\"{dims} \
         shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"QR code\">\
         <rect width=\"{total}\" height=\"{total}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

/// A 2D symbol encoded by rxing, cropped to its dark modules.
struct Matrix {
    rows: Vec<Vec<bool>>,
    /// Quiet zone around the symbol, in the matrix's pixel units.
    quiet: usize,
}

/// Encode `value` with rxing and crop the result to the symbol itself.
///
/// The writer rasterizes at an integer upscale (the GCD of all horizontal
/// runs is that factor, even when the requested size does not divide
/// evenly), so the quiet zone is 4 modules expressed in those units. The
/// rows keep the writer's scale: rxing's own decoder misreads some small
/// native-scale symbols, and the SVG is rasterized at print DPI anyway.
fn encode_matrix(kind: &str, value: &str) -> Option<Matrix> {
    let format = match kind {
        "datamatrix" => BarcodeFormat::DATA_MATRIX,
        "pdf417" => BarcodeFormat::PDF_417,
        "aztec" => BarcodeFormat::AZTEC,
        _ => return None,
    };
    let m = MultiFormatWriter.encode(value, &format, 400, 200).ok()?;
    let [x0, y0, bw, bh] = m.getEnclosingRectangle()?;
    let (x0, y0, bw, bh) = (x0 as usize, y0 as usize, bw as usize, bh as usize);

    let mut g = 0;
    for y in y0..y0 + bh {
        let mut i = x0;
        while i < x0 + bw {
            let dark = m.get(i as u32, y as u32);
            let mut j = i;
            while j < x0 + bw && m.get(j as u32, y as u32) == dark {
                j += 1;
            }
            g = gcd(g, j - i);
            i = j;
        }
    }

    let rows = (y0..y0 + bh)
        .map(|y| (x0..x0 + bw).map(|x| m.get(x as u32, y as u32)).collect())
        .collect();
    Some(Matrix {
        rows,
        quiet: MATRIX_QUIET_MODULES * g,
    })
}

/// A 2D symbol as an inline SVG whose height follows its aspect ratio.
///
/// No human-readable text: the JS preview (bwip-js) does not draw one for
/// 2D symbologies either.
fn matrix2d_svg(m: &Matrix, width_mm: f64, value: &str) -> String {
    let w = m.rows[0].len();
    let h = m.rows.len();
    let total_w = w + 2 * m.quiet;
    let total_h = h + 2 * m.quiet;
    let height_mm = width_mm * total_h as f64 / total_w as f64;

    // One rectangle per horizontal run of dark modules keeps the SVG small.
    let mut path = String::new();
    for (y, row) in m.rows.iter().enumerate() {
        let mut x = 0;
        while x < w {
            if row[x] {
                let start = x;
                while x < w && row[x] {
                    x += 1;
                }
                path.push_str(&format!(
                    "M{},{}h{}v1h-{}z",
                    start + m.quiet,
                    y + m.quiet,
                    x - start,
                    x - start
                ));
            } else {
                x += 1;
            }
        }
    }

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total_w} {total_h}\" \
         width=\"{width_mm}mm\" height=\"{height_mm}mm\" shape-rendering=\"crispEdges\" \
         role=\"img\" aria-label=\"barcode {label}\"><rect width=\"{total_w}\" height=\"{total_h}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/></svg>",
        label = escape_xml(value)
    )
}

/// UPC-E as a native-scale module vector.
///
/// The writer rasterizes the 1D pattern at an integer upscale (all runs are
/// multiples of it), so the runs are divided by the GCD to recover the true
/// module pattern; the writer's own (non-integer) centering quiet zone is
/// dropped because `linear_svg` adds its own.
fn upce_modules(value: &str) -> Option<Vec<u8>> {
    let m = MultiFormatWriter
        .encode(value, &BarcodeFormat::UPC_E, 400, 200)
        .ok()?;
    let [x0, y0, bw, _bh] = m.getEnclosingRectangle()?;
    let (x0, y0, bw) = (x0 as usize, y0 as usize, bw as usize);

    // The symbol is a 1D pattern: every row is identical, so one row suffices.
    let mut runs: Vec<(usize, bool)> = Vec::new();
    let mut i = x0;
    while i < x0 + bw {
        let dark = m.get(i as u32, y0 as u32);
        let mut j = i;
        while j < x0 + bw && m.get(j as u32, y0 as u32) == dark {
            j += 1;
        }
        runs.push((j - i, dark));
        i = j;
    }
    let g = runs.iter().map(|(len, _)| *len).reduce(gcd)?;
    let mut modules = Vec::with_capacity(bw / g);
    for (len, dark) in runs {
        for _ in 0..len / g {
            modules.push(u8::from(dark));
        }
    }
    Some(modules)
}

/// Validate a GTIN-14 and return all 14 digits.
///
/// 13 digits: the check digit is computed. 14 digits: it must match
/// (ISO/IEC 15417). Weights run from the right, ×1 on the check digit.
fn itf14_digits(value: &str) -> Option<String> {
    let digits: Vec<u32> = value
        .chars()
        .map(|c| c.to_digit(10))
        .collect::<Option<_>>()?;
    let check_of = |first_13: &[u32]| -> u32 {
        let sum: u32 = first_13
            .iter()
            .enumerate()
            .map(|(i, &d)| if i % 2 == 0 { d * 3 } else { d })
            .sum();
        (10 - sum % 10) % 10
    };
    match digits.len() {
        13 => {
            let check = check_of(&digits);
            let mut digits = value.to_string();
            digits.push((b'0' + check as u8) as char); // a single digit
            Some(digits)
        }
        14 if check_of(&digits[..13]) == digits[13] => Some(value.to_string()),
        _ => None,
    }
}

/// An ITF-14 symbol: an ITF pattern between two solid bearer bars (2221).
fn itf14_svg(modules: &[u8], value: &str, width_mm: f64, show_text: bool) -> String {
    let total = modules.len() + 2 * QUIET_MODULES;
    let bar_height = ((total as f64) * 0.3).clamp(18.0, 60.0);
    let bars_y = BEARER_MODULES + BEARER_GAP_MODULES;
    let bottom_bearer_y = bars_y + bar_height + BEARER_GAP_MODULES;
    let symbol_bottom = bottom_bearer_y + BEARER_MODULES;

    let text = if show_text {
        format!(
            "<text x=\"{}\" y=\"{}\" font-family=\"monospace\" font-size=\"{}\" \
             text-anchor=\"middle\">{}</text>",
            total as f64 / 2.0,
            symbol_bottom + TEXT_HEIGHT,
            TEXT_HEIGHT,
            escape_xml(value)
        )
    } else {
        String::new()
    };
    let height = if show_text {
        symbol_bottom + TEXT_HEIGHT + 1.0
    } else {
        symbol_bottom
    };

    let mut path = String::new();
    let mut i = 0;
    while i < modules.len() {
        if modules[i] == 1 {
            let start = i;
            while i < modules.len() && modules[i] == 1 {
                i += 1;
            }
            path.push_str(&format!(
                "M{},{}h{}v{}h-{}z",
                start + QUIET_MODULES,
                bars_y,
                i - start,
                bar_height,
                i - start
            ));
        } else {
            i += 1;
        }
    }

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {height}\" \
         width=\"{width_mm}mm\" shape-rendering=\"crispEdges\" role=\"img\" \
         aria-label=\"barcode {label}\"><rect width=\"{total}\" height=\"{height}\" fill=\"#fff\"/>\
         <rect y=\"0\" width=\"{total}\" height=\"{BEARER_MODULES}\" fill=\"#000\"/>\
         <rect y=\"{bottom_bearer_y}\" width=\"{total}\" height=\"{BEARER_MODULES}\" fill=\"#000\"/>\
         <path d=\"{path}\" fill=\"#000\"/>{text}</svg>",
        label = escape_xml(value)
    )
}

fn wrap(svg: &str) -> String {
    format!("<div class=\"barcode\">{svg}</div>")
}

fn clamp_mm(mm: f64) -> f64 {
    if mm.is_finite() {
        mm.clamp(MIN_MM, MAX_MM)
    } else {
        DEFAULT_BARCODE_WIDTH_MM
    }
}

fn gcd(a: usize, b: usize) -> usize {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Encode `value` as the dark/light module pattern of a linear symbology.
fn encode_linear(kind: &str, value: &str) -> Option<Vec<u8>> {
    let all_digits = value.chars().all(|c| c.is_ascii_digit());
    match kind {
        // Code 128 needs a character-set prefix; Ɓ selects set B (ASCII 32-127).
        "code128" => {
            if !value.is_ascii() {
                return None;
            }
            Code128::new(format!("\u{0181}{value}"))
                .ok()
                .map(|b| b.encode())
        }
        "code39" => Code39::new(value.to_uppercase()).ok().map(|b| b.encode()),
        "code93" => Code93::new(value.to_uppercase()).ok().map(|b| b.encode()),
        // The encoders accept a missing check digit and add it; templates must
        // supply the full number, as the Designer's validation requires.
        "ean13" if all_digits && value.len() == 13 => EAN13::new(value).ok().map(|b| b.encode()),
        "ean8" if all_digits && value.len() == 8 => EAN8::new(value).ok().map(|b| b.encode()),
        // UPC-A is EAN-13 with a leading zero.
        "upca" if all_digits && value.len() == 12 => {
            EAN13::new(format!("0{value}")).ok().map(|b| b.encode())
        }
        "itf" if all_digits && value.len().is_multiple_of(2) => {
            TF::interleaved(value).ok().map(|b| b.encode())
        }
        "codabar" => Codabar::new(value.to_uppercase()).ok().map(|b| b.encode()),
        _ => None,
    }
}

fn linear_svg(modules: &[u8], value: &str, width_mm: f64, show_text: bool) -> String {
    let total = modules.len() + 2 * QUIET_MODULES;
    let bar_height = ((total as f64) * 0.3).clamp(18.0, 60.0);
    let height = if show_text {
        bar_height + TEXT_HEIGHT + 1.0
    } else {
        bar_height
    };

    let mut path = String::new();
    let mut i = 0;
    while i < modules.len() {
        if modules[i] == 1 {
            let start = i;
            while i < modules.len() && modules[i] == 1 {
                i += 1;
            }
            path.push_str(&format!(
                "M{},0h{}v{}h-{}z",
                start + QUIET_MODULES,
                i - start,
                bar_height,
                i - start
            ));
        } else {
            i += 1;
        }
    }

    let text = if show_text {
        // Shrink very long values to the printable width instead of overflowing.
        let available = (total - 2 * QUIET_MODULES) as f64;
        let estimated = value.chars().count() as f64 * TEXT_HEIGHT * 0.6;
        let fit = if estimated > available {
            format!(" textLength=\"{available}\" lengthAdjust=\"spacingAndGlyphs\"")
        } else {
            String::new()
        };
        format!(
            "<text x=\"{}\" y=\"{}\" font-family=\"monospace\" font-size=\"{}\" \
             text-anchor=\"middle\"{fit}>{}</text>",
            total as f64 / 2.0,
            bar_height + TEXT_HEIGHT,
            TEXT_HEIGHT,
            escape_xml(value)
        )
    } else {
        String::new()
    };

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {height}\" \
         width=\"{width_mm}mm\" shape-rendering=\"crispEdges\" role=\"img\" \
         aria-label=\"barcode {label}\"><rect width=\"{total}\" height=\"{height}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/>{text}</svg>",
        label = escape_xml(value)
    )
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code128_renders_an_svg_with_the_value() {
        let html = barcode_html("code128", "ORD-1042", 40.0, true).unwrap();
        assert!(html.starts_with("<div class=\"barcode\"><svg"));
        assert!(html.contains("width=\"40mm\""));
        assert!(html.contains(">ORD-1042</text>"));
    }

    #[test]
    fn text_can_be_turned_off() {
        let html = barcode_html("code128", "ORD-1042", 40.0, false).unwrap();
        assert!(!html.contains("<text"));
    }

    #[test]
    fn value_is_escaped_in_the_label_and_text() {
        let html = barcode_html("code128", "A<B>&\"", 40.0, true).unwrap();
        assert!(!html.contains("<B>"));
        assert!(html.contains("A&lt;B&gt;&amp;&quot;"));
    }

    #[test]
    fn empty_or_unknown_renders_nothing() {
        assert!(barcode_html("code128", "  ", 40.0, true).is_none());
        assert!(barcode_html("nope", "123", 40.0, true).is_none());
    }

    #[test]
    fn digit_symbologies_validate_length_and_check_digit() {
        assert!(barcode_html("ean13", "5901234123457", 40.0, true).is_some());
        assert!(barcode_html("ean13", "5901234123458", 40.0, true).is_none());
        assert!(barcode_html("ean13", "590123412345", 40.0, true).is_none());
        assert!(barcode_html("ean8", "55123457", 40.0, true).is_some());
        assert!(barcode_html("upca", "036000291452", 40.0, true).is_some());
        assert!(barcode_html("upca", "03600029145", 40.0, true).is_none());
        assert!(barcode_html("itf", "1234567890", 40.0, true).is_some());
        assert!(barcode_html("itf", "123456789", 40.0, true).is_none());
    }

    #[test]
    fn upce_accepts_seven_or_eight_digits() {
        // 7 digits: the check digit is computed. 8 digits: it must match.
        assert!(barcode_html("upce", "0123456", 40.0, true).is_some());
        assert!(barcode_html("upce", "01234565", 40.0, true).is_some());
        assert!(barcode_html("upce", "01234567", 40.0, true).is_none());
        // 6 digits and a number system other than 0/1 are rejected.
        assert!(barcode_html("upce", "123456", 40.0, true).is_none());
        assert!(barcode_html("upce", "2123456", 40.0, true).is_none());
    }

    #[test]
    fn itf14_validates_gtin14_and_draws_bearer_bars() {
        // 13 digits get the check digit appended (…90 -> …905).
        let html = barcode_html("itf14", "0001234567890", 40.0, true).unwrap();
        assert!(html.contains(">00012345678905</text>"));
        assert!(html.contains("<rect y=\"0\" width=\"")); // top bearer bar
        assert!(barcode_html("itf14", "00012345678905", 40.0, true).is_some());
        assert!(barcode_html("itf14", "00012345678906", 40.0, true).is_none());
        // 12 digits are not a GTIN-14.
        assert!(barcode_html("itf14", "000123456789", 40.0, true).is_none());
    }

    #[test]
    fn two_d_kinds_render_sized_svg() {
        let html = barcode_html("datamatrix", "PrintNinja-42", 40.0, true).unwrap();
        assert!(html.starts_with("<div class=\"barcode\"><svg"));
        assert!(html.contains("width=\"40mm\""));
        assert!(html.contains("height=\"")); // aspect-ratio height
                                             // bwip-js draws no text for 2D symbologies.
        assert!(!html.contains("<text"));

        let html = barcode_html("aztec", "PrintNinja-42", 40.0, true).unwrap();
        assert!(html.contains("width=\"40mm\""));
        let html = barcode_html("pdf417", "https://example.com/o/1042", 40.0, true).unwrap();
        assert!(html.contains("width=\"40mm\""));
    }

    #[test]
    fn every_listed_symbology_encodes_a_sample() {
        let samples = [
            ("code128", "HELLO123"),
            ("code39", "HELLO-123"),
            ("code93", "HELLO123"),
            ("ean13", "5901234123457"),
            ("ean8", "55123457"),
            ("upca", "036000291452"),
            ("itf", "1234567890"),
            ("codabar", "A12345B"),
            ("upce", "0123456"),
            ("itf14", "00012345678905"),
            ("datamatrix", "PrintNinja-42"),
            ("pdf417", "https://example.com/o/1042"),
            ("aztec", "PrintNinja-42"),
        ];
        for kind in SYMBOLOGIES {
            let (_, value) = samples.iter().find(|(k, _)| k == kind).unwrap();
            assert!(
                barcode_html(kind, value, 40.0, true).is_some(),
                "{kind} failed to encode {value}"
            );
        }
    }

    #[test]
    fn width_is_clamped() {
        let html = barcode_html("code128", "X", 9999.0, false).unwrap();
        assert!(html.contains("width=\"200mm\""));
        let html = barcode_html("code128", "X", 0.0, false).unwrap();
        assert!(html.contains("width=\"5mm\""));
    }

    #[test]
    fn qr_renders_a_square_svg() {
        let html = qr_html("https://example.com/o/1042", 25.0).unwrap();
        assert!(html.contains("width=\"25mm\" height=\"25mm\""));
        assert!(html.contains("<path d=\"M"));
        assert!(qr_html("", 25.0).is_none());
    }

    // ── Decode round-trip ───────────────────────────────────────────────
    // Port of the retired dual-engine parity test (tests/barcode_parity.rs).
    // The print renderer is the only renderer that ships, so every
    // symbology it emits must be a scannable barcode that decodes back to
    // the template value. The SVGs are rasterized in-process by rxing's
    // SVGLuminanceSource (resvg), so this runs headless in CI, no browser.
    // The decoder types come from the rxing dev-dependency (decoders /
    // qrcode / svg_read); the app binary keeps the slim encoder-only build.

    use rxing::{
        common::GlobalHistogramBinarizer, BinaryBitmap, MultiFormatReader, Reader,
        SVGLuminanceSource,
    };

    /// One sample per shipped symbology, plus `qr` for `{{qrcode}}` (which
    /// `barcode_html` does not cover): (symbology, template value, expected
    /// scanner payload).
    ///
    /// The expected payload is what a scanner reports, which is not always
    /// the input: codabar's start/stop characters (A-D) are not part of the
    /// payload, and the UPC-E reader returns the expanded 8-digit form with
    /// its check digit.
    const ROUNDTRIP_SAMPLES: &[(&str, &str, &str)] = &[
        ("code128", "HELLO123", "HELLO123"),
        ("code39", "HELLO-123", "HELLO-123"),
        ("code93", "HELLO123", "HELLO123"),
        ("ean13", "5901234123457", "5901234123457"),
        ("ean8", "55123457", "55123457"),
        ("upca", "036000291452", "036000291452"),
        ("itf", "1234567890", "1234567890"),
        ("codabar", "A12345B", "12345"),
        ("upce", "0123456", "01234565"),
        ("itf14", "00012345678905", "00012345678905"),
        ("datamatrix", "PrintNinja-42", "PrintNinja-42"),
        (
            "pdf417",
            "https://example.com/o/1042",
            "https://example.com/o/1042",
        ),
        ("aztec", "PrintNinja-42", "PrintNinja-42"),
        (
            "qr",
            "https://example.com/o/1042",
            "https://example.com/o/1042",
        ),
    ];

    /// The `<svg>` inside the renderer's `<div class="barcode">` wrapper.
    fn svg_of(html: &str) -> String {
        let start = html.find("<svg").expect("renderer output has an <svg>");
        let end = html.find("</svg>").expect("renderer output has an </svg>") + "</svg>".len();
        html[start..end].to_string()
    }

    /// The `viewBox` size of an SVG's root tag, if it has one.
    fn view_box_size(tag: &str) -> Option<(f64, f64)> {
        let key = "viewBox=\"";
        let start = tag.find(key)? + key.len();
        let end = start + tag[start..].find('"')?;
        let parts = tag[start..end]
            .split_whitespace()
            .filter_map(|p| p.parse::<f64>().ok());
        let nums: Vec<f64> = parts.take(4).collect();
        let [_, _, w, h] = nums.as_slice() else {
            return None;
        };
        Some((*w, *h))
    }

    /// The rasterization canvas: white background, a margin around the
    /// symbol, and the content scaled up.
    ///
    /// `SVGLuminanceSource` rasterizes at the SVG's own pixel size, and the
    /// print renderer sizes symbols in millimetres — a 40 mm symbol
    /// rasterizes at ~150 px and a 1-module bar lands on ~1 px, too coarse
    /// for the 1D readers. So the root tag is reissued: an outer white
    /// canvas with a 15% margin (the print renderer already draws a quiet
    /// zone; the margin keeps it well clear of the canvas edge) and the
    /// original content nested in an 8x upscaled box, which turns 1 px
    /// modules into 8 px.
    fn canvas(svg: &str) -> String {
        const K: f64 = 8.0; // upscale factor
        const QUIET: f64 = 0.15; // margin as a fraction of the content size

        let Some(close) = svg.find('>') else {
            return svg.to_string();
        };
        let (tag, rest) = svg.split_at(close + 1);
        let vb = view_box_size(tag);

        // The content's original size in the SVG's own units: the explicit
        // width/height (millimetres converted at 96 dpi) or the viewBox.
        let attr_px = |attr: &str| -> Option<f64> {
            let key = format!("{attr}=\"");
            let start = tag.find(&key)? + key.len();
            let end = start + tag[start..].find('"')?;
            let raw = tag[start..end].trim();
            match raw.strip_suffix("mm") {
                Some(mm) => Some(mm.trim().parse::<f64>().ok()? * 96.0 / 25.4),
                None => Some(raw.trim_end_matches("px").parse::<f64>().ok()?),
            }
        };
        let (vw, vh) = vb.unwrap_or((0.0, 0.0));
        let w = attr_px("width").unwrap_or(0.0).max(vw);
        let h = attr_px("height").unwrap_or(0.0).max(vh);
        if w <= 0.0 || h <= 0.0 {
            return svg.to_string();
        }

        // The nested box below owns the size, so drop it from the inner tag.
        let mut inner = strip_size_attr(tag, "width");
        inner = strip_size_attr(&inner, "height");
        // A nested <svg> without a viewBox scales its content to the box —
        // keep the original one; if there wasn't any, add one matching the
        // original size so the content draws 1:1 inside the box.
        if vb.is_none() {
            let at = inner.find('>').unwrap();
            inner.insert_str(at, &format!(" viewBox=\"0 0 {w} {h}\""));
        }

        let q = w.max(h) * QUIET;
        let (ow, oh) = ((w + 2.0 * q) * K, (h + 2.0 * q) * K);
        // One literal: the format string must be a single string literal.
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{ow:.0}px\" height=\"{oh:.0}px\"><rect width=\"{ow:.0}\" height=\"{oh:.0}\" fill=\"#fff\"/><svg x=\"{qx:.0}\" y=\"{qy:.0}\" width=\"{iw:.0}\" height=\"{ih:.0}\">{inner}{rest}</svg></svg>",
            ow = ow,
            oh = oh,
            qx = q * K,
            qy = q * K,
            iw = w * K,
            ih = h * K,
        )
    }

    /// Drop a `width`/`height` attribute (and the whitespace before it) from
    /// a tag's attribute list.
    fn strip_size_attr(tag: &str, attr: &str) -> String {
        let key = format!("{attr}=\"");
        let Some(start) = tag.find(&key) else {
            return tag.to_string();
        };
        let end = start + key.len() + tag[start + key.len()..].find('"').unwrap() + 1;
        let begin = if tag[..start].ends_with(' ') {
            start - 1
        } else {
            start
        };
        let mut out = tag.to_string();
        out.replace_range(begin..end, "");
        out
    }

    /// Rasterize an SVG in-process and decode it with the multi-format
    /// reader.
    fn decode(label: &str, svg: &str) -> String {
        let source = SVGLuminanceSource::new(canvas(svg).as_bytes())
            .unwrap_or_else(|e| panic!("rasterize {label}: {e}"));
        let mut bitmap = BinaryBitmap::new(GlobalHistogramBinarizer::new(source));
        MultiFormatReader::default()
            .decode(&mut bitmap)
            .unwrap_or_else(|e| panic!("decode {label}: {e}"))
            .getText()
            .to_string()
    }

    /// The print renderer's SVG for a sample — the same call the template
    /// helper makes (`width`/`size` are cosmetic and do not change the
    /// payload).
    fn rust_svg(kind: &str, value: &str) -> String {
        if kind == "qr" {
            svg_of(&qr_html(value, 25.0).expect("qr renders"))
        } else {
            svg_of(&barcode_html(kind, value, 40.0, true).expect("symbology renders"))
        }
    }

    #[test]
    fn print_renderer_decodes_to_expected_payload() {
        // A new symbology in SYMBOLOGIES must get a round-trip sample.
        for kind in SYMBOLOGIES {
            assert!(
                ROUNDTRIP_SAMPLES.iter().any(|(k, _, _)| k == kind),
                "no round-trip sample for symbology {kind}"
            );
        }
        for (kind, value, expected) in ROUNDTRIP_SAMPLES {
            let print = decode(&format!("print {kind} ({value})"), &rust_svg(kind, value));
            assert_eq!(
                print, *expected,
                "{kind} ({value}): print decodes to `{print}`, expected `{expected}`"
            );
        }
    }
}
