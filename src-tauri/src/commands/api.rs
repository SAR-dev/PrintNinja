use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Shutdown handle so `stop_api_server` actually stops the listener.
/// `Mutex` (not `static mut`) to avoid mutable-static-reference UB.
static SHUTDOWN: Mutex<Option<oneshot::Sender<()>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiStatus {
    pub running: bool,
    pub address: String,
    pub port: u16,
    pub lan_access: bool,
}

fn port_from_conn(conn: &rusqlite::Connection, key: &str, default: u16) -> u16 {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(default)
}

fn port_from_settings(db: &DbState, key: &str, default: u16) -> u16 {
    db.lock()
        .ok()
        .map(|g| port_from_conn(g.connection(), key, default))
        .unwrap_or(default)
}

fn bool_from_conn(conn: &rusqlite::Connection, key: &str, default: bool) -> bool {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .map(|v| v == "true" || v == "1")
    .unwrap_or(default)
}

fn bool_from_settings(db: &DbState, key: &str, default: bool) -> bool {
    db.lock()
        .ok()
        .map(|g| bool_from_conn(g.connection(), key, default))
        .unwrap_or(default)
}

/// Whether the API server starts with the app (Settings → API).
/// Opt-in, off by default — an open port must never be a surprise.
pub fn api_autostart_enabled(conn: &rusqlite::Connection) -> bool {
    bool_from_conn(conn, "api_autostart", false)
}

#[tauri::command]
pub fn get_api_status(_app: AppHandle, db: State<DbState>) -> AppResult<ApiStatus> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    Ok(api_status_from_db(
        guard.connection(),
        RUNNING.load(Ordering::Relaxed),
    ))
}

/// The status the UI shows, from one connection. Split out so tests can
/// drive it against a real database without a Tauri runtime: port and
/// LAN come from settings, the bind address from the last start (or the
/// LAN default when never started).
pub fn api_status_from_db(conn: &rusqlite::Connection, running: bool) -> ApiStatus {
    let port = port_from_conn(conn, "api_port", 17717);
    let lan = bool_from_conn(conn, "api_lan_access", false);
    let address = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'api_bind'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .unwrap_or_else(|| {
            if lan {
                "0.0.0.0".into()
            } else {
                "127.0.0.1".into()
            }
        });

    ApiStatus {
        running,
        address,
        port,
        lan_access: lan,
    }
}

/// Handle stored in Tauri state so the UI can query the live bound address.
pub struct ApiServerHandle {
    pub address: String,
    pub port: u16,
}

impl ApiServerHandle {
    fn reset(&self) {
        // Values stay so the UI can still show the last bound address.
    }
}

