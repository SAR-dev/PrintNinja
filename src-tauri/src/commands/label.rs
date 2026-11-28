//! The label track's IPC surface (LABEL_PRINTING_PLAN.md, WP2).
//!
//! Six commands, all keyed on the template's `track` column: saving a
//! scene template (`track = 'scene'`, payload in `scene_json` — a fresh
//! row, or an in-place re-save of one the designer already wrote),
//! preparing one (validate → plan → render, no wire), printing one (the
//! prepared units go out over this app's own transports under the
//! printer's queue permit), listing the bundled printer profiles,
//! previewing an unsaved scene straight from the designer, and encoding
//! a barcode/QR symbol for the designer's canvas. The track follows the
//! template, not the printer's whim: `html` rows are refused here and
//! stay on the existing document path (`print_html`).

use std::time::Instant;

use crate::commands::print::{close_job, lookup_printer, validate_http_method, StoredPrinter};
use crate::commands::template::{self, CreateTemplateRequest};
use crate::data::fetcher::{DataFetcher, FetchOptions};
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::label_pipeline::{
    default_model_for_language, embedded_profile_set, prepare_units, print_units, profile_infos,
    report_of, resolve_profile_for_printer, validate_profile_pick, AppTransportFactory, JobReport,
    PrepareReport, ProfileChoice, ProfileInfo,
};
use crate::queue::PrintQueue;
use pn_profiles::Profile;
use pn_render::{barcode_modules, qr_matrix, QR_QUIET_MODULES, QUIET_MODULES};
use pn_scene::{BarcodeKind, Records, Template};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Save a scene template: validate the payload, then write a
/// `track = 'scene'` row. Without `id` this is a fresh row through the
/// html track's write path (name uniqueness, readme scaffolding and sync
/// bookkeeping behave exactly as they do for document templates); with
/// `id` it re-saves that row in place, because the server is html-only
/// and a scene row's local copy is the whole truth.
#[derive(Debug, Deserialize)]
pub struct LabelSaveTemplateRequest {
    pub name: String,
    /// The scene template as the designer serializes it.
    pub scene: String,
    /// The row's local id when re-saving an existing scene template.
    /// Absent (or null) for a new template.
    #[serde(default)]
    pub id: Option<i64>,
}

#[tauri::command]
pub fn label_save_template(
    db: State<DbState>,
    req: LabelSaveTemplateRequest,
) -> AppResult<template::Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    if let Some(id) = req.id {
        return template::update_scene_template(conn, id, &req.name, &req.scene);
    }
    let inner = CreateTemplateRequest {
        name: req.name,
        page_w_mm: None,
        page_h_mm: None,
        orientation: None,
        html: None,
        css: None,
        compiled_css: None,
        compiled_key: None,
        readme: None,
        summary: None,
        track: Some("scene".into()),
        scene_json: Some(req.scene),
        server_id: None,
        sync_state: None,
        kind: None,
        owner_handle: None,
        server_revision: None,
        base_revision: None,
    };
    template::write_template(conn, &inner)
}

/// What one encoded symbol looks like on the designer's canvas: a row
/// of modules (1 dark, 0 light — a QR matrix is `side × side`, read
/// row-major) plus the quiet zone the symbol needs around it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolEncoding {
    /// Quiet-zone modules on every side, at the symbol's own scale.
    pub quiet: usize,
    pub modules: Vec<u8>,
    /// The QR matrix's side in modules; absent for linear barcodes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<usize>,
}

