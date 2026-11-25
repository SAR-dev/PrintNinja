//! Printer profiles: data, not code (plan §5.4 / §5.10, built in phase 2).
//!
//! One TOML file per model under `profiles/`, shipped with the app and
//! extendable by the user (field-by-field override, see [`merge`]).
//! Adding a printer means adding a profile and running the hardware
//! checklist ([`checklist`]), not changing code.
//!
//! A profile carries a verification status: `verified` (proven on real
//! hardware), `community` (contributed, not ours to verify), or `untested`
//! (the default for new profiles).
//!
//! Schema reference (TOML):
//!
//! ```toml
//! [profile]
//! model = "GK420d"
//! aliases = ["zebra gk420"]
//! status = "untested"            # verified | community | untested
//! language = "zpl"               # zpl | escpos | tspl | cpcl | pdf
//! mode = "zpl"                   # required mode on dual-mode printers
//! dpi = 203
//! head_width_dots = 864
//! printable_width_mm = 104       # consistency-checked against dpi × head
//! media = ["label"]              # label | continuous | page
//! min_gap_dots = 8
//!
//! [fonts]
//! native = ["0", "1", "2", "3", "4"]
//! code_pages = ["437", "850", "1252"]
//! unicode_native = false
//!
//! [barcodes]
//! native = ["CODE128", "EAN13", "QR", "PDF417"]
//!
//! [delivery]
//! chunk_bytes = 1024
//! pause_ms = 10
//! close_delay_ms = 500
//! flow_control = "pace"          # pace | xon-xoff | none
//! keep_open_for_status = true
//!
//! [status]
//! query = "^U"                   # raw bytes, escaped; language-specific
//! expected_prefix = "STATUS"
//! poll_after_ms = 200
//! reports_paper = true
//! reports_cover = false
//! reports_paused = true
//!
//! [[quirks]]
//! id = "needs-finalize"
//! note = "Last line must be followed by ^PKS or a 200ms delay"
//! evidence = "raw-console/2026-11-18-gk420d.txt"
//! ```

mod checklist;
mod load;

pub use checklist::{checklist_for, checklist_text, ChecklistItem, ChecklistKind};
pub use load::{load_dir, merge, parse, ParseError, ProfileSet, ProfileSetError};

use serde::{Deserialize, Serialize};
use std::fmt;

/// Printer language. `Pdf` marks document/network printers delivered
/// through the OS print path — they have no native command language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Zpl,
    Escpos,
    Tspl,
    Cpcl,
    Pdf,
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Language::Zpl => "zpl",
            Language::Escpos => "escpos",
            Language::Tspl => "tspl",
            Language::Cpcl => "cpcl",
            Language::Pdf => "pdf",
        };
        f.write_str(s)
    }
}

/// Verification status of a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Verified,
    Community,
    #[default]
    Untested,
}

/// Media kind a printer handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Media {
    Label,
    Continuous,
    Page,
}

/// Flow control used while writing a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControl {
    #[default]
    Pace,
    XonXoff,
    None,
}

/// The `[profile]` section.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMeta {
    pub model: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub language: Language,
    /// Required mode on dual-mode printers (e.g. `"zpl"`, `"cpcl"`,
    /// `"epl2"`).
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub dpi: Option<u16>,
    #[serde(default)]
    pub head_width_dots: Option<u32>,
    /// Printable width in millimetres. When present together with `dpi`
    /// and `head_width_dots`, the three must agree within one dot
    /// (validation).
    #[serde(default)]
    pub printable_width_mm: Option<f64>,
    /// At least one is required (validation).
    pub media: Vec<Media>,
    #[serde(default)]
    pub min_gap_dots: Option<u32>,
}

/// The `[fonts]` section.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Fonts {
    /// Native font ids/names the printer ships.
    #[serde(default)]
    pub native: Vec<String>,
    /// Code pages the printer can switch to.
    #[serde(default)]
    pub code_pages: Vec<String>,
    /// Native fonts cover Unicode (decides native vs raster fallback).
    #[serde(default)]
    pub unicode_native: bool,
}

/// The `[barcodes]` section.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Barcodes {
    /// Barcode symbols the printer generates natively (anything not
    /// listed is rendered as raster).
    #[serde(default)]
    pub native: Vec<String>,
}

/// The `[delivery]` section: how bytes reach the printer reliably.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delivery {
    /// Chunk size for paced writes.
    #[serde(default = "default_chunk_bytes")]
    pub chunk_bytes: u32,
    /// Pause between chunks, in milliseconds.
    #[serde(default = "default_pause_ms")]
    pub pause_ms: u32,
    /// Hold the connection open this long after the last byte, instead
    /// of a hard-coded value.
    #[serde(default = "default_close_delay_ms")]
    pub close_delay_ms: u32,
    #[serde(default)]
    pub flow_control: FlowControl,
    /// Keep the connection open long enough to read a status reply.
    #[serde(default = "default_true")]
    pub keep_open_for_status: bool,
}

