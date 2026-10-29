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

/// What the gate learned about the caller: `None` on loopback (the PC's
/// own UI and local scripts, which need no device), `Some(id)` for a
/// paired phone over LAN. `POST /v1/print` reads it to stamp
/// `requested_by_device_id` on the job row (Release B §3.4).
#[derive(Clone, Debug)]
pub(crate) struct AuthedDevice {
    pub device_id: Option<String>,
}

/// One hashed lookup answering every gate question at once (Release A
/// §3.1 plus §3.3 and §3.6): who is this token, may they use the main
/// routes, and which account claimed them? Length-guarded first so a megabyte Authorization header never reaches
/// the hash. Anything about *why* it fails stays out of the message —
/// callers answer 401 either way, so a scanner learns nothing.
///
/// Render-only phones (`can_print` false) come back with `can_print`
/// false: they keep the peer routes, which never consult the flag, while
/// the main gate refuses them.
pub(crate) struct DeviceAuth {
    pub device_id: String,
    pub can_print: bool,
    pub account_id: Option<String>,
    pub service_url: Option<String>,
    pub role: String,
    pub expires_at: Option<String>,
}

pub(crate) fn lookup_device(state: &ApiState, presented: &str) -> Option<DeviceAuth> {
    if presented.is_empty() || presented.len() > 256 {
        return None;
    }
    let hash = crate::api::pair_code::token_hash(presented);
    state.db.lock().ok().and_then(|guard| {
        guard
            .connection()
            .query_row(
                "SELECT id, can_print, account_id, service_url, role, expires_at
                 FROM paired_devices WHERE token_hash = ?1",
                [&hash],
                |r| {
                    Ok(DeviceAuth {
                        device_id: r.get(0)?,
                        can_print: r.get(1)?,
                        account_id: r.get(2)?,
                        service_url: r.get(3)?,
                        role: r.get(4)?,
                        expires_at: r.get(5)?,
                    })
                },
            )
            .ok()
    })
}

/// This PC's own account: the `share_user_id` saved at sign-in plus the
/// service URL it belongs to (Release C §3.6). `None` while signed out —
/// and a signed-out PC honours no pair, on any route.
pub(crate) fn pc_account(conn: &rusqlite::Connection) -> Option<(String, String)> {
    let user: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'share_user_id'",
            [],
            |r| r.get(0),
        )
        .ok()
        .filter(|s: &String| !s.trim().is_empty())?;
    let url: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'share_service_url'",
            [],
            |r| r.get(0),
        )
        .ok()
        .filter(|s: &String| !s.trim().is_empty())?;
    Some((user, url))
}

/// Whether this pair is still good for `device`: claimed under the PC's
/// current account, and the PC still signed in to it. A sign-out or an
/// account switch disables existing pairs — they must be redone (§3.6).
/// Guest pairs (ARCHITECTURE §9) skip this entirely: they were
/// never claimed under an account, only expiry governs them (checked
/// separately). Callers answer the generic 401 either way, so the phone
/// cannot tell a disabled pair from a revoked one; both mean "pair again".
fn pair_account_current(state: &ApiState, device: &DeviceAuth) -> bool {
    if device.role == "guest" {
        return true;
    }
    state
        .db
        .lock()
        .ok()
        .and_then(|guard| pc_account(guard.connection()))
        .is_some_and(|(user, url)| {
            device.account_id.as_deref() == Some(user.as_str())
                && device.service_url.as_deref() == Some(url.as_str())
        })
}

/// Whether a guest pair already ran out its invite: a past `expires_at`
/// fails closed (unparseable too — only hand-edited rows do that).
fn pair_unexpired(device: &DeviceAuth) -> bool {
    match device.expires_at.as_deref() {
        // Owners (and legacy rows) never expire.
        None => true,
        Some(exp) => exp
            .parse::<chrono::DateTime<chrono::Utc>>()
            .is_ok_and(|t| t > chrono::Utc::now()),
    }
}

/// Throttled `last_seen_at` touch (at most one write per 30 s per
/// device): shared by both gates so every authenticated request does
/// not pay a write.
pub(crate) fn touch_last_seen(state: &ApiState, presented: &str) {
    let hash = crate::api::pair_code::token_hash(presented);
    if let Ok(guard) = state.db.lock() {
        let _ = guard.connection().execute(
            "UPDATE paired_devices SET last_seen_at = datetime('now')
             WHERE token_hash = ?1
               AND (last_seen_at IS NULL
                    OR (strftime('%s','now') - strftime('%s',last_seen_at)) > 30)",
            [&hash],
        );
    }
}

/// Failed-token attempts remembered per source address (Release A §3.1).
/// Process-global like `status::SUPPORT`: the server is one process, and
/// tests use distinct addresses to stay isolated from each other.
static AUTH_FAILURES: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::HashMap<std::net::IpAddr, std::collections::VecDeque<std::time::Instant>>,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Failures remembered per address: more than this many inside the
/// window answers 429 until the window slides past.
const AUTH_FAIL_MAX: usize = 10;
const AUTH_FAIL_WINDOW_SECS: u64 = 60;
/// Bound on tracked addresses: a rotating-source flood cannot grow the
/// map without bound; quiet entries are reaped once past this size.
const AUTH_FAIL_MAX_ADDRS: usize = 512;

