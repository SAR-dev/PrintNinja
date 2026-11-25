//! Print planner: picks the output path for a job (plan §5.3).
//!
//! Track routing first — the template's `format` and media kind pick the
//! track (decided 2026-11-20), then the profile's language and the
//! scene itself pick the path:
//!
//! | track            | media        | path                            |
//! | ---------------- | ------------ | ------------------------------- |
//! | `html`           | `page`       | browser                         |
//! | `scene`          | `page`       | pdf                             |
//! | `scene`          | label/roll   | native → raster (reason recorded) |
//!
//! On the thermal track the planner tries the native command path first
//! — the encoder says, element by element, whether the scene fits the
//! printer's language. When it does not, the scene falls back to the
//! raster path and the reason is recorded in the plan. The planner
//! never emits bytes — it decides which bytes the encoders (or the
//! browser, on the document track) produce.

use pn_profiles::{Language, Media, Profile};
use pn_scene::{ExpandedJob, Template};
use thiserror::Error;

/// The output path a job takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputPath {
    /// The scene in the printer's own commands: its built-in fonts,
    /// printer-generated barcodes and native shapes (plan §5.3) — tens
    /// of bytes instead of an image.
    Native,
    /// 1-bit raster commands in the profile's thermal language
    /// (ESC/POS, ZPL, TSPL or CPCL) — the fallback when the scene does
    /// not fit the printer's language.
    Raster,
    /// The scene rendered to PDF by the Rust renderer, sent through the
    /// OS print path (spooler or IPP).
    Pdf,
    /// The template rendered to PDF by a headless browser, sent through
    /// the OS print path — the document track.
    Browser,
}

/// The chosen path, and why, when it is not the track's preferred one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub path: OutputPath,
    /// Recorded fallback reason (plan §5.3): set when the track's
    /// preferred path is refused — the scene outgrows the printer's
    /// native language, or the printer speaks no thermal language at
    /// all.
    pub fallback: Option<String>,
}

/// The template's media is not a media this printer takes — no output
/// path can print it.
#[derive(Debug, Error, PartialEq, Eq)]
#[error(
    "the template's {template} media is not this printer's media ({printer}) — no output path can print it"
)]
pub struct PlanError {
    /// The template's media kind in words ("label", "roll" or "page").
    pub template: &'static str,
    /// The printer's media in words, as its profile lists them.
    pub printer: String,
}

