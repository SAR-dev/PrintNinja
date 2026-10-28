//! Consumer tests for shared rendering: device A buying renders from
//! device B (see docs/PEER_RENDERING.md).
//!
//! A mock peer stands in for B — a tiny axum server speaking the same
//! `/v1/capabilities` + `/v1/render` contract — so no browser is needed:
//! the consumer only moves bytes. The provider side proves real renders
//! in `api_routes.rs` behind `PRINTNINJA_TEST_REAL_CHROMIUM`.

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use printninja_lib::api::peer_consume::{
    load_consumer_config, try_peer_render, PeerRenderJob, RenderPair,
};
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<printninja_lib::db::Database>>;

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_peer_{}.db", uuid::Uuid::new_v4()));
    Arc::new(Mutex::new(
        printninja_lib::db::Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ))
}

fn write_setting(db: &Db, key: &str, value: &str) {
    let guard = db.lock().unwrap();
    printninja_lib::commands::settings::write_setting(guard.connection(), key, value)
        .expect("write setting");
}

/// A port nothing listens on, for the "closed port" tests.
///
/// Not `bind(0)` and drop: that returns the port to the OS's ephemeral
/// pool, and another test's own `bind(0)` (they run in parallel) can be
/// handed the very same port while this test is still connecting to it.
/// Windows reuses freed ports quickly, and a Windows client keeps retrying
/// the SYN for about two seconds, so the stray connection then reached the
/// other test's server (its hit counter read 2) and this test's later
/// rebind failed with AddrInUse. These ports sit below every OS's
/// ephemeral range (Windows and macOS start at 49152, Linux at 32768), so
/// no `bind(0)` can return one, and the counter keeps two closed-port
/// tests from picking the same one.
fn closed_port() -> u16 {
    use std::sync::atomic::{AtomicU16, Ordering};
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let base = 20_000 + (std::process::id() % 100) as u16 * 100;
    loop {
        let port = base + NEXT.fetch_add(1, Ordering::Relaxed) % 100;
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

#[derive(Clone)]
struct MockPeer {
    secret: String,
    score: u64,
    platform: String,
    render_status: u16,
    body: Vec<u8>,
}

async fn serve_mock(peer: MockPeer) -> u16 {
    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route("/v1/render", axum::routing::post(mock_render))
        .with_state(peer);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("mock peer");
    });
    port
}

fn mock_authed(req: &axum::extract::Request, secret: &str) -> bool {
    req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        == Some(format!("Bearer {secret}").as_str())
}

async fn mock_caps(State(peer): State<MockPeer>, req: axum::extract::Request) -> impl IntoResponse {
    if !mock_authed(&req, &peer.secret) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "bad secret"})),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "protocol": 1,
            "can_render": peer.render_status == 200,
            "score": peer.score,
            "cores": 8,
            "platform": peer.platform,
            "max_concurrent_renders": 2,
        })),
    )
        .into_response()
}

async fn mock_render(
    State(peer): State<MockPeer>,
    req: axum::extract::Request,
) -> impl IntoResponse {
    if !mock_authed(&req, &peer.secret) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "bad secret"})),
        )
            .into_response();
    }
    if peer.render_status != 200 {
        return (
            StatusCode::from_u16(peer.render_status).unwrap(),
            Json(serde_json::json!({"error": "mock refuses"})),
        )
            .into_response();
    }
    use base64::Engine as _;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "bytes_b64": base64::engine::general_purpose::STANDARD.encode(&peer.body),
            "mime": "application/pdf",
            "render_ms": 7,
        })),
    )
        .into_response()
}

fn pair(name: &str, port: u16, secret: &str) -> RenderPair {
    RenderPair {
        id: name.into(),
        name: name.into(),
        host: "127.0.0.1".into(),
        port,
        secret: secret.into(),
        fingerprint: String::new(),
        provider_id: String::new(),
        platform: String::new(),
        paired_at: String::new(),
        device_id: String::new(),
    }
}

fn job() -> PeerRenderJob {
    PeerRenderJob {
        html: "<html><body>peer</body></html>".into(),
        paper_w_mm: 100.0,
        paper_h_mm: 150.0,
        orientation: "portrait".into(),
        language: "pdf".into(),
        dpi: 203,
    }
}

