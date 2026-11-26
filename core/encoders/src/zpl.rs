//! ZPL label wrapper: a byte-for-byte port of the old app's
//! `label_langs.rs` ZPL path.
//!
//! One `^XA … ^XZ` per page — the whole label raster as a single
//! `^GFA` graphic, hex-encoded the way the old app sent it (Zebra
//! accepts hex; the old app chose it and it is what the hardware
//! sessions captured).

use pn_render::{barcode_module_count, dots_for_mm, qr_module_side, Bitmap, RasterPage};
use pn_scene::{Align, BarcodeKind, ExpandedJob, Placed, PlacedKind};

use crate::hex_upper;
use crate::NativeCtx;

/// All the pages, each as one ZPL label.
pub(crate) fn raster(pages: &[RasterPage]) -> Vec<u8> {
    let mut out = String::new();
    for page in pages {
        let w = page.bitmap.width();
        let h = page.bitmap.height();
        let bpr = Bitmap::bytes_per_row(w);
        let dots = page.bitmap.to_bytes();
        let total = bpr as usize * h as usize;
        out.push_str("^XA\n");
        out.push_str("^MMT\n");
        out.push_str(&format!("^PW{w}\n"));
        out.push_str(&format!("^LL{h}\n"));
        out.push_str("^LH0,0\n");
        out.push_str("^PR6\n");
        out.push_str(&format!("^FO0,0^GFA,{total},{total},{bpr},"));
        out.push_str(&hex_upper(dots));
        out.push_str("^FS\n^XZ\n");
    }
    out.into_bytes()
}

/// All the pages, each as one ZPL label in the printer's own language:
/// native fonts, printer-generated barcodes and `^GB`/`^GR` shapes
/// instead of a raster. One `^XA … ^XZ` per page, with the header the
/// raster path sets (media type, width, length, home, print rate).
pub(crate) fn native(job: &ExpandedJob, ctx: &NativeCtx) -> Vec<u8> {
    // The printer's first built-in font; the shared check already
    // refused a profile with none.
    let font = ctx
        .profile
        .fonts
        .native
        .first()
        .cloned()
        .unwrap_or_default();
    let mut out = String::new();
    for output in &job.outputs {
        for page in &output.pages {
            out.push_str("^XA\n");
            out.push_str("^MMT\n");
            out.push_str(&format!("^PW{}\n", ctx.page_w_dots));
            out.push_str(&format!("^LL{}\n", ctx.page_h_dots));
            out.push_str("^LH0,0\n");
            out.push_str("^PR6\n");
            for el in &page.elements {
                emit(el, &font, ctx, &mut out);
            }
            out.push_str("^XZ\n");
        }
    }
    out.into_bytes()
}

