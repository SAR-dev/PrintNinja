//! Integration tests for the REST API: auth, idempotency, and route wiring.
//!
//! A real axum server is bound to an ephemeral port and driven with
//! `reqwest`, so routing/middleware bugs surface here instead of at runtime.

use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use printninja_lib::db::Database;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Db = Arc<Mutex<Database>>;

fn setup() -> Db {
    // A UUID, not a timestamp: Windows' clock is coarse enough that parallel
    // tests could get the same file name and share (and lock) one SQLite DB.
    let path = std::env::temp_dir().join(format!("printninja_api_{}.db", uuid::Uuid::new_v4()));

    // `Database::open` is the one schema path: DDL, migrations, WAL, busy
    // timeout — so the test exercises exactly what the app runs.
    Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ))
}

fn seed_printers_and_templates(db: &Db) -> (String, String) {
    let guard = db.lock().unwrap();
    let c = guard.connection();

    c.execute(
        "INSERT INTO printers (name, type, address, language) VALUES ('Desk','ipp','1.2.3.4','pdf')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, html, css)
         VALUES ('Receipt',120,200,'portrait','<p>hi</p>','')",
        [],
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
    let db = setup();
    let app = router(&db);

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
async fn health_reports_the_database() {
    let db = setup();
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/health")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: serde_json::Value = {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    };
    assert_eq!(body["status"], "ok");
    assert_eq!(body["db"], "up");
}

#[tokio::test]
async fn metrics_reports_counters() {
    let db = setup();
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO print_jobs (status, source, copies, is_test) VALUES ('success', 'api', 1, 0)",
                [],
            )
            .unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO batches (total, done, failed, mode, status) VALUES (2, 1, 0, 'per_record', 'printing')",
                [],
            )
            .unwrap();
    }
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/metrics")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value = {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    };
    assert_eq!(body["jobs"]["success"], 1);
    assert_eq!(body["jobs"]["queued"], 0);
    assert_eq!(body["batches"]["active"], 1);
    assert!(body["printers"]["tracked"].is_number());
}

#[tokio::test]
async fn metrics_prometheus_renders_gauges() {
    let db = setup();
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO print_jobs (status, source, copies, is_test) VALUES ('failed', 'api', 1, 0)",
                [],
            )
            .unwrap();
    }
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/metrics/prometheus")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("text/plain"));
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(
        text.contains("printninja_jobs{status=\"failed\"} 1\n"),
        "failed gauge must render: {text}"
    );
    assert!(text.contains("printninja_batches_active 0\n"), "{text}");
    assert!(text.contains("# TYPE printninja_jobs gauge"), "{text}");
    assert!(
        text.contains("# TYPE printninja_jobs_completed_total counter"),
        "completed totals are counters: {text}"
    );
    for outcome in ["success", "failed", "cancelled"] {
        assert!(
            text.contains(&format!(
                "printninja_jobs_completed_total{{outcome=\"{outcome}\"}} "
            )),
            "outcome {outcome} rendered: {text}"
        );
    }
}

#[tokio::test]
async fn printers_lists_without_auth() {
    let db = setup();
    seed_printers_and_templates(&db);
    let app = router(&db);

    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
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
    let db = setup();

    {
        let guard = db.lock().unwrap();
        let c = guard.connection();
        c.execute(
            "INSERT INTO print_jobs (source, status, copies, is_test)
             VALUES ('api','queued',1,0)",
            [],
        )
        .unwrap();
    }

    // GET /v1/jobs/1 must work (previously shadowed by the DELETE route).
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/jobs/1")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "GET /v1/jobs/{{id}} must not 404/405"
    );

    // DELETE /v1/jobs/1 must cancel the queued job.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v1/jobs/1")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::NO_CONTENT,
        "DELETE must reach its handler"
    );

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let status: String = c
        .query_row("SELECT status FROM print_jobs WHERE id = 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(status, "cancelled");
}