/// The consumer picks the reachable provider and returns its bytes —
/// here the same-platform peer wins over a higher score elsewhere.
#[tokio::test]
async fn try_peer_render_buys_bytes_from_the_best_peer() {
    let here = std::env::consts::OS.to_string();
    let fast_elsewhere = serve_mock(MockPeer {
        secret: "s".into(),
        score: 900,
        platform: "other-os".into(),
        render_status: 200,
        body: b"%PDF-elsewhere".to_vec(),
    })
    .await;
    let slow_here = serve_mock(MockPeer {
        secret: "s".into(),
        score: 100,
        platform: here,
        render_status: 200,
        body: b"%PDF-here".to_vec(),
    })
    .await;
    let out = try_peer_render(
        &[
            pair("far", fast_elsewhere, "s"),
            pair("near", slow_here, "s"),
        ],
        &job(),
    )
    .await
    .expect("a peer should serve");
    assert_eq!(out.bytes, b"%PDF-here");
    assert_eq!(out.mime, "application/pdf");
    assert_eq!(out.peer_name, "near");
}

/// A refusing peer (422) and a wrong secret (401) both read as "not
/// this peer": the outcome is `None`, the local render's cue.
#[tokio::test]
async fn try_peer_render_returns_none_when_peers_refuse() {
    let refusing = serve_mock(MockPeer {
        secret: "s".into(),
        score: 900,
        platform: std::env::consts::OS.into(),
        render_status: 422,
        body: vec![],
    })
    .await;
    let out = try_peer_render(&[pair("grumpy", refusing, "s")], &job()).await;
    assert!(out.is_none());

    let guarded = serve_mock(MockPeer {
        secret: "right".into(),
        score: 900,
        platform: std::env::consts::OS.into(),
        render_status: 200,
        body: b"%PDF".to_vec(),
    })
    .await;
    let out = try_peer_render(&[pair("locked", guarded, "wrong")], &job()).await;
    assert!(out.is_none());
}

/// A dead port fails fast (connection refused, well inside the probe
/// timeout): three offline providers must not stall a print.
#[tokio::test]
async fn try_peer_render_skips_unreachable_hosts() {
    let started = std::time::Instant::now();
    let out = try_peer_render(
        &[
            pair("gone-1", 1, "s"),
            pair("gone-2", 2, "s"),
            pair("gone-3", 3, "s"),
        ],
        &job(),
    )
    .await;
    assert!(out.is_none());
    assert!(
        started.elapsed()
            < std::time::Duration::from_secs(
                printninja_lib::api::peer_consume::PEER_CAPS_TIMEOUT_SECS
            ),
        "unreachable peers must fail fast, concurrently"
    );
}

/// Policy off, nothing paired, or broken JSON all mean local rendering.
#[test]
fn consumer_config_gates_on_policy_and_pairs() {
    let db = test_db();
    // Default: no policy row → local.
    let guard = db.lock().unwrap();
    assert!(load_consumer_config(guard.connection()).is_none());
    drop(guard);

    write_setting(&db, "render_policy", "auto");
    // Policy on but nothing paired → still local.
    let guard = db.lock().unwrap();
    assert!(load_consumer_config(guard.connection()).is_none());
    drop(guard);

    // Broken JSON → local, never a crash.
    write_setting(&db, "render_pairs", "not json");
    let guard = db.lock().unwrap();
    assert!(load_consumer_config(guard.connection()).is_none());
    drop(guard);

    write_setting(
        &db,
        "render_pairs",
        r#"[{"id":"a","name":"B","host":"192.168.1.9","port":17717,"secret":"s","fingerprint":"f"}]"#,
    );
    let guard = db.lock().unwrap();
    let pairs = load_consumer_config(guard.connection()).expect("paired");
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].name, "B");
    drop(guard);

    // Opting back out disables even a healthy pairing.
    write_setting(&db, "render_policy", "local");
    let guard = db.lock().unwrap();
    assert!(load_consumer_config(guard.connection()).is_none());
}

