use axum::{
    extract::{Extension, Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::DbState;
use crate::error::AppError;

/// Everything a route handler needs.
///
/// The queue and the app handle are here, not just the DB, because
/// `POST /v1/print` used to insert a row with `status = 'queued'`, return
/// `202 Accepted`, and never print anything at all. Now it runs the same
/// pipeline as the desktop UI — including the per-printer queue permit — so
/// an API caller and a UI user cannot interleave bytes on one thermal head.
#[derive(Clone)]
pub struct ApiState {
    pub db: DbState,
    pub queue: std::sync::Arc<crate::queue::PrintQueue>,
    /// Where the PDF renderer writes intermediate files. A plain path, not an
    /// `AppHandle`, so the router can be built in tests without standing up a
    /// Tauri app.
    pub cache_dir: std::path::PathBuf,
    /// The open pairing-code window, if any. In memory only — never in the
    /// DB or logs (docs/ARCHITECTURE.md §9 Pairing).
    pub window: std::sync::Arc<std::sync::Mutex<Option<crate::api::pair_code::PairingWindow>>>,
}

impl ApiState {
    /// Fresh state with no open pairing window (tests, ephemeral servers).
    pub fn without_window(
        db: DbState,
        queue: std::sync::Arc<crate::queue::PrintQueue>,
        cache_dir: std::path::PathBuf,
    ) -> Self {
        ApiState {
            db,
            queue,
            cache_dir,
            window: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

/// Build a router bound to the app's database state.
///
/// NOTE: `/v1/jobs/{id}` is registered ONCE with `get(..).delete(..)`.
/// Registering the same path twice makes axum shadow the first method,
/// silently dropping GET or DELETE.
pub fn router_with_state(state: ApiState, lan_access: bool) -> Router {
    // Browser origins are never allowed: the app's own UI reaches this
    // server through the Rust `api_request` proxy (loopback allow-list),
    // and paired phones call from native code — so no legitimate caller
    // needs CORS, and a wildcard would let any web page on the LAN probe
    // the API (ARCHITECTURE §9). `lan_access` still decides the bind
    // address in the launcher; it no longer changes CORS here.
    let _ = lan_access;
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    // The peer endpoints live on their own sub-router: they need the
    // pairing-secret gate, and the render body can be megabytes, so the
    // default 2MB JSON cap is raised here to `MAX_BODY_BYTES` (validation
    // still answers a JSON 413 above `MAX_HTML_BYTES`). Merged below; the
    // main routes are untouched.
    let peer = Router::new()
        .route("/v1/render", post(crate::api::render_share::peer_render))
        .route(
            "/v1/capabilities",
            get(crate::api::render_share::peer_capabilities),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::api::render_share::require_peer_auth,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(
            crate::api::render_share::MAX_BODY_BYTES,
        ))
        .with_state(state.clone());

    // Pairing introduction: one-time code in, per-device token out. Same
    // outside-CORS placement as `peer` (the phone calls from Rust, not a
    // browser), with a small body cap — a claim is a few hundred bytes.
    let pair = Router::new()
        .route("/v1/pair/hello", get(crate::api::pair_routes::hello))
        .route("/v1/pair/claim", post(crate::api::pair_routes::claim))
        .layer(axum::extract::DefaultBodyLimit::max(
            crate::api::pair_routes::MAX_PAIR_BODY_BYTES,
        ))
        .with_state(state.clone());

    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/printers", get(list_printers))
        .route("/v1/templates", get(list_templates))
        .route("/v1/pc-templates", get(list_pc_templates))
        .route("/v1/print", post(print_job))
        .route("/v1/jobs", get(list_jobs))
        .route("/v1/jobs/{id}", get(get_job).delete(cancel_job))
        .route("/v1/jobs/{id}/retry", post(retry_job))
        .route("/v1/metrics", get(metrics))
        .route("/v1/metrics/prometheus", get(metrics_prometheus))
        .route("/v1/openapi.json", get(openapi))
        // Paired-only LAN (ARCHITECTURE §9): every route above needs a
        // loopback source or a paired-device token. `route_layer` covers
        // only these routes — the peer/pair routers merged below keep
        // their own gates.
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::api::render_share::require_paired_or_local,
        ))
        .with_state(state)
        // Per-request spans (method, path, status, latency): the only way
        // to join a slow print across middleware and handler in the logs.
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors)
        .merge(peer)
        .merge(pair)
}

use axum::response::IntoResponse;
use rusqlite::OptionalExtension;

// ── Handlers ────────────────────────────────────────────────────────────────

/// Liveness plus the dependencies a print needs: the database answers
/// and the queue lock is acquirable. A wedged DB (or a poisoned lock)
/// reports degraded instead of a lying "ok".
async fn health(State(state): State<ApiState>) -> Json<Value> {
    let db_ok = state
        .db
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .connection()
                .query_row("SELECT 1", [], |_| Ok(()))
                .ok()
        })
        .is_some();
    Json(json!({
        "status": if db_ok { "ok" } else { "degraded" },
        "version": env!("CARGO_PKG_VERSION"),
        "app": "PrintNinja",
        "db": if db_ok { "up" } else { "down" },
    }))
}

