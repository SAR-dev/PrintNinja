//! Print via PC, phone side (ARCHITECTURE §9):
//! `remote_print` POSTs a live loopback PC and records the outcome in
//! the phone's own history. The PC has no spooler here, so the print
//! itself fails — the attribution on both rows is the point.

use printninja_lib::commands::remote_print::{remote_print_inner, RemotePrintArgs};
use printninja_lib::db::Database;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

type Db = Arc<Mutex<Database>>;

fn fresh_db(tag: &str) -> Db {
    let path = std::env::temp_dir().join(format!(
        "printninja_remote_{tag}_{}.db",
        uuid::Uuid::new_v4()
    ));
    Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ))
}

fn set(db: &Db, key: &str, value: &str) {
    db.lock()
        .unwrap()
        .connection()
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .unwrap();
}

/// The PC: sharing on, signed in, one paired phone (`tok-1`), one
/// template revision and one (unreachable) printer.
fn pc_db() -> Db {
    use sha2::Digest as _;
    let db = fresh_db("pc");
    set(&db, "render_share_enabled", "true");
    set(&db, "share_user_id", "user-1");
    set(&db, "share_service_url", "https://share.test");
    let hash = format!("{:x}", sha2::Sha256::digest(b"tok-1"));
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO paired_devices
                 (id, name, platform, token_hash, paired_at, last_seen_at, account_id, service_url)
             VALUES ('phone-1', 'Test Phone', 'android', ?1, datetime('now'), datetime('now'),
                     'user-1', 'https://share.test')",
            [&hash],
        )
        .unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO printers (name, type, address, language)
             VALUES ('Desk', 'ipp', '1.2.3.4', 'pdf')",
            [],
        )
        .unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, html, css,
                                    server_id, server_revision, sync_state)
             VALUES ('Receipt', 120, 200, 'portrait', '<p>{{x}}</p>', '',
                     'srv-1', 7, 'synced')",
            [],
        )
        .unwrap();
    drop(guard);
    db
}

/// The phone: flag on, one pair, the same template revision.
fn phone_db(port: u16) -> (Db, i64) {
    let db = fresh_db("phone");
    set(&db, "print_via_pc", "true");
    set(
        &db,
        "render_pairs",
        &serde_json::json!([{
            "id": "pc-1",
            "name": "Studio PC",
            "host": "127.0.0.1",
            "port": port,
            "secret": "tok-1",
            "fingerprint": "",
            "provider_id": "pc-1",
            "platform": "linux",
            "paired_at": "2026-01-01T00:00:00Z",
            "device_id": "phone-1",
        }])
        .to_string(),
    );
    let template_id = {
        let guard = db.lock().unwrap();
        guard
            .connection()
            .execute(
                "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation, html, css,
                                        server_id, server_revision, sync_state)
                 VALUES ('Receipt', 120, 200, 'portrait', '<p>{{x}}</p>', '',
                         'srv-1', 7, 'synced')",
                [],
            )
            .unwrap();
        guard.connection().last_insert_rowid()
    };
    (db, template_id)
}

