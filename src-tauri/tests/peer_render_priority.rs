//! The provider's own prints come first (see docs/ARCHITECTURE.md §9).
//!
//! While this device renders for itself, `POST /v1/render` answers 429
//! with `Retry-After`, so a phone that asked simply renders locally and a
//! paired phone can never make the PC's own printing slower.
//!
//! This lives in its own test binary on purpose: the "busy" flag is a
//! process-wide static, so a guard held here must not be visible to the
//! parallel provider tests in `api_routes.rs`.

use axum::extract::ConnectInfo;
use axum::http::{header, Method, Request, StatusCode};
use printninja_lib::api::render_share::{local_render_busy, LocalRenderGuard};
use printninja_lib::db::Database;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

type Db = Arc<Mutex<Database>>;

fn setup_sharing(token: &str) -> Db {
    let path = std::env::temp_dir().join(format!("printninja_prio_{}.db", uuid::Uuid::new_v4()));
    let db: Db = Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ));
    {
        use sha2::Digest as _;
        let hash = format!("{:x}", sha2::Sha256::digest(token.as_bytes()));
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO settings (key, value) VALUES ('render_share_enabled', 'true')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )
            .unwrap();
        // Signed-in PC (§3.6): the gate re-checks every token against this.
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
        guard
            .connection()
            .execute(
                "INSERT INTO paired_devices
                     (id, name, display_name, platform, token_hash, paired_at, last_seen_at,
                      account_id, service_url)
                 VALUES ('phone-1', 'Test Phone', NULL, 'android', ?1, datetime('now'), datetime('now'),
                         'user-1', 'https://share.test')
                 ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash,
                                                account_id = excluded.account_id,
                                                service_url = excluded.service_url",
                [&hash],
            )
            .unwrap();
    }
    db
}

fn router(db: &Db) -> axum::Router {
    let inner = printninja_lib::api::routes::router_with_state(
        printninja_lib::api::routes::ApiState::without_window(
            db.clone(),
            Arc::new(printninja_lib::queue::PrintQueue::new()),
            std::env::temp_dir().join(format!("printninja_prio_cache_{}", uuid::Uuid::new_v4())),
        ),
        false,
    );
    // Same as api_routes.rs: in-process requests carry no socket address.
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

fn render_request(secret: &str) -> Request<axum::body::Body> {
    let body = serde_json::json!({
        "protocol": 1,
        "html": "<html><body>peer</body></html>",
        "paper_w_mm": 100.0,
        "paper_h_mm": 150.0,
        "orientation": "portrait",
        "language": "pdf",
        "dpi": 203
    });
    Request::builder()
        .method(Method::POST)
        .uri("/v1/render")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

fn capabilities_request(secret: &str) -> Request<axum::body::Body> {
    Request::builder()
        .uri("/v1/capabilities")
        .header(header::AUTHORIZATION, format!("Bearer {secret}"))
        .body(axum::body::Body::empty())
        .unwrap()
}

/// One sequential test: the flag is global, so interleaving separate
/// tests would make each flaky.
#[tokio::test]
async fn peer_renders_yield_while_this_device_prints_for_itself() {
    let db = setup_sharing("correct-horse");
    assert!(!local_render_busy(), "idle at the start");

    let guard = LocalRenderGuard::enter();
    assert!(local_render_busy());

    // A phone's render is told to try later; it falls back to local.
    let res = router(&db)
        .oneshot(render_request("correct-horse"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        res.headers().get(header::RETRY_AFTER).map(|v| v.as_bytes()),
        Some(&b"5"[..]),
        "the busy answer says when to come back"
    );
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        body["error"].as_str().unwrap_or("").contains("own job"),
        "{body}"
    );

    // The probe is not a render: capabilities still answer, so the
    // Settings "Test" button keeps working while the PC prints.
    let res = router(&db)
        .oneshot(capabilities_request("correct-horse"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // A wrong token is still 401, never a busy answer that leaks state.
    let res = router(&db).oneshot(render_request("wrong")).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Overlapping local renders: busy until the last one finishes.
    let second = LocalRenderGuard::enter();
    drop(guard);
    assert!(local_render_busy(), "one local render is still running");
    drop(second);
    assert!(!local_render_busy(), "idle again once both finish");
}
