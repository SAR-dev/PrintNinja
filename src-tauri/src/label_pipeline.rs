//! The label track's print pipeline (LABEL_PRINTING_PLAN.md, WP2):
//! scene template + data + printer profile → prepared units → an
//! honest job result.
//!
//! Lifted from the PrintNinja-Next app's `pipeline.rs` (plain Rust by
//! design): the template is validated, the records expand to pages,
//! the planner picks the output path (native, raster, pdf or browser),
//! the encoders (or the browser) produce the units, and the job state
//! machine delivers them and reports what actually happened.
//!
//! Delivery is rewired onto this app's own transports (decision 4):
//! [`AppTransportFactory`] builds the app's `PrinterTransport` for a
//! stored printer row, and the [`AppTransport`] adapter hands each
//! unit to it. The old transport owns its connection lifecycle, pacing
//! and pre-send status inside its one-shot `send`, reports no byte
//! counts and no per-unit status reply, so a delivered job ends
//! `SentUnconfirmed` — the "sent to the printer" honesty this app
//! already uses on raw wires.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use pn_job::{run, JobResult, JobSpec, TransportFactory};
use pn_planner::{plan, OutputPath};
use pn_profiles::{load_dir, merge, parse, Media, Profile, ProfileSet};
use pn_render::{dots_for_mm, fit_to_head, paint_page, render_pdf, RasterPage, Renderer};
use pn_scene::{expand, substitute, ExpandedJob, Page, Records, Template};
use pn_transport::{SendError, SendPlan, Transport};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A job that cannot be prepared.
#[derive(Debug, Error)]
pub enum PipelineError {
    /// The template does not hold together.
    #[error("the template is not valid: {0}")]
    Template(String),
    /// The data and the template do not meet.
    #[error("the data is not records: {0}")]
    Data(String),
    /// No output path can print the template's media on this printer.
    #[error("{0}")]
    Media(String),
    /// The scene could not be encoded.
    #[error("the scene cannot be encoded: {0}")]
    Encode(String),
    /// The document could not be rendered.
    #[error("the document cannot be rendered: {0}")]
    Document(String),
}

/// The path a job takes, in the words the UI shows.
fn path_word(path: OutputPath) -> &'static str {
    match path {
        OutputPath::Native => "native",
        OutputPath::Raster => "raster",
        OutputPath::Pdf => "pdf",
        OutputPath::Browser => "browser",
    }
}

/// One page of the job, rendered the way the job prints (§3.4).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Preview {
    /// A scene page as 1-bit dots: packed eight dots per byte, row by
    /// row, at the printer's dpi.
    Bitmap {
        width: u32,
        height: u32,
        packed: Vec<u8>,
        width_mm: f32,
        height_mm: f32,
    },
    /// A document job as the PDF it will be sent as.
    Pdf { pdf: Vec<u8> },
}

/// What a prepared job looks like before it goes to the wire.
#[derive(Debug, Clone, Serialize)]
pub struct PrepareReport {
    /// "native", "raster", "pdf" or "browser".
    pub path: &'static str,
    /// The recorded fallback reason, when the track's preferred path
    /// was refused (plan §5.3).
    pub fallback: Option<String>,
    /// How many data records the job carries.
    pub records: u32,
    /// The pages the data expands to.
    pub pages: u32,
    /// The units delivered to the printer — one label or cut each,
    /// copies included.
    pub units: u32,
    /// The job's size on the wire, in bytes.
    pub bytes: u64,
    /// The job's pages, in order — one copy's worth, the copies repeat
    /// it. Scene jobs carry every page as its 1-bit dots; document jobs
    /// carry the PDF the printer will receive (one per record on the
    /// browser path, the whole document on the pdf path).
    pub preview: Option<Vec<Preview>>,
}

/// A job ready for delivery: the units, the report, and how the bytes
/// must be declared to the spooler or IPP.
#[derive(Debug)]
pub struct Units {
    pub report: PrepareReport,
    pub spec: JobSpec,
    /// `"application/octet-stream"` for raw command bytes,
    /// `"application/pdf"` for PDF jobs.
    pub document_format: &'static str,
}

/// What happened to a printed job, in words the UI can show.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JobReport {
    /// "confirmed", "sent_unconfirmed", "partially_printed", "failed"
    /// or "wrong_mode_suspected".
    pub result: String,
    /// The "N of M" counts, for partial jobs.
    pub counts: Option<(u32, u32)>,
    /// The plain-word reason, when there is one.
    pub reason: Option<String>,
}

/// The pacing and close delay a profile ships with — the starting
/// point the settings screen's per-printer overrides sit on top of.
#[derive(Debug, Clone, Serialize)]
pub struct DeliveryInfo {
    pub chunk_bytes: u32,
    pub pause_ms: u32,
    pub close_delay_ms: u32,
}

/// A profile as the UI's printer list shows it.
#[derive(Debug, Clone, Serialize)]
pub struct ProfileInfo {
    /// The bundled profile's id — the file stem of its TOML, the value
    /// a saved printer row's `label_profile` holds (WP3).
    pub id: String,
    pub model: String,
    pub aliases: Vec<String>,
    /// The profile's language, in words: "zpl", "escpos", "pdf", …
    pub language: String,
    /// The media kinds the printer takes: "label", "continuous", "page".
    pub media: Vec<String>,
    pub dpi: Option<u32>,
    pub head_width_dots: Option<u32>,
    /// Whether this printer can confirm a job with its own reply
    /// (plan §5.7: a profile with no status dialect never ends
    /// confirmed).
    pub can_confirm: bool,
    /// The profile's own pacing and close delay, before any override.
    pub delivery: DeliveryInfo,
}

fn media_word(media: &Media) -> &'static str {
    match media {
        Media::Label => "label",
        Media::Continuous => "continuous",
        Media::Page => "page",
    }
}

/// The profile set's printers, in the shape the UI lists them.
pub fn profile_infos(set: &ProfileSet) -> Vec<ProfileInfo> {
    set.profiles()
        .map(|(path, p)| {
            let meta = &p.profile;
            ProfileInfo {
                id: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| meta.model.clone()),
                model: meta.model.clone(),
                aliases: meta.aliases.clone(),
                language: meta.language.to_string(),
                media: meta
                    .media
                    .iter()
                    .map(|m| media_word(m).to_string())
                    .collect(),
                dpi: meta.dpi.map(u16::into),
                head_width_dots: meta.head_width_dots,
                can_confirm: p.answers_status() && p.delivery.keep_open_for_status,
                delivery: DeliveryInfo {
                    chunk_bytes: p.delivery.chunk_bytes,
                    pause_ms: p.delivery.pause_ms,
                    close_delay_ms: p.delivery.close_delay_ms,
                },
            }
        })
        .collect()
}

/// The settings key a profile's delivery override is saved under.
pub fn delivery_key(model: &str) -> String {
    format!("delivery.{model}")
}