/// The output path for an expanded job on a printer.
pub fn plan(job: &ExpandedJob, template: &Template, profile: &Profile) -> Result<Plan, PlanError> {
    let meta = &profile.profile;

    // The printer's media, in words: "label", "continuous", "page"
    // (a dual-media profile lists all of its kinds).
    let printer = meta
        .media
        .iter()
        .map(|m| match m {
            Media::Label => "label",
            Media::Continuous => "continuous",
            Media::Page => "page",
        })
        .collect::<Vec<_>>()
        .join(", ");

    // 1. The printer must take the template's media at all.
    let (kind, wanted) = match template.media {
        pn_scene::Media::Label { .. } => ("label", Media::Label),
        pn_scene::Media::Roll { .. } => ("roll", Media::Continuous),
        pn_scene::Media::Page { .. } => ("page", Media::Page),
    };
    if !meta.media.contains(&wanted) {
        return Err(PlanError {
            template: kind,
            printer,
        });
    }

    // 2. Track routing.
    match template.format {
        pn_scene::Format::Html => Ok(Plan {
            path: OutputPath::Browser,
            fallback: None,
        }),
        pn_scene::Format::Scene => match template.media {
            pn_scene::Media::Page { .. } => Ok(Plan {
                path: OutputPath::Pdf,
                fallback: None,
            }),
            pn_scene::Media::Label { .. } | pn_scene::Media::Roll { .. } => match meta.language {
                Language::Escpos | Language::Zpl | Language::Tspl | Language::Cpcl => {
                    // Native first (plan §5.3): the encoder walks the
                    // scene element by element and says whether the
                    // printer's language can draw it. One refusal sends
                    // the whole job to raster, with the reason.
                    match pn_encoders::native(job, template, profile) {
                        Ok(_) => Ok(Plan {
                            path: OutputPath::Native,
                            fallback: None,
                        }),
                        Err(e) => Ok(Plan {
                            path: OutputPath::Raster,
                            fallback: Some(e.to_string()),
                        }),
                    }
                }
                // The template wants thermal output and the printer
                // speaks no thermal language: raster is refused, the
                // scene is rendered to PDF and goes through the OS
                // print path instead — the fallback, recorded.
                Language::Pdf => Ok(Plan {
                    path: OutputPath::Pdf,
                    fallback: Some(format!(
                        "the {kind} scene needs raster output and this printer speaks pdf, not a thermal language — rendered to PDF and sent through the OS print path instead"
                    )),
                }),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pn_scene::{
        expand, Align, Element, Format, Media as TemplateMedia, Placement, Records, Size, TextStyle,
    };
    use std::fs;

    /// A real shipped profile, parsed from its TOML.
    fn profile(name: &str) -> Profile {
        let path = format!(
            "{}/../profiles/profiles/{name}.toml",
            env!("CARGO_MANIFEST_DIR")
        );
        pn_profiles::parse(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn template(format: Format, media: TemplateMedia) -> Template {
        Template {
            format,
            html: None,
            media,
            fields: Vec::new(),
            elements: Vec::new(),
            fonts: Vec::new(),
        }
    }

    fn label() -> Template {
        template(
            Format::Scene,
            TemplateMedia::Label {
                width_mm: 40.0,
                height_mm: 50.0,
            },
        )
    }

    fn roll() -> Template {
        template(
            Format::Scene,
            TemplateMedia::Roll {
                width_mm: 58.0,
                label_height_mm: 40.0,
            },
        )
    }

    fn page() -> Template {
        template(
            Format::Scene,
            TemplateMedia::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
        )
    }

    /// One empty record, for templates with no bindings.
    fn one_record() -> Records {
        Records::from_json("[{}]").unwrap()
    }

    /// An expanded job for the template.
    fn expanded(t: &Template) -> ExpandedJob {
        expand(t, &one_record()).unwrap()
    }

    /// A text element, plain by default.
    fn text(y_mm: f32, content: &str, bold: bool) -> Element {
        Element::Text {
            at: pn_scene::At { x_mm: 5.0, y_mm },
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

    /// An ESC/POS roll printer with a native font and a Code 128
    /// generator.
    fn escpos_roll() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "V"
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
        .unwrap()
    }

    /// A label scene the printer can draw in its own language: the
    /// native path, with no fallback recorded.
    #[test]
    fn a_label_scene_the_printer_can_draw_natively_plans_native() {
        let t = Template {
            elements: vec![text(5.0, "TEST", false)],
            ..label()
        };
        let job = expanded(&t);
        let plan = plan(&job, &t, &profile("gk420d")).unwrap();
        assert_eq!(plan.path, OutputPath::Native);
        assert_eq!(plan.fallback, None);
    }

    /// A receipt scene of plain text on a roll printer with a native
    /// font: the native path.
    #[test]
    fn a_plain_text_receipt_plans_native() {
        let t = Template {
            elements: vec![text(5.0, "TOTAL 12.00", false)],
            ..roll()
        };
        let job = expanded(&t);
        let plan = plan(&job, &t, &escpos_roll()).unwrap();
        assert_eq!(plan.path, OutputPath::Native);
        assert_eq!(plan.fallback, None);
    }

    /// A scene the printer's language cannot draw — bold text on a
    /// printer whose native fonts are plain: the raster path, with the
    /// reason the planner recorded.
    #[test]
    fn a_scene_the_printer_cannot_draw_natively_falls_back_to_raster_with_a_reason() {
        let t = Template {
            elements: vec![text(5.0, "BOLD", true)],
            ..label()
        };
        let job = expanded(&t);
        let plan = plan(&job, &t, &profile("gk420d")).unwrap();
        assert_eq!(plan.path, OutputPath::Raster);
        let why = plan.fallback.as_deref().unwrap();
        assert!(why.contains("bold"), "{why}");
    }

    /// A page scene on a document printer: rendered to PDF in the Rust
    /// renderer and sent through the OS print path.
    #[test]
    fn a_page_scene_on_a_document_printer_plans_pdf() {
        let t = page();
        let job = expanded(&t);
        let plan = plan(&job, &t, &profile("office-laser-cups")).unwrap();
        assert_eq!(plan.path, OutputPath::Pdf);
        assert_eq!(plan.fallback, None);
    }

    /// An html document on a document printer: the browser track.
    #[test]
    fn an_html_document_plans_the_browser_track() {
        let t = template(
            Format::Html,
            TemplateMedia::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
        );
        // The document track never reads the job; an empty one stands
        // in for it.
        let job = ExpandedJob { outputs: vec![] };
        let plan = plan(&job, &t, &profile("office-laser-cups")).unwrap();
        assert_eq!(plan.path, OutputPath::Browser);
        assert_eq!(plan.fallback, None);
    }

    /// A label scene on a page-only printer: no path takes it.
    #[test]
    fn a_label_scene_on_a_document_printer_is_a_media_mismatch() {
        let job = ExpandedJob { outputs: vec![] };
        let err = plan(&job, &label(), &profile("office-laser-cups")).unwrap_err();
        assert_eq!(err.template, "label");
        assert_eq!(err.printer, "page");
        assert_eq!(
            err.to_string(),
            "the template's label media is not this printer's media (page) — no output path can print it"
        );
    }

    /// A page scene on a label-only printer: no path takes it either.
    #[test]
    fn a_page_scene_on_a_label_printer_is_a_media_mismatch() {
        let job = ExpandedJob { outputs: vec![] };
        let err = plan(&job, &page(), &profile("gk420d")).unwrap_err();
        assert_eq!(err.template, "page");
        assert_eq!(err.printer, "label");
    }

    /// A thermal scene on a pdf-language profile that does take labels:
    /// native and raster are both refused, the fallback to PDF is
    /// taken — and recorded.
    #[test]
    fn a_thermal_scene_on_a_pdf_language_printer_falls_back_to_pdf() {
        let toml = "[profile]\nmodel = \"T\"\nlanguage = \"pdf\"\nmedia = [\"label\"]\n";
        let profile = pn_profiles::parse(toml).unwrap();
        let t = label();
        let job = expanded(&t);
        let plan = plan(&job, &t, &profile).unwrap();
        assert_eq!(plan.path, OutputPath::Pdf);
        let why = plan.fallback.as_deref().unwrap();
        assert!(why.contains("raster"), "{why}");
        assert!(why.contains("pdf"), "{why}");
    }
}
