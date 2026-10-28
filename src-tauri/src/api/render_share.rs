use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use super::routes::ApiState;
use crate::commands::print::JobRenderer;

/// Wire protocol version. A consumer refuses anything else and renders
/// locally instead of guessing at an incompatible schema.
pub const PROTOCOL_VERSION: u32 = 1;
/// Largest HTML body accepted: a finished label document is kilobytes;
/// anything bigger is a mistake or an attack, not a label.
pub const MAX_HTML_BYTES: usize = 10 * 1024 * 1024;
/// Renders that may run at once on this device. Rendering is the
/// heaviest thing the app does; an unbounded peer could wedge the
/// provider's own prints behind a queue of remote jobs.
pub const MAX_CONCURRENT_RENDERS: usize = 2;
/// Seconds before a peer render is abandoned. The consumer enforces its
/// own (shorter) deadline and falls back to local rendering.
pub const RENDER_TIMEOUT_SECS: u64 = 180;

/// Largest request body the peer routes buffer. A little above
/// `MAX_HTML_BYTES` so an oversize document still reaches validation and
/// gets a JSON 413 explaining itself; anything bigger is cut off by the
/// extractor before it can fill memory.
pub const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

static RENDER_PERMITS: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(MAX_CONCURRENT_RENDERS);

/// Prints rendering on THIS device right now. A provider's own prints
/// come first: while one is rendering, peer requests are told to retry
/// (the phone then renders locally), so a phone can never make the PC's
/// own printing slower.
static LOCAL_RENDERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Held by the print pipeline for the duration of a local render.
pub struct LocalRenderGuard;

impl LocalRenderGuard {
    pub fn enter() -> Self {
        LOCAL_RENDERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        LocalRenderGuard
    }
}

impl Drop for LocalRenderGuard {
    fn drop(&mut self) {
        LOCAL_RENDERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

pub fn local_render_busy() -> bool {
    LOCAL_RENDERS.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// Compare secrets without an early exit on the first differing byte.
/// Kept for the pairing-code comparison pattern; the peer gate now looks
/// up per-device token hashes instead.
#[allow(dead_code)]
fn secrets_match(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// What device A sends device B: finished, laid-out HTML plus the paper
/// geometry and head parameters the render stage needs. No template, no
/// data, no printer — B never touches the database, the network, or a
/// transport. `language` names the bytes B must return (`pdf` for
/// document bytes, otherwise a command language rasterized at `dpi`).
#[derive(Debug, Clone, Deserialize)]
pub struct PeerRenderRequest {
    pub protocol: u32,
    pub html: String,
    pub paper_w_mm: f64,
    pub paper_h_mm: f64,
    pub orientation: String,
    pub language: String,
    pub dpi: u32,
}

/// The render stage's output, base64 so the whole round-trip stays JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerRenderResponse {
    pub bytes_b64: String,
    pub mime: String,
    pub render_ms: u64,
}

/// What A reads before choosing a provider: whether this device can
/// render at all, and a static capability score (cores plus a bonus for
/// a local browser renderer). A timed probe render replaces the bonus
/// once the Android WebView path can serve peers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub protocol: u32,
    pub can_render: bool,
    pub score: u64,
    pub cores: u32,
    pub platform: String,
    pub max_concurrent_renders: usize,
}

/// A browser renderer exists on desktop only: headless Edge on Windows,
/// system Chromium on Linux. Anywhere else `PdfRenderer` refuses rather
/// than returning a placeholder, so the provider must advertise that
/// honestly — A must never pick a B that cannot render.
pub fn can_render() -> bool {
    cfg!(windows) || cfg!(target_os = "linux")
}

fn cores() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
}

pub fn capability_score() -> u64 {
    cores() as u64 * 100 + if can_render() { 500 } else { 0 }
}

/// Languages the endpoint accepts. Unlike the print pipeline — which
/// falls back to PDF for an unknown stored value — the peer endpoint
/// refuses unknown names: silently rendering PDF bytes for a ZPL head
/// would waste paper, not save time.
fn parse_language(raw: &str) -> Option<crate::transport::PrinterLanguage> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "pdf" => Some(crate::transport::PrinterLanguage::Pdf),
        "escpos" | "esc/pos" | "esc-pos" => Some(crate::transport::PrinterLanguage::Escpos),
        "tspl" | "tspl2" => Some(crate::transport::PrinterLanguage::Tspl),
        "zpl" | "zpl2" => Some(crate::transport::PrinterLanguage::Zpl),
        "cpcl" => Some(crate::transport::PrinterLanguage::Cpcl),
        "raster" => Some(crate::transport::PrinterLanguage::Raster),
        _ => None,
    }
}

