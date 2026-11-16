//! Batch printing (item 18).
//!
//! The `batches` table, the worker's batch progress and the History
//! column all predate this, but nothing ever created a batch. This is
//! the missing entry point: `create_batch` takes existing job rows,
//! inserts one `batches` row, and clones each job under it into a
//! `queued` row — the same row-to-row copy a reprint uses — so the
//! worker prints them one by one and its existing progress tracking
//! moves the batch.

use std::collections::HashSet;

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::queue::PrintQueue;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

/// The batch row, as History and the API present it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSummary {
    pub id: i64,
    pub template_id: Option<i64>,
    pub printer_id: Option<i64>,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub mode: String,
    pub status: String,
    pub created_at: String,
}

/// Clones job `id` into a fresh `queued` row (the same INSERT..SELECT a
/// reprint uses). `batch_id`/`record_index` are `None` for a plain
/// reprint, and the owning batch's id plus the job's position in it for
/// a batch job. Returns the new row's id.
///
/// A missing source is a 404, not a silent no-op: `INSERT .. SELECT`
/// over a vanished row would insert nothing and report success.
pub fn clone_job_as_queued(
    conn: &Connection,
    id: i64,
    batch_id: Option<i64>,
    record_index: Option<i64>,
) -> AppResult<i64> {
    let exists: i64 =
        conn.query_row("SELECT COUNT(*) FROM print_jobs WHERE id = ?1", [id], |r| r.get(0))?;
    if exists == 0 {
        return Err(AppError::NotFound(format!("Job {} not found", id)));
    }

    // Clone the row itself — including its stored input payload
    // (`data_json`) and its document (`pdf_data`), which the worker
    // replays when it prints the clone. The fresh row is `queued`;
    // nothing but the worker prints it. `template_revision` carries
    // (same template prints); `printed_by` stays NULL — the clone prints
    // locally, not through a PC.
    conn.execute(
        "INSERT INTO print_jobs
            (batch_id, record_index, template_id, printer_id,
             source, source_url, status, error, copies, settings_json, rendered_html,
             idempotency_key, is_test, data_json, requested_by_device_id, template_revision,
             pdf_data)
         SELECT ?1, ?2, template_id, printer_id,
                source, source_url, 'queued', NULL, copies, settings_json, rendered_html,
                NULL, is_test, data_json, requested_by_device_id, template_revision,
                pdf_data
         FROM print_jobs WHERE id = ?3",
        params![batch_id, record_index, id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Creates one `batches` row over the given jobs and clones each of
/// them into the batch. All-or-nothing: if any job id is missing the
/// whole call 404s before the batch row exists, so a half-cloned batch
/// with a wrong `total` can never be left behind.
///
/// The batch's `template_id`/`printer_id` come from the first job, so
/// the row always matches what its jobs actually print. A job listed
/// twice is cloned once, so a duplicate can never double-print.
pub fn create_batch_conn(conn: &Connection, job_ids: &[i64]) -> AppResult<BatchSummary> {
    if job_ids.is_empty() {
        return Err(AppError::Validation("A batch needs at least one job".into()));
    }

    let mut unique: Vec<i64> = Vec::with_capacity(job_ids.len());
    let mut seen: HashSet<i64> = HashSet::new();
    for &id in job_ids {
        if seen.insert(id) {
            unique.push(id);
        }
    }

    for &id in &unique {
        let exists: i64 =
            conn.query_row("SELECT COUNT(*) FROM print_jobs WHERE id = ?1", [id], |r| {
                r.get(0)
            })?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("Job {} not found", id)));
        }
    }

    let (template_id, printer_id): (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT template_id, printer_id FROM print_jobs WHERE id = ?1",
        [unique[0]],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    conn.execute(
        "INSERT INTO batches (template_id, printer_id, total, done, failed, mode, status)
         VALUES (?1, ?2, ?3, 0, 0, 'per_record', 'queued')",
        params![template_id, printer_id, unique.len() as i64],
    )?;
    let batch_id = conn.last_insert_rowid();

    for (index, &job_id) in unique.iter().enumerate() {
        clone_job_as_queued(conn, job_id, Some(batch_id), Some(index as i64))?;
    }

    read_batch(conn, batch_id)
}

fn read_batch(conn: &Connection, batch_id: i64) -> AppResult<BatchSummary> {
    conn.query_row(
        "SELECT id, template_id, printer_id, total, done, failed, mode, status, created_at
         FROM batches WHERE id = ?1",
        [batch_id],
        |r| {
            Ok(BatchSummary {
                id: r.get(0)?,
                template_id: r.get(1)?,
                printer_id: r.get(2)?,
                total: r.get(3)?,
                done: r.get(4)?,
                failed: r.get(5)?,
                mode: r.get(6)?,
                status: r.get(7)?,
                created_at: r.get(8)?,
            })
        },
    )
    .map_err(Into::into)
}

/// Creates a batch from existing job rows and wakes the worker that
/// prints the clones.
#[tauri::command]
pub fn create_batch(
    db: State<DbState>,
    queue: State<PrintQueue>,
    job_ids: Vec<i64>,
) -> AppResult<BatchSummary> {
    let summary = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        create_batch_conn(guard.connection(), &job_ids)?
    };
    // Every clone is a `queued` row; wake the worker that prints them.
    queue.kick();
    Ok(summary)
}