// ───────────────────────────────────────────────────────────────
// idempotency
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn duplicate_idempotency_key_does_not_create_a_second_job() {
    let db = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "data": {"order": 1}
    })
    .to_string();

    // First request creates the job.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .header("idempotency-key", "order-1042")
                .body(axum::body::Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    // The first request runs the real pipeline. On a non-Windows CI host the
    // print itself fails (no spooler), so assert only that it was *not*
    // silently accepted as "queued" — and, crucially, that it still wrote a
    // history row carrying the idempotency key, which is what makes the
    // replay detectable at all.
    assert_ne!(res.status(), StatusCode::ACCEPTED);

    // Replay must be rejected.
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .header("idempotency-key", "order-1042")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "replay returns 200 duplicate");

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = 'order-1042'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1, "idempotent replay must not print twice");
}

/// P12: two simultaneous requests with one idempotency key print once.
/// Both can pass the `check_auth` fast path before either inserts; the
/// unique index on `idempotency_key` is what still records one job — the
/// loser answers `200 duplicate` instead of running the pipeline again.
#[tokio::test]
async fn two_simultaneous_requests_with_one_key_print_once() {
    let db = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "data": {"order": 2}
    })
    .to_string();

    let send = |app: axum::Router, body: String| async move {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .header("idempotency-key", "race-1")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap()
    };

    // Interleaved on one runtime, so each request gets past the replay
    // fast-path check before the other's insert lands, worst case.
    let (res_a, res_b) = tokio::join!(send(router(&db), body.clone()), send(router(&db), body),);

    // One of the two ran the pipeline (its status is the pipeline's own —
    // success or failure), and the other is the 200 duplicate.
    let duplicates = [res_a.status(), res_b.status()]
        .iter()
        .filter(|s| **s == StatusCode::OK)
        .count();
    assert!(
        duplicates >= 1,
        "the loser must answer 200 duplicate, got {:?} and {:?}",
        res_a.status(),
        res_b.status()
    );

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = 'race-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        n,
        1,
        "one key must record exactly one job (statuses {:?}, {:?})",
        res_a.status(),
        res_b.status()
    );
}

/// P12: `callback_url` is accepted-and-ignored nowhere — there is no
/// callback runner, so a caller that relied on one would never learn the
/// outcome. Refused with 400 before any DB work: a request the server will
/// not honour creates no job.
#[tokio::test]
async fn callback_url_is_refused_with_400_before_anything_runs() {
    let db = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk",
        "callback_url": "https://example.com/done"
    })
    .to_string();

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "callback_url must be refused, not silently dropped"
    );

    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let msg = String::from_utf8_lossy(&bytes);
    assert!(
        msg.contains("callback_url"),
        "the refusal names the field: {msg}"
    );

    let guard = db.lock().unwrap();
    let n: i64 = guard
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "nothing runs for a refused request");
}

/// P12's `data` half: the handler treats `data` as optional, so a print
/// without it must reach the pipeline — which records its row (P15) —
/// instead of dying as a validation error.
#[tokio::test]
async fn a_print_without_data_is_not_a_validation_error() {
    let db = setup();
    seed_printers_and_templates(&db);

    let body = serde_json::json!({
        "template": "Receipt",
        "printer": "Desk"
    })
    .to_string();

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "missing `data` is not a validation error"
    );

    // Past validation means the pipeline ran and recorded its row.
    let guard = db.lock().unwrap();
    let n: i64 = guard
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1, "the job was attempted, not rejected");
}