/// Repeated prints skip the handshake while the provider is
/// known-good: two renders cost one capabilities probe. Rotating the
/// secret re-probes instead of trusting the stale acceptance.
#[tokio::test]
async fn try_peer_render_caches_successful_probes() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = std::sync::Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let app = Router::new()
        .route(
            "/v1/capabilities",
            get(move |req: axum::extract::Request| {
                let hits2 = hits2.clone();
                async move {
                    hits2.fetch_add(1, Ordering::SeqCst);
                    if !req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|v| {
                            v == "Bearer s" || v == "Bearer rotated"
                        })
                    {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error": "bad secret"})),
                        )
                            .into_response();
                    }
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "protocol": 1,
                            "can_render": true,
                            "score": 500,
                            "cores": 4,
                            "platform": std::env::consts::OS,
                            "max_concurrent_renders": 2,
                        })),
                    )
                        .into_response()
                }
            }),
        )
        .route(
            "/v1/render",
            axum::routing::post(|| async {
                use base64::Engine as _;
                (
                    StatusCode::OK,
                    Json(serde_json::json!({
                        "bytes_b64": base64::engine::general_purpose::STANDARD.encode(b"%PDF-cached"),
                        "mime": "application/pdf",
                        "render_ms": 3,
                    })),
                )
                    .into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("counting peer");
    });

    let out = try_peer_render(&[pair("cached", port, "s")], &job())
        .await
        .expect("peer serves");
    assert_eq!(out.bytes, b"%PDF-cached");
    let out = try_peer_render(&[pair("cached", port, "s")], &job())
        .await
        .expect("peer serves again");
    assert_eq!(out.bytes, b"%PDF-cached");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "second render must reuse the cached probe"
    );

    // A rotated secret is a different peer identity: re-probe.
    let out = try_peer_render(&[pair("cached", port, "rotated")], &job()).await;
    assert!(out.is_some());
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

/// A PC that is off must cost a print almost nothing, and only once per
/// half minute: the failed probe is remembered, so the next print skips
/// the provider without touching the network. The Settings "Test"
/// button (`probe_fresh`) ignores that memory and sees the PC the
/// moment it comes back.
#[tokio::test]
async fn failed_probes_are_remembered_and_fresh_probe_bypasses_them() {
    use printninja_lib::api::peer_consume::{forget_cached, probe_fresh};

    // Reserve a port, then free it so the first attempt is refused.
    let port = closed_port();
    let p = pair("sleeping-pc", port, "s");
    assert!(try_peer_render(std::slice::from_ref(&p), &job())
        .await
        .is_none());

    // The PC wakes up on the same port.
    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route("/v1/render", axum::routing::post(mock_render))
        .with_state(MockPeer {
            secret: "s".into(),
            score: 500,
            platform: std::env::consts::OS.into(),
            render_status: 200,
            body: b"%PDF-awake".to_vec(),
        });
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("rebind freed port");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("awake peer");
    });

    // Within the memory window the phone still skips it: no probe, no wait.
    let started = std::time::Instant::now();
    assert!(try_peer_render(std::slice::from_ref(&p), &job())
        .await
        .is_none());
    assert!(
        started.elapsed() < std::time::Duration::from_millis(200),
        "a remembered failure must not touch the network"
    );

    // The Test button looks right now and finds it...
    let (_, caps) = probe_fresh(&p).await.expect("fresh probe sees the PC");
    assert!(caps.can_render);
    // ...which also clears the memory, so printing uses it again.
    let out = try_peer_render(std::slice::from_ref(&p), &job())
        .await
        .expect("PC serves once it is back");
    assert_eq!(out.bytes, b"%PDF-awake");

    forget_cached(&p);
}

/// A provider that dies mid-render (transport failure) is skipped by the
/// next prints instead of making each one wait out the deadline.
#[tokio::test]
async fn a_failed_render_marks_the_provider_down_for_a_while() {
    use printninja_lib::api::peer_consume::render_on;

    let port = closed_port();
    let p = pair("crashed-pc", port, "s");
    // Direct render against a closed port: transport failure → None.
    assert!(render_on(&p, &job()).await.is_none());

    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route("/v1/render", axum::routing::post(mock_render))
        .with_state(MockPeer {
            secret: "s".into(),
            score: 500,
            platform: std::env::consts::OS.into(),
            render_status: 200,
            body: b"%PDF-back".to_vec(),
        });
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("rebind freed port");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("recovered peer");
    });

    assert!(
        try_peer_render(std::slice::from_ref(&p), &job())
            .await
            .is_none(),
        "the provider that just failed is skipped, not retried"
    );
}