async fn live_pc(db: &Db) -> u16 {
    let cache =
        std::env::temp_dir().join(format!("printninja_remote_cache_{}", uuid::Uuid::new_v4()));
    let app = printninja_lib::api::routes::router_with_state(
        printninja_lib::api::routes::ApiState {
            db: db.clone(),
            queue: Arc::new(printninja_lib::queue::PrintQueue::new()),
            cache_dir: cache,
            window: Arc::new(Mutex::new(None)),
        },
        false,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    port
}

fn args(template_id: i64) -> RemotePrintArgs {
    RemotePrintArgs {
        template_id: Some(template_id),
        template_name: None,
        template_server_id: None,
        template_server_revision: None,
        printer_name: "Desk".into(),
        data: Some(serde_json::json!({"x": "hi"})),
        data_url: None,
        http_method: None,
        copies: Some(1),
        records: None,
        orientation: None,
        fit_mode: None,
        page_range: None,
        grayscale: None,
        test: None,
        idempotency_key: Some("remote-1".into()),
        pair_id: None,
    }
}

fn phone_row(db: &Db) -> (String, Option<String>, Option<String>) {
    db.lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT status, error, printed_by FROM print_jobs ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

/// The PC has no spooler, so the print fails — but both rows carry the
/// attribution: the PC's row names the phone, the phone's row names the PC.
#[tokio::test]
async fn remote_print_records_both_sides_on_failure() {
    let pc = pc_db();
    let port = live_pc(&pc).await;
    let (phone, template_id) = phone_db(port);

    let res = remote_print_inner(&phone, args(template_id)).await.unwrap();
    assert!(!res.success);
    assert_eq!(res.pc_name, "Studio PC");
    assert!(res.error.is_some(), "the PC's reason surfaces");

    let (status, error, printed_by) = phone_row(&phone);
    assert_eq!(status, "failed");
    assert!(error.is_some());
    assert_eq!(printed_by.as_deref(), Some("Studio PC"));

    // The PC ran the job (loopback bypasses the LAN gate, so its row
    // carries no device — the LAN attribution is pinned by the
    // `lan_print_stamps_requesting_device` api_routes test instead).
    let n: i64 = pc
        .lock()
        .unwrap()
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

/// A stale phone revision never prints: the 409 code comes back in the
/// result for the Sync action, and the phone still records the attempt.
#[tokio::test]
async fn remote_print_stale_revision_is_409_with_row() {
    let pc = pc_db();
    let port = live_pc(&pc).await;
    let (phone, _) = phone_db(port);
    phone
        .lock()
        .unwrap()
        .connection()
        .execute("UPDATE templates SET server_revision = 6", [])
        .unwrap();
    let template_id: i64 = phone
        .lock()
        .unwrap()
        .connection()
        .query_row("SELECT id FROM templates LIMIT 1", [], |r| r.get(0))
        .unwrap();

    let res = remote_print_inner(&phone, args(template_id)).await.unwrap();
    assert!(!res.success);
    assert_eq!(res.code.as_deref(), Some("template_stale"));
    assert!(res.error.is_some());
    let (status, _, printed_by) = phone_row(&phone);
    assert_eq!(status, "failed");
    assert_eq!(printed_by.as_deref(), Some("Studio PC"));
    let n: i64 = pc
        .lock()
        .unwrap()
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "a refused print creates no PC job");
}

/// Gate refusals are covered against the live router in api_routes
/// (loopback here bypasses the LAN gate by design); the message mapping
/// is pinned by the module unit tests on `refusal`.
#[tokio::test]
async fn remote_print_unknown_template_creates_no_rows() {
    let pc = pc_db();
    let port = live_pc(&pc).await;
    let (phone, _) = phone_db(port);
    let mut bad = args(1);
    bad.template_id = Some(999);
    let err = remote_print_inner(&phone, bad).await.unwrap_err();
    assert!(err.to_string().contains("not found"), "{err}");
    for db in [&phone, &pc] {
        let n: i64 = db
            .lock()
            .unwrap()
            .connection()
            .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "intake failures create no rows anywhere");
    }
}

/// The flag gates the command: with it off, nothing dials anyone.
#[tokio::test]
async fn remote_print_refuses_when_flag_off() {
    let pc = pc_db();
    let port = live_pc(&pc).await;
    let (phone, template_id) = phone_db(port);
    phone
        .lock()
        .unwrap()
        .connection()
        .execute("DELETE FROM settings WHERE key = 'print_via_pc'", [])
        .unwrap();
    let err = remote_print_inner(&phone, args(template_id))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("Print via PC is off"), "{err}");
    let n: i64 = pc
        .lock()
        .unwrap()
        .connection()
        .query_row("SELECT COUNT(*) FROM print_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "nothing reached the PC");
}
