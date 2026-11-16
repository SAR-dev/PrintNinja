//! Regression tests for the batch commands (item 18): `create_batch`
//! inserts one `batches` row and clones each named job into it as a
//! `queued` row — all-or-nothing, in the order given.

use printninja_lib::commands::batch::{clone_job_as_queued, create_batch_conn};
use printninja_lib::db::Database;
use printninja_lib::AppError;
use std::sync::{Arc, Mutex};

/// A file-backed Database (the same open path the app uses) seeded with
/// one printer, one template and `n_jobs` finished jobs.
fn test_db(n_jobs: usize) -> Arc<Mutex<Database>> {
    let path = std::env::temp_dir().join(format!("printninja_batch_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    let db = Arc::new(Mutex::new(db));

    let guard = db.lock().unwrap();
    let conn = guard.connection();
    conn.execute(
        "INSERT INTO printers (name, type, address, language)
         VALUES ('Desk', 'ipp', '127.0.0.1', 'pdf')",
        [],
    )
    .unwrap();
    let printer_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO templates (name, html) VALUES ('Label', '<p>v1</p>')",
        [],
    )
    .unwrap();
    let template_id = conn.last_insert_rowid();
    for i in 0..n_jobs {
        // A distinct `source_url` per job so a test can tell which clone
        // came from which original (the clones otherwise are identical).
        conn.execute(
            "INSERT INTO print_jobs
               (template_id, printer_id, source, source_url, status, copies, is_test)
             VALUES (?1, ?2, 'ui', ?3, 'success', 2, 0)",
            rusqlite::params![template_id, printer_id, format!("job-{i}")],
        )
        .unwrap();
    }
    drop(guard);
    db
}

#[test]
fn create_batch_clones_each_job_in_order_under_one_batch() {
    let db = test_db(3);
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let original_urls: Vec<(i64, String)> = conn
        .prepare("SELECT id, source_url FROM print_jobs ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    // Pass them reversed: the batch must run them in the given order, not
    // in id order.
    let reversed: Vec<i64> = original_urls
        .iter()
        .rev()
        .map(|(id, _)| *id)
        .collect();

    let summary = create_batch_conn(conn, &reversed).expect("batch must work");
    assert_eq!(summary.total, 3);
    assert_eq!(summary.done, 0);
    assert_eq!(summary.failed, 0);
    assert_eq!(summary.status, "queued");
    assert_eq!(summary.mode, "per_record");
    assert!(summary.template_id.is_some(), "batch keeps the template");
    assert!(summary.printer_id.is_some(), "batch keeps the printer");

    let clones: Vec<(String, Option<i64>, Option<i64>)> = conn
        .prepare(
            "SELECT source_url, record_index, batch_id FROM print_jobs
             WHERE batch_id = ?1 ORDER BY record_index",
        )
        .unwrap()
        .query_map([summary.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(clones.len(), 3, "one clone per job");
    let url_of = |id: i64| original_urls.iter().find(|(i, _)| *i == id).unwrap();
    for (position, (clone_url, record_index, batch_id)) in clones.iter().enumerate() {
        assert_eq!(
            *clone_url,
            url_of(reversed[position]).1,
            "batch order is the given order"
        );
        assert_eq!(*record_index, Some(position as i64));
        assert_eq!(*batch_id, Some(summary.id));
    }

    let queued: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE batch_id = ?1 AND status = 'queued'",
            [summary.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(queued, 3, "every batch job starts queued");

    // The originals are untouched — a batch never mutates its inputs.
    let originals: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs
             WHERE status = 'success' AND batch_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(originals, 3);
}

#[test]
fn create_batch_refuses_the_whole_call_when_a_job_is_missing() {
    let db = test_db(2);
    let guard = db.lock().unwrap();
    let conn = guard.connection();
    let first: i64 = conn
        .query_row("SELECT id FROM print_jobs ORDER BY id LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap();

    let err = create_batch_conn(conn, &[first, 999_999]).unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "a missing job is a 404, got {err:?}"
    );

    let batches: i64 = conn
        .query_row("SELECT COUNT(*) FROM batches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(batches, 0, "no half-claimed batch row is left behind");
    let jobs: i64 = conn
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(jobs, 2, "no clones are left behind");
}

#[test]
fn create_batch_refuses_an_empty_list() {
    let db = test_db(1);
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let err = create_batch_conn(conn, &[]).unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "an empty batch is a validation error, got {err:?}"
    );
}

#[test]
fn create_batch_clones_a_listed_twice_job_once() {
    let db = test_db(1);
    let guard = db.lock().unwrap();
    let conn = guard.connection();
    let id: i64 = conn
        .query_row("SELECT id FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();

    let summary = create_batch_conn(conn, &[id, id]).expect("batch must work");
    assert_eq!(summary.total, 1, "a duplicate id clones once, so it prints once");
    let clones: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE batch_id = ?1",
            [summary.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(clones, 1);
}

#[test]
fn clone_job_as_queued_404s_a_missing_source() {
    let db = test_db(1);
    let guard = db.lock().unwrap();
    let conn = guard.connection();

    let err = clone_job_as_queued(conn, 424_242, None, None).unwrap_err();
    assert!(
        matches!(err, AppError::NotFound(_)),
        "cloning a missing row is a 404, got {err:?}"
    );
}