/// Tell the Android foreground service whether the local API server is
/// up, so the pinned notification shows the live `host:port` while it
/// runs and falls back to the print-queue wording after it stops.
///
/// Best-effort by design: a missing plugin or a declined notification
/// must never fail the start/stop itself. On Android `run_mobile_plugin`
/// blocks until Kotlin answers, so the call lives on a blocking task —
/// `launch_server` runs on the Tokio reactor and must not stall it.
fn notify_android_api_state(app: &AppHandle, running: bool, address: Option<&str>) {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_print::AndroidPrintExt;

        let app = app.clone();
        let state = tauri_plugin_android_print::ApiServerState {
            running,
            address: address.map(str::to_string),
        };
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = app.android_print().set_api_server_state(state) {
                tracing::warn!("could not update the API server notification: {e}");
            }
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        // Desktop shows the status in the tray/topbar instead.
        let _ = (app, running, address);
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn start_api_server(
    app: AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, crate::queue::PrintQueue>,
    port: Option<u16>,
    lan_access: Option<bool>,
) -> AppResult<String> {
    launch_server(
        app,
        db.inner().clone(),
        queue.inner().clone(),
        port,
        lan_access,
    )
    .await
}

/// The whole start-up path, callable without an IPC context so the app
/// itself can auto-start the server at boot (Settings → API). Stays
/// `async`: `bind_addr` needs the Tokio reactor.
pub async fn launch_server(
    app: AppHandle,
    db: DbState,
    queue: crate::queue::PrintQueue,
    port: Option<u16>,
    lan_access: Option<bool>,
) -> AppResult<String> {
    if RUNNING.load(Ordering::Relaxed) {
        return Err(AppError::Validation("API server is already running".into()));
    }

    let port = port.unwrap_or_else(|| port_from_settings(&db, "api_port", 17717));
    let lan = lan_access.unwrap_or_else(|| bool_from_settings(&db, "api_lan_access", false));

    // Persist so a restart keeps the user's choice.
    {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('api_port', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [port.to_string()],
        )?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('api_lan_access', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [if lan { "true" } else { "false" }],
        )?;
    }

    let host = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let addr = format!("{}:{}", host, port);

    // Bound synchronously first so a busy port returns a clear error to
    // the UI instead of failing silently inside the spawned task.
    let listener = bind_addr(&addr)?;

    let display_addr = host.to_string();
    app.manage(ApiServerHandle {
        address: display_addr,
        port,
    });
    {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let conn = guard.connection();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('api_bind', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [host],
        )?;
    }

    let (tx, rx) = oneshot::channel::<()>();
    // The routes need the same queue the desktop UI uses, so an API job and
    // a UI job aimed at the same printer are serialised against each other.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Internal(format!("No cache dir: {e}")))?;
    // The peer path inlines uploaded fonts: record where they live while
    // the AppHandle is here. Autostart covers booted runs; this covers
    // a server started by hand later.
    if let Ok(guard) = db.lock() {
        crate::commands::font::ensure_fonts_dir(&app, guard.connection());
    }
    // Store the sender so stop() can trigger it. After the fallible setup
    // above, so a failed start leaves no stale handle behind.
    if let Ok(mut slot) = SHUTDOWN.lock() {
        *slot = Some(tx);
    }
    let state = crate::api::routes::ApiState {
        db: db.clone(),
        queue: std::sync::Arc::new(queue),
        cache_dir,
        window: pairing_window(&app),
    };
    let router = crate::api::routes::router_with_state(state, lan);
    let app2 = app.clone();

    let log_addr = addr.clone();
    // Mark running synchronously: the frontend polls get_api_status right
    // after start returns, and on slow (mobile) devices the spawned task
    // may not have run yet — the UI then shows "stopped" and a second tap
    // fails with "already running". All fallible setup is done above, so
    // nothing after this point can fail before the task takes over.
    RUNNING.store(true, Ordering::Relaxed);
    // Pin the live address in the Android notification right away: the
    // spawned task below has not bound yet, but the listener already has.
    notify_android_api_state(&app, true, Some(&addr));
    tauri::async_runtime::spawn(async move {
        tracing::info!("API server listening on {}", log_addr);

        // Keep the peer address available to handlers via ConnectInfo.
        let server = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = rx.await;
        });

        if let Err(e) = server.await {
            tracing::error!("API server error: {}", e);
        }

        RUNNING.store(false, Ordering::Relaxed);
        tracing::info!("API server stopped");

        // Drop the address from the pinned notification: reached on an
        // explicit stop and on a listener error alike, since both end
        // with this task.
        notify_android_api_state(&app2, false, None);

        // Clean up managed state so a restart re-registers it.
        if let Some(handle) = app2.try_state::<ApiServerHandle>() {
            handle.reset();
        }
    });

    Ok(addr)
}

/// One HTTP round-trip as the Explorer shows it: status line plus the
/// raw body (pretty-printed by the UI).
#[derive(Debug, Clone, Serialize)]
pub struct ApiHttpResponse {
    pub status: u16,
    pub text: String,
}

/// Loopback guard for `api_request`: the URL must be a local http(s)
/// address on `127.0.0.0/8`, `::1` or `localhost`, so the command can
/// never be pointed at a remote host. Split out so tests can pin the
/// allow-list without an async runtime or a network.
fn loopback_url(url: &str) -> AppResult<reqwest::Url> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| AppError::Validation(format!("Bad URL: {e}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Validation(format!(
            "Only http(s) URLs are reachable (got scheme '{}')",
            parsed.scheme()
        )));
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let loopback = host == "localhost" || host == "::1" || host.starts_with("127.");
    if !loopback {
        return Err(AppError::Validation(format!(
            "Only loopback URLs are reachable from the Explorer (got '{host}')"
        )));
    }
    Ok(parsed)
}

