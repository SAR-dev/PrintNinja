//! `GET /v1/pair/hello` + `POST /v1/pair/claim` (plan §5.4).
//!
//! Mounted like the `peer` sub-router — outside the CORS layer. The phone
//! calls them from a Rust command, not browser `fetch`, so CORS is moot.
//! Both answer only while a pairing window is open; otherwise 403 with the
//! same wording as a disabled share, so a scanner learns nothing.

use axum::{
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;

use super::pair_code::{normalize_code, valid_format, ClaimError, CODE_LEN};
use super::peer_consume::is_private_host;
use super::render_share::PROTOCOL_VERSION;
use super::routes::ApiState;

/// Body cap for the claim route: a few KB, not the 16 MB peer body cap.
pub const MAX_PAIR_BODY_BYTES: usize = 8 * 1024;

fn sharing_enabled(state: &ApiState) -> bool {
    state
        .db
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .connection()
                .query_row(
                    "SELECT value FROM settings WHERE key = 'render_share_enabled'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
        })
        .is_some_and(|v| v == "true")
}

fn pairing_unavailable() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "pairing is not available on this device" })),
    )
        .into_response()
}

/// The caller's IP must be private or loopback. The server runs with
/// `into_make_service_with_connect_info` (see `launch_server`), so this
/// is always present in production; tests insert a loopback address.
fn caller_allowed(addr: ConnectInfo<SocketAddr>) -> bool {
    let ip = addr.0.ip().to_string();
    // `is_private_host` covers private/loopback/link-local plus LAN names;
    // an IP string that fails it is a public address.
    is_private_host(&ip)
}

fn api_port(state: &ApiState) -> u16 {
    state
        .db
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .connection()
                .query_row(
                    "SELECT value FROM settings WHERE key = 'api_port'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
        })
        .and_then(|v| v.parse().ok())
        .unwrap_or(17717)
}

#[derive(Debug, Clone, Serialize)]
pub struct HelloResponse {
    pub protocol: u32,
    pub provider_id: String,
    pub name: String,
    pub platform: String,
    pub port: u16,
}

