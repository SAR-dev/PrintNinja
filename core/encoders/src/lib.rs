//! Byte encoders (plan §5.5): the wrappers that turn a job into the
//! byte stream the printer's language accepts.
//!
//! Two entry points, both dispatched on the profile's language.
//! [`raster`] takes the rendered pages `pn-render` produces — one
//! 1-bit bitmap per page/label, the four thermal wrappers are
//! byte-for-byte ports of the old app's default output. [`native`]
//! takes the expanded job straight from `pn-scene` and prints it with
//! the printer's own fonts, barcode generators and shapes — far fewer
//! bytes, and the printer renders the glyphs itself. A document
//! printer (`language = "pdf"`) has neither: its bytes are the PDF
//! itself ([`pn_render::render_pdf`]).
//!
//! The output is deterministic, and its bytes are pinned by
//! golden-file tests (`tests/golden`).

mod cpcl;
mod escpos;
mod tspl;
mod zpl;

use pn_profiles::{Language, Profile};
use pn_render::{dots_for_mm, fit_to_head, RasterPage};
use pn_scene::{BarcodeKind, ExpandedJob, Page, Placed, PlacedKind, Template};
use thiserror::Error;

/// What can go wrong wrapping pages in a language.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum EncoderError {
    /// A `language = "pdf"` printer prints through the OS print path
    /// (spooler or IPP), not raster commands.
    #[error("a document printer has no raster path — page media goes through the OS print path")]
    NoRasterPath,
}

/// What can go wrong asking for native output.
#[derive(Debug, Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum NativeError {
    /// The scene exceeds the printer's native capabilities. The job
    /// falls back to raster and the reason — which names the first
    /// blocking element in plain words — becomes the recorded fallback
    /// (plan §5.3).
    #[error("the scene cannot print natively: {reason}")]
    Unsupported { reason: String },
}

/// Everything the per-language emitters need: the language, the
/// profile's capabilities, and the page size in dots.
pub(crate) struct NativeCtx<'a> {
    pub lang: Language,
    pub profile: &'a Profile,
    /// The printer's resolution — the native layout is in dots.
    pub dpi: u32,
    /// The page width in dots, capped to the head the way the raster
    /// is (`fit_to_head`).
    pub page_w_dots: u32,
    /// The page (label or cut) height in dots.
    pub page_h_dots: u32,
    /// The page width in millimetres (from the template's media).
    pub page_w_mm: f32,
    /// The page height in millimetres.
    pub page_h_mm: f32,
}

