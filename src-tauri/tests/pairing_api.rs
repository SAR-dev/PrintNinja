//! Pairing-code flow (docs/ARCHITECTURE.md §9 Pairing): hello + claim,
//! the window state machine, the per-device token gate, and the device
//! registry. Driven through the real router with `oneshot`, so
//! routing/middleware bugs surface here. Time is injected by opening
//! windows with an explicit `opened` — no sleeping.

use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use printninja_lib::api::pair_code::PairingWindow;
use printninja_lib::db::Database;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tower::ServiceExt;

type Db = Arc<Mutex<Database>>;
type Window = Arc<Mutex<Option<PairingWindow>>>;

/// In-process requests carry no socket address; insert one like the live
/// server's `into_make_service_with_connect_info` does.
fn with_loopback(mut req: Request<axum::body::Body>) -> Request<axum::body::Body> {
    req.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        50000,
    )));
    req
}

fn with_remote(mut req: Request<axum::body::Body>, ip: Ipv4Addr) -> Request<axum::body::Body> {
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(IpAddr::V4(ip), 50000)));
    req
}

fn setup() -> (Db, Window) {
    let path = std::env::temp_dir().join(format!("printninja_pair_{}.db", uuid::Uuid::new_v4()));
    let db: Db = Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ));
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO settings (key, value) VALUES ('render_share_enabled', 'true')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .unwrap();
        // This PC is signed in (§3.6): claims without a matching phone
        // account are refused. Tests that need a signed-out PC delete
        // these rows after setup.
        guard
            .connection()
            .execute(
                "INSERT INTO settings (key, value) VALUES
                     ('share_user_id', 'user-1'),
                     ('share_service_url', 'https://share.test')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .unwrap();
    }
    (db.clone(), Arc::new(Mutex::new(None)))
}

fn router(db: &Db, window: &Window) -> axum::Router {
    let cache =
        std::env::temp_dir().join(format!("printninja_pair_cache_{}", uuid::Uuid::new_v4()));
    printninja_lib::api::routes::router_with_state(
        printninja_lib::api::routes::ApiState {
            db: db.clone(),
            queue: Arc::new(printninja_lib::queue::PrintQueue::new()),
            cache_dir: cache,
            window: window.clone(),
        },
        false,
    )
}

fn open_window(window: &Window, code: &str, opened: Instant) {
    *window.lock().unwrap() = Some(PairingWindow::new(code.into(), opened));
}

fn claim_body(code: &str, device_id: &str) -> serde_json::Value {
    serde_json::json!({
        "protocol": 1,
        "code": code,
        "device_id": device_id,
        "device_name": "Test Phone",
        "platform": "android",
        "account_id": "user-1",
        "service_url": "https://share.test",
    })
}