/// The user's per-profile delivery override, as the settings screen
/// saves it (plan phase 7: profile overrides, pacing, close delay).
/// A field left out keeps the profile's own value.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryOverrides {
    #[serde(default)]
    pub chunk_bytes: Option<u32>,
    #[serde(default)]
    pub pause_ms: Option<u32>,
    #[serde(default)]
    pub close_delay_ms: Option<u32>,
}

/// A copy of the profile with the user's delivery override applied,
/// for one job. The shipped profile is never touched, so the override
/// cannot break the profile set's validation. A missing key, or an
/// override that does not parse, leaves the profile as the file has
/// it — a bad setting row must not fail a print.
pub fn with_delivery_overrides(profile: &Profile, settings: &BTreeMap<String, String>) -> Profile {
    let mut out = profile.clone();
    let Some(raw) = settings.get(&delivery_key(&profile.profile.model)) else {
        return out;
    };
    let Ok(o) = serde_json::from_str::<DeliveryOverrides>(raw) else {
        return out;
    };
    if let Some(v) = o.chunk_bytes {
        out.delivery.chunk_bytes = v;
    }
    if let Some(v) = o.pause_ms {
        out.delivery.pause_ms = v;
    }
    if let Some(v) = o.close_delay_ms {
        out.delivery.close_delay_ms = v;
    }
    out
}

/// Load and validate a directory of profile TOMLs.
pub fn load_profiles(dir: &Path) -> Result<ProfileSet, String> {
    load_dir(dir).map_err(|e| e.to_string())
}

/// The template's page size in millimetres — one page's worth, the
/// same for every page of a label, roll or page template. Public so
/// the scene save path can re-derive the row's page columns from the
/// media.
pub fn page_mm(template: &Template) -> (f32, f32) {
    match template.media {
        pn_scene::Media::Label {
            width_mm,
            height_mm,
        } => (width_mm, height_mm),
        pn_scene::Media::Roll {
            width_mm,
            label_height_mm,
        } => (width_mm, label_height_mm),
        pn_scene::Media::Page {
            width_mm,
            height_mm,
        } => (width_mm, height_mm),
    }
}

/// Paint one expanded page at the printer's dpi — the same dots the
/// raster path ships. A profile without a dpi (page printers) renders
/// at 300, the document-resolution the spooler and CUPS expect.
fn render_scene_page(page: &Page, profile: &Profile, w_mm: f32, h_mm: f32) -> RasterPage {
    let dpi = profile.profile.dpi.map_or(300, u16::into);
    let w = fit_to_head(dots_for_mm(w_mm, dpi), profile.profile.head_width_dots);
    let h = dots_for_mm(h_mm, dpi);
    let mut renderer = Renderer::new(dpi, w, h);
    paint_page(page, &mut renderer);
    RasterPage::new(renderer.into_page(), w_mm, h_mm)
}

/// Validate the template, expand the records, pick the path, encode the
/// units. Nothing here touches the wire — `print_units` does.
pub fn prepare_units(
    template: &Template,
    profile: &Profile,
    records: &Records,
    copies: u32,
) -> Result<Units, PipelineError> {
    prepare_units_with_browser(template, profile, records, copies, None)
}

/// As [`prepare_units`], with a chosen browser path for the document
/// track (the managed Chromium from Settings) instead of auto-detect.
pub fn prepare_units_with_browser(
    template: &Template,
    profile: &Profile,
    records: &Records,
    copies: u32,
    browser: Option<&std::path::Path>,
) -> Result<Units, PipelineError> {
    template
        .validate()
        .map_err(|e| PipelineError::Template(e.to_string()))?;
    let job = expand(template, records).map_err(|e| PipelineError::Data(e.to_string()))?;
    let chosen = plan(&job, template, profile).map_err(|e| PipelineError::Media(e.to_string()))?;
    let (w_mm, h_mm) = page_mm(template);
    let copies = copies.max(1);

    // The units for one copy, and how the bytes are declared.
    let once = match chosen.path {
        // The planner already verified the scene fits the native
        // language, so the same call here cannot refuse it.
        OutputPath::Native => native_units(&job, template, profile)?,
        OutputPath::Raster => {
            let mut units = Vec::new();
            for output in &job.outputs {
                for page in &output.pages {
                    let rendered = render_scene_page(page, profile, w_mm, h_mm);
                    units.push(
                        pn_encoders::raster(std::slice::from_ref(&rendered), profile)
                            .map_err(|e| PipelineError::Encode(e.to_string()))?,
                    );
                }
            }
            units
        }
        OutputPath::Pdf => {
            let pages: Vec<RasterPage> = job
                .outputs
                .iter()
                .flat_map(|o| o.pages.iter())
                .map(|p| render_scene_page(p, profile, w_mm, h_mm))
                .collect();
            vec![render_pdf(&pages)]
        }
        OutputPath::Browser => {
            let html = template.html.as_deref().ok_or_else(|| {
                PipelineError::Document("the document template has no html".into())
            })?;
            let mut units = Vec::new();
            for record in &records.0 {
                let doc = substitute(html, record);
                let pdf = pn_browser::render_pdf_with(&doc, &scratch_dir(), browser)
                    .map_err(|e| PipelineError::Document(e.to_string()))?;
                units.push(pdf);
            }
            units
        }
    };

    let document_format = if matches!(chosen.path, OutputPath::Pdf | OutputPath::Browser) {
        "application/pdf"
    } else {
        "application/octet-stream"
    };

    let mut units = Vec::with_capacity(once.len().saturating_mul(copies as usize));
    for _ in 0..copies {
        units.extend(once.iter().cloned());
    }

    // Every page of the job (one copy's worth — the copies repeat it),
    // the way the path ships it: scene pages as their 1-bit dots, the
    // document's PDFs as the bytes the printer receives.
    let preview: Vec<Preview> = match chosen.path {
        OutputPath::Native | OutputPath::Raster => job
            .outputs
            .iter()
            .flat_map(|o| o.pages.iter())
            .map(|p| {
                let rendered = render_scene_page(p, profile, w_mm, h_mm);
                Preview::Bitmap {
                    width: rendered.bitmap.width(),
                    height: rendered.bitmap.height(),
                    packed: rendered.bitmap.to_bytes().to_vec(),
                    width_mm: w_mm,
                    height_mm: h_mm,
                }
            })
            .collect(),
        OutputPath::Pdf | OutputPath::Browser => once
            .iter()
            .map(|pdf| Preview::Pdf { pdf: pdf.clone() })
            .collect(),
    };

    let pages = job.outputs.iter().map(|o| o.pages.len()).sum::<usize>() as u32;
    let report = PrepareReport {
        path: path_word(chosen.path),
        fallback: chosen.fallback,
        records: records.0.len() as u32,
        pages,
        units: units.len() as u32,
        bytes: units.iter().map(|u| u.len() as u64).sum(),
        preview: Some(preview),
    };
    let spec = JobSpec::new(
        format!(
            "{} job — {} record(s), {} unit(s)",
            path_word(chosen.path),
            records.0.len(),
            units.len()
        ),
        units,
    );
    Ok(Units {
        report,
        spec,
        document_format,
    })
}