/// The expanded job in the profile's native language (plan §5.5):
/// the printer's own fonts, barcode generators and shapes instead of a
/// raster. One command block per record — repeated `^XA…^XZ` in ZPL,
/// `SIZE…PRINT` in TSPL, `!…PRINT` in CPCL, one top-to-bottom stream
/// in ESC/POS (the line-based language).
///
/// The planner prefers this over raster for label and roll scenes on a
/// thermal printer: a simple label is a fraction of the raster's byte
/// count. When the scene exceeds the printer's native capabilities,
/// [`NativeError::Unsupported`] names the first blocking element in
/// plain words and the job falls back to [`raster`] with that reason
/// recorded (plan §5.3) — no design is blocked, only downgraded.
pub fn native(
    job: &ExpandedJob,
    template: &Template,
    profile: &Profile,
) -> Result<Vec<u8>, NativeError> {
    let meta = &profile.profile;
    if !matches!(
        meta.language,
        Language::Zpl | Language::Tspl | Language::Cpcl | Language::Escpos
    ) {
        return Err(NativeError::Unsupported {
            reason: format!(
                "this printer speaks {lang}, not a thermal command language — it prints through the OS print path",
                lang = meta.language
            ),
        });
    }
    let dpi = meta.dpi.ok_or(NativeError::Unsupported {
        reason: "the profile lists no dpi, and the native layout is in dots, so the printer's resolution is required".into(),
    })? as u32;
    let (page_w_mm, page_h_mm) = match template.media {
        pn_scene::Media::Label {
            width_mm,
            height_mm,
        } => (width_mm, height_mm),
        pn_scene::Media::Roll {
            width_mm,
            label_height_mm,
        } => (width_mm, label_height_mm),
        pn_scene::Media::Page { .. } => {
            return Err(NativeError::Unsupported {
                reason: "page media goes through the OS print path, not native commands".into(),
            })
        }
    };
    let ctx = NativeCtx {
        lang: meta.language,
        profile,
        dpi,
        page_w_dots: fit_to_head(dots_for_mm(page_w_mm, dpi), meta.head_width_dots),
        page_h_dots: dots_for_mm(page_h_mm, dpi),
        page_w_mm,
        page_h_mm,
    };
    // All-or-nothing: one unsupported element sends the whole job to
    // raster — a printer cannot mix a native block with a raster one,
    // and the reason names what blocked it.
    for output in &job.outputs {
        for page in &output.pages {
            for el in &page.elements {
                check_element(el, &ctx).map_err(|reason| NativeError::Unsupported { reason })?;
            }
        }
    }
    // ESC/POS prints top to bottom in one column: the elements of a
    // page must not share a y-range, or the stream could not keep
    // their layout. This check needs its siblings, so it runs after the
    // per-element pass.
    if ctx.lang == Language::Escpos {
        for output in &job.outputs {
            for page in &output.pages {
                check_no_overlap(page).map_err(|reason| NativeError::Unsupported { reason })?;
            }
        }
    }
    match ctx.lang {
        Language::Zpl => Ok(zpl::native(job, &ctx)),
        Language::Tspl => Ok(tspl::native(job, &ctx)),
        Language::Cpcl => Ok(cpcl::native(job, &ctx)),
        Language::Escpos => Ok(escpos::native(job, &ctx)),
        Language::Pdf => unreachable!("the language check above refused a pdf profile"),
    }
}

/// The machine name a barcode kind carries in a profile's `native`
/// list ("CODE128", "EAN13", "QR", …).
fn barcode_machine_name(kind: &BarcodeKind) -> &'static str {
    match kind {
        BarcodeKind::Code128 => "CODE128",
        BarcodeKind::Code39 => "CODE39",
        BarcodeKind::Code93 => "CODE93",
        BarcodeKind::Ean13 => "EAN13",
        BarcodeKind::Upca => "UPCA",
        BarcodeKind::Itf => "ITF",
    }
}

/// Whether the profile lists `name` (case-insensitively) among its
/// native barcodes.
fn has_native_barcode(profile: &Profile, name: &str) -> bool {
    profile
        .barcodes
        .native
        .iter()
        .any(|b| b.eq_ignore_ascii_case(name))
}

/// The estimated width of one text character in the language's native
/// font, for the wrap check. ZPL and TSPL state the character cell
/// explicitly (square, as wide as tall); CPCL is estimated conservatively
/// square; ESC/POS's normal font is about half as wide as it is tall.
fn char_width_dots(lang: Language, h_dots: u32) -> u32 {
    match lang {
        Language::Zpl | Language::Tspl | Language::Cpcl => h_dots.max(1),
        Language::Escpos => (h_dots / 2).max(1),
        Language::Pdf => 0,
    }
}