/// Encode a barcode or QR value the way the renderer will draw it, so
/// the canvas can show the real symbol and whether it fits its box.
/// `None` when the value cannot be encoded in that symbology.
#[tauri::command]
pub fn label_encode_symbol(kind: String, value: String) -> Option<SymbolEncoding> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if kind == "qr" {
        return qr_matrix(value).map(|m| SymbolEncoding {
            quiet: QR_QUIET_MODULES,
            modules: m.modules,
            side: Some(m.side),
        });
    }
    let kind = match kind.as_str() {
        "code39" => BarcodeKind::Code39,
        "code93" => BarcodeKind::Code93,
        "ean13" => BarcodeKind::Ean13,
        "upca" => BarcodeKind::Upca,
        "itf" => BarcodeKind::Itf,
        _ => BarcodeKind::Code128,
    };
    barcode_modules(&kind, value).map(|modules| SymbolEncoding {
        quiet: QUIET_MODULES,
        modules,
        side: None,
    })
}

/// Prepare an unsaved scene — the designer's preview: the scene JSON
/// straight from the editor, a saved printer, and the data it would
/// print. Same report shape as [`label_prepare`], minus the template
/// row.
#[derive(Debug, Deserialize)]
pub struct LabelPreviewRequest {
    /// The scene template as the designer serializes it.
    pub scene: String,
    /// The saved printer's name.
    pub printer: String,
    /// The preview's data as JSON — one record or an array of them.
    pub records: String,
    /// Sets to preview; defaults to one.
    #[serde(default)]
    pub copies: Option<u32>,
}

#[tauri::command]
pub async fn label_preview(
    db: State<'_, DbState>,
    req: LabelPreviewRequest,
) -> AppResult<LabelPrepareResponse> {
    let stored = lookup_printer(&db, &req.printer).ok_or_else(|| {
        AppError::NotFound(format!(
            "Printer '{}' is not saved; add it in Settings",
            req.printer
        ))
    })?;
    let (profile, choice) = resolve_profile_for_printer(&stored).map_err(AppError::Validation)?;
    let mut template = Template::from_json(&req.scene)
        .map_err(|e| AppError::Validation(format!("the scene is not valid: {e}")))?;
    template
        .validate()
        .map_err(|e| AppError::Validation(format!("the scene is not valid: {e}")))?;
    attach_uploaded_fonts(&db, &mut template);
    let records =
        Records::from_json(&req.records).map_err(|e| AppError::Validation(e.to_string()))?;
    let copies = req.copies.unwrap_or(1).max(1);
    let choice = choice.clone();
    tokio::task::spawn_blocking(move || prepare_units(&template, &profile, &records, copies))
        .await
        .map_err(|e| AppError::Internal(format!("the preview task ended before finishing: {e}")))?
        .map_err(|e| AppError::Validation(e.to_string()))
        .map(|units| LabelPrepareResponse {
            profile: choice.model,
            profile_source: if choice.user_chosen {
                "user"
            } else {
                "default"
            },
            report: units.report,
        })
}