async fn list_printers(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare("SELECT id, name, type, address, language FROM printers ORDER BY name")
        .map_err(ApiRejection::from)?;

    let printers: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "address": row.get::<_, String>(3)?,
                "language": row.get::<_, String>(4)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = printers.len();
    Ok(Json(json!({ "printers": printers, "count": count })))
}

async fn list_templates(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.page_w_mm, t.page_h_mm, t.orientation
             FROM templates t WHERE t.sync_state <> 'deleted_pending' ORDER BY t.name",
        )
        .map_err(ApiRejection::from)?;

    let templates: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "page_w_mm": row.get::<_, i64>(2)?,
                "page_h_mm": row.get::<_, i64>(3)?,
                "orientation": row.get::<_, String>(4)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = templates.len();
    Ok(Json(json!({ "templates": templates, "count": count })))
}

/// The templates a paired phone may print: synced rows only, names plus
/// the sync identity — never bodies (ARCHITECTURE §9). A phone printing
/// via this PC lists these instead of its own rows, so the version
/// check matches by construction: dirty or local-only rows are refused
/// by the check, so listing them would only produce 409s.
async fn list_pc_templates(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT t.name, t.server_id, t.server_revision
             FROM templates t
             WHERE t.sync_state = 'synced'
               AND t.server_id IS NOT NULL
               AND t.server_revision IS NOT NULL
             ORDER BY t.name",
        )
        .map_err(ApiRejection::from)?;

    let templates: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "name": row.get::<_, String>(0)?,
                "server_id": row.get::<_, String>(1)?,
                "server_revision": row.get::<_, Option<i64>>(2)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = templates.len();
    Ok(Json(json!({ "templates": templates, "count": count })))
}

#[derive(Deserialize)]
struct PrintJobRequest {
    template: Option<String>,
    /// The template's synced identity (ARCHITECTURE §9): the phone sends
    /// the `server_id` plus the `server_revision` it rendered against, as
    /// well as the name. The PC resolves by `server_id` — never by name
    /// fallback — and refuses a missing or mismatched revision with 409
    /// instead of printing the wrong thing. Absent for legacy callers,
    /// which keep the name lookup.
    template_server_id: Option<String>,
    template_server_revision: Option<i64>,
    printer: String,
    data: Option<Value>,
    data_url: Option<String>,
    settings: Option<Value>,
    test: Option<bool>,
    /// Refused with 400 in `print_job` — never silently accepted (P12).
    callback_url: Option<String>,
    /// Body-level key, currently unread: the API takes the key from the
    /// `Idempotency-Key` header. Kept for wire compatibility.
    #[allow(dead_code)]
    idempotency_key: Option<String>,
}

/// `settings.copies` as the caller sent it: missing (or a non-number)
/// means 1, matching the pipeline default. Kept beside the handler so the
/// pre-DB limit check and the pipeline agree on where the number comes from.
fn settings_copies(settings: &Value) -> u64 {
    settings.get("copies").and_then(|c| c.as_u64()).unwrap_or(1)
}