/// Pure validation so tests can pin the contract without a browser.
/// Returns the parsed language and clamped dpi on success.
fn validate_request(
    req: &PeerRenderRequest,
) -> Result<(crate::transport::PrinterLanguage, u32), String> {
    if req.protocol != PROTOCOL_VERSION {
        return Err(format!(
            "unsupported protocol {} (this device speaks {PROTOCOL_VERSION})",
            req.protocol
        ));
    }
    if req.html.trim().is_empty() {
        return Err("`html` is required (send the finished, laid-out document)".into());
    }
    if req.html.len() > MAX_HTML_BYTES {
        return Err(format!(
            "`html` is {} bytes, over the {} byte cap",
            req.html.len(),
            MAX_HTML_BYTES
        ));
    }
    for (name, v) in [
        ("paper_w_mm", req.paper_w_mm),
        ("paper_h_mm", req.paper_h_mm),
    ] {
        if !v.is_finite() || !(1.0..=1000.0).contains(&v) {
            return Err(format!("`{name}` must be 1–1000mm (got {v})"));
        }
    }
    match req.orientation.trim().to_ascii_lowercase().as_str() {
        "portrait" | "landscape" => {}
        other => {
            return Err(format!(
                "`orientation` must be portrait|landscape (got `{other}`)"
            ))
        }
    }
    let language = parse_language(&req.language)
        .ok_or_else(|| format!("unknown `language` `{}`", req.language))?;
    // Mirror the pipeline: clamp, don't reject, a hand-set dpi.
    Ok((language, req.dpi.clamp(1, 1200)))
}

/// Whether sharing is on. Read per request: correctness over caching
/// (a removed phone must take effect immediately).
fn sharing_on(state: &ApiState) -> bool {
    let guard = match state.db.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    guard
        .connection()
        .query_row(
            "SELECT value FROM settings WHERE key = 'render_share_enabled'",
            [],
            |r| r.get::<_, String>(0),
        )
        .is_ok_and(|v| v == "true")
}

/// Bearer gate for the peer endpoints. Disabled sharing answers 403 so
/// a scanner learns nothing about whether a token exists; a wrong or
/// missing token on enabled sharing answers 401.
///
/// Each phone holds its own token (minted by `POST /v1/pair/claim`); the
/// PC stores only `sha256(token)` in `paired_devices`. Removing a phone
/// deletes its row and takes effect on its next request. The old shared
/// `render_secret` is no longer accepted (plan §5.5, §10).
pub async fn require_peer_auth(
    State(state): State<ApiState>,
    req: Request,
    next: Next,
) -> Response {
    if !sharing_on(&state) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "render sharing is disabled on this device" })),
        )
            .into_response();
    };
    let presented = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if presented.is_empty() || presented.len() > 256 {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "bad or missing pairing token" })),
        )
            .into_response();
    }
    let hash = crate::api::pair_code::token_hash(presented);
    let known = state
        .db
        .lock()
        .ok()
        .and_then(|guard| {
            let n: i64 = guard
                .connection()
                .query_row(
                    "SELECT COUNT(*) FROM paired_devices WHERE token_hash = ?1",
                    [&hash],
                    |r| r.get(0),
                )
                .ok()?;
            Some(n > 0)
        })
        .unwrap_or(false);
    if !known {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "bad or missing pairing token" })),
        )
            .into_response();
    }
    // Throttle `last_seen_at`: at most one write per 30 s per device, so
    // every render does not pay a write.
    if let Ok(guard) = state.db.lock() {
        let _ = guard.connection().execute(
            "UPDATE paired_devices SET last_seen_at = datetime('now')
             WHERE token_hash = ?1
               AND (last_seen_at IS NULL
                    OR (strftime('%s','now') - strftime('%s',last_seen_at)) > 30)",
            [&hash],
        );
    }
    next.run(req).await
}

pub async fn peer_capabilities(State(_state): State<ApiState>) -> impl IntoResponse {
    Json(Capabilities {
        protocol: PROTOCOL_VERSION,
        can_render: can_render(),
        score: capability_score(),
        cores: cores(),
        platform: std::env::consts::OS.into(),
        max_concurrent_renders: MAX_CONCURRENT_RENDERS,
    })
}

fn busy_response(why: &str) -> Response {
    let mut res = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({ "error": why })),
    )
        .into_response();
    res.headers_mut().insert(
        axum::http::header::RETRY_AFTER,
        axum::http::HeaderValue::from_static("5"),
    );
    res
}

