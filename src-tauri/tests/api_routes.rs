//! Integration tests for the REST API: auth, idempotency, and route wiring.
//!
//! A real axum server is bound to an ephemeral port and driven with
//! `reqwest`, so routing/middleware bugs surface here instead of at runtime.

use axum::http::{Request, StatusCode};
use printninja_lib::api::auth::ApiKey;
use printninja_lib::db::Database;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Db = Arc<Mutex<Database>>;

fn setup() -> (Db, String) {
    let path = std::env::temp_dir().join(format!(
        "printninja_api_{}.db",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let conn = Connection::open(&path).expect("open db");
    conn.execute_batch(include_str!("../src/db/schema.sql"))
        .expect("apply schema");
    drop(conn);

    let db: Db = Arc::new(Mutex::new(Database {
        url: format!("sqlite:{}", path.display()),
    }));

    // Seed an API client.
    let (plain, hash) = ApiKey::generate();
    {
        let guard = db.lock().unwrap();
        let c = guard.connection().unwrap();
        c.execute(
            "INSERT INTO api_clients (name, key_hash, scopes) VALUES ('t', ?1, 'print,read')",
            [&hash],
        )
        .unwrap();
    }

    (db, plain)
}

fn seed_printers_and_templates(db: &Db) -> (String, String) {
    let guard = db.lock().unwrap();
    let c = guard.connection().unwrap();

    c.execute(
        "INSERT INTO printers (name, type, address, language) VALUES ('Desk','ipp','1.2.3.4','pdf')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES ('Receipt',120,200,'portrait')",
        [],
    )
    .unwrap();
    let tid = c.last_insert_rowid();
    c.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, '<p>hi</p>', '', 'manual')",
        [tid],
    )
    .unwrap();
    drop(guard);
    ("Desk".to_string(), "Receipt".to_string())
}

// ───────────────────────────────────────────────────────────────
// auth
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_is_open_without_a_key() {
    let (db, _key) = setup();
    let app = printninja_lib::api::routes::router_with_state(db, false);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn printers_requires_authorization() {
    let (db, _key) = setup();
    let app = printninja_lib::api::routes::router_with_state(db, false);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_key_is_rejected() {
    let (db, _key) = setup();
    let app = printninja_lib::api::routes::router_with_state(db, false);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .header("authorization", "Bearer pn_live_definitely_wrong")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn valid_key_is_accepted() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);
    let app = printninja_lib::api::routes::router_with_state(db, false);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
}

// ───────────────────────────────────────────────────────────────
// route wiring (regression for the shadowed DELETE route)
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn jobs_id_supports_both_get_and_delete() {
    let (db, key) = setup();

    {
        let guard = db.lock().unwrap();
        let c = guard.connection().unwrap();
        c.execute(
            "INSERT INTO print_jobs (source, status, copies, is_test)
             VALUES ('api','queued',1,0)",
            [],
        )
        .unwrap();
    }

    // GET /v1/jobs/1 must work (previously shadowed by the DELETE route).
    let app = printninja_lib::api::routes::router_with_state(db.clone(), false);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/jobs/1")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "GET /v1/jobs/{{id}} must not 404/405");

    // DELETE /v1/jobs/1 must cancel the queued job.
    let app = printninja_lib::api::routes::router_with_state(db.clone(), false);
    let res = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/jobs/1")
                .header("authorization", format!("Bearer {}", key))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT, "DELETE must reach its handler");

    let guard = db.lock().unwrap();
    let c = guard.connection().unwrap();
    let status: String = c
        .query_row("SELECT status FROM print_jobs WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "cancelled");
}

// ───────────────────────────────────────────────────────────────
// idempotency
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn duplicate_idempotency_key_does_not_create_a_second_job() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "data": {"order": 1}
    })
    .to_string();

    // First request creates the job.
    let app = printninja_lib::api::routes::router_with_state(db.clone(), false);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .header("idempotency-key", "order-1042")
                .body(axum::body::Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::ACCEPTED);

    // Replay must be rejected.
    let app = printninja_lib::api::routes::router_with_state(db.clone(), false);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .header("idempotency-key", "order-1042")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "replay returns 200 duplicate");

    let guard = db.lock().unwrap();
    let c = guard.connection().unwrap();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = 'order-1042'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "idempotent replay must not print twice");
}

// ───────────────────────────────────────────────────────────────
// endpoint behaviour
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn print_creates_a_queued_job_row() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = printninja_lib::api::routes::router_with_state(db.clone(), false);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "data": {"order": {"id": 7}}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::ACCEPTED);

    let guard = db.lock().unwrap();
    let c = guard.connection().unwrap();
    let (status, source): (String, String) = c
        .query_row("SELECT status, source FROM print_jobs LIMIT 1", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(status, "queued");
    assert_eq!(source, "api");
}

#[tokio::test]
async fn print_rejects_unknown_printer() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = printninja_lib::api::routes::router_with_state(db, false);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Does Not Exist",
                        "data": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batch_print_creates_one_job_per_record() {
    let (db, key) = setup();
    seed_printers_and_templates(&db);

    let app = printninja_lib::api::routes::router_with_state(db.clone(), false);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print/batch")
                .header("authorization", format!("Bearer {}", key))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "mode": "per_record",
                        "data": [{"n":1},{"n":2},{"n":3}]
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::ACCEPTED);

    let guard = db.lock().unwrap();
    let c = guard.connection().unwrap();
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM print_jobs WHERE source='api'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 3);
}

#[tokio::test]
async fn openapi_documents_bearer_auth() {
    let (db, _key) = setup();
    let app = printninja_lib::api::routes::router_with_state(db, false);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "openapi also requires a key");
}

#[tokio::test]
async fn verify_stored_key_matches_hashed_value() {
    let (db, plain) = setup();
    let guard = db.lock().unwrap();
    let conn = guard.connection().unwrap();

    assert!(printninja_lib::verify_api_key(&conn, &plain));
    assert!(!printninja_lib::verify_api_key(&conn, "pn_live_nope"));
}