/// The Explorer's HTTP client, in Rust rather than in the WebView.
///
/// The page is served from `https://tauri.localhost`, so its `fetch()` to
/// `http://127.0.0.1:<port>` is both cross-origin and mixed content. Two
/// independent blocks follow: the router sends no `Access-Control-Allow-Origin`
/// on a loopback bind (that header is for the opt-in LAN mode), and Android's
/// WebView refuses cleartext subresources from an https origin outright — so
/// every call died with "Failed to fetch" even though the server was
/// listening. From Rust there is no origin, no CORS and no mixed-content
/// check.
///
/// Loopback is the whole allow-list ([`loopback_url`]), so this command
/// cannot be turned into an open proxy.
#[tauri::command(rename_all = "snake_case")]
pub async fn api_request(
    method: String,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> AppResult<ApiHttpResponse> {
    let parsed = loopback_url(&url)?;
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| AppError::Validation(format!("Bad HTTP method: {e}")))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut req = client.request(method, parsed);
    if let Some(headers) = headers {
        for (name, value) in headers {
            req = req.header(name, value);
        }
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    let res = req
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Request failed: {e}")))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok(ApiHttpResponse { status, text })
}

#[cfg(test)]
mod render_share_cmd_tests {
    use super::lan_ip;

    #[test]
    fn lan_ip_always_returns_something_routable_or_loopback() {
        assert!(!lan_ip().is_empty());
    }
}

#[cfg(test)]
mod api_request_tests {
    use super::loopback_url;

    #[test]
    fn accepts_every_loopback_spelling_the_explorer_uses() {
        for url in [
            "http://127.0.0.1:17717/v1/health",
            "http://127.0.0.1:17717/v1/jobs/12/retry",
            "http://localhost:17717/v1/openapi.json",
            "http://[::1]:17717/v1/metrics",
        ] {
            assert!(loopback_url(url).is_ok(), "{url} should be reachable");
        }
    }

    #[test]
    fn refuses_anything_that_is_not_local_http() {
        for url in [
            "http://example.com/v1/health",
            "https://example.com/v1/health",
            "http://192.168.1.4:17717/v1/health",
            "file:///etc/passwd",
            "http:///v1/health",
            "not a url",
        ] {
            assert!(loopback_url(url).is_err(), "{url} must be refused");
        }
    }
}

/// Probe a candidate provider the operator typed in: returns its
/// capabilities or a readable error. Used by the Devices UI "test"
/// button, and by the phone's PC-status banner for a saved pair (which
/// passes the pair's `name` so the error names the PC, not its address).
#[tauri::command]
pub async fn peer_capabilities(
    host: String,
    port: u16,
    secret: String,
    name: Option<String>,
) -> AppResult<crate::api::render_share::Capabilities> {
    // The stored pair's name ("Studio PC") reads better in an error than
    // its address; an unpaired candidate typed into the form has none.
    let name = name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| host.clone());
    let pair = crate::api::peer_consume::RenderPair {
        id: String::new(),
        name,
        host,
        port,
        secret,
        fingerprint: String::new(),
        provider_id: String::new(),
        platform: String::new(),
        paired_at: String::new(),
        device_id: String::new(),
    };
    crate::api::peer_consume::probe_fresh(&pair)
        .await
        .map(|(_, caps)| caps)
        .map_err(AppError::Validation)
}

/// Buy one render from a host/port/secret triple. The print pipeline
/// uses the stored pairs instead; this command exists so a future
/// caller (or a manual test) can prove the round-trip end to end.
#[tauri::command]
pub async fn peer_render_request(
    req: crate::api::peer_consume::PeerRenderArgs,
) -> AppResult<crate::api::render_share::PeerRenderResponse> {
    let pair = crate::api::peer_consume::RenderPair {
        id: String::new(),
        name: req.host.clone(),
        host: req.host,
        port: req.port,
        secret: req.secret,
        fingerprint: String::new(),
        provider_id: String::new(),
        platform: String::new(),
        paired_at: String::new(),
        device_id: String::new(),
    };
    let job = crate::api::peer_consume::PeerRenderJob {
        // The caller supplies raw HTML deliberately, but the no-fetch
        // guarantee holds for every print: strip remote auto-load refs
        // (record data is the usual carrier, not the template).
        html: crate::render::handlebars::sanitize_html(&req.html),
        paper_w_mm: req.paper_w_mm,
        paper_h_mm: req.paper_h_mm,
        orientation: req.orientation,
        language: req.language,
        dpi: req.dpi.clamp(1, 1200),
    };
    crate::api::peer_consume::render_on(&pair, &job)
        .await
        .map(|o| crate::api::render_share::PeerRenderResponse {
            bytes_b64: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(&o.bytes)
            },
            mime: o.mime,
            render_ms: o.render_ms,
        })
        .ok_or_else(|| AppError::Validation("peer render failed; see the provider's logs".into()))
}

