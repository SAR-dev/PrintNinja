use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Printer {
    pub id: i64,
    pub name: String,
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
    /** TSPL media gap in mm; null means the built-in default (2 mm). */
    pub label_gap_mm: Option<f64>,
    /** IPP sign-in user; null means the built-in `PrintNinja`. */
    pub username: Option<String>,
    /**
     * A stored IPP password exists. The value itself is never sent to
     * the frontend — add/update receive it transiently in the request.
     */
    pub has_password: bool,
    /** Accept self-signed certificates on this printer's TLS endpoint. */
    pub skip_tls_verification: bool,
    /**
     * Manual Bluetooth mode: `true` prints through the OS driver queue
     * (Windows spooler / CUPS) instead of the driverless raw wire.
     * Never set automatically.
     */
    pub via_driver: bool,
    pub default_settings_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const VALID_PRINTER_TYPES: &[&str] = &["ipp", "raw_tcp", "usb", "bluetooth", "system"];
const VALID_LANGUAGES: &[&str] = &["pdf", "escpos", "tspl", "zpl", "cpcl", "raster"];

/// Shared by add and update so the UI, the API and the tests see one
/// rulebook with identical messages.
fn validate_printer_input(name: &str, printer_type: &str, language: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Printer name required".into()));
    }
    if !VALID_PRINTER_TYPES.contains(&printer_type) {
        return Err(AppError::Validation(format!(
            "Invalid printer type '{}'. Expected one of {:?}",
            printer_type, VALID_PRINTER_TYPES
        )));
    }
    if !VALID_LANGUAGES.contains(&language) {
        return Err(AppError::Validation(format!(
            "Invalid language '{}'. Expected one of {:?}",
            language, VALID_LANGUAGES
        )));
    }
    Ok(name.to_string())
}

#[tauri::command]
pub fn list_printers(db: State<DbState>) -> AppResult<Vec<Printer>> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let mut stmt = conn.prepare(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                label_gap_mm, username, password, skip_tls_verification,
                via_driver, default_settings_json, created_at, updated_at
         FROM printers ORDER BY name COLLATE NOCASE",
    )?;

    let printers = stmt
        .query_map([], |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                label_gap_mm: row.get(7)?,
                username: row.get(8)?,
                has_password: row.get::<_, Option<String>>(9)?.is_some(),
                skip_tls_verification: row.get(10)?,
                via_driver: row.get(11)?,
                default_settings_json: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(printers)
}

#[derive(Debug, Deserialize)]
pub struct AddPrinterRequest {
    pub name: String,
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
    #[serde(default)]
    pub label_gap_mm: Option<f64>,
    #[serde(default)]
    pub username: Option<String>,
    /// Transient credential: the value is sent to the backend, never back.
    /// On add, blank stores no password. On update, absent keeps the
    /// stored password and an explicit blank clears it.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub skip_tls_verification: Option<bool>,
    /**
     * Manual Bluetooth mode; `None`/absent stores `false` — the
     * driverless wire stays the default and no request can turn it on
     * without saying so.
     */
    #[serde(default)]
    pub via_driver: Option<bool>,
}

#[tauri::command]
pub fn add_printer(db: State<DbState>, req: AddPrinterRequest) -> AppResult<Printer> {
    let name = validate_printer_input(&req.name, &req.printer_type, &req.language)?;

    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE",
        [&name],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Validation(format!(
            "A printer named '{}' already exists",
            name
        )));
    }

    conn.execute(
        "INSERT INTO printers
             (name, type, address, language, paper_width_mm, dpi,
              label_gap_mm, username, password, skip_tls_verification,
              via_driver)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        // Blank credentials store as NULL, not `""` — an empty password
        // must not turn into a Basic-auth header downstream.
        rusqlite::params![
            name,
            req.printer_type,
            req.address,
            req.language,
            req.paper_width_mm,
            req.dpi,
            req.label_gap_mm,
            req.username.as_ref().filter(|s| !s.is_empty()),
            req.password.as_ref().filter(|s| !s.is_empty()),
            req.skip_tls_verification.unwrap_or(false) as i64,
            req.via_driver.unwrap_or(false) as i64,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let printer = conn.query_row(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                label_gap_mm, username, password, skip_tls_verification,
                via_driver, default_settings_json, created_at, updated_at
         FROM printers WHERE id = ?1",
        [id],
        |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                label_gap_mm: row.get(7)?,
                username: row.get(8)?,
                has_password: row.get::<_, Option<String>>(9)?.is_some(),
                skip_tls_verification: row.get(10)?,
                via_driver: row.get(11)?,
                default_settings_json: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        },
    )?;

    Ok(printer)
}