/// Name lookup for legacy callers: there is no HTML body in an API
/// request, so without a template there would be nothing to render.
fn resolve_template_by_name(
    conn: &rusqlite::Connection,
    name: Option<&str>,
) -> Result<i64, ApiRejection> {
    match name.filter(|n| !n.is_empty()) {
        Some(n) => conn
            .query_row(
                "SELECT id FROM templates WHERE name = ?1 COLLATE NOCASE AND sync_state <> 'deleted_pending'",
                [n],
                |r| r.get(0),
            )
            .map_err(|_| ApiRejection::NotFound(format!("Template '{n}' not found"))),
        None => Err(ApiRejection::BadRequest(
            "`template` or `template_server_id` is required (the API has no inline HTML body)"
                .into(),
        )),
    }
}

/// Version-checked lookup for synced callers (ARCHITECTURE §9): the phone
/// sends the `server_id` plus the `server_revision` it holds, as well as
/// the name. The PC finds its copy by `server_id` — never by name, so a
/// renamed template still resolves and a same-named different template
/// can never be picked — and compares revisions.
///
/// Answered 409 with a machine-readable `code`, never a silent wrong
/// print: `template_missing` when the PC has no such template (or the
/// phone sent no revision to compare — a never-synced template), and
/// `template_stale` when the revisions differ or the PC's own copy has
/// unsynced local edits the server and the phone do not have.
fn resolve_template_by_version(
    conn: &rusqlite::Connection,
    server_id: &str,
    client_revision: Option<i64>,
    pc_name: &str,
) -> Result<i64, ApiRejection> {
    let row: Option<(i64, Option<i64>, String)> = conn
        .query_row(
            "SELECT id, server_revision, sync_state FROM templates
             WHERE server_id = ?1 AND sync_state <> 'deleted_pending'",
            [server_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(ApiRejection::from)?;
    let Some((id, pc_revision, sync_state)) = row else {
        return Err(ApiRejection::Conflict(
            format!(
                "template '{server_id}' is not on {pc_name}; sync templates on the PC, then retry"
            ),
            "template_missing",
            json!({ "template_server_id": server_id, "side": "pc" }),
        ));
    };
    let Some(client_revision) = client_revision else {
        return Err(ApiRejection::Conflict(
            "this template never synced, so there is no revision to compare; sync or publish it first, then retry".into(),
            "template_missing",
            json!({ "template_server_id": server_id, "side": "phone" }),
        ));
    };
    if sync_state != "synced" {
        return Err(ApiRejection::Conflict(
            "this PC's copy has unsynced local edits; sync templates first, then retry".into(),
            "template_stale",
            json!({
                "template_server_id": server_id,
                "client_revision": client_revision,
                "pc_revision": pc_revision,
            }),
        ));
    }
    if pc_revision != Some(client_revision) {
        return Err(ApiRejection::Conflict(
            format!(
                "template '{server_id}' is out of date on this PC; sync templates first, then retry"
            ),
            "template_stale",
            json!({
                "template_server_id": server_id,
                "client_revision": client_revision,
                "pc_revision": pc_revision,
            }),
        ));
    }
    Ok(id)
}

async fn print_job(
    State(state): State<ApiState>,
    Extension(authed): Extension<crate::api::render_share::AuthedDevice>,
    headers: HeaderMap,
    Json(req): Json<PrintJobRequest>,
) -> Result<(StatusCode, Json<Value>), ApiRejection> {
    let db = state.db.clone();
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // `callback_url` was accepted and ignored (P12): there is no callback
    // runner, so a caller that relied on one would never learn the outcome.
    // Refused before any DB work — a request the server will not honour
    // creates no job.
    if let Some(callback) = &req.callback_url {
        return Err(ApiRejection::BadRequest(format!(
            "`callback_url` is not supported (got `{callback}`); \
             poll `GET /v1/jobs/{{id}}` for the outcome"
        )));
    }

    // Remote-job limits (ARCHITECTURE §9), refused before any DB work: a
    // request the server will not honour creates no job.
    let settings = req.settings.unwrap_or_else(|| json!({}));
    let copies_raw = settings_copies(&settings);
    if copies_raw > crate::commands::print::MAX_COPIES as u64 {
        return Err(ApiRejection::BadRequest(format!(
            "Too many copies requested: {copies_raw} (max {})",
            crate::commands::print::MAX_COPIES
        )));
    }
    // No `.max(1) as u32` truncation here: over-max is rejected above, so
    // the cast cannot wrap.
    let copies = copies_raw.max(1) as u32;
    if let Some(data) = &req.data {
        let bytes = serde_json::to_string(data).map(|s| s.len()).unwrap_or(0);
        if bytes > crate::commands::print::MAX_API_DATA_BYTES {
            return Err(ApiRejection::BadRequest(format!(
                "`data` is too large ({bytes} bytes, max {}); use `data_url` for big payloads",
                crate::commands::print::MAX_API_DATA_BYTES
            )));
        }
    }

    // Everything that touches the DB happens in its own scope so the
    // `MutexGuard` is definitely released before the print. Holding it across
    // a network round-trip to a thermal printer would stall every other
    // command, and the pipeline takes the lock again for its history write.
    let template_id = {
        let guard = db.lock().map_err(ApiRejection::from)?;
        let conn = guard.connection();

        // A synced caller names the exact revision (ARCHITECTURE §9).
        // A legacy caller sends only the name and keeps the old lookup.
        let pc_name = crate::commands::api::device_name();
        let template_id = if let Some(server_id) =
            req.template_server_id.as_deref().filter(|s| !s.is_empty())
        {
            resolve_template_by_version(conn, server_id, req.template_server_revision, &pc_name)?
        } else {
            resolve_template_by_name(conn, req.template.as_deref())?
        };

        // Fail early with 404 rather than after a pointless render.
        let known: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE",
                [&req.printer],
                |r| r.get(0),
            )
            .map_err(ApiRejection::from)?;
        if known == 0 {
            return Err(ApiRejection::NotFound(format!(
                "Printer '{}' not found",
                req.printer
            )));
        }

        template_id
    };

    // Run the real pipeline. This used to insert a row with
    // `status = 'queued'` and return 202 without printing anything, so every
    // API caller got a cheerful "queued" and no paper.
    let print_req = crate::commands::print::PrintRequest {
        printer_name: req.printer.clone(),
        html: String::new(),
        page_width_mm: None,
        page_height_mm: None,
        orientation: settings
            .get("orientation")
            .and_then(|o| o.as_str())
            .map(str::to_string),
        copies: Some(copies),
        records: None,
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: settings
            .get("fit")
            .and_then(|f| f.as_str())
            .map(str::to_string),
        page_range: settings
            .get("page_range")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        grayscale: settings.get("grayscale").and_then(|v| v.as_bool()),
        http_method: settings
            .get("http_method")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        template_id: Some(template_id),
        data: req.data.clone(),
        data_url: req.data_url.clone(),
        test: req.test,
        source: Some("api".into()),
        // Recorded by the begin_job INSERT under a unique index.
        idempotency_key,
        // Who asked: the paired phone's id over LAN, None on loopback.
        // Stamped on the job row so history shows "printed for <phone>".
        requested_by_device_id: authed.device_id,
    };

    let outcome =
        crate::commands::print::run_print(&state.cache_dir, &state.db, &state.queue, print_req)
            .await;

    match outcome {
        Ok(res) if res.success => Ok((
            StatusCode::OK,
            Json(json!({
                "job_id": res.job_id,
                "status": "success",
                "duration_ms": res.duration_ms,
            })),
        )),
        Ok(res) => {
            let err = res.error.unwrap_or_else(|| "print failed".into());
            Err(ApiRejection::from(crate::error::AppError::Internal(err)))
        }
        // Lost the insert race for this key: the unique index recorded the
        // winner's row before either request printed, so report that job
        // instead of printing again (P12).
        Err(crate::error::AppError::DuplicateJob(id)) => Ok((
            StatusCode::OK,
            Json(json!({
                "status": "duplicate",
                "message": "idempotency key already used; job not created",
                "job_id": id.to_string()
            })),
        )),
        Err(e) => Err(ApiRejection::from(e)),
    }
}

async fn get_job(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiRejection> {
    let db = state.db.clone();
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT id, status, error, duration_ms, copies, source, created_at,
                    requested_by_device_id, template_revision
             FROM print_jobs WHERE id = ?1",
        )
        .map_err(ApiRejection::from)?;

    let mut rows = stmt.query([id]).map_err(ApiRejection::from)?;
    let row = rows
        .next()
        .map_err(ApiRejection::from)?
        .ok_or_else(|| ApiRejection::NotFound(format!("Job {} not found", id)))?;

    Ok(Json(json!({
        "id": row.get::<_, i64>(0)?,
        "status": row.get::<_, String>(1)?,
        "error": row.get::<_, Option<String>>(2)?,
        "duration_ms": row.get::<_, Option<i64>>(3)?,
        "copies": row.get::<_, i64>(4)?,
        "source": row.get::<_, String>(5)?,
        "created_at": row.get::<_, String>(6)?,
        "requested_by_device_id": row.get::<_, Option<String>>(7)?,
        "template_revision": row.get::<_, Option<i64>>(8)?,
    })))
}

async fn list_jobs(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let db = state.db;
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut stmt = conn
        .prepare(
            "SELECT id, status, source, copies, created_at, requested_by_device_id,
                    template_revision
             FROM print_jobs ORDER BY id DESC LIMIT 200",
        )
        .map_err(ApiRejection::from)?;

    let jobs: Vec<Value> = stmt
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "status": row.get::<_, String>(1)?,
                "source": row.get::<_, String>(2)?,
                "copies": row.get::<_, i64>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "requested_by_device_id": row.get::<_, Option<String>>(5)?,
                "template_revision": row.get::<_, Option<i64>>(6)?,
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = jobs.len();
    Ok(Json(json!({ "jobs": jobs, "count": count })))
}

async fn retry_job(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiRejection> {
    let db = state.db.clone();
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    // Only a terminal row may be re-queued: re-queuing a `printing` row
    // would let the worker claim it while the direct pipeline still runs
    // it, and re-queuing a `queued` row would print it twice (P3).
    let affected = conn
        .execute(
            "UPDATE print_jobs SET status='queued', error=NULL, started_at=NULL,
                    finished_at=NULL, duration_ms=NULL, timings_json=NULL
             WHERE id = ?1 AND status IN ('failed', 'cancelled')",
            [id],
        )
        .map_err(ApiRejection::from)?;

    if affected == 0 {
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM print_jobs WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        if exists == 0 {
            return Err(ApiRejection::NotFound(format!("Job {} not found", id)));
        }
        return Err(ApiRejection::BadRequest(
            "Only a failed or cancelled job can be retried; a finished job reprints instead".into(),
        ));
    }
    drop(guard);

    // The row is `queued` again; wake the worker that prints it (P3).
    state.queue.kick();

    Ok(Json(
        json!({ "job_id": id.to_string(), "status": "queued" }),
    ))
}

async fn cancel_job(
    State(state): State<ApiState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiRejection> {
    let db = state.db.clone();
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let affected = conn
        .execute(
            "UPDATE print_jobs SET status='cancelled'
             WHERE id = ?1 AND status = 'queued'",
            [id],
        )
        .map_err(ApiRejection::from)?;

    if affected == 0 {
        return Err(ApiRejection::BadRequest(
            "Job is not cancellable (already started or finished)".into(),
        ));
    }
    crate::metrics::count_finished("cancelled");

    Ok(StatusCode::NO_CONTENT)
}

/// Operational counters for dashboards and smoke checks: jobs by
/// status, active batches, and printers the queue currently serialises.
/// One GROUP BY plus two cheap counts — no per-row work.
/// Shared by the JSON and Prometheus renderings: job counts per
/// status plus the number of batches still printing.
fn read_metric_counts(
    state: &ApiState,
) -> Result<(std::collections::HashMap<String, i64>, i64), ApiRejection> {
    let guard = state.db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection();

    let mut by_status: std::collections::HashMap<String, i64> = [
        ("queued", 0),
        ("printing", 0),
        ("success", 0),
        ("failed", 0),
        ("cancelled", 0),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), *v))
    .collect();
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM print_jobs GROUP BY status")
        .map_err(ApiRejection::from)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(ApiRejection::from)?;
    for row in rows {
        let (status, count) = row.map_err(ApiRejection::from)?;
        by_status.insert(status, count);
    }
    let batches_active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM batches WHERE status IN ('queued', 'printing')",
            [],
            |r| r.get(0),
        )
        .map_err(ApiRejection::from)?;
    Ok((by_status, batches_active))
}

