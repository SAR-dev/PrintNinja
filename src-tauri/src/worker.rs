//! The queued-print worker (Phase 0, item 0.4, P3).
//!
//! Reprint and retry write rows with `status = 'queued'`; before this
//! worker existed nothing consumed them, so "queued" meant "never prints".
//! This module is the one place that runs them: it claims a row atomically
//! (`queued` → `printing`, which is also what makes a row cancelled in
//! between simply be skipped), rebuilds the request the row describes and
//! runs the same pipeline a direct print runs — the per-printer permit
//! included ([`crate::commands::print::run_claimed_job`]).
//!
//! A row the worker cannot run ends `failed` with the reason. That is the
//! invariant of a queue: every row ends `success`, `failed` or
//! `cancelled`; none stays `queued` or `printing` forever. Rows a dead
//! process left `printing` are failed at startup by
//! [`Worker::recover_interrupted`] — re-printing them automatically could
//! duplicate labels, so the person decides with a retry.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use tauri_plugin_android_print::{AndroidPrintExt, JobNotificationRequest};

use crate::commands::print::{run_claimed_job, JobRenderer};
use crate::db::DbState;
use crate::error::AppResult;
use crate::queue::PrintQueue;
use crate::render::PdfRenderer;

/// How often the worker re-scans the queue even without a wake-up, so a
/// missed wake can never strand a row.
const SWEEP: Duration = Duration::from_secs(5);

/// At most this many queued jobs run at once. The per-printer permit
/// serialises each printer's own jobs; this bounds how many renders sit in
/// flight at all, so a burst of queued jobs cannot launch unbounded renders.
const MAX_IN_FLIGHT: usize = 4;

/// Consumes `queued` print jobs from the database.
pub struct Worker {
    db: DbState,
    queue: PrintQueue,
    cache_dir: PathBuf,
    in_flight: Arc<Semaphore>,
    /// The app's handle, set by [`spawn`] so a finished job can post its
    /// result notification (item 41). Empty in tests that build a worker
    /// directly — the notification hook simply no-ops then.
    app: Arc<OnceLock<AppHandle>>,
}

impl Worker {
    pub fn new(db: DbState, queue: PrintQueue, cache_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            db,
            queue,
            cache_dir,
            in_flight: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            app: Arc::new(OnceLock::new()),
        })
    }

    /// Fail the rows a dead process left in `printing`: they belong to
    /// nobody, and re-printing them automatically could duplicate labels.
    /// Returns how many rows were failed.
    pub fn recover_interrupted(&self) -> AppResult<usize> {
        let guard = self
            .db
            .lock()
            .map_err(|_| crate::error::AppError::Internal("DB lock poisoned".into()))?;
        let n = guard.connection().execute(
            "UPDATE print_jobs
             SET status = 'failed', error = 'interrupted by application restart',
                 finished_at = datetime('now')
             WHERE status = 'printing'",
            [],
        )?;
        crate::metrics::count_finished_n("failed", n as u64);
        Ok(n)
    }

    /// Claim and run every job currently `queued`, oldest first; returns how
    /// many jobs were claimed.
    ///
    /// Jobs for different printers run in parallel (bounded by
    /// `MAX_IN_FLIGHT`); one printer's own jobs stay serialised by the
    /// per-printer permit inside the pipeline.
    pub async fn drain(self: &Arc<Self>, renderer: Arc<dyn JobRenderer>) -> usize {
        let mut set = JoinSet::new();
        let mut claimed = 0usize;

        while let Some(job_id) = claim_next(&self.db) {
            let Ok(permit) = self.in_flight.clone().acquire_owned().await else {
                break; // the semaphore is closed: nothing more may run
            };
            let worker = Arc::clone(self);
            let renderer = renderer.clone();
            set.spawn(async move {
                let _permit = permit;
                match run_claimed_job(
                    &worker.cache_dir,
                    &worker.db,
                    &worker.queue,
                    job_id,
                    renderer.as_ref(),
                )
                .await
                {
                    Ok(resp) => {
                        tracing::info!(job_id, success = resp.success, "queued job finished")
                    }
                    Err(e) => tracing::error!(job_id, error = %e, "queued job errored"),
                }
                // The batch moves with every job that ends: counters first,
                // then the batch's own end state once nothing is left.
                if let Some(batch_id) = batch_of(&worker.db, job_id) {
                    let _ = update_batch_progress(&worker.db, batch_id);
                }
                // Item 41: the finished job tells the user in the
                // notification shade (best-effort; `notify_on` decides
                // whether anything is posted at all).
                notify_job_finished(&worker, job_id);
            });
            claimed += 1;
        }

        while let Some(res) = set.join_next().await {
            if let Err(e) = res {
                tracing::error!(error = %e, "queued job task panicked");
            }
        }
        claimed
    }

    /// The production loop: drain what is queued, then wait for a wake-up
    /// or the sweep interval, whichever comes first.
    pub async fn run(self: &Arc<Self>) {
        let renderer: Arc<dyn JobRenderer> = Arc::new(PdfRenderer::new(self.cache_dir.clone()));
        loop {
            let n = self.drain(renderer.clone()).await;
            if n > 0 {
                tracing::info!(jobs = n, "drained queued print jobs");
            }
            tokio::select! {
                _ = self.queue.wait_for_work() => {}
                _ = tokio::time::sleep(SWEEP) => {}
            }
        }
    }
}