/// Edit a printer in place (the UI used to require delete + re-add,
/// losing profiles keyed by name). Same validation as add; the
/// duplicate-name check excludes the row being edited.
#[tauri::command]
pub fn update_printer(db: State<DbState>, id: i64, req: AddPrinterRequest) -> AppResult<Printer> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    update_printer_conn(guard.connection(), id, &req)
}

/// Save a printer's TSPL tuning (darkness, speed, media type). `None`
/// clears it, so the printer's own settings apply again. Stored under the
/// `tspl` key of the row's `default_settings_json`; other keys there are
/// kept.
#[tauri::command]
pub fn set_printer_tspl_tuning(
    db: State<DbState>,
    id: i64,
    tuning: Option<crate::transport::label_langs::tspl::TsplTuning>,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    set_printer_tspl_tuning_conn(guard.connection(), id, tuning.as_ref())
}

/// Test seam for [`set_printer_tspl_tuning`].
pub fn set_printer_tspl_tuning_conn(
    conn: &rusqlite::Connection,
    id: i64,
    tuning: Option<&crate::transport::label_langs::tspl::TsplTuning>,
) -> AppResult<()> {
    if let Some(t) = tuning {
        t.validate().map_err(AppError::Validation)?;
    }
    let current: Option<String> = conn
        .query_row(
            "SELECT default_settings_json FROM printers WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("Printer {} not found", id))
            }
            other => other.into(),
        })?;
    let mut root = current
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = root.as_object_mut().expect("object");
    match tuning {
        Some(t) => {
            obj.insert(
                "tspl".to_string(),
                serde_json::to_value(t).map_err(|e| AppError::Internal(e.to_string()))?,
            );
        }
        None => {
            obj.remove("tspl");
        }
    }
    let stored = if obj.is_empty() {
        None
    } else {
        Some(root.to_string())
    };
    conn.execute(
        "UPDATE printers SET default_settings_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![stored, id],
    )?;
    Ok(())
}

/// Save a printer's ESC/POS tuning (raster band height). `None` clears it,
/// so the built-in 256-row bands apply again. Stored under the `escpos` key
/// of the row's `default_settings_json`; other keys there are kept.
#[tauri::command]
pub fn set_printer_escpos_tuning(
    db: State<DbState>,
    id: i64,
    tuning: Option<crate::transport::escpos::EscPosTuning>,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    set_printer_escpos_tuning_conn(guard.connection(), id, tuning.as_ref())
}

/// Test seam for [`set_printer_escpos_tuning`].
pub fn set_printer_escpos_tuning_conn(
    conn: &rusqlite::Connection,
    id: i64,
    tuning: Option<&crate::transport::escpos::EscPosTuning>,
) -> AppResult<()> {
    if let Some(t) = tuning {
        t.validate().map_err(AppError::Validation)?;
    }
    let current: Option<String> = conn
        .query_row(
            "SELECT default_settings_json FROM printers WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("Printer {} not found", id))
            }
            other => other.into(),
        })?;
    let mut root = current
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = root.as_object_mut().expect("object");
    // An all-default tuning (no band height) is the same as none: keep the
    // stored JSON free of an empty `escpos` object.
    match tuning.filter(|t| t.band_rows.is_some()) {
        Some(t) => {
            obj.insert(
                "escpos".to_string(),
                serde_json::to_value(t).map_err(|e| AppError::Internal(e.to_string()))?,
            );
        }
        None => {
            obj.remove("escpos");
        }
    }
    let stored = if obj.is_empty() {
        None
    } else {
        Some(root.to_string())
    };
    conn.execute(
        "UPDATE printers SET default_settings_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![stored, id],
    )?;
    Ok(())
}