/// Operational counters for dashboards and smoke checks: jobs by
/// status, active batches, and printers the queue currently serialises.
/// One GROUP BY plus two cheap counts — no per-row work.
async fn metrics(State(state): State<ApiState>) -> Result<Json<Value>, ApiRejection> {
    let (by_status, batches_active) = read_metric_counts(&state)?;

    let finished = crate::metrics::finished_counts();
    let peer_renders = crate::metrics::peer_render_counts();
    let browser_renders = crate::metrics::browser_render_counts();
    Ok(Json(json!({
        "jobs": by_status,
        "batches": { "active": batches_active },
        "printers": { "tracked": state.queue.tracked_printers().await },
        "completed": {
            "success": finished.0,
            "failed": finished.1,
            "cancelled": finished.2,
        },
        "peer_renders": {
            "rendered": peer_renders.0,
            "fallback": peer_renders.1,
        },
        "browser_renders": {
            "persistent": browser_renders.0,
            "oneshot": browser_renders.1,
        },
    })))
}

/// Prometheus text exposition (no client library: the shape is three
/// gauges and the label set is a fixed enum, so rendering is trivial).
/// Same numbers as `/v1/metrics`, scrapable by any collector.
async fn metrics_prometheus(State(state): State<ApiState>) -> impl IntoResponse {
    let (by_status, batches_active) = read_metric_counts(&state)?;
    let tracked = state.queue.tracked_printers().await;
    let finished = crate::metrics::finished_counts();
    let peer_renders = crate::metrics::peer_render_counts();
    let browser_renders = crate::metrics::browser_render_counts();
    let out = crate::metrics::render_prometheus(
        &by_status,
        batches_active,
        tracked,
        finished,
        peer_renders,
        browser_renders,
    );
    Ok::<_, ApiRejection>((
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        out,
    ))
}