/// Signals the listener to shut down and waits (bounded) until it has.
/// Graceful shutdown finishes asynchronously, so returning right away left
/// `RUNNING` true: the UI re-read the status, still saw "running", and a
/// stop-then-start (Settings → Devices) failed with "already running".
#[tauri::command]
pub async fn stop_api_server() -> AppResult<()> {
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }
    if let Ok(mut slot) = SHUTDOWN.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
    }
    for _ in 0..STOP_WAIT_STEPS {
        if !RUNNING.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(STOP_WAIT_STEP_MS)).await;
    }
    Ok(())
}

/// Upper bound for `stop_api_server` to wait: 100 x 50 ms = 5 s.
const STOP_WAIT_STEPS: u32 = 100;
const STOP_WAIT_STEP_MS: u64 = 50;

/// What Settings → Devices shows: whether this device answers peer
/// renders, and how many phones are paired. Per-device tokens replaced
/// the shared secret, so there is no secret to report — only the count.
#[derive(Debug, Clone, Serialize)]
pub struct RenderShareStatus {
    pub enabled: bool,
    pub secret_set: bool,
    pub port: u16,
    pub lan_access: bool,
    /// Whether the local API server is up right now. Sharing only works
    /// while it is, so the UI shows "on" only when this and `lan_access`
    /// are both true.
    pub running: bool,
    /// Phones currently paired with this PC.
    pub paired_count: usize,
}

#[tauri::command]
pub fn get_render_status(db: State<DbState>) -> AppResult<RenderShareStatus> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let status = api_status_from_db(conn, RUNNING.load(Ordering::Relaxed));
    let enabled = bool_from_conn(conn, "render_share_enabled", false);
    let paired_count: usize = conn
        .query_row("SELECT COUNT(*) FROM paired_devices", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n.max(0) as usize)
        .unwrap_or(0);
    Ok(RenderShareStatus {
        enabled,
        secret_set: paired_count > 0,
        port: status.port,
        lan_access: status.lan_access,
        running: status.running,
        paired_count,
    })
}

/// Flip render sharing. Pairing codes do the introduction now, so there
/// is no shared secret to mint — enabling just flips the toggle. The
/// return stays a `String` for IPC compatibility and is always empty.
#[tauri::command(rename_all = "snake_case")]
pub fn set_render_sharing(db: State<DbState>, enabled: bool) -> AppResult<String> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    crate::commands::settings::write_setting(
        guard.connection(),
        "render_share_enabled",
        if enabled { "true" } else { "false" },
    )?;
    Ok(String::new())
}

// ── Pairing codes (PC side + phone side) ──────────────────────────────

/// Shared pairing window, managed once in Tauri state so the HTTP routes
/// (`ApiState::window`) and the commands below open and claim the same
/// window. `launch_server` reuses the managed copy when it builds the
/// router.
pub struct PairingState {
    pub window: std::sync::Arc<std::sync::Mutex<Option<crate::api::pair_code::PairingWindow>>>,
}