async fn post_claim(app: axum::Router, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
    let res = app
        .oneshot(with_loopback(
            Request::builder()
                .method("POST")
                .uri("/v1/pair/claim")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        ))
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

async fn get_hello(app: axum::Router) -> (StatusCode, serde_json::Value) {
    let res = app
        .oneshot(with_loopback(
            Request::builder()
                .uri("/v1/pair/hello")
                .body(axum::body::Body::empty())
                .unwrap(),
        ))
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

async fn get_caps(app: axum::Router, token: Option<&str>) -> StatusCode {
    let mut builder = Request::builder().uri("/v1/capabilities");
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    let res = app
        .oneshot(with_loopback(
            builder.body(axum::body::Body::empty()).unwrap(),
        ))
        .await
        .unwrap();
    res.status()
}

fn paired_count(db: &Db) -> i64 {
    db.lock()
        .unwrap()
        .connection()
        .query_row("SELECT COUNT(*) FROM paired_devices", [], |r| r.get(0))
        .unwrap()
}

// ── happy path ──────────────────────────────────────────────────────

#[tokio::test]
async fn claim_succeeds_token_works_and_device_is_listed() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());

    // Hello answers while the window is open.
    let (status, hello) = get_hello(router(&db, &window)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hello["protocol"], 1);
    assert!(hello["provider_id"].is_string());
    assert!(hello["port"].is_number());

    // Claim with lowercase + dash: normalization accepts it.
    let (status, reply) =
        post_claim(router(&db, &window), claim_body("k7qm-4xpd", "phone-1")).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let token = reply["token"].as_str().expect("token").to_string();
    assert_eq!(token.len(), 32);
    assert_eq!(reply["provider_id"], hello["provider_id"]);

    // The token works on the gated endpoints…
    assert_eq!(
        get_caps(router(&db, &window), Some(&token)).await,
        StatusCode::OK
    );
    // …and the device is in the registry.
    assert_eq!(paired_count(&db), 1);
    let name: String = db
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT name FROM paired_devices WHERE id = 'phone-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "Test Phone");

    // Single use: the window is closed, hello is 403 again.
    let (status, _) = get_hello(router(&db, &window)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-2")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

// ── window state machine ────────────────────────────────────────────

#[tokio::test]
async fn no_window_expired_wrong_locked_and_disabled() {
    // No window: hello and claim are both 403 with the same wording.
    let (db, window) = setup();
    let (status, hello) = get_hello(router(&db, &window)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, claim) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(hello["error"], claim["error"]);

    // Expired window: 410. (Opened further back than the default
    // 90 s TTL; the env override is unset in tests.)
    open_window(
        &window,
        "K7QM4XPD",
        Instant::now() - Duration::from_secs(91),
    );
    let (status, _) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    assert_eq!(status, StatusCode::GONE);

    // Wrong code: 401 with attempts left.
    open_window(&window, "K7QM4XPD", Instant::now());
    let (status, body) = post_claim(router(&db, &window), claim_body("AAAAAAAA", "phone-1")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["attempts_left"], 4);

    // Malformed code: 400, and it does not consume an attempt.
    let (status, _) = post_claim(router(&db, &window), claim_body("short", "phone-1")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    {
        let guard = window.lock().unwrap();
        assert_eq!(guard.as_ref().map(|w| w.wrong()), Some(1));
    }

    // Unsupported protocol: 400.
    let mut bad = claim_body("K7QM4XPD", "phone-1");
    bad["protocol"] = serde_json::json!(999);
    let (status, _) = post_claim(router(&db, &window), bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Four more wrong guesses lock the window: 429, and the right code
    // afterwards is refused.
    for _ in 0..3 {
        let (status, _) = post_claim(router(&db, &window), claim_body("AAAAAAAA", "phone-1")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, _) = post_claim(router(&db, &window), claim_body("AAAAAAAA", "phone-1")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let (status, _) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    // Locked windows close: the next claim sees no window.
    assert!(
        status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::FORBIDDEN,
        "locked window stays closed: {status}"
    );

    // Sharing disabled: 403 even with an open window.
    let (db2, window2) = setup();
    {
        let guard = db2.lock().unwrap();
        guard
            .connection()
            .execute(
                "UPDATE settings SET value = 'false' WHERE key = 'render_share_enabled'",
                [],
            )
            .unwrap();
    }
    open_window(&window2, "K7QM4XPD", Instant::now());
    let (status, _) = post_claim(router(&db2, &window2), claim_body("K7QM4XPD", "phone-1")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = get_hello(router(&db2, &window2)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

// ── registry ────────────────────────────────────────────────────────

#[tokio::test]
async fn removing_a_device_makes_its_token_fail_immediately() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let (_, reply) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    let token = reply["token"].as_str().unwrap().to_string();
    assert_eq!(
        get_caps(router(&db, &window), Some(&token)).await,
        StatusCode::OK
    );
    db.lock()
        .unwrap()
        .connection()
        .execute("DELETE FROM paired_devices WHERE id = 'phone-1'", [])
        .unwrap();
    assert_eq!(
        get_caps(router(&db, &window), Some(&token)).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn reclaiming_same_device_replaces_row_invalidates_old_token_keeps_rename() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let (_, first) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    let first_token = first["token"].as_str().unwrap().to_string();

    // The PC user renames the phone.
    db.lock()
        .unwrap()
        .connection()
        .execute(
            "UPDATE paired_devices SET display_name = 'Shop Phone' WHERE id = 'phone-1'",
            [],
        )
        .unwrap();

    // Re-pair with a new code: same device_id replaces the row.
    open_window(&window, "BBBBBBBB", Instant::now());
    let (status, second) =
        post_claim(router(&db, &window), claim_body("BBBBBBBB", "phone-1")).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    let second_token = second["token"].as_str().unwrap().to_string();
    assert_ne!(first_token, second_token);

    assert_eq!(paired_count(&db), 1, "re-pair replaces, not duplicates");
    assert_eq!(
        get_caps(router(&db, &window), Some(&first_token)).await,
        StatusCode::UNAUTHORIZED,
        "the old token dies with the row"
    );
    assert_eq!(
        get_caps(router(&db, &window), Some(&second_token)).await,
        StatusCode::OK
    );
    let display: Option<String> = db
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT display_name FROM paired_devices WHERE id = 'phone-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(display.as_deref(), Some("Shop Phone"));
}

#[tokio::test]
async fn old_shared_secret_is_refused() {
    let (db, window) = setup();
    {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO settings (key, value) VALUES ('render_secret', 'old-shared')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .unwrap();
    }
    assert_eq!(
        get_caps(router(&db, &window), Some("old-shared")).await,
        StatusCode::UNAUTHORIZED,
        "the QR-era secret buys nothing"
    );
}

#[tokio::test]
async fn non_private_callers_are_rejected() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    // Documentation address (TEST-NET-3): public, so both routes refuse.
    let public = Ipv4Addr::new(203, 0, 113, 7);
    let res = router(&db, &window)
        .oneshot(with_remote(
            Request::builder()
                .uri("/v1/pair/hello")
                .body(axum::body::Body::empty())
                .unwrap(),
            public,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = router(&db, &window)
        .oneshot(with_remote(
            Request::builder()
                .method("POST")
                .uri("/v1/pair/claim")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(
                    claim_body("K7QM4XPD", "phone-1").to_string(),
                ))
                .unwrap(),
            public,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    // The refused claim consumed no attempt.
    assert_eq!(window.lock().unwrap().as_ref().map(|w| w.wrong()), Some(0));
}

// ── live server (ConnectInfo present) ───────────────────────────────

#[tokio::test]
async fn hello_and_claim_work_over_a_live_loopback_server() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let app = router(&db, &window);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    let client = reqwest::Client::new();
    let hello: serde_json::Value = client
        .get(format!("http://127.0.0.1:{port}/v1/pair/hello"))
        .send()
        .await
        .expect("hello reachable")
        .error_for_status()
        .expect("hello 200")
        .json()
        .await
        .expect("hello json");
    assert_eq!(hello["protocol"], 1);
    let reply: serde_json::Value = client
        .post(format!("http://127.0.0.1:{port}/v1/pair/claim"))
        .json(&claim_body("K7QM4XPD", "phone-live"))
        .send()
        .await
        .expect("claim reachable")
        .error_for_status()
        .expect("claim 200")
        .json()
        .await
        .expect("claim json");
    let token = reply["token"].as_str().expect("token").to_string();
    let caps = client
        .get(format!("http://127.0.0.1:{port}/v1/capabilities"))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("caps reachable");
    assert_eq!(caps.status(), reqwest::StatusCode::OK);
}

/// A fresh claim can always print: `can_print` defaults true, and only
/// an explicit toggle changes it (re-pairing keeps the stored choice).
#[tokio::test]
async fn claim_defaults_can_print_to_true() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let (status, _) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-9")).await;
    assert_eq!(status, StatusCode::OK);
    let can_print: i64 = db
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT can_print FROM paired_devices WHERE id = 'phone-9'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(can_print, 1, "fresh pairs print");
}

// ── same-account pairing (Release C §3.6) ──────────────────────────

/// A phone that sends no account is told to sign in first — and the code
/// is not burned: signing in and retrying on the same window succeeds.
#[tokio::test]
async fn claim_without_phone_account_is_400_and_keeps_the_window() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let mut bare = claim_body("K7QM4XPD", "phone-1");
    bare.as_object_mut().unwrap().remove("account_id");
    bare.as_object_mut().unwrap().remove("service_url");
    let (status, body) = post_claim(router(&db, &window), bare).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "phone_sign_in_required");
    assert_eq!(paired_count(&db), 0, "no row on refusal");

    let (status, _) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    assert_eq!(status, StatusCode::OK, "same code works after sign-in");
}

/// A PC that is signed out refuses every claim until it signs in.
#[tokio::test]
async fn claim_refuses_when_pc_signed_out() {
    let (db, window) = setup();
    db.lock()
        .unwrap()
        .connection()
        .execute(
            "DELETE FROM settings WHERE key IN ('share_user_id', 'share_service_url')",
            [],
        )
        .unwrap();
    open_window(&window, "K7QM4XPD", Instant::now());
    let (status, body) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "pc_sign_in_required");
    assert_eq!(paired_count(&db), 0, "no row on refusal");
}

/// A phone on another account (or another server) is refused.
#[tokio::test]
async fn claim_refuses_different_account() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let mut other = claim_body("K7QM4XPD", "phone-1");
    other["account_id"] = serde_json::json!("user-2");
    let (status, body) = post_claim(router(&db, &window), other).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "different_account");

    open_window(&window, "BBBBBBBB", Instant::now());
    let mut elsewhere = claim_body("BBBBBBBB", "phone-1");
    elsewhere["service_url"] = serde_json::json!("https://other.example");
    let (status, body) = post_claim(router(&db, &window), elsewhere).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "different_account");
    assert_eq!(paired_count(&db), 0, "no row on refusal");
}

/// The claim stores the verified account on the row for the gate's
/// later re-checks.
#[tokio::test]
async fn claim_stores_account_on_row() {
    let (db, window) = setup();
    open_window(&window, "K7QM4XPD", Instant::now());
    let (status, _) = post_claim(router(&db, &window), claim_body("K7QM4XPD", "phone-1")).await;
    assert_eq!(status, StatusCode::OK);
    let (account, url): (Option<String>, Option<String>) = db
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT account_id, service_url FROM paired_devices WHERE id = 'phone-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(account.as_deref(), Some("user-1"));
    assert_eq!(url.as_deref(), Some("https://share.test"));
}
