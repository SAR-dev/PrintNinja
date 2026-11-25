//! The label track's IPC surface (LABEL_PRINTING_PLAN.md, WP2).
//!
//! Four commands, all keyed on the template's `track` column: saving a
//! scene template (`track = 'scene'`, payload in `scene_json`), preparing
//! one (validate → plan → render, no wire), printing one (the prepared
//! units go out over this app's own transports under the printer's queue
//! permit), and listing the bundled printer profiles. The track follows
//! the template, not the printer's whim: `html` rows are refused here and
//! stay on the existing document path (`print_html`).

use std::time::Instant;

use crate::commands::print::{close_job, lookup_printer, StoredPrinter};
use crate::commands::template::{self, CreateTemplateRequest};
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::label_pipeline::{
    embedded_profile_set, prepare_units, print_units, profile_infos, report_of,
    resolve_profile_for_printer, AppTransportFactory, JobReport, PrepareReport, ProfileInfo,
};
use crate::queue::PrintQueue;
use pn_profiles::Profile;
use pn_scene::{Records, Template};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Save a scene template: validate the payload, then write a
/// `track = 'scene'` row. Reuses the html track's write path, so name
/// uniqueness, readme scaffolding and sync bookkeeping behave exactly as
/// they do for document templates.
#[derive(Debug, Deserialize)]
pub struct LabelSaveTemplateRequest {
    pub name: String,
    /// The scene template as the designer serializes it.
    pub scene: String,
}

#[tauri::command]
pub fn label_save_template(
    db: State<DbState>,
    req: LabelSaveTemplateRequest,
) -> AppResult<template::Template> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
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
    template::write_template(guard.connection(), &inner)
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
}

/// What a scene job resolves to before anything is prepared.
struct SceneJob {
    template: Template,
    profile: Profile,
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
    let template = Template::from_json(&scene)
        .map_err(|e| AppError::Validation(format!("the template's scene is not valid: {e}")))?;
    let records =
        Records::from_json(records_json).map_err(|e| AppError::Validation(e.to_string()))?;
    let profile = resolve_profile_for_printer(&stored).map_err(AppError::Validation)?;

    Ok(SceneJob {
        template,
        profile,
        records,
        printer_name: printer.to_string(),
        printer_id,
        stored,
    })
}

/// Prepare a scene job — validate, plan, render — and report what it
/// would print, without sending anything.
#[tauri::command]
pub async fn label_prepare(
    db: State<'_, DbState>,
    req: LabelJobRequest,
) -> AppResult<PrepareReport> {
    let scene_job = resolve_scene_job(&db, req.template_id, &req.printer, &req.records)?;
    let copies = req.copies.unwrap_or(1).max(1);
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
    .map(|units| units.report)
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
fn begin_label_job(
    db: &DbState,
    template_id: i64,
    printer_id: Option<i64>,
    copies: u32,
    records: &str,
) -> AppResult<i64> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let settings = serde_json::json!({ "track": "scene", "copies": copies });
    conn.execute(
        "INSERT INTO print_jobs (template_id, printer_id, source, status, copies,
                settings_json, rendered_html, is_test, started_at, data_json)
         VALUES (?1, ?2, 'ui', 'printing', ?3, ?4, '', 0, datetime('now'), ?5)",
        rusqlite::params![
            template_id,
            printer_id,
            copies as i64,
            settings.to_string(),
            records
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

/// Print a scene job: prepare it, then deliver its units over the
/// printer's own transport under that printer's queue permit. The job
/// row closes with the result; the report keeps the plain words.
#[tauri::command]
pub async fn label_print(
    db: State<'_, DbState>,
    queue: State<'_, PrintQueue>,
    req: LabelJobRequest,
) -> AppResult<LabelPrintResponse> {
    let started = Instant::now();
    let scene_job = resolve_scene_job(&db, req.template_id, &req.printer, &req.records)?;
    let copies = req.copies.unwrap_or(1).max(1);

    let job_id = begin_label_job(
        &db,
        req.template_id,
        scene_job.printer_id,
        copies,
        &req.records,
    )?;
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
                &db,
                job_id,
                "failed",
                Some(e.to_string()),
                "",
                &[],
                duration(&started),
            );
            return Err(AppError::Validation(e.to_string()));
        }
        Err(e) => {
            let reason = format!("the prepare task ended before finishing: {e}");
            let _ = close_job(
                &db,
                job_id,
                "failed",
                Some(reason.clone()),
                "",
                &[],
                duration(&started),
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
                &db,
                job_id,
                "failed",
                Some(e.clone()),
                "",
                &[],
                duration(&started),
            );
            return Err(AppError::Internal(e));
        }
    };

    let report = report_of(result);
    let (status, error) = job_status(&report);
    close_job(&db, job_id, status, error, "", &[], duration(&started))?;

    Ok(LabelPrintResponse {
        job_id,
        report,
        duration_ms: duration(&started),
    })
}

/// The bundled printer profiles, in the shape the UI lists them.
#[tauri::command]
pub fn label_list_profiles() -> AppResult<Vec<ProfileInfo>> {
    let set = embedded_profile_set().map_err(AppError::Internal)?;
    Ok(profile_infos(&set))
}