/// Required mode serves a thermal job from the peer instead of failing
/// locally: the bytes come back with the peer's name attached.
#[tokio::test]
async fn required_mode_buys_thermal_bytes_from_the_peer() {
    use printninja_lib::api::peer_consume::try_peer_render_required;

    let port = serve_mock(MockPeer {
        secret: "s".into(),
        score: 500,
        platform: std::env::consts::OS.into(),
        render_status: 200,
        body: b"ESC/POS-bytes".to_vec(),
    })
    .await;
    let mut thermal = job();
    thermal.language = "escpos".into();
    let out = try_peer_render_required(&[pair("pc", port, "s")], &thermal)
        .await
        .expect("peer should serve the thermal job");
    assert_eq!(out.bytes, b"ESC/POS-bytes");
    assert_eq!(out.peer_name, "pc");
}

/// Required mode names the missing PC instead of failing silently: no
/// pairs, and no reachable pair, are both loud errors.
#[tokio::test]
async fn required_mode_fails_loudly_without_a_usable_peer() {
    use printninja_lib::api::peer_consume::try_peer_render_required;

    let err = try_peer_render_required(&[], &job()).await.unwrap_err();
    assert!(err.contains("no paired PC"), "{err}");

    let port = closed_port();
    let err = try_peer_render_required(&[pair("off", port, "s")], &job())
        .await
        .unwrap_err();
    assert!(err.contains("no paired PC answered"), "{err}");
    assert!(err.contains("off"), "{err}");
}

/// A port nobody listens on is "refused": the PC answered, so it is awake.
/// The message must say PrintNinja is not sharing there, not "firewall".
#[tokio::test]
async fn the_test_button_says_refused_when_the_pc_is_up_but_not_sharing() {
    use printninja_lib::api::peer_consume::probe_fresh;

    let port = closed_port();
    let err = probe_fresh(&pair("Studio PC", port, "s"))
        .await
        .unwrap_err();
    assert!(err.starts_with("Studio PC refused the connection"), "{err}");
    assert!(err.contains("not sharing"), "{err}");
    assert!(!err.contains("firewall"), "{err}");
}

/// A PC that accepts the connection but never answers (a sleeping or
/// frozen host, or a firewall that swallows the request) must read as
/// "blocked or unreachable", never as a bare "probe timeout".
#[tokio::test]
async fn the_test_button_says_blocked_or_unreachable_when_nothing_answers() {
    use printninja_lib::api::peer_consume::probe_fresh;

    // Listening but never accepting: the kernel completes the TCP
    // handshake, the HTTP request then hangs until the probe timeout.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let started = std::time::Instant::now();
    let err = probe_fresh(&pair("Studio PC", port, "s"))
        .await
        .unwrap_err();
    assert!(
        err.starts_with("Studio PC is blocked or unreachable"),
        "{err}"
    );
    assert!(err.contains(&port.to_string()), "{err}");
    assert!(err.contains("firewall"), "{err}");
    assert!(
        !err.contains("probe timeout"),
        "the raw timeout wording must not reach the person: {err}"
    );
    assert!(
        started.elapsed()
            < std::time::Duration::from_secs(
                printninja_lib::api::peer_consume::PEER_CAPS_TIMEOUT_SECS + 2
            ),
        "a silent PC still fails within the probe timeout"
    );
    drop(listener);
}

/// A busy provider is retried with backoff instead of abandoned: two
/// 429s (no waiting, the mock names no delay) then a 200 serves.
#[tokio::test]
async fn required_mode_retries_a_busy_peer() {
    use printninja_lib::api::peer_consume::try_peer_render_required;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route(
            "/v1/render",
            axum::routing::post(move |req: axum::extract::Request| {
                let hits2 = hits2.clone();
                async move {
                    if !mock_authed(&req, "s") {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error": "bad secret"})),
                        )
                            .into_response();
                    }
                    let n = hits2.fetch_add(1, Ordering::SeqCst);
                    if n < 2 {
                        return (
                            StatusCode::TOO_MANY_REQUESTS,
                            [(axum::http::header::RETRY_AFTER, "0")],
                            Json(serde_json::json!({"error": "busy"})),
                        )
                            .into_response();
                    }
                    use base64::Engine as _;
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "bytes_b64": base64::engine::general_purpose::STANDARD.encode(b"ESC-after-busy"),
                            "mime": "application/octet-stream",
                            "render_ms": 4,
                        })),
                    )
                        .into_response()
                }
            }),
        )
        .with_state(MockPeer {
            secret: "s".into(),
            score: 500,
            platform: std::env::consts::OS.into(),
            render_status: 200,
            body: vec![],
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("busy peer");
    });

    let mut thermal = job();
    thermal.language = "zpl".into();
    let out = try_peer_render_required(&[pair("busy-pc", port, "s")], &thermal)
        .await
        .expect("busy peer serves after retries");
    assert_eq!(out.bytes, b"ESC-after-busy");
    assert_eq!(hits.load(Ordering::SeqCst), 3, "two 429s then the 200");
}