/// Spawn the production worker: fail rows a dead process left running, then
/// consume the queue for the life of the app.
pub fn spawn(app: AppHandle, db: DbState, queue: PrintQueue, cache_dir: PathBuf) {
    let worker = Worker::new(db, queue, cache_dir);
    // The finished-job notification (item 41) needs the app handle; set it
    // before the first drain so no job can finish without a way to tell.
    let _ = worker.app.set(app);
    tauri::async_runtime::spawn(async move {
        match worker.recover_interrupted() {
            Ok(0) => {}
            Ok(n) => tracing::warn!(jobs = n, "failed jobs interrupted by the previous shutdown"),
            Err(e) => tracing::error!(error = %e, "could not recover interrupted jobs"),
        }
        worker.run().await;
    });
}

/// Claim the oldest `queued` row: the atomic `queued` → `printing` flip is
/// what stops two claimers from printing one row twice, and what makes a
/// row cancelled in between simply be skipped. A batch shows `printing` as
/// soon as one of its jobs starts.
fn claim_next(db: &DbState) -> Option<i64> {
    loop {
        // created_at travels along so the claim can log how long the job
        // waited in the queue (Phase 0 visibility). Best-effort: an
        // unparsable timestamp skips the log, never the claim.
        let (id, created_at): (i64, String) = {
            let guard = db.lock().ok()?;
            guard
                .connection()
                .query_row(
                    "SELECT id, created_at FROM print_jobs WHERE status = 'queued' ORDER BY id LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok()?
        };

        let claimed = {
            let guard = db.lock().ok()?;
            let conn = guard.connection();
            let n = conn
                .execute(
                    "UPDATE print_jobs
                     SET status = 'printing', started_at = datetime('now'), error = NULL
                     WHERE id = ?1 AND status = 'queued'",
                    [id],
                )
                .unwrap_or(0);
            if n == 1 {
                let _ = conn.execute(
                    "UPDATE batches SET status = 'printing'
                     WHERE id = (SELECT batch_id FROM print_jobs WHERE id = ?1)
                       AND status = 'queued'",
                    [id],
                );
            }
            n
        };

        if claimed == 1 {
            if let Ok(queued_at) =
                chrono::NaiveDateTime::parse_from_str(created_at.trim(), "%Y-%m-%d %H:%M:%S")
            {
                let wait_ms = chrono::Utc::now()
                    .naive_utc()
                    .signed_duration_since(queued_at)
                    .num_milliseconds()
                    .max(0) as u64;
                tracing::info!(id, wait_ms, "queued job claimed");
            }
            return Some(id);
        }
        // The row vanished under us (cancelled, or already claimed): next.
    }
}

fn batch_of(db: &DbState, job_id: i64) -> Option<i64> {
    let guard = db.lock().ok()?;
    guard
        .connection()
        .query_row(
            "SELECT batch_id FROM print_jobs WHERE id = ?1",
            [job_id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
}

/// Post the one-shot result notification for a finished job (item 41).
///
/// The `print_jobs` row plus its template name is the payload; the
/// `notify_on` setting decides whether anything is posted at all
/// (`"failures"` — the default — posts only failures, `"all"` posts both,
/// `"never"` nothing). Best-effort by contract: any problem here is logged
/// at debug level and never surfaces — a notification must not be able to
/// disturb the queue.
fn notify_job_finished(worker: &Worker, job_id: i64) {
    let Some(app) = worker.app.get() else {
        return; // no app handle: tests and the pre-spawn window
    };
    let Some(guard) = worker.db.lock().ok() else {
        return;
    };
    let row: Option<(String, Option<String>, Option<String>)> = guard
        .connection()
        .query_row(
            "SELECT j.status, t.name, j.error
             FROM print_jobs j
             LEFT JOIN templates t ON t.id = j.template_id
             WHERE j.id = ?1",
            [job_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    drop(guard);
    let Some((status, subject, error)) = row else {
        return;
    };
    if status == "cancelled" {
        return; // the user chose to stop it; that is not a result
    }
    let failed = status == "failed";
    let mode = read_notify_on(&worker.db);
    if failed && mode == "never" {
        return;
    }
    if !failed && mode != "all" {
        return;
    }
    let request = JobNotificationRequest {
        kind: if failed { "failure" } else { "success" }.to_string(),
        subject,
        detail: failed.then_some(error).flatten(),
    };
    if let Err(e) = app.android_print().post_job_notification(request) {
        tracing::debug!(job_id, error = %e, "job result notification not posted");
    }
}

/// The `notify_on` setting: `"failures"` (the default) posts only
/// failures, `"all"` posts every finished job, `"never"` posts nothing.
/// Anything unreadable or unknown reads as the default.
fn read_notify_on(db: &DbState) -> &'static str {
    let value: Option<String> = match db.lock().ok() {
        Some(guard) => guard
            .connection()
            .query_row(
                "SELECT value FROM settings WHERE key = 'notify_on'",
                [],
                |r| r.get(0),
            )
            .ok(),
        None => return "failures",
    };
    match value.as_deref() {
        Some("all") => "all",
        Some("never") => "never",
        _ => "failures",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn db_with_notify_on(value: Option<&str>) -> DbState {
        let database = crate::db::Database::open("sqlite::memory:").expect("db");
        let state = Arc::new(Mutex::new(database));
        if let Some(v) = value {
            state
                .lock()
                .unwrap()
                .connection()
                .execute(
                    "INSERT INTO settings (key, value) VALUES ('notify_on', ?1)",
                    [v],
                )
                .unwrap();
        }
        state
    }

    #[test]
    fn notify_on_defaults_to_failures_when_unstored_or_unknown() {
        assert_eq!(read_notify_on(&db_with_notify_on(None)), "failures");
        assert_eq!(
            read_notify_on(&db_with_notify_on(Some("bogus"))),
            "failures"
        );
    }

    #[test]
    fn notify_on_reads_the_stored_mode() {
        assert_eq!(read_notify_on(&db_with_notify_on(Some("failures"))), "failures");
        assert_eq!(read_notify_on(&db_with_notify_on(Some("all"))), "all");
        assert_eq!(read_notify_on(&db_with_notify_on(Some("never"))), "never");
    }

    #[test]
    fn a_worker_without_an_app_handle_notifies_nothing() {
        // No app handle was ever set: the hook is a no-op, even for a
        // row that exists and wants notifying.
        let db = db_with_notify_on(Some("all"));
        {
            let guard = db.lock().unwrap();
            guard
                .connection()
                .execute(
                    "INSERT INTO print_jobs (id, status, error) VALUES (1, 'failed', 'x')",
                    [],
                )
                .unwrap();
        }
        let worker = Worker::new(db, crate::queue::PrintQueue::new(), PathBuf::from("."));
        // Must not panic and must not block: there is no way to notify.
        notify_job_finished(&worker, 1);
    }
}

/// Move a batch's counters and end state with the jobs that finished.
///
/// `done` counts records that reached a terminal state, `failed` the
/// failures among them; when nothing is left to run the batch ends
/// `success`, or `failed` when any record failed. A cancelled batch stays
/// `cancelled` — the guard keeps finished jobs from resurrecting it.
fn update_batch_progress(db: &DbState, batch_id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| crate::error::AppError::Internal("DB lock poisoned".into()))?;
    guard.connection().execute(
        "UPDATE batches SET
            done = (SELECT COUNT(*) FROM print_jobs
                     WHERE batch_id = ?1 AND status IN ('success', 'failed', 'cancelled')),
            failed = (SELECT COUNT(*) FROM print_jobs
                       WHERE batch_id = ?1 AND status = 'failed'),
            status = CASE
                WHEN (SELECT COUNT(*) FROM print_jobs
                       WHERE batch_id = ?1 AND status IN ('queued', 'printing')) > 0
                    THEN 'printing'
                WHEN (SELECT COUNT(*) FROM print_jobs
                       WHERE batch_id = ?1 AND status = 'failed') > 0
                    THEN 'failed'
                ELSE 'success'
            END
         WHERE id = ?1 AND status != 'cancelled'",
        [batch_id],
    )?;
    Ok(())
}