/// One scene job's request: which template, which printer, which data,
/// how many sets. `records` is the job's data as JSON — one record or an
/// array of them, the shape `pn_scene::Records` takes.
#[derive(Debug, Deserialize)]
pub struct LabelJobRequest {
    pub template_id: i64,
    /// The saved printer's name.
    pub printer: String,
    pub records: String,
    /// Sets to print; defaults to one.
    #[serde(default)]
    pub copies: Option<u32>,
    /// Test print: use the supplied records as sample data, never a URL.
    #[serde(default)]
    pub test: Option<bool>,
    /// Fetch records from this URL with the same limits as `print_html`.
    #[serde(default)]
    pub data_url: Option<String>,
    #[serde(default)]
    pub http_method: Option<String>,
    /// Inline records (a deep link's `data`), as JSON.
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

/// Give a scene template the uploaded fonts its text names. The bytes
/// ride in the in-memory template only (never saved back), so the
/// renderer draws the same dots on every device and the stored scene
/// stays small. A family the template embeds itself, or one that is not
/// uploaded as TrueType/OpenType here, is left alone: that text draws in
/// the default font.
fn attach_uploaded_fonts(db: &DbState, template: &mut Template) {
    let wanted: Vec<String> = template
        .font_families()
        .into_iter()
        .filter(|f| {
            !template
                .fonts
                .iter()
                .any(|t| t.family.eq_ignore_ascii_case(f))
        })
        .collect();
    if wanted.is_empty() {
        return;
    }
    let Ok(guard) = db.lock() else {
        return;
    };
    let fonts = crate::commands::font::scene_fonts_for(guard.connection(), &wanted);
    template.fonts.extend(fonts);
}

/// What a scene job resolves to before anything is prepared.
struct SceneJob {
    template: Template,
    profile: Profile,
    /// The model the row prints with, and whether the user picked it
    /// (WP3) — the prepare report shows it.
    choice: ProfileChoice,
    records: Records,
    /// The printer's display name — the queue's per-printer key.
    printer_name: String,
    /// The printer's row id, for the job row's `printer_id`.
    printer_id: Option<i64>,
    /// The saved row the transport is built from.
    stored: StoredPrinter,
}

/// Load the template row, require the scene track, look the printer up
/// and build the profile it prints with. The DB is only held for the two
/// reads, so the callers may await after this returns.
fn resolve_scene_job(
    db: &DbState,
    template_id: i64,
    printer: &str,
    records_json: &str,
) -> AppResult<SceneJob> {
    let (track, scene, printer_id): (String, Option<String>, Option<i64>) = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        let (track, scene) = conn
            .query_row(
                "SELECT track, scene_json FROM templates
                 WHERE id = ?1 AND sync_state <> 'deleted_pending'",
                [template_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::NotFound(format!("Template {template_id} not found"))
                }
                other => other.into(),
            })?;
        let printer_id = conn
            .query_row(
                "SELECT id FROM printers WHERE name = ?1 COLLATE NOCASE",
                [printer],
                |r| r.get(0),
            )
            .ok();
        (track, scene, printer_id)
    };

    if track != "scene" {
        return Err(AppError::Validation(format!(
            "Template {template_id} is on the '{track}' track; the label commands take scene templates"
        )));
    }
    let scene = scene.ok_or_else(|| {
        AppError::Validation("this scene template has no scene_json payload".into())
    })?;
    // Label jobs print with a saved printer's geometry: an unsaved
    // printer has no profile to plan against.
    let stored = lookup_printer(db, printer).ok_or_else(|| {
        AppError::NotFound(format!(
            "Printer '{printer}' is not saved; add it in Settings"
        ))
    })?;
    let mut template = Template::from_json(&scene)
        .map_err(|e| AppError::Validation(format!("the template's scene is not valid: {e}")))?;
    attach_uploaded_fonts(db, &mut template);
    let records =
        Records::from_json(records_json).map_err(|e| AppError::Validation(e.to_string()))?;
    let (profile, choice) = resolve_profile_for_printer(&stored).map_err(AppError::Validation)?;

    Ok(SceneJob {
        template,
        profile,
        choice,
        records,
        printer_name: printer.to_string(),
        printer_id,
        stored,
    })
}

/// What a prepared scene job would print, and which model the row
/// prints it with (WP3: the user's pick, or the language-based
/// default — the UI shows the latter as "auto").
#[derive(Debug, Clone, Serialize)]
pub struct LabelPrepareResponse {
    #[serde(flatten)]
    pub report: PrepareReport,
    /// The bundled model id the job prepared against.
    pub profile: String,
    /// "user" when the row carries a pick, "default" otherwise.
    pub profile_source: &'static str,
}

/// Prepare a scene job — validate, plan, render — and report what it
/// would print, without sending anything.
#[tauri::command]
pub async fn label_prepare(
    db: State<'_, DbState>,
    req: LabelJobRequest,
) -> AppResult<LabelPrepareResponse> {
    let scene_job = resolve_scene_job(&db, req.template_id, &req.printer, &req.records)?;
    let copies = req.copies.unwrap_or(1).max(1);
    let choice = scene_job.choice.clone();
    tokio::task::spawn_blocking(move || {
        prepare_units(
            &scene_job.template,
            &scene_job.profile,
            &scene_job.records,
            copies,
        )
    })
    .await
    .map_err(|e| AppError::Internal(format!("the prepare task ended before finishing: {e}")))?
    .map_err(|e| AppError::Validation(e.to_string()))
    .map(|units| LabelPrepareResponse {
        profile: choice.model,
        profile_source: if choice.user_chosen {
            "user"
        } else {
            "default"
        },
        report: units.report,
    })
}