/// Save a printer's driverless Bluetooth delivery pacing (chunk size and
/// pause). `None` clears it, so the built-in pace applies again. Stored
/// under the `bluetooth` key of the row's `default_settings_json`; other
/// keys there are kept.
#[tauri::command]
pub fn set_printer_bluetooth_delivery(
    db: State<DbState>,
    id: i64,
    delivery: Option<crate::transport::BluetoothDelivery>,
) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    set_printer_bluetooth_delivery_conn(guard.connection(), id, delivery.as_ref())
}

/// Test seam for [`set_printer_bluetooth_delivery`].
pub fn set_printer_bluetooth_delivery_conn(
    conn: &rusqlite::Connection,
    id: i64,
    delivery: Option<&crate::transport::BluetoothDelivery>,
) -> AppResult<()> {
    if let Some(d) = delivery {
        d.validate().map_err(AppError::Validation)?;
    }
    let current: Option<String> = conn
        .query_row(
            "SELECT default_settings_json FROM printers WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("Printer {} not found", id))
            }
            other => other.into(),
        })?;
    let mut root = current
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let obj = root.as_object_mut().expect("object");
    match delivery {
        Some(d) => {
            obj.insert(
                "bluetooth".to_string(),
                serde_json::to_value(d).map_err(|e| AppError::Internal(e.to_string()))?,
            );
        }
        None => {
            obj.remove("bluetooth");
        }
    }
    let stored = if obj.is_empty() {
        None
    } else {
        Some(root.to_string())
    };
    conn.execute(
        "UPDATE printers SET default_settings_json = ?1, updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![stored, id],
    )?;
    Ok(())
}

/// Test seam for the edit path: the Tauri command only adds the lock.
/// Public so integration tests can drive validation and the duplicate
/// check against a real database without a Tauri runtime.
pub fn update_printer_conn(
    conn: &rusqlite::Connection,
    id: i64,
    req: &AddPrinterRequest,
) -> AppResult<Printer> {
    let name = validate_printer_input(&req.name, &req.printer_type, &req.language)?;

    let clash: i64 = conn.query_row(
        "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
        rusqlite::params![name, id],
        |r| r.get(0),
    )?;
    if clash > 0 {
        return Err(AppError::Validation(format!(
            "A printer named '{}' already exists",
            name
        )));
    }

    // The form never prefills the stored password, so an update that
    // omits it means "keep what is stored": only an explicit value
    // rewrites the column, and an explicit blank clears it.
    let existing_password: Option<String> = conn
        .query_row("SELECT password FROM printers WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))?;
    let new_password = match &req.password {
        None => existing_password,
        Some(p) => (!p.is_empty()).then(|| p.clone()),
    };

    let affected = conn.execute(
        "UPDATE printers SET name = ?1, type = ?2, address = ?3, language = ?4,
                paper_width_mm = ?5, dpi = ?6, label_gap_mm = ?7, username = ?8,
                password = ?9, skip_tls_verification = ?10, via_driver = ?11,
                updated_at = datetime('now')
         WHERE id = ?12",
        // Blank credentials store as NULL, not `""` — an empty password
        // must not turn into a Basic-auth header downstream.
        rusqlite::params![
            name,
            req.printer_type,
            req.address,
            req.language,
            req.paper_width_mm,
            req.dpi,
            req.label_gap_mm,
            req.username.as_ref().filter(|s| !s.is_empty()),
            &new_password,
            req.skip_tls_verification.unwrap_or(false) as i64,
            req.via_driver.unwrap_or(false) as i64,
            id,
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Printer {} not found", id)));
    }
    conn.query_row(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                label_gap_mm, username, password, skip_tls_verification,
                via_driver, default_settings_json, created_at, updated_at
         FROM printers WHERE id = ?1",
        [id],
        |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                label_gap_mm: row.get(7)?,
                username: row.get(8)?,
                has_password: row.get::<_, Option<String>>(9)?.is_some(),
                skip_tls_verification: row.get(10)?,
                via_driver: row.get(11)?,
                default_settings_json: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        },
    )
    .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))
}