/// The whole job as one native stream (the established e2e convention).
fn native_units(
    job: &ExpandedJob,
    template: &Template,
    profile: &Profile,
) -> Result<Vec<Vec<u8>>, PipelineError> {
    let stream = pn_encoders::native(job, template, profile)
        .map_err(|e| PipelineError::Encode(e.to_string()))?;
    Ok(vec![stream])
}

// ─────────────────────────────────────────────────────────────────────
// Profiles: the bundled set, and a saved printer's row as a profile

/// The eleven printer profiles that ship with the core
/// (`core/profiles/profiles/*.toml`), embedded so the label track has
/// them wherever the app runs.
const EMBEDDED_PROFILES: &[(&str, &str)] = &[
    (
        "bf-p2d",
        include_str!("../../core/profiles/profiles/bf-p2d.toml"),
    ),
    (
        "ct-s500",
        include_str!("../../core/profiles/profiles/ct-s500.toml"),
    ),
    (
        "generic-thermal-58mm",
        include_str!("../../core/profiles/profiles/generic-thermal-58mm.toml"),
    ),
    (
        "gk420d",
        include_str!("../../core/profiles/profiles/gk420d.toml"),
    ),
    (
        "office-laser-cups",
        include_str!("../../core/profiles/profiles/office-laser-cups.toml"),
    ),
    (
        "ql-820nwb",
        include_str!("../../core/profiles/profiles/ql-820nwb.toml"),
    ),
    (
        "rp325",
        include_str!("../../core/profiles/profiles/rp325.toml"),
    ),
    (
        "tm-t88vii",
        include_str!("../../core/profiles/profiles/tm-t88vii.toml"),
    ),
    (
        "ttp-244-pro",
        include_str!("../../core/profiles/profiles/ttp-244-pro.toml"),
    ),
    (
        "zd421",
        include_str!("../../core/profiles/profiles/zd421.toml"),
    ),
    (
        "zt411",
        include_str!("../../core/profiles/profiles/zt411.toml"),
    ),
];

fn embedded_text(name: &str) -> &'static str {
    EMBEDDED_PROFILES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, text)| *text)
        .unwrap_or_else(|| panic!("bundled profile {name} is missing"))
}

/// The bundled profile set, loaded fresh (the profiles are embedded;
/// this only gives `load_dir` a directory to read them from).
pub fn embedded_profile_set() -> Result<ProfileSet, String> {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, text) in EMBEDDED_PROFILES {
        std::fs::write(dir.join(format!("{name}.toml")), text).map_err(|e| e.to_string())?;
    }
    let set = load_dir(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(set)
}

/// Which bundled model a saved printer row prints scene jobs with, and
/// whether the user picked it (LABEL_PRINTING_PLAN.md, WP3 — the main
/// design decision). The row's `label_profile` column holds the pick;
/// `None` means the language-based default applies.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProfileChoice {
    /// The bundled profile's id — the file stem of one of
    /// `core/profiles/profiles/*.toml`.
    pub model: String,
    /// True when the user picked this model for the row; false for the
    /// language-based default (the UI flags the latter as "auto").
    pub user_chosen: bool,
}

/// The bundled profile ids, in the order they ship.
pub fn bundled_profile_ids() -> Vec<&'static str> {
    EMBEDDED_PROFILES.iter().map(|(name, _)| *name).collect()
}

/// The model a row without a pick prints with, by its language — the
/// same bases the WP2 mapping used. A raster row talks the raw ESC/POS
/// family on the wire, so it takes the ESC/POS base.
pub fn default_model_for_language(row_language: &str) -> &'static str {
    match crate::transport::parse_printer_language(row_language) {
        crate::transport::PrinterLanguage::Pdf => "office-laser-cups",
        crate::transport::PrinterLanguage::Zpl => "zt411",
        crate::transport::PrinterLanguage::Tspl => "ql-820nwb",
        crate::transport::PrinterLanguage::Cpcl => "ct-s500",
        crate::transport::PrinterLanguage::Escpos | crate::transport::PrinterLanguage::Raster => {
            "generic-thermal-58mm"
        }
    }
}

/// The profile language a pick must speak, so a row cannot be pointed
/// at a model whose dialect it cannot send. A raster row takes the
/// ESC/POS family — on the wire it is an ESC/POS printer.
fn expected_language(row_language: &str) -> pn_profiles::Language {
    match crate::transport::parse_printer_language(row_language) {
        crate::transport::PrinterLanguage::Pdf => pn_profiles::Language::Pdf,
        crate::transport::PrinterLanguage::Zpl => pn_profiles::Language::Zpl,
        crate::transport::PrinterLanguage::Tspl => pn_profiles::Language::Tspl,
        crate::transport::PrinterLanguage::Cpcl => pn_profiles::Language::Cpcl,
        crate::transport::PrinterLanguage::Escpos | crate::transport::PrinterLanguage::Raster => {
            pn_profiles::Language::Escpos
        }
    }
}

/// A pick is usable when the profile exists in the bundled set and
/// speaks the row's language family.
pub fn validate_profile_pick(profile_id: &str, row_language: &str) -> Result<(), String> {
    let Some((_, text)) = EMBEDDED_PROFILES
        .iter()
        .find(|(name, _)| *name == profile_id)
    else {
        return Err(format!(
            "no bundled profile '{profile_id}'; the ids the app knows: {}",
            bundled_profile_ids().join(", ")
        ));
    };
    let want = expected_language(row_language);
    let got = parse(text)
        .map(|p| p.profile.language)
        .map_err(|e| e.to_string())?;
    if got != want {
        return Err(format!(
            "profile '{profile_id}' speaks {got}, but this printer's language is {want}"
        ));
    }
    Ok(())
}

/// The model a saved row prints with: the user's pick when the row
/// carries one (validated), else the language-based default.
pub fn resolve_profile_choice(
    printer: &crate::commands::print::StoredPrinter,
) -> Result<ProfileChoice, String> {
    match &printer.label_profile {
        Some(pick) => {
            validate_profile_pick(pick, &printer.language)?;
            Ok(ProfileChoice {
                model: pick.clone(),
                user_chosen: true,
            })
        }
        None => Ok(ProfileChoice {
            model: default_model_for_language(&printer.language).to_string(),
            user_chosen: false,
        }),
    }
}