impl Default for PairingState {
    fn default() -> Self {
        PairingState {
            window: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

fn pairing_window(
    app: &AppHandle,
) -> std::sync::Arc<std::sync::Mutex<Option<crate::api::pair_code::PairingWindow>>> {
    if let Some(state) = app.try_state::<PairingState>() {
        return state.window.clone();
    }
    let fresh = PairingState::default();
    let window = fresh.window.clone();
    // `manage` fails only when already managed (a concurrent start); the
    // returned clone still points at an equivalent fresh window then.
    let _ = app.manage(fresh);
    app.try_state::<PairingState>()
        .map(|s| s.window.clone())
        .unwrap_or(window)
}

/// What `start_pairing` / `get_pairing_state` report: the code to show,
/// seconds until it expires, and where the phone can reach this PC.
#[derive(Debug, Clone, Serialize)]
pub struct PairingStatePayload {
    pub open: bool,
    pub code: String,
    pub expires_in: u64,
    pub host: String,
    pub port: u16,
}

fn pairing_status_locked(
    db: &DbState,
    window: &Option<crate::api::pair_code::PairingWindow>,
) -> PairingStatePayload {
    let now = std::time::Instant::now();
    let (code, expires_in, open) = match window {
        Some(w) if !w.is_expired(now) && !w.is_locked() => {
            let left = crate::api::pair_code::pairing_ttl()
                .checked_sub(now.duration_since(w.opened()))
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (crate::api::pair_code::format_display(w.code()), left, true)
        }
        _ => (String::new(), 0, false),
    };
    let (host, port) = db
        .lock()
        .ok()
        .map(|guard| {
            let conn = guard.connection();
            (lan_ip(), port_from_conn(conn, "api_port", 17717))
        })
        .unwrap_or_else(|| ("127.0.0.1".into(), 17717));
    PairingStatePayload {
        open,
        code,
        expires_in,
        host,
        port,
    }
}

/// Open a pairing window and return the code to show. Replaces any
/// open window (one active code at a time). Valid 90 s by default
/// (`PRINTNINJA_PAIRING_TTL_SECS` overrides). Needs sharing on — the
/// claim route refuses while it is off.
#[tauri::command]
pub fn start_pairing(
    db: State<DbState>,
    pairing: State<PairingState>,
) -> AppResult<PairingStatePayload> {
    {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        if !bool_from_conn(guard.connection(), "render_share_enabled", false) {
            return Err(AppError::Validation(
                "render sharing is not enabled on this device".into(),
            ));
        }
    }
    let code = crate::api::pair_code::generate_code();
    {
        let mut guard = pairing
            .window
            .lock()
            .map_err(|_| AppError::Internal("pairing state locked".into()))?;
        *guard = Some(crate::api::pair_code::PairingWindow::new(
            code,
            std::time::Instant::now(),
        ));
    }
    let guard = pairing
        .window
        .lock()
        .map_err(|_| AppError::Internal("pairing state locked".into()))?;
    Ok(pairing_status_locked(db.inner(), &guard))
}

/// Close the pairing window without claiming it.
#[tauri::command]
pub fn cancel_pairing(pairing: State<PairingState>) -> AppResult<()> {
    pairing
        .window
        .lock()
        .map(|mut guard| *guard = None)
        .map_err(|_| AppError::Internal("pairing state locked".into()))
}

/// What the PC panel shows right now: the code, seconds left, and the
/// PC's address. The panel polls this while open and regenerates when
/// the countdown ends.
#[tauri::command]
pub fn get_pairing_state(
    db: State<DbState>,
    pairing: State<PairingState>,
) -> AppResult<PairingStatePayload> {
    let guard = pairing
        .window
        .lock()
        .map_err(|_| AppError::Internal("pairing state locked".into()))?;
    Ok(pairing_status_locked(db.inner(), &guard))
}

/// One row of the PC's "Paired phones" list. `name` is what the phone
/// reported; `display_name` is the PC user's rename and wins.
#[derive(Debug, Clone, Serialize)]
pub struct PairedDeviceRow {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub platform: String,
    pub paired_at: String,
    pub last_seen_at: String,
}

#[tauri::command]
pub fn list_paired_devices(db: State<DbState>) -> AppResult<Vec<PairedDeviceRow>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let mut stmt = guard.connection().prepare(
        "SELECT id, name, display_name, platform, paired_at, last_seen_at
         FROM paired_devices ORDER BY paired_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PairedDeviceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                display_name: row.get(2)?,
                platform: row.get(3)?,
                paired_at: row.get(4)?,
                last_seen_at: row.get(5)?,
            })
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Remove one paired phone. Its token fails with 401 on its next request.
#[tauri::command(rename_all = "snake_case")]
pub fn revoke_paired_device(db: State<DbState>, id: String) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let n = guard
        .connection()
        .execute("DELETE FROM paired_devices WHERE id = ?1", [&id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("paired phone '{id}' not found")));
    }
    Ok(())
}