fn get_printer_inner(db: &DbState, id: i64) -> AppResult<Printer> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    guard
        .connection()
        .query_row(
            "SELECT id, name, type, address, language, paper_width_mm, dpi,
                    label_gap_mm, username, password, skip_tls_verification,
                via_driver, default_settings_json, created_at, updated_at
             FROM printers WHERE id = ?1",
            [id],
            |row| {
                Ok(Printer {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    printer_type: row.get(2)?,
                    address: row.get(3)?,
                    language: row.get(4)?,
                    paper_width_mm: row.get(5)?,
                    dpi: row.get(6)?,
                    label_gap_mm: row.get(7)?,
                    username: row.get(8)?,
                    has_password: row.get::<_, Option<String>>(9)?.is_some(),
                    skip_tls_verification: row.get(10)?,
                    via_driver: row.get(11)?,
                    default_settings_json: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        )
        .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))
}

#[tauri::command]
pub fn delete_printer(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();

    let affected = conn.execute("DELETE FROM printers WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Printer {} not found", id)));
    }
    Ok(())
}

#[tauri::command]
pub fn get_printer(db: State<DbState>, id: i64) -> AppResult<Printer> {
    get_printer_inner(&db, id)
}

/// Load a stored printer row, password included.
///
/// The password rides along for the transport only — the `Printer` the
/// frontend sees reports `has_password`, never the value. Shared by the
/// test print and the raw console so both resolve a row identically.
fn load_printer_row(db: &DbState, id: i64) -> AppResult<(Printer, Option<String>)> {
    let guard = db
        .lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection();
    conn.query_row(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                label_gap_mm, username, password, skip_tls_verification,
                via_driver, default_settings_json, created_at, updated_at
         FROM printers WHERE id = ?1",
        [id],
        |row| {
            let password = row.get::<_, Option<String>>(9)?;
            Ok((
                Printer {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    printer_type: row.get(2)?,
                    address: row.get(3)?,
                    language: row.get(4)?,
                    paper_width_mm: row.get(5)?,
                    dpi: row.get(6)?,
                    label_gap_mm: row.get(7)?,
                    username: row.get(8)?,
                    has_password: password.as_ref().is_some(),
                    skip_tls_verification: row.get(10)?,
                    via_driver: row.get(11)?,
                    default_settings_json: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                },
                password,
            ))
        },
    )
    .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))
}