/// The profile a saved printer row prints scene jobs with: the bundled
/// base for its model, merged with the row's own geometry.
///
/// A row without a pick takes the language-based default and is mapped
/// exactly as WP2 mapped it: the row's language family and media are
/// forced, the dpi falls back to 203, and the row's width brings its
/// head. A user pick (WP3) changes which base the job runs on — its
/// language, media, fonts and barcodes win — and only the row's
/// geometry is applied on top: the dpi and width each fall back to the
/// model's values, and when both are known the head is recomputed so
/// the profile validator's cross-check holds.
pub fn resolve_profile_for_printer(
    printer: &crate::commands::print::StoredPrinter,
) -> Result<(Profile, ProfileChoice), String> {
    let choice = resolve_profile_choice(printer)?;
    let base = parse(embedded_text(&choice.model)).map_err(|e| e.to_string())?;

    if choice.user_chosen {
        let meta = &base.profile;
        let dpi: Option<u32> = printer
            .dpi
            .and_then(|d| u32::try_from(d).ok())
            .or_else(|| meta.dpi.map(u16::into));
        let width_mm: Option<f64> = printer
            .paper_width_mm
            .map(|w| w as f64)
            .or(meta.printable_width_mm);
        let mut override_toml = String::from("[profile]\n");
        match (dpi, width_mm) {
            (Some(d), Some(w)) => {
                // All three together: the profile validator
                // cross-checks them only when all are present.
                let head = (d as f64 * w / 25.4).round() as u32;
                override_toml.push_str(&format!(
                    "dpi = {d}\nprintable_width_mm = {w}\nhead_width_dots = {head}\n"
                ));
            }
            (Some(d), None) => override_toml.push_str(&format!("dpi = {d}\n")),
            (None, Some(w)) => override_toml.push_str(&format!("printable_width_mm = {w}\n")),
            (None, None) => return Ok((base, choice)),
        }
        return merge(&base, &override_toml)
            .map(|p| (p, choice))
            .map_err(|e| e.to_string());
    }

    let lang = crate::transport::parse_printer_language(&printer.language);
    let (lang_word, media) = match lang {
        crate::transport::PrinterLanguage::Pdf => ("pdf", "[\"page\"]"),
        crate::transport::PrinterLanguage::Zpl => ("zpl", "[\"label\", \"continuous\"]"),
        crate::transport::PrinterLanguage::Tspl => ("tspl", "[\"label\", \"continuous\"]"),
        crate::transport::PrinterLanguage::Cpcl => ("cpcl", "[\"label\", \"continuous\"]"),
        // A raster row still talks the raw ESC/POS family on the wire.
        crate::transport::PrinterLanguage::Escpos | crate::transport::PrinterLanguage::Raster => {
            ("escpos", "[\"label\", \"continuous\"]")
        }
    };
    let dpi = printer.dpi.unwrap_or(203);
    let mut override_toml =
        format!("[profile]\nlanguage = \"{lang_word}\"\nmedia = {media}\ndpi = {dpi}\n");
    if let Some(width_mm) = printer.paper_width_mm {
        // All three together: the profile validator cross-checks them
        // only when all are present.
        let head = (dpi as f64 * width_mm as f64 / 25.4).round() as u32;
        override_toml.push_str(&format!(
            "head_width_dots = {head}\nprintable_width_mm = {width_mm}\n"
        ));
    }
    merge(&base, &override_toml)
        .map(|p| (p, choice))
        .map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────
// Delivery: pn-job on top of this app's own transports (decision 4)

/// A `pn-job` transport factory over this app's `PrinterTransport`s.
///
/// `connect` builds the app's transport for one stored printer row. The
/// app's transports are one-shot — each `send` owns the connection
/// lifecycle, the driverless pacing and the pre-send status check — so
/// the profile's per-unit pacing plan is not re-applied here, and the
/// transport reports no byte counts or status reply. A delivered job
/// therefore ends `SentUnconfirmed` ("sent to the printer"), the same
/// honesty the app already reports on raw wires.
pub struct AppTransportFactory {
    printer_type: crate::transport::PrinterType,
    name: String,
    address: String,
    settings: crate::transport::TransportSettings,
    language: crate::transport::PrinterLanguage,
    mime_type: &'static str,
    job_id: String,
    printer_id: String,
    handle: tokio::runtime::Handle,
}

impl AppTransportFactory {
    /// Build a factory for one printer row. `handle` must be the
    /// runtime the delivery runs in: the command captures it on the
    /// async side, and the blocking thread calls `block_on` on it.
    // Every parameter is a transport-creation value read off the saved
    // printer row, mirroring the old `create_transport` seam.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        printer_type: crate::transport::PrinterType,
        name: &str,
        address: &str,
        settings: crate::transport::TransportSettings,
        language: crate::transport::PrinterLanguage,
        mime_type: &'static str,
        job_id: &str,
        printer_id: &str,
        handle: tokio::runtime::Handle,
    ) -> Self {
        Self {
            printer_type,
            name: name.to_string(),
            address: address.to_string(),
            settings,
            language,
            mime_type,
            job_id: job_id.to_string(),
            printer_id: printer_id.to_string(),
            handle,
        }
    }
}

impl TransportFactory for AppTransportFactory {
    fn connect(&self) -> Result<Box<dyn Transport>, SendError> {
        let inner = crate::transport::create_transport(
            &self.printer_type,
            &self.name,
            &self.address,
            &self.settings,
        )
        .ok_or_else(|| {
            SendError::Connect(format!(
                "the {} transport is not supported for this printer on this platform",
                self.printer_type
            ))
        })?;
        Ok(Box::new(AppTransport {
            inner,
            language: self.language.clone(),
            mime_type: self.mime_type,
            job_id: self.job_id.clone(),
            printer_id: self.printer_id.clone(),
            handle: self.handle.clone(),
        }))
    }
}

/// One unit at a time, handed to the app's one-shot transport.
struct AppTransport {
    inner: Box<dyn crate::transport::PrinterTransport>,
    language: crate::transport::PrinterLanguage,
    mime_type: &'static str,
    job_id: String,
    printer_id: String,
    handle: tokio::runtime::Handle,
}

impl Transport for AppTransport {
    fn send_unit(&mut self, data: &[u8], _plan: &SendPlan) -> pn_transport::UnitReport {
        let job = crate::transport::RenderedJob {
            job_id: self.job_id.clone(),
            printer_id: self.printer_id.clone(),
            data: data.to_vec(),
            mime_type: self.mime_type.to_string(),
            copies: 1,
            language: self.language.clone(),
            raw: None,
        };
        match self.handle.block_on(self.inner.send(job)) {
            Ok(()) => pn_transport::UnitReport::ok(data.len() as u64),
            Err(message) => pn_transport::UnitReport {
                bytes_written: 0,
                error: Some(SendError::Io(message)),
            },
        }
    }

