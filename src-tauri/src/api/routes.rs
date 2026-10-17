use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::DbState;
use crate::error::AppError;

pub type ApiState = (DbState, bool);

/// Build a router bound to the app's database state.
///
/// NOTE: `/v1/jobs/{id}` is registered ONCE with `get(..).delete(..)`.
/// Registering the same path twice makes axum shadow the first method,
/// silently dropping GET or DELETE.
pub fn router_with_state(db: DbState, lan_access: bool) -> Router {
    let auth_ctx = AuthCtx { db: db.clone() };
    let mut cors = tower_http::cors::CorsLayer::new()
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    if lan_access {
        // Operator opted into LAN access: allow browser origins.
        cors = cors.allow_origin(tower_http::cors::Any);
    }

    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/printers", get(list_printers))
        .route("/v1/templates", get(list_templates))
        .route("/v1/print", post(print_job))
        .route("/v1/print/batch", post(batch_print))
        .route("/v1/jobs", get(list_jobs))
        .route("/v1/jobs/{id}", get(get_job).delete(cancel_job))
        .route("/v1/jobs/{id}/retry", post(retry_job))
        .route("/v1/openapi.json", get(openapi))
        .with_state(db.clone())
        .layer(middleware::from_fn(move |req: axum::extract::Request, next: Next| {
            let auth = auth_ctx.clone();
            async move { auth_middleware_inner(auth, req, next).await }
        }))
        .layer(cors)
}

/// Reject unauthenticated requests before they reach a handler.
///
/// The DB state is passed in explicitly (via a closure) because `State` is
/// not available inside middleware request extensions.
async fn auth_middleware_inner(
    auth: AuthCtx,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let headers = request.headers().clone();
    // Health is intentionally open so probes work without a key.
    if request.uri().path() == "/v1/health" {
        return next.run(request).await;
    }

    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string());

    let Some(token) = token else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing Authorization: Bearer <key>" })),
        )
            .into_response();
    };

    // All DB access happens in a sync helper so the MutexGuard is never
    // held across an await point.
    let decision = check_auth(&auth, &token, headers.get("idempotency-key"));

    match decision {
        AuthDecision::Allow => next.run(request).await,
        AuthDecision::Duplicate => (
            StatusCode::OK,
            Json(json!({
                "status": "duplicate",
                "message": "idempotency key already used; job not created"
            })),
        )
            .into_response(),
        AuthDecision::Unauthorized => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid API key" })),
        )
            .into_response(),
        AuthDecision::Unavailable => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "database unavailable" })),
        )
            .into_response(),
    }
}

/// Outcome of the auth check.
enum AuthDecision {
    Allow,
    Duplicate,
    Unauthorized,
    Unavailable,
}

/// Synchronous auth + idempotency check. Keeping this non-async guarantees
/// the DB mutex is released before the handler future is awaited.
fn check_auth(
    auth: &AuthCtx,
    token: &str,
    idempotency: Option<&axum::http::HeaderValue>,
) -> AuthDecision {
    let Ok(guard) = auth.db.lock() else {
        return AuthDecision::Unavailable;
    };
    let Ok(conn) = guard.connection() else {
        return AuthDecision::Unavailable;
    };

    // Idempotency replay must not print twice (PLANNING.md 7.1).
    if let Some(key) = idempotency.and_then(|v| v.to_str().ok()) {
        let existing: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM print_jobs WHERE idempotency_key = ?1",
                [key],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if existing > 0 {
            return AuthDecision::Duplicate;
        }
    }

    if crate::commands::api::verify_stored_key(&conn, token) {
        AuthDecision::Allow
    } else {
        AuthDecision::Unauthorized
    }
}

/// State threaded into the auth middleware.
#[derive(Clone)]
pub struct AuthCtx {
    pub db: DbState,
}

use axum::response::IntoResponse;

// ── Handlers ────────────────────────────────────────────────────────────────

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "app": "PrintNinja"
    }))
}