/// Send a small test to a configured printer: the full test page, or —
/// for the command languages — one line of plain text (`kind: "text"`),
/// the fastest way to tell whether the language mode is right.
#[tauri::command]
pub async fn test_printer(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, crate::queue::PrintQueue>,
    id: i64,
    kind: Option<String>,
) -> AppResult<()> {
    // Load the printer so we know where to send and which language to
    // speak. The password rides along for the transport only.
    let (printer, password) = load_printer_row(&db, id)?;

    let printer_type = crate::transport::parse_printer_type(&printer.printer_type);
    let settings = crate::transport::TransportSettings {
        username: printer.username.clone(),
        password,
        skip_tls_verification: printer.skip_tls_verification,
        via_driver: printer.via_driver,
        bluetooth: crate::transport::BluetoothDelivery::from_settings_json(
            printer.default_settings_json.as_deref(),
        ),
    };

    if kind
        .as_deref()
        .map(str::trim)
        .is_some_and(|k| k.eq_ignore_ascii_case("text"))
    {
        return test_printer_text(&db, &printer, &printer_type, &settings).await;
    }

    let html = TEST_PAGE_HTML.replace("{{name}}", &printer.name);

    // Ask the printer whether it is there *before* rendering the page.
    // Without this the test print rendered first (seconds, and up to a
    // minute on Android's WebView) and only then discovered the address
    // was dead — the operator stared at a spinning button to learn the
    // printer was offline. The probe only opens and closes a connection:
    // it cannot print, so nothing is put on paper by looking.
    if test_print_probes(&printer_type, printer.via_driver) {
        crate::transport::TransportRegistry::probe(
            &printer_type,
            &printer.name,
            &printer.address,
            &settings,
        )
        .await
        .map_err(AppError::Internal)?;
    }

    let req = crate::commands::print::PrintRequest {
        printer_name: printer.name.clone(),
        html,
        pdf: None,
        page_width_mm: printer.paper_width_mm.map(|v| v as f64),
        page_height_mm: None,
        orientation: Some("portrait".into()),
        copies: Some(1),
        records: None,
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        page_range: None,
        grayscale: None,
        template_id: None,
        data: None,
        data_url: None,
        http_method: None,
        test: Some(true),
        source: Some("test".into()),
        idempotency_key: None,
        requested_by_device_id: None,
    };

    let res = crate::commands::print::print_html(app, db, queue, req).await?;
    if res.success {
        Ok(())
    } else {
        Err(AppError::Internal(
            res.error.unwrap_or_else(|| "test print failed".into()),
        ))
    }
}

/// Whether the image test asks the printer whether it is there before
/// sending. Driverless Bluetooth is the only no: its RFCOMM socket is
/// stateful, and a probe would be a second connect right before the real
/// send — some heads treat the connect, close, reconnect as a full
/// session and drop what comes after. The send opens the one connection
/// it needs and reports a dead address itself.
fn test_print_probes(printer_type: &crate::transport::PrinterType, via_driver: bool) -> bool {
    printer_type != &crate::transport::PrinterType::Bluetooth || via_driver
}

/// The plain-text test: one line in the printer's own language, sent
/// straight to the wire (no render, no probe) with a history row like
/// any other job.
async fn test_printer_text(
    db: &DbState,
    printer: &Printer,
    printer_type: &crate::transport::PrinterType,
    settings: &crate::transport::TransportSettings,
) -> AppResult<()> {
    let start = std::time::Instant::now();
    let language = crate::transport::parse_printer_language(&printer.language);
    let label_w_mm = printer.paper_width_mm.map(|v| v as f64).unwrap_or(40.0);
    let Some(data) = crate::transport::text_test_bytes(&language, &printer.name, label_w_mm) else {
        return Err(AppError::Validation(
            "Text tests are only available for ESC/POS, TSPL, ZPL and CPCL printers".into(),
        ));
    };

    // A history row like the image test gets, so both show up in History.
    let req = crate::commands::print::PrintRequest {
        printer_name: printer.name.clone(),
        html: String::new(),
        pdf: None,
        page_width_mm: None,
        page_height_mm: None,
        orientation: Some("portrait".into()),
        copies: Some(1),
        records: None,
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        page_range: None,
        grayscale: None,
        template_id: None,
        data: None,
        data_url: None,
        http_method: None,
        test: Some(true),
        source: Some("test".into()),
        idempotency_key: None,
        requested_by_device_id: None,
    };
    let job_id = crate::commands::print::begin_job(db, &req, 1, (label_w_mm, 30.0))?;
    let job = crate::transport::RenderedJob {
        job_id: job_id.to_string(),
        printer_id: printer.id.to_string(),
        data,
        mime_type: "application/octet-stream".into(),
        copies: 1,
        language,
        raw: None,
    };
    let result = crate::transport::TransportRegistry::send_to(
        printer_type,
        &printer.name,
        &printer.address,
        job,
        settings,
    )
    .await;
    let duration_ms = start.elapsed().as_millis() as i64;
    match result {
        Ok(()) => {
            crate::commands::print::close_job(db, job_id, "success", None, "", &[], duration_ms)?;
            Ok(())
        }
        Err(error) => {
            // Leave a failed row with the reason, like every other path.
            let _ = crate::commands::print::close_job(
                db,
                job_id,
                "failed",
                Some(error.clone()),
                "",
                &[],
                duration_ms,
            );
            Err(AppError::Internal(error))
        }
    }
}