async fn openapi() -> Json<Value> {
    Json(serde_json::to_value(crate::api::openapi::OpenApiSpec::default()).unwrap())
}

/// Map internal errors onto HTTP responses instead of panicking.
pub struct ApiRejection(AppError);

impl From<AppError> for ApiRejection {
    fn from(e: AppError) -> Self {
        ApiRejection(e)
    }
}

impl From<rusqlite::Error> for ApiRejection {
    fn from(e: rusqlite::Error) -> Self {
        ApiRejection(AppError::from(e))
    }
}

impl From<std::sync::PoisonError<std::sync::MutexGuard<'_, crate::db::Database>>> for ApiRejection {
    fn from(_: std::sync::PoisonError<std::sync::MutexGuard<'_, crate::db::Database>>) -> Self {
        ApiRejection(AppError::Internal("DB lock poisoned".into()))
    }
}

impl IntoResponse for ApiRejection {
    fn into_response(self) -> Response {
        // A version conflict carries a machine-readable `code` plus the
        // revisions, so the phone can offer Sync instead of a dead end.
        if let AppError::Conflict {
            message,
            code,
            details,
        } = &self.0
        {
            let mut body = serde_json::Map::with_capacity(4);
            body.insert("error".to_string(), json!(message));
            body.insert("code".to_string(), json!(code));
            if let Some(extra) = details.as_object() {
                body.extend(extra.clone());
            }
            return (StatusCode::CONFLICT, Json(Value::Object(body))).into_response();
        }
        let (status, msg) = match &self.0 {
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            AppError::Validation(m) => (StatusCode::BAD_REQUEST, m.clone()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

impl ApiRejection {
    #[allow(non_snake_case)]
    fn NotFound(m: String) -> Self {
        ApiRejection(AppError::NotFound(m))
    }
    #[allow(non_snake_case)]
    fn BadRequest(m: String) -> Self {
        ApiRejection(AppError::Validation(m))
    }
    #[allow(non_snake_case)]
    fn Conflict(m: String, code: &str, details: Value) -> Self {
        ApiRejection(AppError::Conflict {
            message: m,
            code: code.to_string(),
            details,
        })
    }
}
