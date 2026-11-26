//! TSPL label wrapper: a byte-for-byte port of the old app's
//! `label_langs.rs` TSPL path at its defaults (no density, no speed —
//! those per-roll tunings had no profile field in the new schema).
//!
//! One job per page: `SIZE`, `GAP` (the profile's `min_gap_dots` in
//! millimetres, or 0 for continuous media — the old app's media
//! switch), `DIRECTION 1`, `CLS`, then the raster as a raw
//! `BITMAP` command and `PRINT 1`.

use pn_profiles::{Media, Profile};
use pn_render::{dots_for_mm, Bitmap, RasterPage};
use pn_scene::{Align, BarcodeKind, ExpandedJob, Placed, PlacedKind};

use crate::NativeCtx;

/// All the pages, each as one TSPL label.
pub(crate) fn raster(pages: &[RasterPage], profile: &Profile) -> Vec<u8> {
    let gap = gap_mm(profile);
    let mut out = Vec::new();
    for page in pages {
        let h = page.bitmap.height();
        let bpr = Bitmap::bytes_per_row(page.bitmap.width());
        let mut head = String::new();
        head.push_str(&format!(
            "SIZE {} mm,{} mm\r\n",
            page.width_mm, page.height_mm
        ));
        head.push_str(&format!("GAP {gap} mm,0 mm\r\n"));
        head.push_str("DIRECTION 1\r\n");
        head.push_str("REFERENCE 0,0\r\n");
        head.push_str("CLS\r\n");
        head.push_str(&format!("BITMAP 0,0,{bpr},{h},0\r\n"));
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(page.bitmap.to_bytes());
        out.extend_from_slice(b"\r\nPRINT 1\r\n");
    }
    out
}

/// The gap in millimetres, from the profile's `min_gap_dots` (one decimal
/// place, the way the old app's gap setting was stored). 0.0 when the
/// printer has no labels, or the profile is missing the gap or dpi —
/// the old app's continuous-media default.
fn gap_mm(profile: &Profile) -> String {
    let m = &profile.profile;
    if m.media.contains(&Media::Label) {
        if let (Some(gap), Some(dpi)) = (m.min_gap_dots, m.dpi) {
            return format!("{:.1}", gap as f64 * 25.4 / dpi as f64);
        }
    }
    "0.0".to_string()
}

