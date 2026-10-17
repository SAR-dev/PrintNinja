use axum::{
    extract::Path,
    http::{HeaderMap, StatusCode},
    Json, Router,
    routing::{get, post, delete},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Build the axum router
///
/// NOTE: `/v1/jobs/{id}` is registered ONCE with `get(..).delete(..)`.
/// Registering the same path twice makes axum shadow the first method,
/// silently dropping GET or DELETE.
pub fn build_router() -> Router {
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
}

// ── Handlers ────────────────────────────────────────────────────────────────

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "app": "PrintNinja"
    }))
}

async fn list_printers() -> Json<Value> {
    // TODO: query from database
    Json(json!({
        "printers": [],
        "count": 0
    }))
}

async fn list_templates() -> Json<Value> {
    // TODO: query from database
    Json(json!({
        "templates": [],
        "count": 0
    }))
}

#[derive(Deserialize)]
struct PrintJobRequest {
    template: String,
    printer: String,
    data: Option<Value>,
    data_url: Option<String>,
    settings: Option<Value>,
    test: Option<bool>,
    callback_url: Option<String>,
    idempotency_key: Option<String>,
}

async fn print_job(
    headers: HeaderMap,
    Json(req): Json<PrintJobRequest>,
) -> (StatusCode, Json<Value>) {
    // Validate API key (placeholder)
    // In production, check Authorization header

    // Return job ID
    let job_id = uuid::Uuid::new_v4().to_string();

    // TODO: enqueue job through the print queue

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "job_id": job_id,
            "status": "queued"
        })),
    )
}

#[derive(Deserialize)]
struct BatchPrintRequest {
    template: String,
    printer: String,
    data: Value,
    settings: Option<Value>,
    mode: Option<String>,
}

async fn batch_print(
    headers: HeaderMap,
    Json(req): Json<BatchPrintRequest>,
) -> (StatusCode, Json<Value>) {
    let batch_id = uuid::Uuid::new_v4().to_string();
    let records = req.data.as_array().map(|a| a.len()).unwrap_or(0);

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "batch_id": batch_id,
            "status": "queued",
            "records": records,
            "mode": req.mode.unwrap_or_else(|| "per_record".to_string())
        })),
    )
}

async fn get_job(Path(id): Path<String>) -> Json<Value> {
    Json(json!({
        "id": id,
        "status": "queued",
        "error": null,
        "duration_ms": null
    }))
}

async fn list_jobs() -> Json<Value> {
    Json(json!({
        "jobs": [],
        "count": 0
    }))
}

async fn retry_job(Path(id): Path<String>) -> Json<Value> {
    Json(json!({
        "job_id": id,
        "status": "queued"
    }))
}

async fn cancel_job(Path(id): Path<String>) -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn openapi() -> Json<Value> {
    Json(json!({
        "openapi": "3.0.0",
        "info": {
            "title": "PrintNinja API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Local REST API for PrintNinja print automation"
        },
        "servers": [
            { "url": "http://127.0.0.1:17717", "description": "Local server" }
        ],
        "paths": {
            "/v1/health": {
                "get": { "summary": "Health check" }
            },
            "/v1/printers": {
                "get": { "summary": "List printers" }
            },
            "/v1/templates": {
                "get": { "summary": "List templates" }
            },
            "/v1/print": {
                "post": { "summary": "Create a print job" }
            },
            "/v1/print/batch": {
                "post": { "summary": "Create a batch print" }
            },
            "/v1/jobs/{id}": {
                "get": { "summary": "Get job status" },
                "delete": { "summary": "Cancel job" }
            },
            "/v1/jobs/{id}/retry": {
                "post": { "summary": "Retry failed job" }
            }
        }
    }))
}