fn prune_failures(
    queue: &mut std::collections::VecDeque<std::time::Instant>,
    now: std::time::Instant,
) {
    while queue
        .front()
        .is_some_and(|t| now.duration_since(*t).as_secs() > AUTH_FAIL_WINDOW_SECS)
    {
        queue.pop_front();
    }
}

/// True when `ip` failed too often too recently: answer 429 without
/// touching the database.
pub(crate) fn auth_throttled(ip: &std::net::IpAddr) -> bool {
    let Ok(mut guard) = AUTH_FAILURES.lock() else {
        return false;
    };
    let now = std::time::Instant::now();
    match guard.get_mut(ip) {
        Some(queue) => {
            prune_failures(queue, now);
            queue.len() >= AUTH_FAIL_MAX
        }
        None => false,
    }
}

/// Record one failed attempt from `ip`.
pub(crate) fn note_auth_failure(ip: &std::net::IpAddr) {
    let Ok(mut guard) = AUTH_FAILURES.lock() else {
        return;
    };
    if guard.len() >= AUTH_FAIL_MAX_ADDRS {
        let now = std::time::Instant::now();
        guard.retain(|_, queue| {
            prune_failures(queue, now);
            !queue.is_empty()
        });
    }
    let queue = guard.entry(*ip).or_default();
    prune_failures(queue, std::time::Instant::now());
    queue.push_back(std::time::Instant::now());
    while queue.len() > AUTH_FAIL_MAX * 2 {
        queue.pop_front();
    }
}

/// Extract a Bearer token or return an empty string when there is none.
fn bearer_token(req: &Request) -> &str {
    req.headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
}

/// Generic 401 body: identical whatever the reason, so a scanner learns
/// nothing about whether a token exists.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "bad or missing pairing token" })),
    )
        .into_response()
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
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
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
    if auth_throttled(&addr.ip()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "too many failed attempts; slow down" })),
        )
            .into_response();
    }
    let presented = bearer_token(&req);
    let device = lookup_device(&state, presented);
    let Some(device) = device else {
        note_auth_failure(&addr.ip());
        return unauthorized();
    };
    // A sign-out or account switch disables the pair (§3.6): generic 401,
    // like a revocation. Renders too — a disabled pair renders nothing.
    // Expired guests fail the same way (ARCHITECTURE §9).
    if !pair_unexpired(&device) || !pair_account_current(&state, &device) {
        return unauthorized();
    }
    touch_last_seen(&state, presented);
    next.run(req).await
}

/// Gate for every non-pairing route (Release A §3.1, paired-only LAN).
///
/// Loopback callers (the PC's own UI and local scripts, including the
/// API explorer's Rust proxy) pass through unchanged. Anything else must
/// present a paired-device Bearer token; failures answer 401 with the
/// same generic text whatever the reason, and repeated failures from one
/// address answer 429. A pair claimed under another account — or after
/// the PC signed out — answers that same 401 (§3.6). Sharing off refuses
/// non-loopback with 403, like the peer gate. Pairing introduction
/// (`/v1/pair/hello`, `/v1/pair/claim`) lives on its own sub-router and
/// is exempt here — it has its own guards.
pub async fn require_paired_or_local(
    State(state): State<ApiState>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    if addr.ip().is_loopback() {
        req.extensions_mut()
            .insert(AuthedDevice { device_id: None });
        return next.run(req).await;
    }
    if !sharing_on(&state) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "sharing is disabled on this device" })),
        )
            .into_response();
    }
    if auth_throttled(&addr.ip()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "too many failed attempts; slow down" })),
        )
            .into_response();
    }
    let presented = bearer_token(&req);
    let device = lookup_device(&state, presented);
    let Some(device) = device else {
        note_auth_failure(&addr.ip());
        return unauthorized();
    };
    // Render-only phones (can_print false) keep the peer routes, which
    // never consult the flag — but every route behind this gate refuses
    // them here.
    if !device.can_print {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "printing is not allowed for this device" })),
        )
            .into_response();
    }
    // A sign-out or account switch disables the pair (§3.6): generic 401,
    // like a revocation — the phone pairs again. Expired guests fail the
    // same way (ARCHITECTURE §9).
    if !pair_unexpired(&device) || !pair_account_current(&state, &device) {
        return unauthorized();
    }
    // Stamp the caller's device for handlers: `POST /v1/print` records it
    // on the job row (Release B §3.4). The touch runs first so no borrow
    // of the request is live across the extensions insert.
    touch_last_seen(&state, presented);
    req.extensions_mut().insert(AuthedDevice {
        device_id: Some(device.device_id),
    });
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