/// While a pairing window is open, answer who this PC is. Otherwise 403,
/// the same as `claim` — a scanner learns nothing about windows.
pub async fn hello(State(state): State<ApiState>, addr: ConnectInfo<SocketAddr>) -> Response {
    if !sharing_enabled(&state) {
        return pairing_unavailable();
    }
    if !caller_allowed(addr) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "pairing is only available on the local network" })),
        )
            .into_response();
    }
    let now = std::time::Instant::now();
    enum WindowStatus {
        Closed,
        Open,
        Expired,
        Locked,
    }
    let status = state
        .window
        .lock()
        .map(|mut guard| match guard.as_mut() {
            None => WindowStatus::Closed,
            Some(w) if w.is_expired(now) => WindowStatus::Expired,
            Some(w) if w.is_locked() => WindowStatus::Locked,
            Some(_) => WindowStatus::Open,
        })
        .unwrap_or(WindowStatus::Closed);
    match status {
        WindowStatus::Closed => return pairing_unavailable(),
        WindowStatus::Expired => {
            return (
                StatusCode::GONE,
                Json(serde_json::json!({ "error": "pairing code expired" })),
            )
                .into_response();
        }
        WindowStatus::Locked => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({ "error": "too many wrong codes; ask the PC for a new one" })),
            )
                .into_response();
        }
        WindowStatus::Open => {}
    }
    let provider_id = {
        let guard = match state.db.lock() {
            Ok(g) => g,
            Err(_) => return pairing_unavailable(),
        };
        crate::db::ensure_provider_id(guard.connection()).unwrap_or_default()
    };
    let port = api_port(&state);
    (
        StatusCode::OK,
        Json(HelloResponse {
            protocol: PROTOCOL_VERSION,
            provider_id,
            name: crate::commands::api::device_name(),
            platform: std::env::consts::OS.into(),
            port,
        }),
    )
        .into_response()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaimRequest {
    pub protocol: Option<u32>,
    pub code: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimResponse {
    pub provider_id: String,
    pub provider_name: String,
    pub provider_platform: String,
    pub port: u16,
    /// Shown once. The PC stores only its SHA-256.
    pub token: String,
    pub paired_at: String,
}

/// Claim the open window with the 8-character code. Mints a per-device
/// token, stores its hash in `paired_devices`, and closes the window
/// (single use).
pub async fn claim(
    State(state): State<ApiState>,
    addr: ConnectInfo<SocketAddr>,
    Json(req): Json<ClaimRequest>,
) -> Response {
    if !sharing_enabled(&state) {
        return pairing_unavailable();
    }
    if !caller_allowed(addr) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "pairing is only available on the local network" })),
        )
            .into_response();
    }
    if req.protocol != Some(PROTOCOL_VERSION) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unsupported protocol (this device speaks 1)" })),
        )
            .into_response();
    }
    let raw_code = req.code.unwrap_or_default();
    let normalized = normalize_code(&raw_code);
    if !valid_format(&normalized) && normalized.len() != CODE_LEN {
        // Still needs an open window first: without one this is 403, not
        // 400, so a scanner cannot probe code shapes.
        let has_window = state.window.lock().map(|g| g.is_some()).unwrap_or(false);
        if !has_window {
            return pairing_unavailable();
        }
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "pairing code must be 8 characters" })),
        )
            .into_response();
    }
    let device_id = req.device_id.unwrap_or_default().trim().to_string();
    if device_id.is_empty() || device_id.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "device_id is required" })),
        )
            .into_response();
    }
    let device_name: String = req
        .device_name
        .unwrap_or_default()
        .trim()
        .chars()
        .take(64)
        .collect();
    let device_name = if device_name.is_empty() {
        "Phone".to_string()
    } else {
        device_name
    };
    let platform = req.platform.unwrap_or_default();
    let platform: String = platform.trim().chars().take(32).collect();

    // Check the window state machine.
    let now = std::time::Instant::now();
    let outcome = state.window.lock().map(|mut guard| {
        let w = guard.as_mut().ok_or(ClaimError::NoWindow)?;
        w.claim(&raw_code, now)
    });
    let outcome = outcome.unwrap_or(Err(ClaimError::NoWindow));
    match outcome {
        Ok(()) => {}
        Err(ClaimError::NoWindow) => return pairing_unavailable(),
        Err(ClaimError::Expired) => {
            return (
                StatusCode::GONE,
                Json(serde_json::json!({ "error": "pairing code expired; ask the PC for a new one" })),
            )
                .into_response();
        }
        Err(ClaimError::Wrong { left }) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "wrong pairing code", "attempts_left": left })),
            )
                .into_response();
        }
        Err(ClaimError::Locked) => {
            // Close a locked window: only the PC's user can open a new one.
            if let Ok(mut guard) = state.window.lock() {
                *guard = None;
            }
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({ "error": "too many wrong codes; ask the PC for a new one" })),
            )
                .into_response();
        }
        Err(ClaimError::BadFormat) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "pairing code must be 8 characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789" })),
            )
                .into_response();
        }
    }

    // Window claimed: mint the per-device token and store its hash.
    // Re-pairing the same `device_id` replaces its row and keeps the
    // PC user's `display_name`.
    let token = super::pair_code::mint_token();
    let hash = super::pair_code::token_hash(&token);
    let paired_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let provider_id = {
        let guard = match state.db.lock() {
            Ok(g) => g,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "database unavailable" })),
                )
                    .into_response();
            }
        };
        crate::db::ensure_provider_id(guard.connection()).unwrap_or_default()
    };
    let port = api_port(&state);
    {
        let guard = match state.db.lock() {
            Ok(g) => g,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "database unavailable" })),
                )
                    .into_response();
            }
        };
        if let Err(e) = guard.connection().execute(
            "INSERT INTO paired_devices
                 (id, name, display_name, platform, token_hash, paired_at, last_seen_at)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               platform = excluded.platform,
               token_hash = excluded.token_hash,
               paired_at = excluded.paired_at,
               last_seen_at = excluded.last_seen_at",
            rusqlite::params![device_id, device_name, platform, hash, paired_at],
        ) {
            tracing::warn!("pair claim insert failed: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not store the paired device" })),
            )
                .into_response();
        }
    }
    // Single use: close the window.
    if let Ok(mut guard) = state.window.lock() {
        *guard = None;
    }
    (
        StatusCode::OK,
        Json(ClaimResponse {
            provider_id,
            provider_name: crate::commands::api::device_name(),
            provider_platform: std::env::consts::OS.into(),
            port,
            token,
            paired_at,
        }),
    )
        .into_response()
}
