//! Printer add/update validation and edit-in-place. The UI edits through
//! `update_printer` instead of delete + re-add, so profiles keyed by
//! printer name survive a rename of anything but the name itself.

use printninja_lib::commands::printer::{update_printer_conn, AddPrinterRequest};
use printninja_lib::db::Database;
use std::sync::{Arc, Mutex};

type Db = Arc<Mutex<Database>>;

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_printer_{}.db", uuid::Uuid::new_v4()));
    Arc::new(Mutex::new(
        Database::open(&format!("sqlite:{}", path.display())).expect("open db"),
    ))
}

fn with_conn<T>(db: &Db, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
    let guard = db.lock().unwrap();
    f(guard.connection())
}

fn req(name: &str) -> AddPrinterRequest {
    AddPrinterRequest {
        name: name.to_string(),
        printer_type: "ipp".to_string(),
        address: "http://192.0.2.10/ipp/print".to_string(),
        language: "pdf".to_string(),
        paper_width_mm: Some(80),
        dpi: Some(203),
        label_gap_mm: None,
        username: None,
        password: None,
        skip_tls_verification: None,
        via_driver: None,
    }
}

fn add(db: &Db, name: &str) -> i64 {
    with_conn(db, |conn| {
        conn.execute(
            "INSERT INTO printers (name, type, address, language) VALUES (?1, 'ipp', 'http://192.0.2.10/ipp/print', 'pdf')",
            [name],
        )
        .unwrap();
        conn.last_insert_rowid()
    })
}

#[test]
fn update_changes_fields_and_rejects_unknown_ids() {
    let db = test_db();
    let id = add(&db, "Dock Zebra");

    let updated = with_conn(&db, |conn| {
        update_printer_conn(
            conn,
            id,
            &AddPrinterRequest {
                address: "http://192.0.2.11/ipp/print".to_string(),
                ..req("Dock Zebra")
            },
        )
        .expect("update works")
    });
    assert_eq!(updated.address, "http://192.0.2.11/ipp/print");
    assert_eq!(updated.name, "Dock Zebra");

    let missing = with_conn(&db, |conn| {
        update_printer_conn(conn, id + 999, &req("Ghost"))
    });
    assert!(missing.is_err(), "unknown id must 404");
}

#[test]
fn update_rejects_duplicates_case_insensitively_but_keeps_own_name() {
    let db = test_db();
    let id = add(&db, "Dock Zebra");
    add(&db, "Office Inkjet");

    // Renaming onto another printer's name fails, any casing.
    let clash = with_conn(&db, |conn| {
        update_printer_conn(conn, id, &req("OFFICE inkjet"))
    });
    assert!(
        format!("{clash:?}").contains("already exists"),
        "duplicate must be refused: {clash:?}"
    );

    // Keeping the row's own name (even re-cased) is fine.
    let kept = with_conn(&db, |conn| {
        update_printer_conn(conn, id, &req("dock zebra"))
    });
    assert!(kept.is_ok(), "own name must not count as a duplicate");
}

#[test]
fn update_validates_like_add() {
    let db = test_db();
    let id = add(&db, "Dock Zebra");

    for bad in [
        req(""),
        req("   "),
        AddPrinterRequest {
            printer_type: "carrier-pigeon".to_string(),
            ..req("Dock Zebra")
        },
        AddPrinterRequest {
            language: "hieroglyphs".to_string(),
            ..req("Dock Zebra")
        },
    ] {
        assert!(
            with_conn(&db, |conn| update_printer_conn(conn, id, &bad)).is_err(),
            "invalid input must fail: {bad:?}"
        );
    }
}

/// The manual driver flag round-trips like every other stored field,
/// and an update that does not mention it leaves it off — no path
/// turns driver mode on by accident.
#[test]
fn via_driver_stores_and_updates_explicitly() {
    let db = test_db();
    let id = add(&db, "Dock Zebra");

    let untouched = with_conn(&db, |conn| {
        update_printer_conn(conn, id, &req("Dock Zebra"))
    })
    .expect("update works");
    assert!(!untouched.via_driver, "absent must store as driverless");

    let turned_on = with_conn(&db, |conn| {
        update_printer_conn(
            conn,
            id,
            &AddPrinterRequest {
                via_driver: Some(true),
                ..req("Dock Zebra")
            },
        )
    })
    .expect("update works");
    assert!(turned_on.via_driver);

    // A later unrelated edit must not silently flip it back either —
    // the value travels with the form, which always sends it.
    let kept_on = with_conn(&db, |conn| {
        update_printer_conn(
            conn,
            id,
            &AddPrinterRequest {
                via_driver: Some(true),
                dpi: Some(300),
                ..req("Dock Zebra")
            },
        )
    })
    .expect("update works");
    assert!(kept_on.via_driver);
    assert_eq!(kept_on.dpi, Some(300));
}