/// Build the router the way the real app does.
///
/// The state carries a print queue and a cache dir so `POST /v1/print` runs
/// the real pipeline instead of only inserting a "queued" row.
fn router(db: &Db) -> axum::Router {
    let cache = std::env::temp_dir().join(format!("printninja_api_cache_{}", uuid::Uuid::new_v4()));
    let inner = printninja_lib::api::routes::router_with_state(
        printninja_lib::api::routes::ApiState::without_window(
            db.clone(),
            std::sync::Arc::new(printninja_lib::queue::PrintQueue::new()),
            cache,
        ),
        false,
    );
    // In-process requests carry no socket address; give them the loopback
    // one the live server's `into_make_service_with_connect_info`
    // provides. Tests that need a remote source insert their own
    // `ConnectInfo`, which this keeps.
    axum::Router::new()
        .merge(inner)
        .layer(axum::middleware::from_fn(
            |mut req: Request<axum::body::Body>, next: axum::middleware::Next| async move {
                if req.extensions().get::<ConnectInfo<SocketAddr>>().is_none() {
                    req.extensions_mut().insert(ConnectInfo(SocketAddr::new(
                        IpAddr::V4(Ipv4Addr::LOCALHOST),
                        50000,
                    )));
                }
                next.run(req).await
            },
        ))
}

// ───────────────────────────────────────────────────────────────
// endpoint behaviour
// ───────────────────────────────────────────────────────────────