/// The shared support rules: walk one element and refuse — in plain
/// words — anything the language cannot generate itself. An element the
/// raster renderer would not draw either (an empty or unencodable
/// barcode value) is skipped, not refused.
fn check_element(p: &Placed, ctx: &NativeCtx) -> Result<(), String> {
    let pos = format!("at ({:.1}, {:.1} mm)", p.x_mm, p.y_mm);
    match &p.kind {
        PlacedKind::Text {
            w_mm,
            content,
            style,
            ..
        } => {
            if content.trim().is_empty() {
                return Ok(());
            }
            if ctx.profile.fonts.native.is_empty() {
                return Err(format!(
                    "the text {pos}: this profile lists no native fonts, so text can only print as raster"
                ));
            }
            if let Some(name) = &style.font {
                return Err(format!(
                    "the text {pos} requests the font \"{name}\", but native text uses only the printer's built-in fonts"
                ));
            }
            if style.italic {
                return Err(format!(
                    "the text {pos} is italic, and native text in {} has no italic",
                    ctx.lang
                ));
            }
            if style.bold && !matches!(ctx.lang, Language::Escpos) {
                return Err(format!(
                    "the text {pos} is bold, and native text in {} has no bold (only ESC/POS can)",
                    ctx.lang
                ));
            }
            if !ctx.profile.unicode_native() && !content.is_ascii() {
                let ch = content.chars().find(|c| !c.is_ascii()).unwrap();
                return Err(format!(
                    "the text {pos} contains “{ch}”, which the printer's native fonts cannot draw (they are code-page fonts, not Unicode)"
                ));
            }
            if content.contains(['\n', '\r']) {
                return Err(format!(
                    "the text {pos} has a line break, but native text is one line per element"
                ));
            }
            let h_dots = dots_for_mm(style.size_mm, ctx.dpi);
            let text_w = content.chars().count() as u32 * char_width_dots(ctx.lang, h_dots);
            let available = dots_for_mm(*w_mm, ctx.dpi).min(ctx.page_w_dots);
            if text_w > available {
                return Err(format!(
                    "the text {pos} is wider than its box, and native text does not wrap"
                ));
            }
            Ok(())
        }
        PlacedKind::Image { .. } => Err(format!(
            "the image {pos}: images print as raster — the native path has no image commands"
        )),
        PlacedKind::Barcode {
            kind,
            value,
            show_text,
            ..
        } => {
            let machine = barcode_machine_name(kind);
            if !has_native_barcode(ctx.profile, machine) {
                return Err(format!(
                    "the barcode {pos}: this profile does not list {machine} among its native barcodes"
                ));
            }
            if ctx.lang == Language::Cpcl {
                return Err(format!(
                    "the barcode {pos}: CPCL has no native barcode command"
                ));
            }
            // An empty or unencodable value: the raster renderer draws
            // nothing either, so skipping is the native path's honest
            // behaviour — consistency, not failure.
            if value.trim().is_empty() || pn_render::barcode_module_count(kind, value).is_none() {
                return Ok(());
            }
            if *show_text && ctx.lang == Language::Cpcl {
                // Unreachable (CPCL was refused above), but the rule is
                // stated where the other barcode rules live.
                return Err(format!(
                    "the barcode {pos}: this language has no human-readable line under native barcodes"
                ));
            }
            Ok(())
        }
        PlacedKind::Qr { h_mm, value } => {
            if !has_native_barcode(ctx.profile, "QR") {
                return Err(format!(
                    "the QR code {pos}: this profile does not list QR among its native barcodes"
                ));
            }
            if value.trim().is_empty() || pn_render::qr_module_side(value).is_none() {
                return Ok(());
            }
            match ctx.lang {
                Language::Zpl => {
                    let side = pn_render::qr_module_side(value).unwrap();
                    let mag = (dots_for_mm(*h_mm, ctx.dpi) as f64 / (side + 8) as f64).round() as i64;
                    if !(2..=10).contains(&mag) {
                        return Err(format!(
                            "the QR code {pos}: its size needs a ZPL magnification outside 2–10, so the box is too small or too large for the code"
                        ));
                    }
                    Ok(())
                }
                Language::Escpos => Ok(()),
                _ => Err(format!(
                    "the QR code {pos}: native QR in {} is not supported yet — the job prints as raster",
                    ctx.lang
                )),
            }
        }
        PlacedKind::Line { .. } | PlacedKind::Rect { .. } if ctx.lang == Language::Escpos => {
            let shape = if matches!(p.kind, PlacedKind::Line { .. }) {
                "line"
            } else {
                "rectangle"
            };
            Err(format!(
                "the {shape} {pos}: ESC/POS prints top to bottom in one column and cannot place a shape at a point"
            ))
        }
        _ => Ok(()),
    }
}

/// The name of a placed element's kind, for plain words.
fn kind_name(kind: &PlacedKind) -> &'static str {
    match kind {
        PlacedKind::Text { .. } => "text",
        PlacedKind::Image { .. } => "image",
        PlacedKind::Barcode { .. } => "barcode",
        PlacedKind::Qr { .. } => "QR code",
        PlacedKind::Line { .. } => "line",
        PlacedKind::Rect { .. } => "rectangle",
    }
}