/// The largest payload the raw console will carry, in bytes.
const MAX_RAW_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Raw console (developer tool): send arbitrary bytes to a saved
/// printer through the app's real send path — the same registry as
/// `test_printer` — with the operator choosing the pacing, and report
/// what was actually applied and how long each stage took.
///
/// An experiment tool by contract: no render, no history row, no queue.
/// It logs byte counts and timings — never the payload.
#[tauri::command]
pub async fn send_raw_bytes(
    db: State<'_, DbState>,
    printer_id: i64,
    data_base64: String,
    options: Option<crate::transport::RawSendOptions>,
) -> AppResult<crate::transport::RawSendReport> {
    use crate::transport::{
        BluetoothDelivery, RawDelivery, RawRecorder, RawSend, RawSendOptions, RawSendReport,
        RenderedJob,
    };
    use base64::Engine as _;

    // Bound the payload before decoding: a 10 MiB base64 string must not
    // become a 7.5 MiB allocation just to be rejected a line later.
    if data_base64.len() > MAX_RAW_PAYLOAD_BYTES * 4 / 3 + 4 {
        return Err(AppError::Validation(
            "Payload is too large for the raw console (max 1 MiB)".into(),
        ));
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| AppError::Validation(format!("Data is not valid base64: {e}")))?;
    if data.is_empty() {
        return Err(AppError::Validation(
            "The raw console needs at least one byte to send".into(),
        ));
    }
    if data.len() > MAX_RAW_PAYLOAD_BYTES {
        return Err(AppError::Validation(
            "Payload is too large for the raw console (max 1 MiB)".into(),
        ));
    }
    let bytes = data.len();

    let (printer, password) = load_printer_row(&db, printer_id)?;
    let printer_type = crate::transport::parse_printer_type(&printer.printer_type);
    let language = crate::transport::parse_printer_language(&printer.language);
    let options = options.unwrap_or_default();
    // Override where the operator gave one, else the row's stored pace,
    // clamped to the same bounds the settings form enforces.
    let delivery = RawDelivery::resolve(
        &options,
        BluetoothDelivery::from_settings_json(printer.default_settings_json.as_deref()),
    );
    let recorder = RawRecorder::default();

    let settings = crate::transport::TransportSettings {
        username: printer.username.clone(),
        password,
        skip_tls_verification: printer.skip_tls_verification,
        via_driver: printer.via_driver,
        // The Android transport paces the RFCOMM write from these values;
        // the desktop raw transports read the delivery from the job.
        bluetooth: BluetoothDelivery {
            chunk_bytes: delivery.chunk_bytes,
            chunk_pause_ms: delivery.chunk_pause_ms,
        },
    };

    let job = RenderedJob {
        job_id: "raw-console".into(),
        printer_id: printer.id.to_string(),
        data,
        mime_type: "application/octet-stream".into(),
        copies: 1,
        language,
        raw: Some(RawSend {
            delivery,
            recorder: recorder.clone(),
        }),
    };

    let result = crate::transport::TransportRegistry::send_to(
        &printer_type,
        &printer.name,
        &printer.address,
        job,
        &settings,
    )
    .await;

    let ok = result.is_ok();
    let report = RawSendReport {
        ok,
        error: result.err(),
        bytes_sent: if ok { bytes as u64 } else { 0 },
        timings_ms: recorder.timings(),
        // The transport records what it actually applied; when it failed
        // before it could (a dead address, an unsupported type) the
        // resolved values are the best statement of what would have been.
        effective_options: recorder.effective().unwrap_or(RawSendOptions {
            chunk_bytes: Some(delivery.chunk_bytes),
            chunk_pause_ms: Some(delivery.chunk_pause_ms),
            settle_ms: Some(delivery.desktop_settle_ms()),
        }),
    };
    tracing::info!(
        printer = %printer.name,
        bytes,
        ok = report.ok,
        ?report.timings_ms,
        "raw console send"
    );
    Ok(report)
}