/// A provider that stays busy is given up on loudly after the retries,
/// naming the wait instead of hanging the print.
#[tokio::test]
async fn required_mode_gives_up_on_a_permanently_busy_peer() {
    use printninja_lib::api::peer_consume::{try_peer_render_required, PEER_BUSY_RETRIES};
    use std::sync::atomic::{AtomicUsize, Ordering};

    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route(
            "/v1/render",
            axum::routing::post(move |req: axum::extract::Request| {
                let hits2 = hits2.clone();
                async move {
                    if !mock_authed(&req, "s") {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error": "bad secret"})),
                        )
                            .into_response();
                    }
                    hits2.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(axum::http::header::RETRY_AFTER, "0")],
                        Json(serde_json::json!({"error": "busy"})),
                    )
                        .into_response()
                }
            }),
        )
        .with_state(MockPeer {
            secret: "s".into(),
            score: 500,
            platform: std::env::consts::OS.into(),
            render_status: 200,
            body: vec![],
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("always-busy peer");
    });

    let err = try_peer_render_required(&[pair("jammed", port, "s")], &job())
        .await
        .unwrap_err();
    assert!(err.contains("busy"), "{err}");
    assert_eq!(
        hits.load(Ordering::SeqCst) as u32,
        PEER_BUSY_RETRIES + 1,
        "one try plus every retry"
    );
}

/// Best-effort mode keeps its old contract: a busy provider is NOT
/// waited out — the print falls back locally at once.
#[tokio::test]
async fn best_effort_does_not_wait_out_a_busy_peer() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let hits = Arc::new(AtomicUsize::new(0));
    let hits2 = hits.clone();
    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route(
            "/v1/render",
            axum::routing::post(move |req: axum::extract::Request| {
                let hits2 = hits2.clone();
                async move {
                    if !mock_authed(&req, "s") {
                        return (
                            StatusCode::UNAUTHORIZED,
                            Json(serde_json::json!({"error": "bad secret"})),
                        )
                            .into_response();
                    }
                    hits2.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(axum::http::header::RETRY_AFTER, "0")],
                        Json(serde_json::json!({"error": "busy"})),
                    )
                        .into_response()
                }
            }),
        )
        .with_state(MockPeer {
            secret: "s".into(),
            score: 500,
            platform: std::env::consts::OS.into(),
            render_status: 200,
            body: vec![],
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("busy peer");
    });

    let started = std::time::Instant::now();
    assert!(try_peer_render(&[pair("busy", port, "s")], &job())
        .await
        .is_none());
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "no retries in fallback mode"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "fallback must not wait out the busy provider"
    );
}

/// Required mode does not consult the failure memory: a PC that was
/// down when the last print ran is asked again right away instead of
/// failing the job on a stale skip.
#[tokio::test]
async fn required_mode_asks_despite_a_remembered_failure() {
    use printninja_lib::api::peer_consume::{forget_cached, try_peer_render_required};

    let port = closed_port();
    let p = pair("flaky-pc", port, "s");
    // Best-effort attempt against the dead port: fails and remembers.
    assert!(try_peer_render(std::slice::from_ref(&p), &job())
        .await
        .is_none());

    // The PC wakes up on the same port.
    let app = Router::new()
        .route("/v1/capabilities", get(mock_caps))
        .route("/v1/render", axum::routing::post(mock_render))
        .with_state(MockPeer {
            secret: "s".into(),
            score: 500,
            platform: std::env::consts::OS.into(),
            render_status: 200,
            body: b"%PDF-back".to_vec(),
        });
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("rebind freed port");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("awake peer");
    });

    // Required mode asks anyway (fail memory bypassed) and serves.
    let out = try_peer_render_required(std::slice::from_ref(&p), &job())
        .await
        .expect("required mode re-asks the PC");
    assert_eq!(out.bytes, b"%PDF-back");

    forget_cached(&p);
}