async fn list_printers(State(db): State<DbState>) -> Result<Json<Value>, ApiRejection> {
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

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

async fn list_templates(State(db): State<DbState>) -> Result<Json<Value>, ApiRejection> {
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.page_w_mm, t.page_h_mm, t.orientation,
                    (SELECT COUNT(*) FROM template_versions v WHERE v.template_id = t.id)
             FROM templates t ORDER BY t.name",
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
                "version_count": row.get::<_, i64>(5)?,
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
    printer: String,
    data: Option<Value>,
    data_url: Option<String>,
    settings: Option<Value>,
    test: Option<bool>,
    #[allow(dead_code)]
    callback_url: Option<String>,
    #[allow(dead_code)]
    idempotency_key: Option<String>,
}

async fn print_job(
    State(db): State<DbState>,
    headers: HeaderMap,
    Json(req): Json<PrintJobRequest>,
) -> Result<(StatusCode, Json<Value>), ApiRejection> {
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

    let template_id: Option<i64> = match &req.template {
        Some(name) if !name.is_empty() => conn
            .query_row("SELECT id FROM templates WHERE name = ?1 COLLATE NOCASE", [name], |r| {
                r.get(0)
            })
            .map_err(|_| ApiRejection::NotFound(format!("Template '{}' not found", name)))?,
        _ => None,
    };

    let printer_id: i64 = conn
        .query_row(
            "SELECT id FROM printers WHERE name = ?1 COLLATE NOCASE",
            [&req.printer],
            |r| r.get(0),
        )
        .map_err(|_| ApiRejection::NotFound(format!("Printer '{}' not found", req.printer)))?;

    let version_id: Option<i64> = template_id
        .and_then(|tid| {
            conn.query_row(
                "SELECT current_version_id FROM templates WHERE id = ?1",
                [tid],
                |r| r.get(0),
            )
            .ok()
        })
        .flatten();

    let settings = req.settings.unwrap_or_else(|| json!({}));
    let rendered = req
        .data
        .as_ref()
        .map(|d| serde_json::to_string(d).unwrap_or_default())
        .unwrap_or_default();

    conn.execute(
        "INSERT INTO print_jobs
           (template_id, template_version_id, printer_id, source, source_url,
            status, copies, settings_json, rendered_html, idempotency_key, is_test)
         VALUES (?1, ?2, ?3, 'api', ?4, 'queued', ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            template_id,
            version_id,
            printer_id,
            req.data_url,
            settings
                .get("copies")
                .and_then(|c| c.as_u64())
                .unwrap_or(1) as i64,
            settings.to_string(),
            rendered,
            idempotency_key,
            i64::from(req.test.unwrap_or(false)),
        ],
    )
    .map_err(ApiRejection::from)?;

    let job_id = conn.last_insert_rowid().to_string();

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "job_id": job_id, "status": "queued" })),
    ))
}

#[derive(Deserialize)]
struct BatchPrintRequest {
    template: Option<String>,
    printer: String,
    data: Value,
    mode: Option<String>,
}

async fn batch_print(
    State(db): State<DbState>,
    Json(req): Json<BatchPrintRequest>,
) -> Result<(StatusCode, Json<Value>), ApiRejection> {
    let records = req
        .data
        .as_array()
        .ok_or_else(|| ApiRejection::BadRequest("data must be a JSON array".into()))?;

    let guard = db.lock().map_err(ApiRejection::from)?;
    let mut conn = guard.connection().map_err(ApiRejection::from)?;
    let tx = conn.transaction().map_err(ApiRejection::from)?;

    let template_id: i64 = match &req.template {
        Some(n) if !n.is_empty() => tx
            .query_row("SELECT id FROM templates WHERE name = ?1 COLLATE NOCASE", [n], |r| r.get(0))
            .map_err(|_| ApiRejection::NotFound(format!("Template '{}' not found", n)))?,
        _ => return Err(ApiRejection::BadRequest("template is required".into())),
    };

    let printer_id: i64 = tx
        .query_row("SELECT id FROM printers WHERE name = ?1 COLLATE NOCASE", [&req.printer], |r| {
            r.get(0)
        })
        .map_err(|_| ApiRejection::NotFound(format!("Printer '{}' not found", req.printer)))?;

    let mode = req.mode.unwrap_or_else(|| "per_record".into());
    if !["single_job", "per_record"].contains(&mode.as_str()) {
        return Err(ApiRejection::BadRequest(format!("invalid mode '{}'", mode)));
    }

    tx.execute(
        "INSERT INTO batches (template_id, printer_id, total, mode, status)
         VALUES (?1, ?2, ?3, ?4, 'queued')",
        rusqlite::params![template_id, printer_id, records.len() as i64, mode],
    )
    .map_err(ApiRejection::from)?;
    let batch_id = tx.last_insert_rowid();

    let version_id: Option<i64> = tx
        .query_row(
            "SELECT current_version_id FROM templates WHERE id = ?1",
            [template_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    if mode == "per_record" {
        for (i, _) in records.iter().enumerate() {
            tx.execute(
                "INSERT INTO print_jobs
                   (batch_id, record_index, template_id, template_version_id,
                    printer_id, source, status, copies, is_test)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'api', 'queued', 1, 0)",
                rusqlite::params![batch_id, i as i64, template_id, version_id, printer_id],
            )
            .map_err(ApiRejection::from)?;
        }
    } else {
        tx.execute(
            "INSERT INTO print_jobs
               (batch_id, record_index, template_id, template_version_id,
                printer_id, source, status, copies, rendered_html, is_test)
             VALUES (?1, 0, ?2, ?3, ?4, 'api', 'queued', 1, ?5, 0)",
            rusqlite::params![
                batch_id,
                template_id,
                version_id,
                printer_id,
                serde_json::to_string(records).unwrap_or_default()
            ],
        )
        .map_err(ApiRejection::from)?;
    }

    tx.commit().map_err(ApiRejection::from)?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "batch_id": batch_id.to_string(),
            "status": "queued",
            "records": records.len(),
            "mode": mode,
        })),
    ))
}