/// All the pages, each as one TSPL label in the printer's own language:
/// a built-in font for text, a printer-generated `BARCODE` and `BAR`/
/// `BOX` shapes instead of a `BITMAP`. The header (SIZE, GAP,
/// DIRECTION, REFERENCE, CLS) is the raster's, so a native label sizes
/// itself the same way.
pub(crate) fn native(job: &ExpandedJob, ctx: &NativeCtx) -> Vec<u8> {
    let gap = gap_mm(ctx.profile);
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
                "SIZE {:.1} mm,{:.1} mm\r\n",
                ctx.page_w_mm, ctx.page_h_mm
            ));
            out.push_str(&format!("GAP {gap} mm,0 mm\r\n"));
            out.push_str("DIRECTION 1\r\n");
            out.push_str("REFERENCE 0,0\r\n");
            out.push_str("CLS\r\n");
            for el in &page.elements {
                emit(el, &font, ctx, &mut out);
            }
            out.push_str("PRINT 1\r\n");
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
            // TSPL's `TEXT` size parameters are multipliers of the
            // printer's base font, not a dot height, so v1 maps every
            // text size onto the base font (1,1) and centers the line
            // with the same character-width estimate the support check
            // uses. Phase 10 reconciles the multiplier per printer on
            // real hardware through the raw console.
            let h = dots_for_mm(style.size_mm, ctx.dpi).max(1);
            let cw = crate::char_width_dots(ctx.lang, h);
            let box_w = dots_for_mm(*w_mm, ctx.dpi).min(ctx.page_w_dots);
            let text_w = content.chars().count() as u32 * cw;
            let x = match style.align {
                Align::Center => x + box_w.saturating_sub(text_w) / 2,
                Align::Right => x + box_w.saturating_sub(text_w),
                Align::Left => x,
            };
            out.push_str(&format!("TEXT {x},{y},\"{font}\",0,1,1,\"{content}\"\r\n"));
        }
        // TSPL picks the module width itself, so only the box height
        // matters — the shared check already passed the value.
        PlacedKind::Barcode {
            h_mm,
            kind,
            value,
            show_text,
            ..
        } => {
            let h = dots_for_mm(*h_mm, ctx.dpi).max(1);
            let yn = if *show_text { 1 } else { 0 };
            let ty = match kind {
                BarcodeKind::Code128 => "128",
                BarcodeKind::Code39 => "39",
                BarcodeKind::Code93 => "93",
                BarcodeKind::Ean13 => "EAN13",
                BarcodeKind::Upca => "UPCA",
                BarcodeKind::Itf => "ITF",
            };
            out.push_str(&format!(
                "BARCODE {x},{y},\"{ty}\",{h},{yn},1,0,0,\"{value}\"\r\n"
            ));
        }
        PlacedKind::Qr { .. } => {} // refused by the shared check
        PlacedKind::Line {
            length_mm,
            thickness_mm,
            vertical,
        } => {
            let len = dots_for_mm(*length_mm, ctx.dpi).max(1);
            let th = dots_for_mm(*thickness_mm, ctx.dpi).max(1);
            let (w, h) = if *vertical { (th, len) } else { (len, th) };
            out.push_str(&format!("BAR {x},{y},{w},{h}\r\n"));
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
                out.push_str(&format!("BAR {x},{y},{w},{h}\r\n"));
            } else {
                // A plain rect has no thickness of its own: the 0.5 mm
                // the raster uses. A frame's border carries its own.
                let mm = match thickness_mm {
                    Some(t) => *t,
                    None => 0.5,
                };
                let t = dots_for_mm(mm, ctx.dpi).max(1);
                out.push_str(&format!("BOX {x},{y},{w},{h},{t}\r\n"));
            }
        }
        PlacedKind::Image { .. } => {} // refused by the shared check
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(media: &str, min_gap_dots: Option<u32>) -> Profile {
        let toml = format!(
            "[profile]\nmodel = \"T\"\nlanguage = \"tspl\"\ndpi = 203\n\
             head_width_dots = 812\nmedia = [\"{media}\"]\n{}\n",
            min_gap_dots
                .map(|g| format!("min_gap_dots = {g}\n"))
                .unwrap_or_default()
        );
        pn_profiles::parse(&toml).unwrap()
    }

    fn page(w: u32, h: u32, w_mm: f32, h_mm: f32) -> RasterPage {
        RasterPage::new(Bitmap::new(w, h), w_mm, h_mm)
    }

    /// A label profile carries its gap in millimetres: 16 dots at 203
    /// dpi is 2.0 mm.
    #[test]
    fn a_label_profile_carries_its_gap_in_millimetres() {
        let out = raster(&[page(80, 60, 40.0, 30.0)], &profile("label", Some(16)));
        let tspl = String::from_utf8_lossy(&out);
        assert!(tspl.starts_with("SIZE 40 mm,30 mm\r\n"));
        assert!(tspl.contains("GAP 2.0 mm,0 mm\r\n"));
        assert!(tspl.contains("DIRECTION 1\r\n"));
        assert!(tspl.contains("REFERENCE 0,0\r\n"));
        assert!(tspl.contains("CLS\r\n"));
        assert!(tspl.ends_with("\r\nPRINT 1\r\n"));
    }

    /// Continuous media (or a missing gap) prints with a zero gap.
    #[test]
    fn continuous_media_gets_a_zero_gap() {
        for (media, gap) in [("continuous", None), ("label", None)] {
            let out = raster(&[page(80, 60, 40.0, 30.0)], &profile(media, gap));
            assert!(
                String::from_utf8_lossy(&out).contains("GAP 0.0 mm,0 mm\r\n"),
                "{media} without a gap must print GAP 0"
            );
        }
    }

    /// The `BITMAP` header matches the raw dots that follow: 32 x 4 is
    /// 4 bytes x 4 rows = 16 bytes of binary after the header.
    #[test]
    fn the_bitmap_header_matches_its_raw_dots() {
        let mut b = Bitmap::new(32, 4);
        b.set(0, 0, true);
        b.set(31, 3, true);
        let out = raster(
            &[RasterPage::new(b, 40.0, 30.0)],
            &profile("label", Some(16)),
        );
        let at = out
            .windows(b"BITMAP 0,0,4,4,0\r\n".len())
            .position(|w| w == b"BITMAP 0,0,4,4,0\r\n")
            .unwrap();
        let dots = &out[at + 18..at + 18 + 16];
        assert_eq!(dots[0], 0x80); // first dot of row 0, MSB first
        assert_eq!(dots[15], 0x01); // last dot of row 3
        assert_eq!(&out[at + 18 + 16..], b"\r\nPRINT 1\r\n");
    }

    /// Two labels come out in order, each with its own `PRINT 1`.
    #[test]
    fn a_batch_prints_every_label_in_order() {
        let out = raster(
            &[page(80, 60, 40.0, 30.0), page(80, 100, 40.0, 50.0)],
            &profile("label", Some(16)),
        );
        let tspl = String::from_utf8_lossy(&out);
        assert_eq!(tspl.matches("PRINT 1\r\n").count(), 2);
        let first = tspl.find("SIZE 40 mm,30 mm").unwrap();
        let second = tspl.find("SIZE 40 mm,50 mm").unwrap();
        assert!(first < second);
    }

    // ── native ──────────────────────────────────────────────────────

    use pn_render::fit_to_head;
    use pn_scene::{
        expand, At, Element, Format, Media as SceneMedia, Placement, Records, Size, Template,
        TextStyle,
    };

    /// The shipped TTP-244 Pro: one built-in font, no barcode
    /// generators — so its native label is text and shapes only.
    fn ttp244() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "TTP-244 Pro"