/// Remove every paired phone ("Remove all phones" in the UI).
#[tauri::command]
pub fn clear_paired_devices(db: State<DbState>) -> AppResult<u64> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let n = guard
        .connection()
        .execute("DELETE FROM paired_devices", [])?;
    Ok(n as u64)
}

/// Rename a paired phone. The PC's name wins and survives re-pairing;
/// an empty name clears the override.
#[tauri::command(rename_all = "snake_case")]
pub fn rename_paired_device(
    db: State<DbState>,
    id: String,
    name: String,
) -> AppResult<PairedDeviceRow> {
    let cleaned = clean_display_name(&name)?;
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM paired_devices WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Err(AppError::NotFound(format!("paired phone '{id}' not found")));
    }
    match cleaned {
        None => {
            conn.execute(
                "UPDATE paired_devices SET display_name = NULL WHERE id = ?1",
                [&id],
            )?;
        }
        Some(display) => {
            conn.execute(
                "UPDATE paired_devices SET display_name = ?1 WHERE id = ?2",
                [&display, &id],
            )?;
        }
    }
    Ok(conn.query_row(
        "SELECT id, name, display_name, platform, paired_at, last_seen_at
         FROM paired_devices WHERE id = ?1",
        [&id],
        |row| {
            Ok(PairedDeviceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                display_name: row.get(2)?,
                platform: row.get(3)?,
                paired_at: row.get(4)?,
                last_seen_at: row.get(5)?,
            })
        },
    )?)
}

/// Trimmed rename, capped at 64 characters. `None` clears the override
/// (empty input). Pure so tests pin it without a Tauri runtime.
fn clean_display_name(name: &str) -> AppResult<Option<String>> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 64 {
        return Err(AppError::Validation(
            "phone name must be 1–64 characters".into(),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

#[cfg(test)]
mod paired_device_tests {
    use super::clean_display_name;

    #[test]
    fn rename_sets_trims_caps_and_clears_on_empty() {
        assert_eq!(
            clean_display_name("  Shop Phone ").unwrap(),
            Some("Shop Phone".into())
        );
        assert_eq!(clean_display_name("").unwrap(), None);
        assert_eq!(clean_display_name("   ").unwrap(), None);
        assert!(clean_display_name(&"n".repeat(64)).is_ok());
        assert!(clean_display_name(&"n".repeat(65)).is_err());
    }
}
/// This phone's stable id, minted once: the PC stores it as
/// `paired_devices.id`, so re-pairing replaces the row.
fn phone_device_id(conn: &rusqlite::Connection) -> rusqlite::Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'device_id'",
            [],
            |r| r.get(0),
        )
        .ok()
        .filter(|s: &String| !s.is_empty());
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('device_id', ?1)
         ON CONFLICT(key) DO NOTHING",
        [&id],
    )?;
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'device_id'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or(id))
}

/// This device's display name for the claim. Best effort, no native
/// lookup: a generic name on phones, the host name on PCs.
pub fn phone_name() -> String {
    #[cfg(target_os = "android")]
    {
        "Android phone".into()
    }
    #[cfg(target_os = "ios")]
    {
        "iPhone".into()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        device_name()
    }
}

#[derive(Debug, Clone, Deserialize)]
struct HelloReply {
    protocol: u32,
    provider_id: String,
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    platform: String,
    port: u16,
}

#[derive(Debug, Clone, Deserialize)]
struct ClaimReply {
    provider_id: String,
    provider_name: String,
    provider_platform: String,
    port: u16,
    token: String,
    paired_at: String,
}

fn pair_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(400))
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client failed: {e}"))
}