/// The y-range one element occupies, in millimetres: `(top, bottom)`.
fn y_range_mm(el: &Placed) -> (f32, f32) {
    let top = el.y_mm;
    let bottom = match &el.kind {
        PlacedKind::Text { h_mm, .. }
        | PlacedKind::Image { h_mm, .. }
        | PlacedKind::Barcode { h_mm, .. }
        | PlacedKind::Qr { h_mm, .. }
        | PlacedKind::Rect { h_mm, .. } => top + *h_mm,
        PlacedKind::Line {
            length_mm,
            thickness_mm,
            vertical,
        } => top + if *vertical { *length_mm } else { *thickness_mm },
    };
    (top, bottom)
}

/// The ESC/POS-only layout rule: the printer emits one column of
/// content top to bottom, so two elements of a page that share a
/// y-range could not keep their layout — the stream has no way to
/// print the second beside or over the first.
fn check_no_overlap(page: &Page) -> Result<(), String> {
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
    let mut prev: Option<(&Placed, f32)> = None; // element and its bottom
    for el in els {
        if let Some((p, bottom)) = prev {
            if el.y_mm < bottom {
                return Err(format!(
                    "the {} at ({:.1}, {:.1} mm) and the {} at ({:.1}, {:.1} mm) overlap vertically, and ESC/POS prints top to bottom in one column, so it cannot keep their layout",
                    kind_name(&p.kind), p.x_mm, p.y_mm,
                    kind_name(&el.kind), el.x_mm, el.y_mm
                ));
            }
        }
        let (_, bottom) = y_range_mm(el);
        prev = Some((el, bottom));
    }
    Ok(())
}

/// The rendered pages as one job in the profile's language.
///
/// # Panics
/// An empty page list, or a page without size or dots, is a bug in the
/// caller — the planner guarantees at least one rendered page.
pub fn raster(pages: &[RasterPage], profile: &Profile) -> Result<Vec<u8>, EncoderError> {
    assert!(!pages.is_empty(), "a job has at least one page");
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
    match profile.profile.language {
        Language::Escpos => Ok(escpos::raster(pages)),
        Language::Zpl => Ok(zpl::raster(pages)),
        Language::Tspl => Ok(tspl::raster(pages, profile)),
        Language::Cpcl => Ok(cpcl::raster(pages)),
        Language::Pdf => Err(EncoderError::NoRasterPath),
    }
}