    fn status_reply(
        &mut self,
        _query: &[u8],
        _deadline: std::time::Duration,
        _reply_complete: &dyn Fn(&[u8]) -> bool,
    ) -> Result<Option<Vec<u8>>, SendError> {
        // The app's transports answer no per-unit status dialect:
        // silence, which the job state machine reads as
        // `SentUnconfirmed`, never a failure.
        Ok(None)
    }

    fn finish(&mut self, _plan: &SendPlan) {}
}

/// Deliver a prepared job and report what actually happened.
pub fn print_units<F: TransportFactory>(
    spec: &JobSpec,
    profile: &Profile,
    factory: &F,
) -> JobResult {
    run(spec, profile, factory)
}

/// The job result in words the UI can show.
pub fn report_of(result: JobResult) -> JobReport {
    let (state, reason) = match &result {
        JobResult::Confirmed => ("confirmed", None),
        JobResult::SentUnconfirmed => ("sent_unconfirmed", None),
        JobResult::PartiallyPrinted { reason, .. } => ("partially_printed", Some(reason.clone())),
        JobResult::Failed { reason } => ("failed", Some(reason.clone())),
        JobResult::WrongModeSuspected => (
            "wrong_mode_suspected",
            Some(
                "the printer answered in a language other than its profile's — check the printer's mode"
                    .into(),
            ),
        ),
    };
    JobReport {
        result: state.to_string(),
        counts: result.counts(),
        reason,
    }
}

/// A scratch directory for one browser render; unique per call.
static SCRATCH_SEQ: AtomicUsize = AtomicUsize::new(0);

fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
        "pn-print-{}-{}",
        std::process::id(),
        SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use pn_job::TcpFactory;
    use pn_scene::{
        Align, Element, Field, Format, Media as TemplateMedia, Placement, Size, TextStyle,
    };

    /// A ZPL label printer with a status dialect — the same shape as the
    /// e2e's virtual ZPL profile, so a live job can end `Confirmed`.
    fn zpl_profile() -> Profile {
        pn_profiles::parse(
            r#"
[profile]
model = "Fake Label"
language = "zpl"
mode = "zpl"
media = ["label"]
dpi = 203
head_width_dots = 384
printable_width_mm = 48
[fonts]
native = ["0"]
code_pages = ["437"]
[barcodes]
native = ["CODE128"]
[delivery]
chunk_bytes = 512
pause_ms = 10
close_delay_ms = 0
keep_open_for_status = true
[status]
query = "~HS"
expected_prefix = "\u0002"
poll_after_ms = 200
"#,
        )
        .unwrap()
    }

    fn page_profile() -> Profile {
        pn_profiles::parse(
            r#"[profile]
model = "Fake Page"
language = "pdf"
media = ["page"]
"#,
        )
        .unwrap()
    }

    /// A 40 × 50 mm label with one bound heading.
    fn label_template(bold: bool) -> Template {
        Template {
            format: Format::Scene,
            html: None,
            media: TemplateMedia::Label {
                width_mm: 40.0,
                height_mm: 50.0,
            },
            fields: vec![Field {
                name: "name".into(),
                kind: Default::default(),
            }],
            elements: vec![Element::Text {
                at: pn_scene::At {
                    x_mm: 2.0,
                    y_mm: 2.0,
                },
                size: Size {
                    w_mm: 36.0,
                    h_mm: 4.0,
                },
                content: "{{name}}".into(),
                style: TextStyle {
                    size_mm: 3.0,
                    font: None,
                    bold,
                    italic: false,
                    align: Align::Left,
                },
                page: Placement::Every,
            }],
            fonts: vec![],
        }
    }

    fn two_records() -> Records {
        Records::from_json(r#"[{"name":"BOLT M8"},{"name":"NUT M8"}]"#).unwrap()
    }

    /// A fake raw printer: a TCP listener that answers the status query
    /// and records every byte it was sent.
    struct FakePrinter {
        port: u16,
        got: Arc<Mutex<Vec<u8>>>,
        handle: Option<JoinHandle<()>>,
    }

    impl FakePrinter {
        fn spawn(status_ok: bool) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let got = Arc::new(Mutex::new(Vec::new()));
            let log = got.clone();
            let handle = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let ready = b"\x02030,0,0,1234,000,0,0,0,000,0,0,0\x03\r\n";
                let fault = b"\x02030,1,0,1234,000,0,0,0,000,0,0,0\x03\r\n";
                let mut byte = [0u8; 1];
                let mut prev = 0u8;
                loop {
                    if stream.read(&mut byte).unwrap() == 0 {
                        break;
                    }
                    if prev == b'~' && byte[0] == b'H' {
                        // The status query (~HS): answer ready or fault.
                        stream
                            .write_all(if status_ok { ready } else { fault })
                            .unwrap();
                        stream.flush().unwrap();
                    } else {
                        log.lock().unwrap().extend_from_slice(&byte);
                    }
                    prev = byte[0];
                }
            });
            FakePrinter {
                port,
                got,
                handle: Some(handle),
            }
        }

        fn received(&self) -> Vec<u8> {
            self.got.lock().unwrap().clone()
        }
    }

    impl Drop for FakePrinter {
        fn drop(&mut self) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    /// A fake raw printer for the app's own transports: the old
    /// `RawTcpPrinter` dials a fresh connection for the pre-send status
    /// probe and another for the job, on every unit, and its Zebra
    /// dialect reads three `~HS` frames — so this fake accepts
    /// connections until dropped and answers in three frames.
    struct FakeRawPrinter {
        port: u16,
        got: Arc<Mutex<Vec<u8>>>,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl FakeRawPrinter {
        fn spawn(status_ok: bool) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let got = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let log = got.clone();
            let listener_stop = stop.clone();
            let handle = thread::spawn(move || {
                listener.set_nonblocking(true).unwrap();
                loop {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            Self::serve(stream, status_ok, &log);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            if listener_stop.load(Ordering::Relaxed) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            FakeRawPrinter {
                port,
                got,
                stop,
                handle: Some(handle),
            }
        }

        fn serve(mut stream: std::net::TcpStream, status_ok: bool, log: &Mutex<Vec<u8>>) {
            // The three frames the Zebra dialect reads: status, media
            // type, ribbon. The status frame carries the fault bit.
            let mut reply = Vec::new();
            reply.extend_from_slice(if status_ok {
                b"\x02030,0,0,1234,000,0,0,0,000,0,0,0\x03\r\n"
            } else {
                b"\x02030,1,0,1234,000,0,0,0,000,0,0,0\x03\r\n"
            });
            reply.extend_from_slice(b"\x02000,0\x03\r\n");
            reply.extend_from_slice(b"\x020000,0\x03\r\n");
            let mut byte = [0u8; 1];
            let mut prev = 0u8;
            loop {
                if stream.read(&mut byte).unwrap() == 0 {
                    break;
                }
                if prev == b'~' && byte[0] == b'H' {
                    // The status query (~HS): answer ready or fault.
                    stream.write_all(&reply).unwrap();
                    stream.flush().unwrap();
                } else {
                    log.lock().unwrap().extend_from_slice(&byte);
                }
                prev = byte[0];
            }
        }

        fn received(&self) -> Vec<u8> {
            self.got.lock().unwrap().clone()
        }
    }

    impl Drop for FakeRawPrinter {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    /// A `TcpFactory` for the vendored-transport tests: loopback, five
    /// seconds to connect.
    fn tcp_factory(port: u16) -> TcpFactory {
        TcpFactory {
            host: "127.0.0.1".into(),
            port,
            connect_deadline: Duration::from_secs(5),
        }
    }

    /// A scene the printer's language can draw plans native, with a
    /// 1-bit preview of every label in the job.
    #[test]
    fn a_drawable_label_plans_native_with_a_dots_preview() {
        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 1)
            .expect("the scene fits the native path");
        let report = &units.report;
        assert_eq!(report.path, "native");
        assert_eq!(report.fallback, None);
        assert_eq!(report.records, 2);
        assert_eq!(report.pages, 2);
        assert_eq!(report.units, 1, "one native stream per copy");
        let pages = report.preview.as_ref().expect("the job previews its pages");
        assert_eq!(pages.len(), 2, "every page of the job, one copy's worth");
        match &pages[0] {
            Preview::Bitmap {
                width,
                height,
                packed,
                width_mm,
                height_mm,
            } => {
                // 40 × 50 mm at 203 dpi is 320 × 400 dots, 40 bytes per
                // row.
                assert_eq!(*width, 320);
                assert_eq!(*height, 400);
                assert_eq!(packed.len(), 40 * 400);
                assert_eq!(*width_mm, 40.0);
                assert_eq!(*height_mm, 50.0);
            }
            other => panic!("expected a bitmap preview, got {other:?}"),
        }
        // Native is a handful of commands, not an image.
        assert!(report.bytes < 2048, "native is {} bytes", report.bytes);
    }

    /// Bold text on a plain-font printer: the raster path takes the
    /// job, the reason is recorded, one unit per page.
    #[test]
    fn a_scene_beyond_the_native_language_falls_back_to_raster() {
        let units = prepare_units(&label_template(true), &zpl_profile(), &two_records(), 1)
            .expect("raster always takes the scene");
        let report = &units.report;
        assert_eq!(report.path, "raster");
        assert!(report.fallback.as_deref().unwrap().contains("bold"));
        assert_eq!(report.units, 2, "one raster unit per page");
    }

    /// Copies repeat the units.
    #[test]
    fn copies_repeat_the_units() {
        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 3)
            .expect("the scene fits the native path");
        assert_eq!(units.report.units, 3, "three copies of the native stream");
    }

    /// A label scene on a page-only printer: no path takes it.
    #[test]
    fn a_media_mismatch_is_named_in_plain_words() {
        let err =
            prepare_units(&label_template(false), &page_profile(), &two_records(), 1).unwrap_err();
        let words = err.to_string();
        assert!(words.contains("label media"), "{words}");
        assert!(words.contains("not this printer's media"), "{words}");
    }

    /// Empty data is a data error, not a zero-unit job.
    #[test]
    fn empty_records_fail_before_the_wire() {
        let err = prepare_units(
            &label_template(false),
            &zpl_profile(),
            &Records::from_json("[]").unwrap(),
            1,
        )
        .unwrap_err();
        assert!(matches!(err, PipelineError::Data(_)));
    }

    /// A page scene on a pdf-language printer: one PDF unit, a PDF
    /// preview.
    #[test]
    fn a_page_scene_prepares_one_pdf_unit() {
        let template = Template {
            format: Format::Scene,
            html: None,
            media: TemplateMedia::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
            fields: Vec::new(),
            elements: vec![Element::Text {
                at: pn_scene::At {
                    x_mm: 20.0,
                    y_mm: 20.0,
                },
                size: Size {
                    w_mm: 100.0,
                    h_mm: 10.0,
                },
                content: "TOTAL 12.00".into(),
                style: TextStyle {
                    size_mm: 5.0,
                    font: None,
                    bold: false,
                    italic: false,
                    align: Align::Left,
                },
                page: Placement::Every,
            }],
            fonts: vec![],
        };
        let units = prepare_units(
            &template,
            &page_profile(),
            &Records::from_json("[{}]").unwrap(),
            1,
        )
        .expect("the page scene renders to pdf");
        assert_eq!(units.report.path, "pdf");
        assert_eq!(units.report.units, 1);
        assert_eq!(units.document_format, "application/pdf");
        let preview = units
            .report
            .preview
            .as_ref()
            .expect("the job previews its pages");
        assert_eq!(preview.len(), 1, "the whole document is one PDF");
        match &preview[0] {
            Preview::Pdf { pdf } => assert!(pdf.starts_with(b"%PDF-")),
            other => panic!("expected a pdf preview, got {other:?}"),
        }
    }

    /// The document track: one PDF per record, or an honest no-browser
    /// error where no headless browser is installed.
    #[test]
    fn an_html_document_previews_a_pdf_or_says_there_is_no_browser() {
        let template = Template {
            format: Format::Html,
            html: Some(
                "<!doctype html><html><head><meta charset=\"utf-8\"><style>\
                 @page{size:210mm 297mm;margin:20mm}</style></head>\
                 <body><h1>{{title}}</h1></body></html>"
                    .into(),
            ),
            media: TemplateMedia::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
            fields: vec![Field {
                name: "title".into(),
                kind: Default::default(),
            }],
            elements: Vec::new(),
            fonts: vec![],
        };
        let records = Records::from_json(r#"[{"title":"INVOICE 1042"}]"#).unwrap();
        match prepare_units(&template, &page_profile(), &records, 1) {
            Ok(units) => {
                assert_eq!(units.report.path, "browser");
                assert_eq!(units.report.units, 1, "one document per record");
                let preview = units
                    .report
                    .preview
                    .as_ref()
                    .expect("the job previews its pages");
                assert_eq!(preview.len(), 1, "one document per record");
                match &preview[0] {
                    Preview::Pdf { pdf } => assert!(pdf.starts_with(b"%PDF-")),
                    other => panic!("expected a pdf preview, got {other:?}"),
                }
            }
            Err(PipelineError::Document(words)) => {
                assert!(
                    words.to_lowercase().contains("browser"),
                    "the honest error names the missing browser: {words}"
                );
            }
            Err(e) => panic!("unexpected error: {e}"),
        }
    }

    /// The whole thermal track against a live (fake) printer: prepared
    /// native units are delivered over TCP, the reply confirms.
    #[test]
    fn a_prepared_job_prints_confirmed_over_tcp() {
        let fake = FakePrinter::spawn(true);
        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 1)
            .expect("the scene fits the native path");
        let factory = tcp_factory(fake.port);
        let result = print_units(&units.spec, &zpl_profile(), &factory);
        assert_eq!(result, JobResult::Confirmed, "the reply says ready");
        // The fake logs the payload as its reader thread pulls it off
        // the socket — wait for the last bytes to be logged.
        let mut received = Vec::new();
        for _ in 0..500 {
            received = fake.received();
            let text = String::from_utf8_lossy(&received);
            if text.contains("BOLT M8") && text.contains("NUT M8") {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let text = String::from_utf8_lossy(&received);
        assert!(
            text.contains("^XA"),
            "the native stream reached the printer"
        );
        assert!(text.contains("BOLT M8"), "the binding made it to the wire");
    }

    /// A fault before print is an honest failure with the printer's
    /// own words.
    #[test]
    fn a_printer_fault_before_print_fails_honestly() {
        let fake = FakePrinter::spawn(false);
        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 1)
            .expect("the scene fits the native path");
        let factory = tcp_factory(fake.port);
        let report = report_of(print_units(&units.spec, &zpl_profile(), &factory));
        assert_eq!(report.result, "failed");
        assert!(
            report.reason.as_deref().unwrap().contains("out of paper"),
            "the printer's own words: {:?}",
            report.reason
        );
    }

    /// A refused port is a failed job, and the reason says connect.
    #[test]
    fn a_refused_port_fails_with_a_connect_reason() {
        // Bind and drop a listener to learn a port that is (just)
        // closed.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 1)
            .expect("the scene fits the native path");
        let factory = tcp_factory(port);
        let report = report_of(print_units(&units.spec, &zpl_profile(), &factory));
        assert_eq!(report.result, "failed");
        assert!(
            report.reason.as_deref().unwrap().contains("connect"),
            "the reason says connect: {:?}",
            report.reason
        );
    }

    /// Delivery through the app's own transports: a prepared job goes
    /// out the old raw-TCP wire (probe, then bytes, per unit) and the
    /// honest result is "sent to the printer" — the app's transports
    /// confirm nothing, and nothing failed.
    #[test]
    fn the_app_transport_delivers_a_prepared_job_over_the_old_wire() {
        let fake = FakeRawPrinter::spawn(true);
        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 1)
            .expect("the scene fits the native path");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let factory = AppTransportFactory::new(
            crate::transport::PrinterType::RawTcp,
            "fake",
            &format!("127.0.0.1:{}", fake.port),
            crate::transport::TransportSettings::default(),
            crate::transport::PrinterLanguage::Zpl,
            units.document_format,
            "job-1",
            "fake",
            runtime.handle().clone(),
        );
        let report = report_of(print_units(&units.spec, &zpl_profile(), &factory));
        assert_eq!(
            report.result, "sent_unconfirmed",
            "nothing was confirmed, and nothing failed"
        );
        // The fake's accept thread serves the job's connection a moment
        // after the probe's, and it logs the payload as it reads it —
        // wait for the last bytes to be logged instead of racing them.
        let mut received = Vec::new();
        for _ in 0..500 {
            received = fake.received();
            let text = String::from_utf8_lossy(&received);
            if text.contains("BOLT M8") && text.contains("NUT M8") {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let text = String::from_utf8_lossy(&received);
        assert!(
            text.contains("^XA"),
            "the native stream reached the printer"
        );
        assert!(
            text.contains("BOLT M8"),
            "the first binding made it to the wire"
        );
        assert!(
            text.contains("NUT M8"),
            "the second binding made it to the wire"
        );
        runtime.shutdown_timeout(Duration::from_secs(1));
    }

    /// The old transport's own pre-send probe is the fault detection on
    /// this path: a faulted printer fails the job before the bytes, in
    /// the transport's own words.
    #[test]
    fn the_app_transport_reports_the_old_wire_fault_before_printing() {
        let fake = FakeRawPrinter::spawn(false);
        let units = prepare_units(&label_template(false), &zpl_profile(), &two_records(), 1)
            .expect("the scene fits the native path");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let factory = AppTransportFactory::new(
            crate::transport::PrinterType::RawTcp,
            "fake",
            &format!("127.0.0.1:{}", fake.port),
            crate::transport::TransportSettings::default(),
            crate::transport::PrinterLanguage::Zpl,
            units.document_format,
            "job-1",
            "fake",
            runtime.handle().clone(),
        );
        let report = report_of(print_units(&units.spec, &zpl_profile(), &factory));
        assert_eq!(report.result, "failed");
        assert!(
            report.reason.as_deref().unwrap().contains("out of paper"),
            "the transport's own words: {:?}",
            report.reason
        );
        // The probe's own query bytes are expected on the wire; the
        // job's are not.
        let received = fake.received();
        assert!(
            !String::from_utf8_lossy(&received).contains("^XA"),
            "no job bytes went out at the fault"
        );
        runtime.shutdown_timeout(Duration::from_secs(1));
    }

    /// The printer list reports language, media and confirmation
    /// honestly.
    #[test]
    fn profile_infos_report_language_media_and_confirmation() {
        let dir = scratch_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("fake-label.toml"),
            r#"[profile]
model = "Fake Label"
language = "zpl"
media = ["label"]
[status]
query = "~HS"
expected_prefix = "\u0002"
"#,
        )
        .unwrap();
        let set = load_profiles(&dir).expect("one valid profile");
        let infos = profile_infos(&set);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(infos.len(), 1);
        let info = &infos[0];
        assert_eq!(info.model, "Fake Label");
        assert_eq!(info.language, "zpl");
        assert_eq!(info.media, vec!["label".to_string()]);
        assert!(
            info.can_confirm,
            "a status dialect means confirmed is reachable"
        );
        // No [delivery] in the file: the shipped defaults flow through.
        assert_eq!(info.delivery.chunk_bytes, 1024);
        assert_eq!(info.delivery.pause_ms, 10);
        assert_eq!(info.delivery.close_delay_ms, 500);
    }

    /// A saved delivery override changes the job's pacing and close
    /// delay; fields left out keep the profile's own values, and the
    /// shipped profile is never touched.
    #[test]
    fn a_saved_delivery_override_changes_pacing_and_close_delay() {
        let base = zpl_profile();
        assert_eq!(base.delivery.pause_ms, 10);

        let mut settings = BTreeMap::new();
        settings.insert(
            delivery_key(&base.profile.model),
            r#"{"pauseMs":50}"#.to_string(),
        );
        let overridden = with_delivery_overrides(&base, &settings);
        assert_eq!(overridden.delivery.pause_ms, 50);
        assert_eq!(
            overridden.delivery.chunk_bytes, base.delivery.chunk_bytes,
            "a field left out keeps the profile's value"
        );
        assert_eq!(
            overridden.delivery.close_delay_ms, base.delivery.close_delay_ms,
            "a field left out keeps the profile's value"
        );
        assert_eq!(
            base.delivery.pause_ms, 10,
            "the shipped profile stays as the file has it"
        );

        let untouched = with_delivery_overrides(&base, &BTreeMap::new());
        assert_eq!(untouched.delivery.pause_ms, 10);

        let mut bad = BTreeMap::new();
        bad.insert(delivery_key(&base.profile.model), "not json".to_string());
        assert_eq!(
            with_delivery_overrides(&base, &bad).delivery.pause_ms,
            10,
            "an override that does not parse is dropped, not a failure"
        );
    }

    // ── Printer mapping (WP3) ─────────────────────────────────────

    /// A stored row for the mapping tests: only the fields the mapping
    /// consults vary; everything else is the built-in default.
    fn stored_row(
        language: &str,
        dpi: Option<i64>,
        width_mm: Option<i64>,
    ) -> crate::commands::print::StoredPrinter {
        crate::commands::print::StoredPrinter {
            printer_type: "raw_tcp".into(),
            address: "127.0.0.1:9100".into(),
            language: language.into(),
            paper_width_mm: width_mm,
            dpi,
            label_gap_mm: None,
            label_profile: None,
            tspl: crate::transport::label_langs::tspl::TsplTuning::from_settings_json(None),
            escpos: crate::transport::escpos::EscPosTuning::from_settings_json(None),
            bluetooth: crate::transport::BluetoothDelivery::from_settings_json(None),
            username: None,
            password: None,
            skip_tls_verification: false,
            via_driver: false,
        }
    }

    /// A row without a pick takes the language-based default model,
    /// and a raster row takes the ESC/POS base — on the wire it is an
    /// ESC/POS printer.
    #[test]
    fn a_row_without_a_pick_takes_the_language_default() {
        for (language, model, want) in [
            ("pdf", "office-laser-cups", pn_profiles::Language::Pdf),
            ("zpl", "zt411", pn_profiles::Language::Zpl),
            ("tspl", "ql-820nwb", pn_profiles::Language::Tspl),
            ("cpcl", "ct-s500", pn_profiles::Language::Cpcl),
            (
                "escpos",
                "generic-thermal-58mm",
                pn_profiles::Language::Escpos,
            ),
            (
                "raster",
                "generic-thermal-58mm",
                pn_profiles::Language::Escpos,
            ),
        ] {
            let (profile, choice) =
                resolve_profile_for_printer(&stored_row(language, None, None)).unwrap();
            assert_eq!(choice.model, model, "language {language}");
            assert!(!choice.user_chosen, "language {language}");
            assert_eq!(profile.profile.language, want, "language {language}");
            assert_eq!(
                profile.profile.dpi,
                Some(203),
                "language {language}: a row without a dpi keeps 203"
            );
        }
    }

    /// The default path maps the row's geometry exactly as WP2 did:
    /// the row's width wins, its head is recomputed, the dpi falls
    /// back to 203.
    #[test]
    fn the_default_mapping_keeps_the_row_geometry() {
        let (profile, choice) =
            resolve_profile_for_printer(&stored_row("zpl", None, Some(58))).unwrap();
        assert!(!choice.user_chosen);
        let meta = &profile.profile;
        assert_eq!(meta.dpi, Some(203));
        assert_eq!(meta.printable_width_mm, Some(58.0), "the row's width wins");
        assert_eq!(
            meta.head_width_dots,
            Some(464),
            "round(203 dpi × 58 mm / 25.4)"
        );
    }

    /// A user pick changes which bundled model the job runs on; the
    /// row's own geometry is applied on top of it — dpi and width win
    /// over the model's values, and the head is recomputed with them
    /// so the validator's cross-check holds.
    #[test]
    fn a_picked_model_drives_the_job_and_the_row_geometry_wins() {
        let mut row = stored_row("escpos", Some(300), Some(100));
        row.label_profile = Some("tm-t88vii".into());
        let (profile, choice) = resolve_profile_for_printer(&row).unwrap();
        assert_eq!(choice.model, "tm-t88vii");
        assert!(choice.user_chosen);
        let meta = &profile.profile;
        assert_eq!(
            meta.language,
            pn_profiles::Language::Escpos,
            "the pick's language"
        );
        assert_eq!(meta.dpi, Some(300), "the row's dpi wins");
        assert_eq!(meta.printable_width_mm, Some(100.0), "the row's width wins");
        assert_eq!(
            meta.head_width_dots,
            Some(1181),
            "recomputed: round(300 × 100 / 25.4)"
        );
    }

    /// A pick on a row that carries no geometry of its own: the
    /// model's values stand, and a pick whose model has no geometry
    /// at all leaves the bundled profile untouched.
    #[test]
    fn a_pick_without_row_geometry_keeps_the_bundled_values() {
        let mut row = stored_row("zpl", None, None);
        row.label_profile = Some("zt411".into());
        let (profile, choice) = resolve_profile_for_printer(&row).unwrap();
        assert!(choice.user_chosen);
        let base = pn_profiles::parse(embedded_text("zt411")).unwrap();
        assert_eq!(profile.profile.model, base.profile.model);
        assert_eq!(profile.profile.dpi, base.profile.dpi);
        assert_eq!(
            profile.profile.head_width_dots,
            base.profile.head_width_dots
        );

        let mut pdf_row = stored_row("pdf", None, None);
        pdf_row.label_profile = Some("office-laser-cups".into());
        let (profile, choice) = resolve_profile_for_printer(&pdf_row).unwrap();
        assert!(choice.user_chosen);
        let base = pn_profiles::parse(embedded_text("office-laser-cups")).unwrap();
        assert_eq!(profile.profile.model, base.profile.model);
        assert_eq!(profile.profile.dpi, base.profile.dpi, "nothing to override");
    }

    /// A pick must name a bundled profile and speak the row's
    /// language family — a raster row takes the ESC/POS family.
    #[test]
    fn a_pick_outside_the_row_language_family_is_refused() {
        let mut row = stored_row("zpl", None, None);
        row.label_profile = Some("generic-thermal-58mm".into());
        let err = resolve_profile_for_printer(&row).unwrap_err();
        assert!(err.contains("escpos"), "{err}");
        assert!(err.contains("zpl"), "{err}");

        let err = validate_profile_pick("no-such-model", "zpl").unwrap_err();
        assert!(err.contains("no-such-model"), "{err}");
        assert!(err.contains("zt411"), "the known ids are named: {err}");

        // The same pick fits a raster row: on the wire it is ESC/POS.
        let mut raster = stored_row("raster", None, None);
        raster.label_profile = Some("generic-thermal-58mm".into());
        let (profile, choice) = resolve_profile_for_printer(&raster).unwrap();
        assert!(choice.user_chosen);
        assert_eq!(profile.profile.language, pn_profiles::Language::Escpos);
    }
}
