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
    /** IPP password; null means no HTTP authentication is sent. */
    pub password: Option<String>,
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
                password: row.get(9)?,
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
                password: row.get(9)?,
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
            req.password.as_ref().filter(|s| !s.is_empty()),
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
                password: row.get(9)?,
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
                    password: row.get(9)?,
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

/// Send a small test page to a configured printer.
#[tauri::command]
pub async fn test_printer(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    queue: State<'_, crate::queue::PrintQueue>,
    id: i64,
) -> AppResult<()> {
    // Load the printer so we know where to send and which language to speak.
    let printer = {
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
                    password: row.get(9)?,
                    skip_tls_verification: row.get(10)?,
                    via_driver: row.get(11)?,
                    default_settings_json: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            },
        )
        .map_err(|_| AppError::NotFound(format!("Printer {} not found", id)))?
    };

    let html = TEST_PAGE_HTML.replace("{{name}}", &printer.name);

    // Ask the printer whether it is there *before* rendering the page.
    // Without this the test print rendered first (seconds, and up to a
    // minute on Android's WebView) and only then discovered the address
    // was dead — the operator stared at a spinning button to learn the
    // printer was offline. The probe only opens and closes a connection:
    // it cannot print, so nothing is put on paper by looking.
    let printer_type = crate::transport::parse_printer_type(&printer.printer_type);
    crate::transport::TransportRegistry::probe(
        &printer_type,
        &printer.name,
        &printer.address,
        &crate::transport::TransportSettings {
            username: printer.username.clone(),
            password: printer.password.clone(),
            skip_tls_verification: printer.skip_tls_verification,
            via_driver: printer.via_driver,
        },
    )
    .await
    .map_err(AppError::Internal)?;

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

const TEST_PAGE_HTML: &str = r#"<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;padding:24px;text-align:center">
  <h1 style="font-size:24px;margin:0 0 8px">PrintNinja</h1>
  <p style="margin:0;color:#555">{{name}}</p>
  <hr style="margin:24px 0">
  <p style="font-size:12px;color:#888">Test page — if you can read this, printing works.</p>
</body></html>"#;
