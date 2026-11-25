//! Per-profile hardware checklist (phase 2): a minimal job set — text,
//! label, barcode, long job, two jobs back to back — derived from the
//! profile itself, so every printer gets the same shape of test.
//!
//! Execution of the checklist (spawning a job per item, checking the
//! status reply) lands with the Raw Console (phase 1) and the job
//! pipeline (phase 3). This module only *describes* what to print.

use crate::{Language, Media, Profile};

/// The kinds of checklist jobs, in execution order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecklistKind {
    /// A few lines of text: proves the connection and the language.
    MinimalText,
    /// A full label with a title, a field and (if native) a barcode.
    Label,
    /// A long job: many labels, to expose pacing/flow-control problems.
    LongJob,
    /// Two jobs back to back: proves the printer (or the spooler path)
    /// handles consecutive submissions without swallowing the second.
    TwoJobsBackToBack,
    /// Run the profile's status query and confirm a reply.
    StatusQuery,
}

/// One item of a checklist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecklistItem {
    pub kind: ChecklistKind,
    /// Human-readable description for the checklist UI.
    pub description: String,
}

/// Build the checklist for a profile. Document printers (`page` media)
/// run the OS print path instead of paced raw writes, so their items
/// are described accordingly.
pub fn checklist_for(profile: &Profile) -> Vec<ChecklistItem> {
    let is_page = profile
        .profile
        .media
        .iter()
        .any(|m| matches!(m, Media::Page))
        || profile.profile.language == Language::Pdf;

    let mut items = vec![ChecklistItem {
        kind: ChecklistKind::MinimalText,
        description: if is_page {
            "Print the minimal text page through the OS print path".to_string()
        } else {
            format!(
                "Print the minimal text job in {} ({} chunks @ {}ms)",
                profile.profile.language, profile.delivery.chunk_bytes, profile.delivery.pause_ms,
            )
        },
    }];

    if is_page {
        items.push(ChecklistItem {
            kind: ChecklistKind::Label,
            description: "Print a full A4 page (scene template) and confirm \
                          layout, fonts and page count"
                .to_string(),
        });
    } else {
        let mut label = "Print one full label (title, fields, barcode)".to_string();
        if let Some(barcode) = profile.first_native_barcode() {
            label.push_str(&format!(" — barcode {barcode} rendered natively"));
        } else {
            label.push_str(" — barcode rendered as raster (no native symbols)");
        }
        items.push(ChecklistItem {
            kind: ChecklistKind::Label,
            description: label,
        });
        if profile
            .profile
            .media
            .iter()
            .any(|m| matches!(m, Media::Label))
        {
            if let Some(min_gap) = profile.profile.min_gap_dots {
                items.push(ChecklistItem {
                    kind: ChecklistKind::LongJob,
                    description: format!(
                        "Print 50 labels back to back (min gap {min_gap} dots); \
                         no dropped labels, no gaps"
                    ),
                });
            }
        }
    }

    items.push(ChecklistItem {
        kind: ChecklistKind::TwoJobsBackToBack,
        description: if is_page {
            "Submit two jobs in a row; both must reach the spooler and print".to_string()
        } else {
            "Print two jobs in a row; the second must not be swallowed".to_string()
        },
    });

    if profile.answers_status() {
        items.push(ChecklistItem {
            kind: ChecklistKind::StatusQuery,
            description: "Run the status query and confirm the reply \
                          (never block a print on silence)"
                .to_string(),
        });
    }

    items
}

/// The text used by the `MinimalText` item: short, ASCII-safe, and it
/// carries the model name so a mis-routed job is obvious on the paper.
pub fn checklist_text(profile: &Profile) -> String {
    let mut text = String::new();
    text.push_str("PRINTNINJA CHECKLIST\n");
    text.push_str(&format!("model: {}\n", profile.profile.model));
    text.push_str(&format!("language: {}\n", profile.profile.language));
    if let Some(dpi) = profile.profile.dpi {
        text.push_str(&format!("dpi: {dpi}\n"));
    }
    text
}