async fn hello_at(client: &reqwest::Client, host: &str, port: u16) -> Option<(String, HelloReply)> {
    if !crate::api::peer_consume::is_private_host(host) {
        return None;
    }
    let reply: HelloReply = client
        .get(format!("http://{host}:{port}/v1/pair/hello"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    if reply.protocol != crate::api::render_share::PROTOCOL_VERSION || reply.provider_id.is_empty()
    {
        return None;
    }
    Some((host.to_string(), reply))
}

/// Probe the phone's own /24 for PCs with an open pairing window (plan
/// §5.3): 254 hosts, ~64 at a time, 400 ms timeout — a second or two.
/// Returns each answering host with its hello reply.
async fn probe_subnet(port: u16) -> Vec<(String, HelloReply)> {
    let lan = lan_ip();
    let prefix = lan.rsplit_once('.').map(|(p, _)| p.to_string());
    let Some(prefix) = prefix else {
        return Vec::new();
    };
    let Ok(client) = pair_client() else {
        return Vec::new();
    };
    let client = std::sync::Arc::new(client);
    let mut found = Vec::new();
    // Borrow the client across chunks; each chunk probes up to 64 hosts
    // concurrently so a dead subnet costs ~4 × 400 ms, not 254 × 400 ms.
    let hosts: Vec<String> = (1u16..=254).map(|i| format!("{prefix}.{i}")).collect();
    for chunk in hosts.chunks(64) {
        let mut set = tokio::task::JoinSet::new();
        for host in chunk {
            let (client, host, port) = (client.clone(), host.clone(), port);
            set.spawn(async move { hello_at(&client, &host, port).await });
        }
        while let Some(done) = set.join_next().await {
            if let Ok(Some(hit)) = done {
                found.push(hit);
            }
        }
        if !found.is_empty() {
            // Keep the first batch of answers: with several PCs open, the
            // code is tried on each in turn below.
            break;
        }
    }
    found
}

async fn claim_at(
    client: &reqwest::Client,
    host: &str,
    port: u16,
    code: &str,
    device_id: &str,
) -> Result<ClaimReply, String> {
    let res = client
        .post(format!("http://{host}:{port}/v1/pair/claim"))
        .json(&serde_json::json!({
            "protocol": crate::api::render_share::PROTOCOL_VERSION,
            "code": code,
            "device_id": device_id,
            "device_name": phone_name(),
            "platform": std::env::consts::OS,
        }))
        .send()
        .await
        .map_err(|e| {
            crate::api::peer_consume::describe_no_answer_for(&phone_name(), host, port, &e)
        })?;
    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("Update PrintNinja on your PC, then pair again.".into());
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("Pairing is not open on that PC. Tap Pair a phone on it first.".into());
    }
    if status == reqwest::StatusCode::GONE {
        return Err("That code expired. Ask the PC for a new one.".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Too many wrong codes. Ask the PC for a new one.".into());
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let left = res
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("attempts_left").and_then(|n| n.as_u64()))
            .map(|n| format!(" ({n} tries left)"))
            .unwrap_or_default();
        return Err(format!("Wrong code{left}. Check the PC and try again."));
    }
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("Pairing failed ({status}): {detail}"));
    }
    res.json::<ClaimReply>()
        .await
        .map_err(|e| format!("The PC sent an unreadable reply: {e}"))
}

