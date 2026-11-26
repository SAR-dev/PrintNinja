//! CPCL label wrapper: a byte-for-byte port of the old app's
//! `label_langs.rs` CPCL path.
//!
//! One `! … PRINT` per page: the raster as a single `EG` (extended
//! graphics) command, hex-encoded like the old app's.

use pn_render::{dots_for_mm, Bitmap, RasterPage};
use pn_scene::{ExpandedJob, Placed, PlacedKind};

use crate::hex_upper;
use crate::NativeCtx;

/// All the pages, each as one CPCL label.
pub(crate) fn raster(pages: &[RasterPage]) -> Vec<u8> {
    let mut out = String::new();
    for page in pages {
        let h = page.bitmap.height();
        let bpr = Bitmap::bytes_per_row(page.bitmap.width());
        out.push_str(&format!("! 0 200 200 {h} 1\r\n"));
        out.push_str(&format!("EG {bpr} {h} 0 0 "));
        out.push_str(&hex_upper(page.bitmap.to_bytes()));
        out.push_str("\r\nPRINT\r\n");
    }
    out.into_bytes()
}

/// All the pages, each as one CPCL label in the printer's own
/// language: a built-in font for text and `F`/`B` shapes instead of an
/// `EG` graphic. The `!` header is the raster's, with the profile's
/// dpi, so a native label sizes itself the same way.
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
            out.push_str(&format!(
                "! 0 {} {} {} 1\r\n",
                ctx.dpi, ctx.dpi, ctx.page_h_dots
            ));
            for el in &page.elements {
                emit(el, &font, ctx, &mut out);
            }
            out.push_str("PRINT\r\n");
        }
    }
    out.into_bytes()
}

fn emit(el: &Placed, font: &str, ctx: &NativeCtx, out: &mut String) {
    let x = dots_for_mm(el.x_mm, ctx.dpi);
    let y = dots_for_mm(el.y_mm, ctx.dpi);
    match &el.kind {
        // CPCL's `TEXT` takes a dot height for its size, so the text
        // size maps through straight.
        PlacedKind::Text { content, style, .. } => {
            if content.trim().is_empty() {
                return;
            }
            let size = dots_for_mm(style.size_mm, ctx.dpi).max(1);
            out.push_str(&format!("TEXT {font} {x} {y} {size} {content}\r\n"));
        }
        PlacedKind::Barcode { .. } => {} // refused by the shared check
        PlacedKind::Qr { .. } => {}      // refused by the shared check
        PlacedKind::Line {
            length_mm,
            thickness_mm,
            vertical,
        } => {
            let len = dots_for_mm(*length_mm, ctx.dpi).max(1);
            let th = dots_for_mm(*thickness_mm, ctx.dpi).max(1);
            let (w, h) = if *vertical { (th, len) } else { (len, th) };
            out.push_str(&format!("F {x} {y} {w} {h}\r\n"));
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
                out.push_str(&format!("F {x} {y} {w} {h}\r\n"));
            } else {
                // A plain rect has no thickness of its own: the 0.5 mm
                // the raster uses. A frame's border carries its own.
                let mm = match thickness_mm {
                    Some(t) => *t,
                    None => 0.5,
                };
                let t = dots_for_mm(mm, ctx.dpi).max(1);
                out.push_str(&format!("B {x} {y} {w} {h} {t}\r\n"));
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

    /// 20 x 3: the `!` header carries the height, the `EG` header
    /// matches the data, and the hex is exactly the dotted bytes.
    #[test]
    fn the_graphic_header_matches_its_data() {
        let mut b = Bitmap::new(20, 3);
        b.set(0, 0, true); // first dot of row 0
        let cpcl = String::from_utf8(raster(&[RasterPage::new(b, 0.0, 0.0)])).unwrap();
        assert!(cpcl.starts_with("! 0 200 200 3 1\r\n"));
        // 20 dots = 3 bytes/row, 3 rows = 9 bytes = 18 hex digits:
        // row 0 = 0x80 (dot 0, MSB), rows 1-2 blank
        assert!(cpcl.contains("EG 3 3 0 0 800000000000000000\r\nPRINT\r\n"));
    }

    /// Two labels come out in order, each with its own `PRINT`.
    #[test]
    fn a_batch_prints_every_label_in_order() {
        let cpcl = String::from_utf8(raster(&[page(100, 50), page(200, 60)])).unwrap();
        assert_eq!(cpcl.matches("PRINT\r\n").count(), 2);
        let first = cpcl.find("! 0 200 200 50 1").unwrap();
        let second = cpcl.find("! 0 200 200 60 1").unwrap();
        assert!(first < second);
    }

    // ── native ──────────────────────────────────────────────────────

    use pn_profiles::Profile;
    use pn_render::fit_to_head;
    use pn_scene::{
        expand, At, Element, Format, Media, Placement, Records, Size, Template, TextStyle,
    };

    /// The shipped CT-S500: 200 dpi, font "4", no barcode generators —
    /// so its native label is text and shapes only.
    fn cts500() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "CT-S500"
language = "cpcl"
dpi = 200
head_width_dots = 800
media = ["label"]
[fonts]
native = ["4"]
"#,
        )
        .expect("test profile is valid")
    }

    fn ctx_for(profile: &Profile, w_mm: f32, h_mm: f32) -> NativeCtx<'_> {
        NativeCtx {
            lang: profile.profile.language,
            profile,
            dpi: 200,
            page_w_dots: fit_to_head(dots_for_mm(w_mm, 200), profile.profile.head_width_dots),
            page_h_dots: dots_for_mm(h_mm, 200),
            page_w_mm: w_mm,
            page_h_mm: h_mm,
        }
    }

    /// A 40 × 50 mm label: a 3 mm heading and a framed box.
    fn native_label() -> (Profile, ExpandedJob) {
        let profile = cts500();
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
                        align: pn_scene::Align::Left,
                    },
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

    /// The native label is the printer's own commands — a `TEXT` in the
    /// built-in font and a `B` frame — and no `EG` graphic.
    #[test]
    fn a_native_label_is_fonts_and_shapes_not_a_graphic() {
        let (profile, job) = native_label();
        let cpcl = String::from_utf8(native(&job, &ctx_for(&profile, 40.0, 50.0))).unwrap();
        // 50 mm at 200 dpi is 394 dots.
        assert!(cpcl.starts_with("! 0 200 200 394 1\r\n"));
        assert!(cpcl.contains("TEXT 4 39 39 24 TEST\r\n"));
        assert!(cpcl.contains("B 39 236 236 94 4\r\n"));
        assert!(cpcl.ends_with("PRINT\r\n"));
        assert!(!cpcl.contains("EG "), "native output has no graphic");
    }

    /// The native label's exact bytes are pinned, the way the
    /// raster's are.
    #[test]
    fn the_native_label_matches_the_pinned_golden_bytes() {
        let (profile, job) = native_label();
        let out = native(&job, &ctx_for(&profile, 40.0, 50.0));
        golden_harness::assert_matches_golden("encoders/cpcl-native.bin", &out);
    }
}