/// What the printer understands, asked *before* its row is saved (TODO
/// items 2 + 4): the document formats it accepts (IPP), its
/// make-and-model, and the language suggested by either.
///
/// Read-only — status queries print nothing — and graceful by
/// contract: an unreachable, refusing or silent printer comes back as
/// `detected: false`, never as an error. The form keeps its default
/// language and shows "unknown — please pick".
#[tauri::command(rename_all = "snake_case")]
pub async fn probe_printer_capabilities(
    printer_type: String,
    name: Option<String>,
    address: String,
    username: Option<String>,
    password: Option<String>,
    skip_tls_verification: Option<bool>,
) -> AppResult<crate::transport::capabilities::ProbeCapabilities> {
    probe_printer_capabilities_inner(
        &printer_type,
        name.as_deref().unwrap_or(""),
        &address,
        &crate::transport::TransportSettings {
            username,
            password,
            skip_tls_verification: skip_tls_verification.unwrap_or(false),
            // Pre-save detection asks the wire itself; the row's manual
            // mode does not exist yet, so the driverless path answers.
            via_driver: false,
            // No row yet, so no stored pacing either.
            bluetooth: Default::default(),
        },
    )
    .await
}

/// The seam the Tauri command wraps: tests (and anything else) call
/// this directly, the way `update_printer_conn` is tested.
pub async fn probe_printer_capabilities_inner(
    printer_type: &str,
    name: &str,
    address: &str,
    settings: &crate::transport::TransportSettings,
) -> AppResult<crate::transport::capabilities::ProbeCapabilities> {
    let ty = printer_type.trim().to_ascii_lowercase();
    if !VALID_PRINTER_TYPES.contains(&ty.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid printer type '{}'. Expected one of {:?}",
            printer_type, VALID_PRINTER_TYPES
        )));
    }
    Ok(crate::transport::capabilities::probe(
        &crate::transport::parse_printer_type(&ty),
        name,
        address,
        settings,
    )
    .await)
}

/// The border is the width check: the page is rendered at the printer's
/// stored width, so if that number is wider than the real paper, the
/// right side of the border comes off the edge (or the whole page shifts
/// and the left side is clipped). Garbled text means the language mode
/// is wrong — the plain-text test pinpoints that one.
const TEST_PAGE_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;margin:0;background:#fff">
  <div style="box-sizing:border-box;border:2px solid #000;height:140mm;padding:10px">
    <h1 style="font-size:24px;margin:16px 0 8px;text-align:center">PrintNinja</h1>
    <p style="margin:0;text-align:center;color:#555">{{name}}</p>
    <hr style="margin:24px 0">
    <p style="font-size:12px;text-align:center;color:#888">
      If any side of the border is cut off, the paper width is set too wide.<br>
      If the text is garbled, the printer's language mode is wrong.
    </p>
  </div>
</body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::PrinterType;

    /// A driverless Bluetooth test must open one connection (the send),
    /// not two (probe + send): the second connect is what wedges the
    /// B-FP2D's head.
    #[test]
    fn bluetooth_test_opens_one_connection_not_two() {
        // Driverless: no probe, the send is the only connection.
        assert!(!test_print_probes(&PrinterType::Bluetooth, false));
        // Driver mode goes through the OS queue, where a probe is cheap.
        assert!(test_print_probes(&PrinterType::Bluetooth, true));
    }

    #[test]
    fn every_other_test_kind_still_probes() {
        for ty in [
            PrinterType::Ipp,
            PrinterType::RawTcp,
            PrinterType::Usb,
            PrinterType::System,
        ] {
            assert!(test_print_probes(&ty, false), "{ty:?}");
            assert!(test_print_probes(&ty, true), "{ty:?}");
        }
    }
}