fn emit(el: &Placed, font: &str, ctx: &NativeCtx, out: &mut String) {
    let x = dots_for_mm(el.x_mm, ctx.dpi);
    let y = dots_for_mm(el.y_mm, ctx.dpi);
    match &el.kind {
        PlacedKind::Text {
            w_mm,
            content,
            style,
            ..
        } => {
            if content.trim().is_empty() {
                return;
            }
            let h = dots_for_mm(style.size_mm, ctx.dpi).max(1);
            // `^A` takes the character cell: square, as wide as tall.
            let cw = crate::char_width_dots(ctx.lang, h);
            let box_w = dots_for_mm(*w_mm, ctx.dpi).min(ctx.page_w_dots);
            let text_w = content.chars().count() as u32 * cw;
            let x = match style.align {
                Align::Center => x + box_w.saturating_sub(text_w) / 2,
                Align::Right => x + box_w.saturating_sub(text_w),
                Align::Left => x,
            };
            out.push_str(&format!("^FO{x},{y}^A{font}N,{h},{cw}^FD{content}^FS\n"));
        }
        PlacedKind::Barcode {
            w_mm,
            h_mm,
            kind,
            value,
            show_text,
        } => {
            // The shared check passed, so the count is `Some` here; the
            // guard only keeps this function total.
            let Some(total) = barcode_module_count(kind, value) else {
                return;
            };
            let bw = (dots_for_mm(*w_mm, ctx.dpi).max(1) as usize / total).max(1);
            let h = dots_for_mm(*h_mm, ctx.dpi).max(1);
            let hri = if *show_text { "Y" } else { "N" };
            let cmd = match kind {
                BarcodeKind::Code128 => format!("^BCN,{h},{hri},N,N"),
                BarcodeKind::Code39 => format!("^B3N,{h},N,N"),
                BarcodeKind::Code93 => format!("^B39N,{h},N,N"),
                BarcodeKind::Ean13 => format!("^BE{hri},Y,N"),
                BarcodeKind::Upca => format!("^BU{hri},Y,N"),
                BarcodeKind::Itf => format!("^BII,{h},{hri},N,N"),
            };
            out.push_str(&format!("^FO{x},{y}^BY{bw}{cmd}^FD{value}^FS\n"));
        }
        PlacedKind::Qr { h_mm, value } => {
            let Some(side) = qr_module_side(value) else {
                return;
            };
            // 4 quiet modules on each side: the code is `side + 8`
            // modules across the box. The shared check keeps the
            // magnification inside ZPL's 2–10.
            let mag = (dots_for_mm(*h_mm, ctx.dpi) as f64 / (side + 8) as f64).round() as i64;
            out.push_str(&format!("^FO{x},{y}^BQN,2,{mag}^FDQ,{value}^FS\n"));
        }
        PlacedKind::Line {
            length_mm,
            thickness_mm,
            vertical,
        } => {
            let len = dots_for_mm(*length_mm, ctx.dpi).max(1);
            let th = dots_for_mm(*thickness_mm, ctx.dpi).max(1);
            let (w, h) = if *vertical { (th, len) } else { (len, th) };
            out.push_str(&format!("^FO{x},{y}^GB{w},{h},{th}^FS\n"));
        }
        PlacedKind::Rect {
            w_mm,
            h_mm,
            fill,
            thickness_mm,
        } => {
            let w = dots_for_mm(*w_mm, ctx.dpi).max(1);
            let h = dots_for_mm(*h_mm, ctx.dpi).max(1);
            if *fill {
                out.push_str(&format!("^FO{x},{y}^GB{w},{h},{}^FS\n", w.min(h)));
            } else {
                // A plain rect has no thickness of its own: the 0.5 mm
                // the raster uses. A frame's border carries its own.
                let mm = match thickness_mm {
                    Some(t) => *t,
                    None => 0.5,
                };
                let t = dots_for_mm(mm, ctx.dpi).max(1);
                out.push_str(&format!("^FO{x},{y}^GR{w},{h},{t}^FS\n"));
            }
        }
        PlacedKind::Image { .. } => {} // refused by the shared check
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(w: u32, h: u32) -> RasterPage {
        RasterPage::new(Bitmap::new(w, h), 0.0, 0.0)
    }

    /// 320 x 240 at 203 dpi (40 bytes/row, 9 600 bytes of dots): width,
    /// length and home are set, and the `^GFA` header matches the data.
    #[test]
    fn a_label_carries_width_length_home_and_matching_hex() {
        let zpl = String::from_utf8(raster(&[page(320, 240)])).unwrap();
        assert!(zpl.contains("^PW320\n"));
        assert!(zpl.contains("^LL240\n"));
        assert!(zpl.contains("^LH0,0\n"));
        assert!(zpl.contains("^PR6\n"));
        assert!(zpl.contains("^FO0,0^GFA,9600,9600,40,"));
        // 9 600 bytes of dots, hex-doubled, all zero for a blank label.
        let at = zpl.find("^FO0,0^GFA,9600,9600,40,").unwrap() + "^FO0,0^GFA,9600,9600,40,".len();
        let hex = &zpl[at..at + 19200];
        // uppercase hex, all zero for a blank label
        assert_eq!(hex, "0".repeat(19200));
        assert!(zpl.ends_with("^FS\n^XZ\n"));
    }

    /// Ink survives the hex round trip: a set dot is a high bit, MSB
    /// first, in the first byte of its row.
    #[test]
    fn a_set_dot_is_a_high_bit_in_the_hex() {
        let mut b = Bitmap::new(16, 2);
        b.set(0, 0, true);
        b.set(7, 1, true);
        let zpl = String::from_utf8(raster(&[RasterPage::new(b, 0.0, 0.0)])).unwrap();
        // 16 dots x 2 rows is 2 bytes per row: row 0 = 80 00 (dot 0 is the
        // MSB), row 1 = 01 00 (dot 7 is the low bit of the first byte)
        assert!(zpl.contains("^GFA,4,4,2,80000100"));
    }

    /// Two labels come out in order, each with its own `^XA`…`^XZ`.
    #[test]
    fn a_batch_prints_every_label_in_order() {
        let out = raster(&[page(100, 50), page(200, 60)]);
        let zpl = String::from_utf8(out).unwrap();
        assert_eq!(zpl.matches("^XA\n").count(), 2);
        assert_eq!(zpl.matches("^XZ\n").count(), 2);
        let first = zpl.find("^PW100").unwrap();
        let second = zpl.find("^PW200").unwrap();
        assert!(first < second);
    }

    // ── native ──────────────────────────────────────────────────────

    use pn_profiles::Profile;
    use pn_render::fit_to_head;
    use pn_scene::{
        expand, At, Element, Format, Media, Placement, Records, Size, Template, TextStyle,
    };

    /// The shipped GK420d capabilities: five built-in fonts and the
    /// barcodes its manual lists.
    fn gk420d() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "GK420d"
language = "zpl"
dpi = 203
head_width_dots = 864
media = ["label"]
min_gap_dots = 8
[fonts]
native = ["0", "1", "2", "3", "4"]
code_pages = ["437", "850", "1252"]
[barcodes]
native = ["CODE128", "EAN13", "QR"]
"#,
        )
        .expect("test profile is valid")
    }

    fn ctx_for(profile: &Profile, w_mm: f32, h_mm: f32) -> NativeCtx<'_> {
        NativeCtx {
            lang: profile.profile.language,
            profile,
            dpi: 203,
            page_w_dots: fit_to_head(dots_for_mm(w_mm, 203), profile.profile.head_width_dots),
            page_h_dots: dots_for_mm(h_mm, 203),
            page_w_mm: w_mm,
            page_h_mm: h_mm,
        }
    }

    /// A 40 × 50 mm label with a 3 mm heading, a Code 128 and a framed
    /// box — the shapes the native path covers.
    fn native_label() -> (Profile, ExpandedJob) {
        let profile = gk420d();
        let template = Template {
            format: Format::Scene,
            html: None,
            media: Media::Label {
                width_mm: 40.0,
                height_mm: 50.0,
            },
            fields: vec![],
            elements: vec![
                Element::Text {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 5.0,
                    },
                    size: Size {
                        w_mm: 30.0,
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
                Element::Barcode {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 15.0,
                    },
                    size: Size {
                        w_mm: 30.0,
                        h_mm: 8.0,
                    },
                    kind: BarcodeKind::Code128,
                    value: "1234567890".into(),
                    show_text: false,
                    page: Placement::Every,
                },
                Element::Rect {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 30.0,
                    },
                    size: Size {
                        w_mm: 30.0,
                        h_mm: 12.0,
                    },
                    fill: false,
                    page: Placement::Every,
                },
            ],
            fonts: vec![],
        };
        let records = Records::from_json("[{}]").unwrap();
        (profile, expand(&template, &records).unwrap())
    }

    /// The native label is the printer's own commands: a built-in font
    /// for the text, a printer-generated Code 128 and a `^GR` frame —
    /// and no `^GFA` graphic anywhere.
    #[test]
    fn a_native_label_is_fonts_barcode_and_shapes_not_a_raster() {
        let (profile, job) = native_label();
        let ctx = ctx_for(&profile, 40.0, 50.0);
        let zpl = String::from_utf8(native(&job, &ctx)).unwrap();
        // 40 mm at 203 dpi is 320 dots, 50 mm is 400; the header is the
        // raster's, so a native label sizes itself the same way.
        assert!(zpl.starts_with("^XA\n^MMT\n^PW320\n^LL400\n^LH0,0\n^PR6\n"));
        // 3 mm text in the first built-in font (font "0"), square cells.
        assert!(zpl.contains("^A0N,24,24^FDTEST^FS\n"));
        // Code 128, 8 mm = 64 dots tall, no human-readable line.
        assert!(zpl.contains("^BCN,64,N,N,N^FD1234567890^FS\n"));
        // The framed box: 30 × 12 mm = 240 × 96 dots, 0.5 mm = 4 dots.
        assert!(zpl.contains("^GR240,96,4^FS\n"));
        assert!(zpl.ends_with("^XZ\n"));
        assert!(!zpl.contains("^GFA"), "native output has no raster graphic");
    }

    /// A QR code becomes a printer-generated `^BQ` with the
    /// magnification the box calls for.
    #[test]
    fn a_native_qr_uses_the_printer_generator() {
        let (profile, _job) = native_label();
        let template = Template {
            elements: vec![Element::Qr {
                at: At {
                    x_mm: 5.0,
                    y_mm: 5.0,
                },
                h_mm: 20.0,
                value: "PrintNinja".into(),
                page: Placement::Every,
            }],
            ..Template {
                format: Format::Scene,
                html: None,
                media: Media::Label {
                    width_mm: 40.0,
                    height_mm: 50.0,
                },
                fields: vec![],
                elements: vec![],
                fonts: vec![],
            }
        };
        let records = Records::from_json("[{}]").unwrap();
        let job = expand(&template, &records).unwrap();
        let zpl = String::from_utf8(native(&job, &ctx_for(&profile, 40.0, 50.0))).unwrap();
        assert!(zpl.contains("^BQN,2,"));
        assert!(zpl.contains("^FDQ,PrintNinja^FS\n"));
    }

    /// The native label's exact bytes are pinned: golden cases, the way
    /// the raster's are.
    #[test]
    fn the_native_label_matches_the_pinned_golden_bytes() {
        let (profile, job) = native_label();
        let out = native(&job, &ctx_for(&profile, 40.0, 50.0));
        golden_harness::assert_matches_golden("encoders/zpl-native.bin", &out);
    }
}