pub async fn peer_render(
    State(state): State<ApiState>,
    Json(req): Json<PeerRenderRequest>,
) -> Response {
    let (language, dpi) = match validate_request(&req) {
        Ok(v) => v,
        Err(msg) => {
            let status = if msg.contains("over the") {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            };
            return (status, Json(serde_json::json!({ "error": msg }))).into_response();
        }
    };
    if !can_render() {
        // Authenticated but honest: this platform has no renderer, so say
        // so instead of burning the consumer's deadline on a doomed job.
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "this device has no PDF renderer (desktop with Edge/Chromium required)" })),
        )
            .into_response();
    }
    if local_render_busy() {
        return busy_response("provider is printing its own job");
    }
    let _permit = match RENDER_PERMITS.try_acquire() {
        Ok(p) => p,
        Err(_) => return busy_response("provider is busy rendering"),
    };

    let renderer = crate::render::PdfRenderer::new(state.cache_dir.clone());
    // The pipeline creates this before rendering; the endpoint must too —
    // otherwise the job-HTML write fails with ENOENT on a cold cache dir.
    if let Err(e) = tokio::fs::create_dir_all(&state.cache_dir).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("cache dir unavailable: {e}") })),
        )
            .into_response();
    }
    let html = req.html.clone();
    let orientation = req.orientation.trim().to_ascii_lowercase();
    let started = std::time::Instant::now();
    let rendered = tokio::time::timeout(
        std::time::Duration::from_secs(RENDER_TIMEOUT_SECS),
        renderer.render_for_language(
            &html,
            req.paper_w_mm,
            req.paper_h_mm,
            &orientation,
            language,
            dpi,
        ),
    )
    .await;
    let render_ms = started.elapsed().as_millis() as u64;
    match rendered {
        Err(_) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "render timed out" })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": format!("render failed: {e}") })),
        )
            .into_response(),
        Ok(Ok((bytes, mime))) => {
            use base64::Engine as _;
            (
                StatusCode::OK,
                Json(PeerRenderResponse {
                    bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                    mime: mime.into(),
                    render_ms,
                }),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod render_share_tests {
    use super::*;

    fn req() -> PeerRenderRequest {
        PeerRenderRequest {
            protocol: PROTOCOL_VERSION,
            html: "<html><body>hi</body></html>".into(),
            paper_w_mm: 100.0,
            paper_h_mm: 150.0,
            orientation: "portrait".into(),
            language: "pdf".into(),
            dpi: 203,
        }
    }

    #[test]
    fn accepts_the_documented_request_shape() {
        let (lang, dpi) = validate_request(&req()).expect("valid request");
        assert!(matches!(lang, crate::transport::PrinterLanguage::Pdf));
        assert_eq!(dpi, 203);
    }

    #[test]
    fn refuses_unknown_protocol_versions_and_languages() {
        let mut bad = req();
        bad.protocol = 999;
        assert!(validate_request(&bad).is_err());
        let mut bad = req();
        bad.language = "telepathy".into();
        assert!(validate_request(&bad).is_err());
    }

    #[test]
    fn refuses_empty_or_oversize_html_and_bad_geometry() {
        let mut bad = req();
        bad.html = "   ".into();
        assert!(validate_request(&bad).is_err());
        let mut bad = req();
        bad.html = "x".repeat(MAX_HTML_BYTES + 1);
        assert!(validate_request(&bad).is_err());
        for (w, h, o) in [
            (0.0, 150.0, "portrait"),
            (100.0, 5000.0, "portrait"),
            (100.0, 150.0, "sideways"),
        ] {
            let mut bad = req();
            bad.paper_w_mm = w;
            bad.paper_h_mm = h;
            bad.orientation = o.into();
            assert!(validate_request(&bad).is_err(), "{w}x{h} {o}");
        }
    }

    #[test]
    fn clamps_dpi_like_the_pipeline_instead_of_rejecting() {
        let mut bad = req();
        bad.dpi = 0;
        assert_eq!(validate_request(&bad).expect("clamped").1, 1);
        let mut bad = req();
        bad.dpi = 9999;
        assert_eq!(validate_request(&bad).expect("clamped").1, 1200);
    }

    #[test]
    fn secrets_match_only_when_identical() {
        assert!(secrets_match("abc123", "abc123"));
        assert!(!secrets_match("abc123", "abc124"));
        assert!(!secrets_match("abc12", "abc123"));
        assert!(!secrets_match("", "abc123"));
        assert!(secrets_match("", ""));
    }

    #[test]
    fn local_render_guard_marks_the_device_busy_until_dropped() {
        // Other tests may hold guards concurrently, so assert on the
        // transition this guard causes rather than an absolute state.
        let g = LocalRenderGuard::enter();
        assert!(local_render_busy());
        drop(g);
    }

    #[test]
    fn capability_score_rewards_cores_and_a_renderer() {
        let score = capability_score();
        assert!(score >= cores() as u64 * 100);
        assert_eq!(can_render(), cfg!(windows) || cfg!(target_os = "linux"));
    }
}