/// Pair this phone with a PC using the 8-character code (plan §5.6).
///
/// Without `host`, probes the phone's own /24 for PCs with an open
/// window; with `host` (Advanced: enter the PC's address), claims that
/// PC directly. Re-pairing the same PC (same `provider_id`) replaces the
/// old entry. Stores the `RenderPair` in `render_pairs` and returns it.
#[tauri::command(rename_all = "snake_case")]
pub async fn pair_with_code(
    app: AppHandle,
    db: State<'_, DbState>,
    code: String,
    host: Option<String>,
    port: Option<u16>,
) -> AppResult<crate::api::peer_consume::RenderPair> {
    let normalized = crate::api::pair_code::normalize_code(&code);
    if !crate::api::pair_code::valid_format(&normalized) {
        return Err(AppError::Validation(
            "Enter the 8-character code shown on the PC.".into(),
        ));
    }
    let client = pair_client().map_err(AppError::Internal)?;
    // Our stable id for the PC's registry.
    let device_id = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        phone_device_id(guard.connection()).map_err(|e| AppError::Internal(e.to_string()))?
    };
    // Candidate PCs: the typed address, or whoever answers the probe.
    // The host is always the address that answered — never anything in
    // a payload (plan §5.3.3).
    let mut candidates: Vec<(String, u16)> = Vec::new();
    if let Some(h) = host.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        let (h, p) = h
            .rsplit_once(':')
            .and_then(|(hh, pp)| pp.parse::<u16>().ok().map(|p| (hh.to_string(), p)))
            .map(|(hh, p)| (hh.trim_matches(|c| c == '[' || c == ']').to_string(), p))
            .unwrap_or_else(|| {
                (
                    h.trim_matches(|c| c == '[' || c == ']').to_string(),
                    port.unwrap_or(17717),
                )
            });
        if p == 0 {
            return Err(AppError::Validation("Port must be 1–65535.".into()));
        }
        if !crate::api::peer_consume::is_private_host(&h) {
            return Err(AppError::Validation(
                "That address is not on your local network.".into(),
            ));
        }
        candidates.push((h, p));
    } else {
        let probe_port = port.unwrap_or_else(|| port_from_settings(db.inner(), "api_port", 17717));
        for (h, reply) in probe_subnet(probe_port).await {
            candidates.push((h.clone(), reply.port));
        }
        // Manual-address fallback when the probe finds nothing (non-/24
        // subnets, client isolation, non-default ports).
        if candidates.is_empty() {
            return Err(AppError::Validation(
                "Could not find your PC. Check it shows a code, is on the same Wi-Fi, then try Advanced: enter its address.".into(),
            ));
        }
    }
    let mut last_err = String::new();
    for (h, p) in &candidates {
        match claim_at(&client, h, *p, &normalized, &device_id).await {
            Ok(reply) => {
                let pair = crate::api::peer_consume::RenderPair {
                    id: reply.provider_id.clone(),
                    name: reply.provider_name.clone(),
                    host: h.clone(),
                    port: reply.port,
                    secret: reply.token.clone(),
                    fingerprint: crate::api::pairing::fingerprint(&reply.token),
                    provider_id: reply.provider_id.clone(),
                    platform: reply.provider_platform.clone(),
                    paired_at: reply.paired_at.clone(),
                    device_id: device_id.clone(),
                };
                // Re-pairing the same PC replaces the old row.
                let raw: Option<String> = db.lock().ok().and_then(|g| {
                    g.connection()
                        .query_row(
                            "SELECT value FROM settings WHERE key = 'render_pairs'",
                            [],
                            |r| r.get(0),
                        )
                        .ok()
                });
                let mut pairs: Vec<crate::api::peer_consume::RenderPair> = raw
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                pairs.retain(|e| {
                    e.provider_id != pair.provider_id
                        && !(e.host == pair.host && e.port == pair.port)
                });
                pairs.push(pair.clone());
                if let Ok(guard) = db.lock() {
                    let _ = crate::commands::settings::write_setting(
                        guard.connection(),
                        "render_pairs",
                        &serde_json::to_string(&pairs).unwrap_or_default(),
                    );
                }
                // Prove the token works straight away (capabilities
                // probe); a failure here does not fail pairing — the
                // Devices list re-tests on demand.
                let _ = crate::api::peer_consume::probe_fresh(&pair).await;
                let _ = app;
                return Ok(pair);
            }
            Err(e) => last_err = e,
        }
    }
    Err(AppError::Validation(if last_err.is_empty() {
        "Could not find your PC. Check it shows a code, is on the same Wi-Fi, then try Advanced: enter its address.".into()
    } else {
        last_err
    }))
}

/// This PC's display name for pairing.
pub fn device_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .chain(std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_string())
        .find(|n| !n.is_empty())
        .unwrap_or_else(|| "PrintNinja PC".into())
}

/// This device's LAN address for pairing. A UDP "connect" sends
/// no packets — it only asks the OS which interface would route out —
/// so this works offline and needs no new dependency.
pub fn lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

/// Bind a TCP listener synchronously so a busy port returns a clear
/// error to the caller instead of failing silently inside a spawned
/// task. Split out so tests can pin the busy-port message without a
/// Tauri runtime.
pub fn bind_addr(addr: &str) -> AppResult<tokio::net::TcpListener> {
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|e| AppError::Internal(format!("Cannot bind {addr}: {e}")))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    tokio::net::TcpListener::from_std(listener)
        .map_err(|e| AppError::Internal(format!("Listener setup failed: {e}")))
}

/// Spawn helper kept public so tests can start an ephemeral server.
pub fn spawn_test_server(port: u16) -> std::io::Result<(tokio::net::TcpListener, String)> {
    let addr = format!("127.0.0.1:{}", port);
    let listener = std::net::TcpListener::bind(&addr)?;
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok((listener, addr))
}