/// Dots as uppercase hex — ZPL `^GFA` and CPCL `EG` both carry the
/// raster this way (the old app's choice, kept).
pub(crate) fn hex_upper(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0F) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use pn_render::{dots_for_mm, Renderer};
    use std::fs;

    /// A real shipped profile, parsed from its TOML.
    fn profile(name: &str) -> Profile {
        let path = format!(
            "{}/../profiles/profiles/{name}.toml",
            env!("CARGO_MANIFEST_DIR")
        );
        pn_profiles::parse(&fs::read_to_string(path).unwrap()).unwrap()
    }

    /// A page drawn at the profile's own dpi and head width: the
    /// encoder's golden input is rendered by the same renderer that
    /// production uses.
    fn page_for(profile: &Profile, h_mm: f32, draw: impl FnOnce(&mut Renderer)) -> RasterPage {
        let meta = &profile.profile;
        let dpi = meta.dpi.unwrap() as u32;
        let w = meta.head_width_dots.unwrap();
        let w_mm = w as f64 * 25.4 / dpi as f64;
        let mut r = Renderer::new(dpi, w, dots_for_mm(h_mm, dpi));
        draw(&mut r);
        RasterPage::new(r.into_page(), w_mm as f32, h_mm)
    }

    /// A two-page A4 document for the document printer: the profile's
    /// language says "pdf", so there is no raster path.
    #[test]
    fn a_document_printer_has_no_raster_path() {
        let profile = profile("office-laser-cups");
        let r = Renderer::new(300, dots_for_mm(210.0, 300), dots_for_mm(297.0, 300));
        let page = RasterPage::new(r.into_page(), 210.0, 297.0);
        let err = raster(&[page], &profile).unwrap_err();
        assert_eq!(err, EncoderError::NoRasterPath);
    }

    /// A receipt on the generic 58 mm thermal: the bytes the old app
    /// would have sent to the same printer, pinned.
    #[test]
    fn the_escpos_receipt_matches_the_pinned_golden_bytes() {
        let profile = profile("generic-thermal-58mm");
        let page = page_for(&profile, 40.0, |r| {
            r.draw_text(
                3.0,
                3.0,
                50.0,
                6.0,
                "PRINT NINJA",
                &pn_scene::TextStyle {
                    size_mm: 3.0,
                    font: None,
                    bold: true,
                    italic: false,
                    align: pn_scene::Align::Center,
                },
            );
            r.draw_line(3.0, 12.0, 52.0, 0.3, false);
            r.draw_text(
                3.0,
                16.0,
                50.0,
                5.0,
                "¥1,200 本体",
                &pn_scene::TextStyle {
                    size_mm: 2.0,
                    font: None,
                    bold: false,
                    italic: false,
                    align: pn_scene::Align::Right,
                },
            );
        });
        golden_harness::assert_matches_golden(
            "encoders/escpos-receipt.bin",
            &raster(&[page], &profile).unwrap(),
        );
    }

    /// A Code 128 label on the GK420d: pinned, hex included.
    #[test]
    fn the_zpl_label_matches_the_pinned_golden_bytes() {
        let profile = profile("gk420d");
        let page = page_for(&profile, 40.0, |r| {
            r.draw_barcode(
                10.0,
                8.0,
                80.0,
                14.0,
                &pn_scene::BarcodeKind::Code128,
                "SN-1042-88",
                true,
            );
            r.draw_text(
                10.0,
                28.0,
                80.0,
                5.0,
                "プリント忍者",
                &pn_scene::TextStyle {
                    size_mm: 3.0,
                    font: None,
                    bold: false,
                    italic: false,
                    align: pn_scene::Align::Left,
                },
            );
        });
        golden_harness::assert_matches_golden(
            "encoders/zpl-label.bin",
            &raster(&[page], &profile).unwrap(),
        );
    }

    /// A two-line label on the TTP-244 Pro, gap 2.0 mm: pinned, raw
    /// binary included.
    #[test]
    fn the_tspl_label_matches_the_pinned_golden_bytes() {
        let profile = profile("ttp-244-pro");
        let page = page_for(&profile, 40.0, |r| {
            r.draw_text(
                5.0,
                5.0,
                48.0,
                8.0,
                "SN-1042-88",
                &pn_scene::TextStyle {
                    size_mm: 3.0,
                    font: None,
                    bold: true,
                    italic: false,
                    align: pn_scene::Align::Center,
                },
            );
            r.draw_rect(3.0, 3.0, 52.0, 34.0, 0.5, false);
        });
        golden_harness::assert_matches_golden(
            "encoders/tspl-label.bin",
            &raster(&[page], &profile).unwrap(),
        );
    }

    /// A QR label on the CT-S500 at its own 200 dpi: pinned.
    #[test]
    fn the_cpcl_label_matches_the_pinned_golden_bytes() {
        let profile = profile("ct-s500");
        let page = page_for(&profile, 50.0, |r| {
            r.draw_qr(5.0, 5.0, 40.0, "https://example.com/o/1042");
        });
        golden_harness::assert_matches_golden(
            "encoders/cpcl-label.bin",
            &raster(&[page], &profile).unwrap(),
        );
    }

    // ── native: the recorded fallback ───────────────────────────────

    use pn_render::paint_page;
    use pn_scene::{
        expand, Align, At, Element, Format, Media as SceneMedia, Placement, Records, Size,
        TextStyle,
    };

    /// A 40 × 50 label template with the given elements.
    fn label_template(elements: Vec<Element>) -> Template {
        Template {
            format: Format::Scene,
            html: None,
            media: SceneMedia::Label {
                width_mm: 40.0,
                height_mm: 50.0,
            },
            fields: vec![],
            elements,
            fonts: vec![],
        }
    }

    /// One line of text at (x, y), 3 mm tall in a 30 × 6 mm box.
    fn text_el(x: f32, y: f32, content: &str, bold: bool) -> Element {
        Element::Text {
            at: At { x_mm: x, y_mm: y },
            size: Size {
                w_mm: 30.0,
                h_mm: 6.0,
            },
            content: content.into(),
            style: TextStyle {
                size_mm: 3.0,
                font: None,
                bold,
                italic: false,
                align: Align::Left,
            },
            page: Placement::Every,
        }
    }

    /// Run the scene through the native entry point and hand back the
    /// recorded fallback reason — the test fails if it did not refuse.
    fn native_reason(template: Template, profile: &Profile) -> String {
        let records = Records::from_json("[{}]").unwrap();
        let job = expand(&template, &records).unwrap();
        match native(&job, &template, profile) {
            Ok(_) => panic!("expected the native path to refuse this scene"),
            Err(NativeError::Unsupported { reason }) => reason,
        }
    }

    /// Bold has no native ZPL equivalent (only ESC/POS can do it), so
    /// the scene falls back and the reason says why.
    #[test]
    fn bold_text_falls_back_with_a_recorded_reason() {
        let profile = profile("gk420d");
        let reason = native_reason(
            label_template(vec![text_el(5.0, 5.0, "TEST", true)]),
            &profile,
        );
        assert!(
            reason.contains("bold"),
            "the reason names the cause, not just a failure: {reason}"
        );
    }

    /// The profile's native fonts are code-page fonts, so a Japanese
    /// line falls back — the reason names the character.
    #[test]
    fn non_ascii_text_falls_back_because_the_fonts_are_code_page() {
        let profile = profile("gk420d");
        let reason = native_reason(
            label_template(vec![text_el(5.0, 5.0, "プリント", false)]),
            &profile,
        );
        assert!(
            reason.contains("cannot draw"),
            "the reason says the native fonts cannot draw it: {reason}"
        );
    }

    /// Native commands have no image command, so an image sends the
    /// job to raster.
    #[test]
    fn an_image_falls_back_because_native_has_no_image_commands() {
        let profile = profile("gk420d");
        let template = label_template(vec![Element::Image {
            at: At {
                x_mm: 5.0,
                y_mm: 5.0,
            },
            size: Size {
                w_mm: 20.0,
                h_mm: 20.0,
            },
            src: "data:,".into(),
            page: Placement::Every,
        }]);
        let reason = native_reason(template, &profile);
        assert!(
            reason.contains("images print as raster"),
            "the reason says why: {reason}"
        );
    }

    /// The profile lists CODE128, EAN13 and QR — an ITF barcode is not
    /// among them, so the job falls back naming the symbology.
    #[test]
    fn a_barcode_the_profile_does_not_list_falls_back() {
        let profile = profile("gk420d");
        let template = label_template(vec![Element::Barcode {
            at: At {
                x_mm: 5.0,
                y_mm: 15.0,
            },
            size: Size {
                w_mm: 30.0,
                h_mm: 8.0,
            },
            kind: BarcodeKind::Itf,
            value: "1234567890".into(),
            show_text: false,
            page: Placement::Every,
        }]);
        let reason = native_reason(template, &profile);
        assert!(
            reason.contains("does not list ITF"),
            "the reason names the missing symbology: {reason}"
        );
    }

    /// A document printer (`language = "pdf"`) prints through the OS
    /// print path — native commands are refused before any element is
    /// walked.
    #[test]
    fn a_document_printer_is_refused_for_native() {
        let profile = profile("office-laser-cups");
        let reason = native_reason(
            label_template(vec![text_el(5.0, 5.0, "TEST", false)]),
            &profile,
        );
        assert!(
            reason.contains("OS print path"),
            "the reason says where the job goes instead: {reason}"
        );
    }

    /// Page media goes through the OS print path no matter what the
    /// scene holds.
    #[test]
    fn page_media_is_refused_for_native() {
        let profile = profile("gk420d");
        let template = Template {
            media: SceneMedia::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
            ..label_template(vec![text_el(5.0, 5.0, "TEST", false)])
        };
        let reason = native_reason(template, &profile);
        assert!(
            reason.contains("OS print path"),
            "the reason says where the job goes instead: {reason}"
        );
    }

    /// The profile lists no native fonts, so even plain ASCII text
    /// falls back — the reason says the fonts are missing.
    #[test]
    fn a_profile_without_native_fonts_falls_back_for_text() {
        let profile = profile("generic-thermal-58mm");
        let reason = native_reason(
            label_template(vec![text_el(5.0, 5.0, "TEST", false)]),
            &profile,
        );
        assert!(
            reason.contains("no native fonts"),
            "the reason says the profile lists no fonts: {reason}"
        );
    }

    /// An ESC/POS profile with fonts: a shape at a point is refused,
    /// because the stream is one column wide.
    #[test]
    fn escpos_refuses_a_placed_shape() {
        let profile = escpos_fonts_profile();
        let template = label_template(vec![Element::Line {
            at: At {
                x_mm: 5.0,
                y_mm: 15.0,
            },
            length_mm: 30.0,
            thickness_mm: 0.3,
            vertical: false,
            page: Placement::Every,
        }]);
        let reason = native_reason(template, &profile);
        assert!(
            reason.contains("one column"),
            "the reason says why the shape cannot print: {reason}"
        );
    }

    /// Two elements that share a y-range cannot print in one column.
    #[test]
    fn escpos_refuses_overlapping_y_ranges() {
        let profile = escpos_fonts_profile();
        let template = label_template(vec![
            text_el(5.0, 5.0, "FIRST", false),   // 5–11 mm
            text_el(5.0, 10.0, "SECOND", false), // 10–16 mm, overlapping the first
        ]);
        let reason = native_reason(template, &profile);
        assert!(
            reason.contains("overlap vertically"),
            "the reason says the layout cannot be kept: {reason}"
        );
    }

    /// Two elements that do not overlap print natively — the stream
    /// keeps their order.
    #[test]
    fn escpos_keeps_separate_y_ranges_native() {
        let profile = escpos_fonts_profile();
        let template = label_template(vec![
            text_el(5.0, 5.0, "FIRST", false),   // 5–11 mm
            text_el(5.0, 15.0, "SECOND", false), // 15–21 mm
        ]);
        let records = Records::from_json("[{}]").unwrap();
        let job = expand(&template, &records).unwrap();
        let out = native(&job, &template, &profile).expect("separate rows print natively");
        assert!(
            out.windows(2).any(|w| w == [0x1B, 0x40]),
            "the stream inits"
        );
        assert!(
            out.windows(6).any(|w| w == b"FIRST\n"),
            "the first line prints"
        );
        let first = out.windows(6).position(|w| w == b"FIRST\n").unwrap();
        let second = out.windows(7).position(|w| w == b"SECOND\n").unwrap();
        assert!(first < second, "top to bottom order is kept");
    }

    /// The plan's exit criterion: a simple label's native bytes are a
    /// fraction of the raster's for the same scene.
    #[test]
    fn a_simple_label_prints_native_in_a_fraction_of_the_bytes() {
        let profile = profile("gk420d");
        let template = label_template(vec![
            text_el(5.0, 5.0, "TEST", false),
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
        ]);
        let records = Records::from_json("[{}]").unwrap();
        let job = expand(&template, &records).unwrap();

        let n_bytes = native(&job, &template, &profile).unwrap();

        // The same page the way the raster path gets it: paint the
        // expanded page at the profile's dpi and wrap it.
        let dpi = profile.profile.dpi.unwrap() as u32;
        let page = &job.outputs[0].pages[0];
        let mut r = Renderer::new(
            dpi,
            fit_to_head(dots_for_mm(40.0, dpi), profile.profile.head_width_dots),
            dots_for_mm(50.0, dpi),
        );
        paint_page(page, &mut r);
        let r_bytes = raster(&[RasterPage::new(r.into_page(), 40.0, 50.0)], &profile).unwrap();

        assert!(
            n_bytes.len() * 10 < r_bytes.len(),
            "native {} bytes should be a fraction of raster {} bytes",
            n_bytes.len(),
            r_bytes.len()
        );
    }

    /// An ESC/POS profile that lists a built-in font, for the layout
    /// tests: the shape and overlap rules are checked after the font
    /// rule.
    fn escpos_fonts_profile() -> Profile {
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
"#,
        )
        .expect("test profile is valid")
    }
}