/// Regression for #18: `POST /v1/print` used to insert a row with
/// `status = 'queued'` and return `202 Accepted` **without printing
/// anything at all** — no render, no transport, no queue. It now runs the
/// same pipeline as the desktop UI.
///
/// On a non-Windows CI host there is no spooler, so the print itself fails —
/// which is exactly the point: the caller gets the real outcome, not a
/// cheerful "queued" and no paper.
#[tokio::test]
async fn print_runs_the_real_pipeline_instead_of_lying_queued() {
    let db = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
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

    // Not 202/"queued" any more.
    assert_ne!(res.status(), StatusCode::ACCEPTED);

    // A history row is written either way, tagged as coming from the API.
    let guard = db.lock().unwrap();
    let c = guard.connection();
    let source: String = c
        .query_row("SELECT source FROM print_jobs LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(source, "api");
}

/// The endpoint must reject a request it cannot actually render rather than
/// accepting it and doing nothing.
#[tokio::test]
async fn print_requires_a_template() {
    let db = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({ "printer": "Desk", "data": {} }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

/// A template with empty html has nothing to render.
/// That used to be reported as a cheerful "queued"; it must be a 404.

#[tokio::test]
async fn print_rejects_unknown_printer() {
    let db = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
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

/// Retry re-queues only terminal rows: a `queued` or running job must not
/// be re-queued (it would print twice), and an unknown id stays a 404 (P3).
#[tokio::test]
async fn retry_rejects_non_terminal_jobs_and_still_404s_unknown_ones() {
    let db = setup();
    seed_printers_and_templates(&db);

    let queued_id: i64 = {
        let guard = db.lock().unwrap();
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO print_jobs (source, status, copies, is_test)
             VALUES ('api', 'queued', 1, 0)",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    };

    let retry = |id: i64, db: Db| async move {
        let app = router(&db);
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/jobs/{id}/retry"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    };

    let res = retry(queued_id, db.clone()).await;
    assert_eq!(
        res.status(),
        StatusCode::BAD_REQUEST,
        "a queued job is not retryable"
    );

    let res = retry(424242, db.clone()).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND, "unknown id stays 404");

    // Once it is failed, retry re-queues it — and the worker owns it then.
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE print_jobs SET status='failed', error='offline' WHERE id=?1",
                [queued_id],
            )
            .unwrap();
    }
    let res = retry(queued_id, db.clone()).await;
    assert_eq!(res.status(), StatusCode::OK, "failed job re-queues");
}
#[tokio::test]
async fn the_idempotency_key_is_persisted_with_the_job() {
    let db = setup();
    seed_printers_and_templates(&db);

    let app = router(&db);
    let _ = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/print")
                .header("content-type", "application/json")
                .header("idempotency-key", "order-7777")
                .body(axum::body::Body::from(
                    serde_json::json!({
                        "template": "Receipt",
                        "printer": "Desk",
                        "data": {}
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let stored: Option<String> = c
        .query_row(
            "SELECT idempotency_key FROM print_jobs ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        stored.as_deref(),
        Some("order-7777"),
        "the replay guard depends on this column being written"
    );
}

/// A job with no `Idempotency-Key` header must not invent one — otherwise
/// every keyless request would collide with every other keyless request.
#[tokio::test]
async fn requests_without_a_key_do_not_collide() {
    let db = setup();
    seed_printers_and_templates(&db);

    for _ in 0..2 {
        let app = router(&db);
        let _ = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/print")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({
                            "template": "Receipt",
                            "printer": "Desk",
                            "data": {}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    }

    let guard = db.lock().unwrap();
    let c = guard.connection();
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2, "keyless requests must all be recorded");
}

/// The OpenAPI document is the API's contract, and `POST /v1/print` was
/// documented as creating a queued job. It now renders and prints, so the
/// documented status codes must match what the handler really returns.
#[tokio::test]
async fn openapi_documents_the_print_response_codes() {
    let db = setup();
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let spec: serde_json::Value = serde_json::from_slice(&body).unwrap();

    let responses = spec["paths"]["/v1/print"]["post"]["responses"]
        .as_object()
        .expect("documented responses");
    for code in ["200", "400", "404", "500"] {
        assert!(responses.contains_key(code), "missing documented {code}");
    }

    // 202 is deliberately absent: the endpoint no longer lies about queueing.
    assert!(
        !responses.contains_key("202"),
        "must not document the old fake 'queued' 202"
    );

    // The body is required; only `template` and `printer` are. The handler
    // treats `data` as optional, so the contract must not claim otherwise
    // (P12: "openapi.rs says data is required; the code treats it as
    // optional").
    let required = spec["paths"]["/v1/print"]["post"]["requestBody"]["required"]
        .as_bool()
        .unwrap_or(false);
    assert!(required, "requestBody must be required");
    let fields: Vec<&str> = spec["paths"]["/v1/print"]["post"]["requestBody"]["content"]
        ["application/json"]["schema"]["required"]
        .as_array()
        .expect("`required` must be an array")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        fields.contains(&"template") && fields.contains(&"printer"),
        "template and printer are required: {fields:?}"
    );
    assert!(
        !fields.contains(&"data"),
        "`data` is optional in the handler, so it must not be documented as required: {fields:?}"
    );
}

/// P12: the hand-written document must describe what the router really
/// returns — cancel answers `204` with no body, and the jobs endpoints
/// answer `404`/`400` for missing or non-terminal jobs.
#[tokio::test]
async fn the_openapi_document_matches_the_router() {
    let db = setup();
    let app = router(&db);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/v1/openapi.json")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let spec: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let paths = &spec["paths"];
    let codes = |path: &str, method: &str| -> Vec<String> {
        paths[path][method]["responses"]
            .as_object()
            .unwrap_or_else(|| panic!("documented responses for {method} {path}"))
            .keys()
            .cloned()
            .collect()
    };

    // Cancel answers 204 with no body.
    let delete = codes("/v1/jobs/{id}", "delete");
    for want in ["204", "400"] {
        assert!(
            delete.contains(&want.to_string()),
            "cancel must document {want}: {delete:?}"
        );
    }
    assert!(
        !delete.iter().any(|c| c == "200"),
        "cancel answers 204, not 200: {delete:?}"
    );

    // Get reports a missing job with 404; retry with 404 and a refused
    // re-queue with 400.
    let get = codes("/v1/jobs/{id}", "get");
    for want in ["200", "404"] {
        assert!(
            get.contains(&want.to_string()),
            "get must document {want}: {get:?}"
        );
    }
    let retry = codes("/v1/jobs/{id}/retry", "post");
    for want in ["200", "400", "404"] {
        assert!(
            retry.contains(&want.to_string()),
            "retry must document {want}: {retry:?}"
        );
    }

    // The document describes its own endpoint.
    let spec_ep = codes("/v1/openapi.json", "get");
    assert!(
        spec_ep.iter().any(|c| c == "200"),
        "the spec endpoint must document itself: {spec_ep:?}"
    );

    // No endpoint documents auth refusals: loopback-only serving has no
    // keys, scopes, or allowlists, so 401/403 must not appear anywhere —
    // except the shared-rendering peer pair (per-device token gate) and
    // the pairing introduction (window gate), which are explicitly gated
    // (see docs/ARCHITECTURE.md §9).
    for (path, operations) in paths.as_object().expect("paths object") {
        if path == "/v1/render"
            || path == "/v1/capabilities"
            || path == "/v1/pair/hello"
            || path == "/v1/pair/claim"
        {
            continue;
        }
        for (method, operation) in operations.as_object().expect("operations") {
            let documented: Vec<&String> = operation["responses"]
                .as_object()
                .unwrap_or_else(|| panic!("responses of {method} {path}"))
                .keys()
                .collect();
            assert!(
                documented.iter().all(|c| *c != "401" && *c != "403"),
                "{method} {path} must not document auth refusals: {documented:?}"
            );
        }
    }
}

// ───────────────────────────────────────────────────────────────
// the Explorer's client
// ───────────────────────────────────────────────────────────────

/// The Explorer reaches this server through the `api_request` command,
/// never through the page's own `fetch()`. Two blocks make the page-level
/// path impossible: on a loopback bind the router sends no
/// `Access-Control-Allow-Origin` (asserted below), and Android's WebView
/// refuses cleartext subresources from its `https://tauri.localhost`
/// origin — together they produced the "Failed to fetch" on every call
/// while the server was demonstrably up.
#[tokio::test]
async fn api_request_reaches_the_live_server_and_stays_loopback_only() {
    let db = setup();
    let app = router(&db);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("local addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("server");
    });

    // The browser's view of the same endpoint: reachable, but with no
    // ACAO header, so a WebView fetch would be blocked even on a 200.
    let cross = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/health"))
        .header("Origin", "https://tauri.localhost")
        .send()
        .await
        .expect("loopback is reachable");
    assert_eq!(cross.status().as_u16(), 200);
    assert!(
        !cross.headers().contains_key("access-control-allow-origin"),
        "loopback mode is deliberately not CORS-open; the app must not fetch from the page"
    );

    // The command takes the same route and hands the UI the status + body.
    let res = printninja_lib::commands::api::api_request(
        "GET".to_string(),
        format!("http://127.0.0.1:{port}/v1/health"),
        None,
        None,
    )
    .await
    .expect("loopback call");
    assert_eq!(res.status, 200);
    assert!(res.text.contains("\"status\":\"ok\""), "body: {}", res.text);

    // Its allow-list is loopback: a remote URL is refused before any
    // socket is opened, so the command can never act as an open proxy.
    let refused = printninja_lib::commands::api::api_request(
        "GET".to_string(),
        "http://example.com/v1/health".to_string(),
        None,
        None,
    )
    .await
    .expect_err("remote URLs are refused");
    assert!(
        refused.to_string().contains("loopback"),
        "names the restriction: {refused}"
    );
}

// ───────────────────────────────────────────────────────────────
// shared rendering (provider)
// ───────────────────────────────────────────────────────────────

/// Seed the pairing gate: sharing on, one phone paired with a known
/// token. Mirrors what `POST /v1/pair/claim` writes, without an HTTP
/// round-trip. Returns the token the tests present as `Bearer`.
fn seed_sharing(db: &Db, token: &str) -> String {
    use sha2::Digest as _;
    let hash = format!("{:x}", sha2::Sha256::digest(token.as_bytes()));
    let guard = db.lock().unwrap();
    let c = guard.connection();
    c.execute(
        "INSERT INTO settings (key, value) VALUES ('render_share_enabled', 'true')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO paired_devices
             (id, name, display_name, platform, token_hash, paired_at, last_seen_at)
         VALUES ('phone-1', 'Test Phone', NULL, 'android', ?1, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash",
        [&hash],
    )
    .unwrap();
    token.to_string()
}

/// The old shared `render_secret` buys nothing: per-device tokens
/// replaced it (plan §10). Kept as a named constant so the refusal test
/// reads clearly.
const OLD_SHARED_SECRET: &str = "correct-horse-shared-secret";

fn valid_render_body() -> serde_json::Value {
    serde_json::json!({
        "protocol": 1,
        "html": "<html><body>peer</body></html>",
        "paper_w_mm": 100.0,
        "paper_h_mm": 150.0,
        "orientation": "portrait",
        "language": "pdf",
        "dpi": 203
    })
}

async fn post_render(
    app: axum::Router,
    secret: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder()
        .method(axum::http::Method::POST)
        .uri("/v1/render")
        .header("content-type", "application/json");
    if let Some(s) = secret {
        builder = builder.header("authorization", format!("Bearer {s}"));
    }
    let res = app
        .oneshot(
            builder
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

async fn get_capabilities(
    app: axum::Router,
    secret: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder().uri("/v1/capabilities");
    if let Some(s) = secret {
        builder = builder.header("authorization", format!("Bearer {s}"));
    }
    let res = app
        .oneshot(builder.body(axum::body::Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

/// Disabled sharing answers 403 on both peer endpoints — a scanner
/// learns nothing about whether a secret exists.
#[tokio::test]
async fn render_endpoints_are_closed_until_sharing_is_enabled() {
    let db = setup();
    let (status, _) = post_render(router(&db), Some("whatever"), valid_render_body()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = get_capabilities(router(&db), Some("whatever")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/// Enabled sharing answers 401 without the pairing token, or with the
/// wrong one — including the old shared secret, which is refused since
/// pairing codes replaced it. The main routes stay open: only the peer
/// pair is gated.
#[tokio::test]
async fn render_endpoints_reject_bad_secrets() {
    let db = setup();
    seed_sharing(&db, "phone-token-abc");
    let (status, _) = post_render(router(&db), None, valid_render_body()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = post_render(router(&db), Some("wrong"), valid_render_body()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = get_capabilities(router(&db), Some("wrong")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The old shared secret no longer pairs anything.
    let (status, _) = get_capabilities(router(&db), Some(OLD_SHARED_SECRET)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The open routes are unaffected by the gate.
    let res = router(&db)
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

/// Validation happens before any browser spawns: bad protocol, unknown
/// language, empty or oversize HTML, and bad geometry all fail fast.
#[tokio::test]
async fn render_validates_before_touching_a_browser() {
    let db = setup();
    seed_sharing(&db, "phone-token-abc");
    let mut cases: Vec<(&str, serde_json::Value, StatusCode)> = vec![];
    let mut protocol = valid_render_body();
    protocol["protocol"] = serde_json::json!(999);
    cases.push(("protocol", protocol, StatusCode::BAD_REQUEST));
    let mut language = valid_render_body();
    language["language"] = serde_json::json!("telepathy");
    cases.push(("language", language, StatusCode::BAD_REQUEST));
    let mut html = valid_render_body();
    html["html"] = serde_json::json!("   ");
    cases.push(("html", html, StatusCode::BAD_REQUEST));
    let mut orientation = valid_render_body();
    orientation["orientation"] = serde_json::json!("sideways");
    cases.push(("orientation", orientation, StatusCode::BAD_REQUEST));
    let mut geometry = valid_render_body();
    geometry["paper_w_mm"] = serde_json::json!(0.0);
    cases.push(("geometry", geometry, StatusCode::BAD_REQUEST));
    let mut big = valid_render_body();
    big["html"] = serde_json::json!("x".repeat(10 * 1024 * 1024 + 1));
    cases.push(("oversize", big, StatusCode::PAYLOAD_TOO_LARGE));
    for (name, body, want) in cases {
        let (status, _) = post_render(router(&db), Some("phone-token-abc"), body).await;
        assert_eq!(status, want, "case {name}");
    }
}

/// The peer routes buffer a body of up to `MAX_BODY_BYTES`. A document
/// over the HTML cap but under the body cap still reaches validation and
/// is told why (JSON 413); anything past the body cap is cut off by the
/// extractor before it can fill memory, instead of the old unlimited
/// buffer.
#[tokio::test]
async fn render_body_is_capped_but_oversize_html_still_gets_an_explanation() {
    use printninja_lib::api::render_share::{MAX_BODY_BYTES, MAX_HTML_BYTES};
    let db = setup();
    seed_sharing(&db, "phone-token-abc");

    // Over the HTML cap, inside the body cap: validation answers.
    let mut over_html = valid_render_body();
    over_html["html"] = serde_json::json!("x".repeat(MAX_HTML_BYTES + 1024));
    let (status, body) = post_render(router(&db), Some("phone-token-abc"), over_html).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(
        body["error"].is_string(),
        "validation explains itself with JSON: {body}"
    );

    // Past the body cap: refused by the extractor.
    let mut over_body = valid_render_body();
    over_body["html"] = serde_json::json!("x".repeat(MAX_BODY_BYTES + 1));
    let (status, _) = post_render(router(&db), Some("phone-token-abc"), over_body).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}

/// Removing a paired phone cuts it off from the very next request: the
/// provider reads the token hash per request, so no restart or cache
/// expiry is involved. Other phones keep working.
#[tokio::test]
async fn removing_a_device_locks_it_out_immediately() {
    let db = setup();
    seed_sharing(&db, "phone-token-abc");
    let (status, _) = get_capabilities(router(&db), Some("phone-token-abc")).await;
    assert_eq!(status, StatusCode::OK);

    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute("DELETE FROM paired_devices WHERE id = 'phone-1'", [])
            .unwrap();
    }

    let (status, _) = get_capabilities(router(&db), Some("phone-token-abc")).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the removed phone is refused"
    );
    let (status, _) = post_render(router(&db), Some("phone-token-abc"), valid_render_body()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "renders too");
}

/// A paired consumer learns the protocol, render availability, and a
/// score to rank providers by.
#[tokio::test]
async fn capabilities_advertise_score_when_paired() {
    let db = setup();
    seed_sharing(&db, "phone-token-abc");
    let (status, body) = get_capabilities(router(&db), Some("phone-token-abc")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 1);
    assert!(body["score"].is_number(), "{body}");
    assert!(body["cores"].is_number(), "{body}");
    assert!(body["max_concurrent_renders"].is_number(), "{body}");
    assert_eq!(body["platform"], std::env::consts::OS);
}

/// The full provider path against a real browser (Linux only, opt-in
/// like `chromium_render`): finished HTML in, PDF bytes out. Skipped
/// everywhere else, including CI without a browser.
#[tokio::test]
async fn render_serves_pdf_from_a_real_browser() {
    if std::env::var_os("PRINTNINJA_TEST_REAL_CHROMIUM").is_none() {
        eprintln!("skipped: set PRINTNINJA_TEST_REAL_CHROMIUM=1 with a system chromium");
        return;
    }
    let db = setup();
    seed_sharing(&db, "phone-token-abc");
    let (status, body) =
        post_render(router(&db), Some("phone-token-abc"), valid_render_body()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mime"], "application/pdf");
    // "%PDF" base64s to "JVBER": the payload is a real document, and no
    // extra decode dependency is needed to prove it.
    assert!(
        body["bytes_b64"]
            .as_str()
            .unwrap_or("")
            .starts_with("JVBER"),
        "not a pdf: {}",
        body["bytes_b64"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(20)
            .collect::<String>()
    );
    assert!(body["render_ms"].is_number(), "{body}");
}

// ───────────────────────────────────────────────────────────────
// paired-only LAN (Release A §3.1): require_paired_or_local
// ───────────────────────────────────────────────────────────────

/// GET with an explicit source address and optional bearer, bypassing
/// the loopback default the `router()` helper installs.
async fn lan_get(
    app: axum::Router,
    uri: &str,
    ip: std::net::Ipv4Addr,
    token: Option<&str>,
) -> StatusCode {
    let mut builder = Request::builder().uri(uri);
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let mut req = builder.body(axum::body::Body::empty()).unwrap();
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(IpAddr::V4(ip), 50000)));
    app.oneshot(req).await.unwrap().status()
}

/// Distinct 10/8 sources per test: the failure memory is process-global,
/// so tests must not spend each other's budgets.
fn lan_ip(n: u8) -> std::net::Ipv4Addr {
    std::net::Ipv4Addr::new(10, 99, 0, n)
}

#[tokio::test]
async fn lan_with_valid_token_reaches_guarded_routes() {
    let db = setup();
    seed_sharing(&db, "gate-token-1");
    assert_eq!(
        lan_get(
            router(&db),
            "/v1/printers",
            lan_ip(11),
            Some("gate-token-1")
        )
        .await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn lan_without_token_is_401_even_on_health() {
    let db = setup();
    seed_sharing(&db, "gate-token-2");
    // Health included: only the pairing introduction stays open.
    assert_eq!(
        lan_get(router(&db), "/v1/health", lan_ip(12), None).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        lan_get(router(&db), "/v1/printers", lan_ip(12), None).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn lan_with_wrong_token_is_401() {
    let db = setup();
    seed_sharing(&db, "gate-token-3");
    assert_eq!(
        lan_get(router(&db), "/v1/printers", lan_ip(13), Some("wrong")).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn removed_token_fails_on_its_next_request() {
    let db = setup();
    seed_sharing(&db, "gate-token-4");
    assert_eq!(
        lan_get(
            router(&db),
            "/v1/printers",
            lan_ip(14),
            Some("gate-token-4")
        )
        .await,
        StatusCode::OK
    );
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute("DELETE FROM paired_devices WHERE id = 'phone-1'", [])
            .unwrap();
    }
    assert_eq!(
        lan_get(
            router(&db),
            "/v1/printers",
            lan_ip(14),
            Some("gate-token-4")
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "revocation takes effect on the next request"
    );
}

#[tokio::test]
async fn sharing_off_refuses_lan_but_loopback_still_passes() {
    let db = setup();
    seed_sharing(&db, "gate-token-5");
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE settings SET value = 'false' WHERE key = 'render_share_enabled'",
                [],
            )
            .unwrap();
    }
    assert_eq!(
        lan_get(
            router(&db),
            "/v1/printers",
            lan_ip(15),
            Some("gate-token-5")
        )
        .await,
        StatusCode::FORBIDDEN,
        "a valid token means nothing with sharing off"
    );
    // The PC's own UI and scripts are unaffected: loopback passes with no token.
    let res = router(&db)
        .oneshot(
            Request::builder()
                .uri("/v1/printers")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn repeated_failures_are_rate_limited() {
    let db = setup();
    seed_sharing(&db, "gate-token-6");
    let ip = lan_ip(16);
    for _ in 0..10 {
        assert_eq!(
            lan_get(router(&db), "/v1/printers", ip, Some("wrong")).await,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        lan_get(router(&db), "/v1/printers", ip, Some("wrong")).await,
        StatusCode::TOO_MANY_REQUESTS,
        "the 11th failure inside a minute is throttled"
    );
    // A different source is unaffected by one address's budget.
    assert_eq!(
        lan_get(router(&db), "/v1/printers", lan_ip(17), Some("wrong")).await,
        StatusCode::UNAUTHORIZED
    );
}