/// What a printed scene job answered, in the shape the UI shows.
#[derive(Debug, Serialize)]
pub struct LabelPrintResponse {
    pub job_id: i64,
    pub report: JobReport,
    pub duration_ms: i64,
}

/// Open the `printing` job row before anything slow, the same
/// convention as the document path: the row is visible in History while
/// the job runs, and a failure reports its own row's id.
#[allow(clippy::too_many_arguments)]
fn begin_label_job(
    db: &DbState,
    template_id: i64,
    printer_id: Option<i64>,
    copies: u32,
    records: &str,
    source: &str,
    is_test: bool,
    requested_by_device_id: Option<&str>,
) -> AppResult<i64> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let settings = serde_json::json!({ "track": "scene", "copies": copies });
    conn.execute(
        "INSERT INTO print_jobs (template_id, printer_id, source, status, copies,
                settings_json, rendered_html, is_test, started_at, data_json,
                requested_by_device_id)
         VALUES (?1, ?2, ?3, 'printing', ?4, ?5, '', ?6, datetime('now'), ?7, ?8)",
        rusqlite::params![
            template_id,
            printer_id,
            source,
            copies as i64,
            settings.to_string(),
            is_test as i64,
            records,
            requested_by_device_id
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The job row's terminal state for a delivery result: the honest word
/// lives in the report, the row only records whether the job came back
/// as a whole or not.
fn job_status(report: &JobReport) -> (&'static str, Option<String>) {
    match report.result.as_str() {
        "confirmed" | "sent_unconfirmed" => ("success", None),
        "partially_printed" => {
            let reason = report
                .reason
                .clone()
                .unwrap_or_else(|| "the printer stopped mid-job".into());
            let text = match report.counts {
                Some((printed, total)) => format!("{printed} of {total} units printed: {reason}"),
                None => reason,
            };
            ("failed", Some(text))
        }
        _ => (
            "failed",
            report
                .reason
                .clone()
                .or_else(|| Some("the job did not print".into())),
        ),
    }
}

/// One scene print as the shared runner is fed it (LABEL_PRINTING_PLAN.md,
/// WP5): the same inputs the `label_print` command takes, so the REST API
/// and the worker's retry path can drive the pipeline without the command
/// envelope.
pub(crate) struct LabelJobRun {
    pub template_id: i64,
    pub printer: String,
    pub records_json: String,
    pub copies: u32,
    pub source: &'static str,
    pub is_test: bool,
    pub requested_by_device_id: Option<String>,
}

/// A finished scene job: its row, the honest report, the terminal status
/// the row closed with, and the error text on failure.
pub(crate) struct LabelJobOutcome {
    pub job_id: i64,
    pub report: JobReport,
    pub status: String,
    pub error: Option<String>,
    pub duration_ms: i64,
}

/// Print a scene job: prepare it, then deliver its units over the
/// printer's own transport under that printer's queue permit. The job
/// row closes with the result; the report keeps the plain words.
///
/// `job_id` reuses an existing row (the worker's retry of a scene row);
/// `None` opens a fresh one from `run`.
pub(crate) async fn run_label_job(
    db: &DbState,
    queue: &PrintQueue,
    job_id: Option<i64>,
    run: &LabelJobRun,
) -> AppResult<LabelJobOutcome> {
    let started = Instant::now();
    let scene_job = resolve_scene_job(db, run.template_id, &run.printer, &run.records_json)?;
    let copies = run.copies.max(1);

    let job_id = match job_id {
        Some(job_id) => job_id,
        None => begin_label_job(
            db,
            run.template_id,
            scene_job.printer_id,
            copies,
            &run.records_json,
            run.source,
            run.is_test,
            run.requested_by_device_id.as_deref(),
        )?,
    };
    let duration = |started: &Instant| started.elapsed().as_millis() as i64;

    let profile = scene_job.profile;
    let units = match tokio::task::spawn_blocking({
        let prepare_profile = profile.clone();
        move || {
            prepare_units(
                &scene_job.template,
                &prepare_profile,
                &scene_job.records,
                copies,
            )
        }
    })
    .await
    {
        Ok(Ok(units)) => units,
        Ok(Err(e)) => {
            let _ = close_job(
                db,
                job_id,
                "failed",
                Some(e.to_string()),
                "",
                &[],
                duration(&started),
                None,
            );
            return Err(AppError::Validation(e.to_string()));
        }
        Err(e) => {
            let reason = format!("the prepare task ended before finishing: {e}");
            let _ = close_job(
                db,
                job_id,
                "failed",
                Some(reason.clone()),
                "",
                &[],
                duration(&started),
                None,
            );
            return Err(AppError::Internal(reason));
        }
    };

    let stored = scene_job.stored;
    let printer_name = scene_job.printer_name;
    // The runtime this command runs on: the adapter blocks delivery onto
    // it, so it must be this one, not a fresh one the task invents.
    let factory = AppTransportFactory::new(
        crate::transport::parse_printer_type(&stored.printer_type),
        &printer_name,
        &stored.address,
        crate::transport::TransportSettings {
            username: stored.username,
            password: stored.password,
            skip_tls_verification: stored.skip_tls_verification,
            via_driver: stored.via_driver,
            bluetooth: stored.bluetooth,
        },
        crate::transport::parse_printer_language(&stored.language),
        units.document_format,
        &job_id.to_string(),
        &printer_name,
        tokio::runtime::Handle::current(),
    );

    // Two jobs for the same printer must never overlap, so the delivery
    // holds the printer's permit; the blocking run lives in a task, the
    // way the document path does its sends.
    let result = queue
        .with_permit(&printer_name, async move {
            tokio::task::spawn_blocking(move || print_units(&units.spec, &profile, &factory))
                .await
                .map_err(|e| format!("the delivery task ended before finishing: {e}"))
        })
        .await;
    let result = match result {
        Ok(result) => result,
        Err(e) => {
            let _ = close_job(
                db,
                job_id,
                "failed",
                Some(e.clone()),
                "",
                &[],
                duration(&started),
                None,
            );
            return Err(AppError::Internal(e));
        }
    };

    let report = report_of(result);
    let (status, error) = job_status(&report);
    close_job(
        db,
        job_id,
        status,
        error.clone(),
        "",
        &[],
        duration(&started),
        Some(report.result.as_str()),
    )?;

    Ok(LabelJobOutcome {
        job_id,
        report,
        status: status.to_string(),
        error,
        duration_ms: duration(&started),
    })
}

/// Print a scene job from the app: the shared runner over a fresh job
/// row, with the IPC response shape the print screen reads.
/// Resolve the records a scene job prints, with the same data sources and
/// limits the html track uses: inline deep-link data, a fetched URL, or
/// the records the caller supplied (sample data on a test print).
async fn resolve_label_records(req: &LabelJobRequest) -> AppResult<String> {
    if req.test.unwrap_or(false) {
        return Ok(req.records.clone());
    }
    if let Some(data) = &req.data {
        return serde_json::to_string(data).map_err(|e| AppError::Validation(e.to_string()));
    }
    if let Some(url) = &req.data_url {
        if !url.trim().is_empty() {
            let method = validate_http_method(req.http_method.as_deref())?;
            let opts = FetchOptions {
                url: url.clone(),
                method,
                headers: None,
                timeout_secs: 15,
                max_size_bytes: 5 * 1024 * 1024,
                json_path: None,
            };
            let value = DataFetcher::new()
                .fetch(&opts)
                .await
                .map_err(|e| AppError::Validation(e.to_string()))?;
            return serde_json::to_string(&value).map_err(|e| AppError::Validation(e.to_string()));
        }
    }
    Ok(req.records.clone())
}

#[tauri::command]
pub async fn label_print(
    db: State<'_, DbState>,
    queue: State<'_, PrintQueue>,
    req: LabelJobRequest,
) -> AppResult<LabelPrintResponse> {
    let records_json = resolve_label_records(&req).await?;
    let is_test = req.test.unwrap_or(false);
    let run = LabelJobRun {
        template_id: req.template_id,
        printer: req.printer,
        records_json,
        copies: req.copies.unwrap_or(1).max(1),
        source: "ui",
        is_test,
        requested_by_device_id: None,
    };
    let outcome = run_label_job(&db, &queue, None, &run).await?;
    Ok(LabelPrintResponse {
        job_id: outcome.job_id,
        report: outcome.report,
        duration_ms: outcome.duration_ms,
    })
}

/// The bundled printer profiles, in the shape the UI lists them.
#[tauri::command]
pub fn label_list_profiles() -> AppResult<Vec<ProfileInfo>> {
    let set = embedded_profile_set().map_err(AppError::Internal)?;
    Ok(profile_infos(&set))
}

/// Set (or clear) the label model a saved printer row prints scene
/// jobs with (WP3 — the main design decision). The pick is validated
/// at write time: the id must name a bundled profile, and that
/// profile must speak the row's language family (a raster row takes
/// the ESC/POS family). `None` clears the pick; the row prints with
/// the language-based default again. Returns the effective choice
/// either way, so the UI can show it straight back.
pub fn set_printer_label_profile(
    conn: &rusqlite::Connection,
    printer_id: i64,
    profile_id: Option<&str>,
) -> AppResult<ProfileChoice> {
    let language: String = conn
        .query_row(
            "SELECT language FROM printers WHERE id = ?1",
            [printer_id],
            |r| r.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("Printer {printer_id} not found"))
            }
            other => other.into(),
        })?;
    if let Some(pick) = profile_id {
        validate_profile_pick(pick, &language).map_err(AppError::Validation)?;
    }
    conn.execute(
        "UPDATE printers SET label_profile = ?1, updated_at = datetime('now')
         WHERE id = ?2",
        rusqlite::params![profile_id, printer_id],
    )?;
    Ok(match profile_id {
        Some(pick) => ProfileChoice {
            model: pick.to_string(),
            user_chosen: true,
        },
        None => ProfileChoice {
            model: default_model_for_language(&language).to_string(),
            user_chosen: false,
        },
    })
}

/// The Tauri wrapper: lock, delegate, no logic.
#[tauri::command(rename_all = "snake_case")]
pub fn label_set_printer_profile(
    db: State<DbState>,
    printer_id: i64,
    profile_id: Option<String>,
) -> AppResult<ProfileChoice> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    set_printer_label_profile(guard.connection(), printer_id, profile_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LabelJobRequest {
        LabelJobRequest {
            template_id: 1,
            printer: "Zebra".into(),
            records: r#"[{"name":"sample"}]"#.into(),
            copies: None,
            test: None,
            data_url: None,
            http_method: None,
            data: None,
        }
    }

    #[tokio::test]
    async fn test_prints_use_the_supplied_records() {
        let mut req = request();
        req.test = Some(true);
        req.data_url = Some("http://127.0.0.1:9/data".into());
        assert_eq!(resolve_label_records(&req).await.unwrap(), req.records);
    }

    #[tokio::test]
    async fn inline_data_wins_over_supplied_records() {
        let mut req = request();
        req.data = Some(serde_json::json!([{"name":"inline"}]));
        assert_eq!(
            resolve_label_records(&req).await.unwrap(),
            r#"[{"name":"inline"}]"#
        );
    }
}