async fn get_job(
    State(db): State<DbState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiRejection> {
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, status, error, duration_ms, copies, source, created_at
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
    })))
}

async fn list_jobs(State(db): State<DbState>) -> Result<Json<Value>, ApiRejection> {
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, status, source, copies, created_at FROM print_jobs ORDER BY id DESC LIMIT 200",
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
            }))
        })
        .map_err(ApiRejection::from)?
        .filter_map(Result::ok)
        .collect();

    let count = jobs.len();
    Ok(Json(json!({ "jobs": jobs, "count": count })))
}

async fn retry_job(
    State(db): State<DbState>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiRejection> {
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

    let affected = conn
        .execute(
            "UPDATE print_jobs SET status='queued', error=NULL, started_at=NULL,
                    finished_at=NULL, duration_ms=NULL
             WHERE id = ?1",
            [id],
        )
        .map_err(ApiRejection::from)?;

    if affected == 0 {
        return Err(ApiRejection::NotFound(format!("Job {} not found", id)));
    }

    Ok(Json(json!({ "job_id": id.to_string(), "status": "queued" })))
}

async fn cancel_job(
    State(db): State<DbState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiRejection> {
    let guard = db.lock().map_err(ApiRejection::from)?;
    let conn = guard.connection().map_err(ApiRejection::from)?;

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

    Ok(StatusCode::NO_CONTENT)
}

async fn openapi() -> Json<Value> {
    Json(json!({
        "openapi": "3.0.0",
        "info": {
            "title": "PrintNinja API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Local REST API for PrintNinja print automation"
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": { "type": "http", "scheme": "bearer" }
            }
        },
        "security": [{ "bearerAuth": [] }],
        "servers": [
            { "url": "http://127.0.0.1:17717", "description": "Local server" }
        ],
        "paths": {
            "/v1/health": { "get": { "summary": "Health check", "security": [] } },
            "/v1/printers": { "get": { "summary": "List printers" } },
            "/v1/templates": { "get": { "summary": "List templates" } },
            "/v1/print": { "post": { "summary": "Create a print job" } },
            "/v1/print/batch": { "post": { "summary": "Create a batch print" } },
            "/v1/jobs": { "get": { "summary": "List jobs" } },
            "/v1/jobs/{id}": {
                "get": { "summary": "Get job status" },
                "delete": { "summary": "Cancel queued job" }
            },
            "/v1/jobs/{id}/retry": { "post": { "summary": "Retry failed job" } }
        }
    }))
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

impl From<std::sync::PoisonError<std::sync::MutexGuard<'_, crate::db::Database>>>
    for ApiRejection
{
    fn from(_: std::sync::PoisonError<std::sync::MutexGuard<'_, crate::db::Database>>) -> Self {
        ApiRejection(AppError::Internal("DB lock poisoned".into()))
    }
}

impl IntoResponse for ApiRejection {
    fn into_response(self) -> Response {
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
}