language = "tspl"
dpi = 203
head_width_dots = 812
media = ["label"]
min_gap_dots = 16
[fonts]
native = ["2"]
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

    /// A 40 × 50 mm label: a 3 mm heading, a rule and a framed box.
    fn native_label() -> (Profile, ExpandedJob) {
        let profile = ttp244();
        let template = Template {
            format: Format::Scene,
            html: None,
            media: SceneMedia::Label {
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
                Element::Line {
                    at: At {
                        x_mm: 5.0,
                        y_mm: 15.0,
                    },
                    length_mm: 30.0,
                    thickness_mm: 0.3,
                    vertical: false,
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
    /// built-in font, a `BAR` rule and a `BOX` frame — and no `BITMAP`.
    #[test]
    fn a_native_label_is_fonts_and_shapes_not_a_bitmap() {
        let (profile, job) = native_label();
        let bytes = native(&job, &ctx_for(&profile, 40.0, 50.0));
        let out = String::from_utf8_lossy(&bytes);
        // 16 dots at 203 dpi is the profile's 2.0 mm gap.
        assert!(out.starts_with(
            "SIZE 40.0 mm,50.0 mm\r\nGAP 2.0 mm,0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\n"
        ));
        // 3 mm text in the built-in font "2", base size (multiplier 1,1).
        assert!(out.contains("TEXT 40,40,\"2\",0,1,1,\"TEST\"\r\n"));
        assert!(out.contains("BAR 40,120,240,2\r\n"));
        assert!(out.contains("BOX 40,240,240,96,4\r\n"));
        assert!(out.ends_with("PRINT 1\r\n"));
        assert!(!out.contains("BITMAP"), "native output has no raster");
    }

    /// The native label's exact bytes are pinned, the way the
    /// raster's are.
    #[test]
    fn the_native_label_matches_the_pinned_golden_bytes() {
        let (profile, job) = native_label();
        let out = native(&job, &ctx_for(&profile, 40.0, 50.0));
        golden_harness::assert_matches_golden("encoders/tspl-native.bin", &out);
    }
}