impl Default for Delivery {
    fn default() -> Self {
        Delivery {
            chunk_bytes: default_chunk_bytes(),
            pause_ms: default_pause_ms(),
            close_delay_ms: default_close_delay_ms(),
            flow_control: FlowControl::default(),
            keep_open_for_status: default_true(),
        }
    }
}

fn default_chunk_bytes() -> u32 {
    1024
}
fn default_pause_ms() -> u32 {
    10
}
fn default_close_delay_ms() -> u32 {
    500
}
fn default_true() -> bool {
    true
}

/// The `[status]` section: how the printer answers a status query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusQuery {
    /// Raw query bytes, escaped (language-specific: `"^U"` for ZPL,
    /// `DLE EOT` for ESC/POS, `~HS` for TSPL, `@STA` for CPCL).
    pub query: String,
    /// Prefix expected on the reply. Required when `query` is set
    /// (validation).
    #[serde(default)]
    pub expected_prefix: Option<String>,
    /// Wait this long after sending the query before reading.
    #[serde(default = "default_poll_after_ms")]
    pub poll_after_ms: u32,
    #[serde(default = "default_true")]
    pub reports_paper: bool,
    #[serde(default)]
    pub reports_cover: bool,
    #[serde(default = "default_true")]
    pub reports_paused: bool,
}

fn default_poll_after_ms() -> u32 {
    200
}

/// A `[[quirks]]` entry. Every quirk must carry evidence — a quirk
/// without a captured Raw Console session is a bug in the profile, not a
/// feature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quirk {
    pub id: String,
    pub note: String,
    /// Link to the evidence (the Raw Console session that proved it).
    pub evidence: String,
}

/// A printer profile: one TOML file per model. Every section except
/// `[status]` and `[[quirks]]` is optional in the file and falls back
/// to a documented default; `[status]` has no sensible default query,
/// so it stays `Option`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub profile: ProfileMeta,
    #[serde(default)]
    pub fonts: Fonts,
    #[serde(default)]
    pub barcodes: Barcodes,
    #[serde(default)]
    pub delivery: Delivery,
    #[serde(default)]
    pub status: Option<StatusQuery>,
    #[serde(default)]
    pub quirks: Vec<Quirk>,
}

impl Profile {
    /// Validate the profile's cross-field rules (plan §5.10).
    pub fn validate(&self) -> Result<(), ProfileError> {
        let m = &self.profile;
        if m.model.trim().is_empty() {
            return Err(ProfileError::EmptyModel);
        }
        if m.media.is_empty() {
            return Err(ProfileError::NoMedia);
        }
        if let Some(s) = &self.status {
            if !s.query.trim().is_empty()
                && s.expected_prefix
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
            {
                return Err(ProfileError::StatusPrefixMissing);
            }
        }
        if let (Some(head), Some(dpi), Some(mm)) = (m.head_width_dots, m.dpi, m.printable_width_mm)
        {
            let expected = (dpi as f64 * mm / 25.4).round() as u32;
            if head.abs_diff(expected) > 1 {
                return Err(ProfileError::WidthMismatch { head, expected });
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for q in &self.quirks {
            if q.note.trim().is_empty() {
                return Err(ProfileError::QuirkEmptyNote { id: q.id.clone() });
            }
            if q.evidence.trim().is_empty() {
                return Err(ProfileError::QuirkMissingEvidence { id: q.id.clone() });
            }
            if !seen.insert(q.id.as_str()) {
                return Err(ProfileError::DuplicateQuirk { id: q.id.clone() });
            }
        }
        Ok(())
    }

    /// The first native barcode symbol, if any.
    pub fn first_native_barcode(&self) -> Option<&str> {
        self.barcodes.native.first().map(String::as_str)
    }

    /// True when the printer's native fonts cover Unicode.
    pub fn unicode_native(&self) -> bool {
        self.fonts.unicode_native
    }

    /// True when the profile carries a status query the transport should
    /// run (and never block a print on silence — plan §5.7).
    pub fn answers_status(&self) -> bool {
        self.status
            .as_ref()
            .is_some_and(|s| !s.query.trim().is_empty())
    }
}

/// Cross-field validation failures (plan §5.10 rules).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProfileError {
    #[error("empty model name")]
    EmptyModel,
    #[error("no media types listed")]
    NoMedia,
    #[error("status.query is set but expected_prefix is missing")]
    StatusPrefixMissing,
    #[error(
        "head_width_dots ({head}) disagrees with dpi × printable_width_mm ({expected}) by more than one dot"
    )]
    WidthMismatch { head: u32, expected: u32 },
    #[error("duplicate quirk id '{id}'")]
    DuplicateQuirk { id: String },
    #[error("quirk '{id}' has no evidence")]
    QuirkMissingEvidence { id: String },
    #[error("quirk '{id}' has an empty note")]
    QuirkEmptyNote { id: String },
}
