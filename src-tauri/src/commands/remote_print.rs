//! Print via PC (ARCHITECTURE §9), phone side: send the job to a paired
//! PC's `POST /v1/print` instead of the local pipeline, then record the
//! outcome in the phone's own history.
//!
//! While the flag is on the phone calls no local transport at all — no
//! USB, Bluetooth, or network send. There is no fallback and no override:
//! an unreachable PC or a rejected token fails the job with a clear
//! message, and printing locally means turning the flag off. Retries
//! reuse the caller's idempotency key, so a timeout never prints twice.
//!
//! The PC endpoint already stamps `requested_by_device_id` (ARCHITECTURE §9) and
//! enforces the template version check (ARCHITECTURE §9); this command feeds it the
//! `server_id`/`server_revision` from the phone's own template row.

use crate::api::peer_consume::{describe_no_answer_for, pair_base, RenderPair};
use crate::commands::print::{check_copies, MAX_API_DATA_BYTES, MAX_RECORDS};
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

/// Long send: a big document can render for minutes on the PC before the
/// POST answers. Generous, not infinite — a truly wedged PC still fails.
const POST_TIMEOUT_SECS: u64 = 15 * 60;
/// The POST already ran the pipeline, so the first poll is terminal in
/// practice; the loop only covers the duplicate-key path and races.
const POLL_INTERVAL_MS: u64 = 1000;
const POLL_TIMEOUT_SECS: u64 = 60;
/// Printer-list fetch: a fast LAN round trip, or the cached list wins.
const PRINTERS_TIMEOUT_SECS: u64 = 10;
const PRINTERS_CACHE_TTL_SECS: i64 = 5 * 60;

/// One print through the paired PC. Field names mirror [`PrintRequest`];
/// `template_id` is the phone's *local* id — the command resolves the
/// name and sync identity the PC needs.
#[derive(Debug, Clone, Deserialize)]
pub struct RemotePrintArgs {
    pub template_id: i64,
    /// The PC's printer, by the name its `GET /v1/printers` reports.
    pub printer_name: String,
    pub data: Option<serde_json::Value>,
    pub data_url: Option<String>,
    pub http_method: Option<String>,
    pub copies: Option<u32>,
    /// Pages per print (see `PrintRequest.records`): expanded into an
    /// array client-side, since the API has no records parameter.
    pub records: Option<u32>,
    pub orientation: Option<String>,
    pub fit_mode: Option<String>,
    pub page_range: Option<String>,
    pub grayscale: Option<bool>,
    pub test: Option<bool>,
    /// Caller-generated de-duplication key. Retries of one attempt reuse
    /// it, so a timeout never prints twice; absent, one is minted.
    pub idempotency_key: Option<String>,
    /// Which PC, by `provider_id`. Defaults to the `print_via_pc_device`
    /// setting, or the only pair when one is paired.
    pub pair_id: Option<String>,
}

/// The outcome, for the print dialog: what the PC reported, plus which
/// PC ran it. `code` carries a 409 `template_missing`/`template_stale`
/// through for the Sync-templates action.
#[derive(Debug, Clone, Serialize)]
pub struct RemotePrintResult {
    pub success: bool,
    pub status: String,
    pub pc_job_id: Option<String>,
    pub duration_ms: u64,
    pub error: Option<String>,
    pub code: Option<String>,
    pub pc_name: String,
}

/// One PC printer, as its `GET /v1/printers` reports it. No address: the
/// phone never dials printers itself while the flag is on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcPrinterInfo {
    pub name: String,
    /// The PC's `GET /v1/printers` names this key `type`; the phone's own
    /// UI and cache use `printer_type`. Accept both.
    #[serde(alias = "type")]
    pub printer_type: String,
    #[serde(default)]
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemotePrintersResult {
    pub printers: Vec<PcPrinterInfo>,
    /// True when the PC did not answer and this is the last good list.
    pub cached: bool,
}

fn setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .filter(|s| !s.trim().is_empty())
}

/// The pairs this phone can print through.
fn load_pairs(conn: &rusqlite::Connection) -> Vec<RenderPair> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'render_pairs'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
    .unwrap_or_default()
}

/// Pick the PC: explicit choice wins, then the stored default, then the
/// only pair. Anything else names the problem instead of guessing —
/// printing on the wrong PC's printers is exactly what the picker is for.
fn select_pair(pairs: &[RenderPair], wanted: Option<&str>) -> Result<RenderPair, AppError> {
    if pairs.is_empty() {
        return Err(AppError::Validation(
            "No PC is paired. Pair a PC first, then turn on Print via PC.".into(),
        ));
    }
    if let Some(id) = wanted.map(str::trim).filter(|s| !s.is_empty()) {
        return pairs
            .iter()
            .find(|p| p.provider_id == id || p.id == id)
            .cloned()
            .ok_or_else(|| AppError::Validation("That PC is no longer paired.".into()));
    }
    if pairs.len() == 1 {
        return Ok(pairs[0].clone());
    }
    Err(AppError::Validation(
        "Choose which PC to print on first.".into(),
    ))
}

/// Expand `records` the way the local pipeline does: one object repeated
/// N times prints N identical pages, which is exactly an N-element array
/// of that object. An array already prints its own length.
fn expand_records(data: Option<serde_json::Value>, records: u32) -> Option<serde_json::Value> {
    // An array prints its own length — pass it through untouched. (`None`
    // would drop it: the caller assigns the return as the payload.)
    if matches!(data, Some(serde_json::Value::Array(_))) {
        return data;
    }
    let n = records.max(1);
    if n <= 1 {
        return data;
    }
    let template = data.unwrap_or(serde_json::Value::Object(Default::default()));
    Some(serde_json::Value::Array(vec![
        template;
        n.min(MAX_RECORDS) as usize
    ]))
}

/// The phone's template row: the name the PC resolves (by `server_id`
/// when the phone has one) plus the revision it renders against.
fn lookup_template(
    conn: &rusqlite::Connection,
    template_id: i64,
) -> AppResult<(String, Option<String>, Option<i64>)> {
    conn.query_row(
        "SELECT name, server_id, server_revision FROM templates
         WHERE id = ?1 AND sync_state <> 'deleted_pending'",
        [template_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|_| AppError::NotFound(format!("Template #{template_id} not found")))
}

fn print_client(timeout_secs: u64) -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        // The peer path's connect timeout, not the pairing probe's: this
        // dials one known PC, and a hasty connect fails on slow phone
        // Wi-Fi where the Test button (same address, patient dial)
        // succeeds. Same address, same outcome.
        .connect_timeout(std::time::Duration::from_millis(
            crate::api::peer_consume::PEER_CONNECT_TIMEOUT_MS,
        ))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| AppError::Internal(format!("http client failed: {e}")))
}

/// The PC's refusal, in its own words when it has them. 401 is generic by
/// design (the gate hides why), so the phone says what it means here:
/// pair again. (409s never reach this: a version refusal is an answered
/// print with a code, returned as `Ok(success: false)` so the dialog can
/// offer Sync directly from the result.)
fn refusal(status: reqwest::StatusCode, body: &serde_json::Value) -> AppError {
    let msg = body
        .get("error")
        .and_then(|e| e.as_str())
        .unwrap_or_default();
    match status.as_u16() {
        401 => AppError::Validation(
            "This phone was removed on the PC, or the PC switched account. Pair again.".into(),
        ),
        403 => AppError::Validation(if msg.is_empty() {
            "Printing is not allowed for this phone on that PC.".into()
        } else {
            msg.to_string()
        }),
        _ => {
            let text = if msg.is_empty() {
                format!("The PC refused the print ({status})")
            } else {
                msg.to_string()
            };
            AppError::Validation(text)
        }
    }
}

/// Poll the PC's job until it leaves `printing`/`queued`. The POST
/// already ran the pipeline, so this usually returns on the first read.
async fn poll_job(
    client: &reqwest::Client,
    base: &str,
    secret: &str,
    job_id: &str,
) -> AppResult<(String, Option<String>)> {
    let url = format!("{base}/v1/jobs/{job_id}");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(POLL_TIMEOUT_SECS);
    loop {
        let res = client
            .get(&url)
            .header("Authorization", format!("Bearer {secret}"))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("Could not read the PC's job: {e}")))?;
        if !res.status().is_success() {
            return Err(AppError::Internal(format!(
                "The PC lost the job ({})",
                res.status()
            )));
        }
        let body: serde_json::Value = res
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("The PC sent an unreadable job: {e}")))?;
        let status = body
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        if status != "queued" && status != "printing" {
            let error = body
                .get("error")
                .and_then(|e| e.as_str())
                .map(str::to_string);
            return Ok((status, error));
        }
        if std::time::Instant::now() >= deadline {
            return Err(AppError::Internal(
                "Timed out waiting for the PC. Retry with the same key — it will not print twice."
                    .into(),
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// Record the attempt in the phone's own history: what was asked, what
/// the PC said, and which PC ran it. Every tap leaves a row, success or
/// not — the dialog reads this, not the PC.
#[allow(clippy::too_many_arguments)]
fn record_remote_job(
    conn: &rusqlite::Connection,
    template_id: i64,
    template_revision: Option<i64>,
    copies: u32,
    pc_printer: &str,
    pc_name: &str,
    data: &Option<serde_json::Value>,
    idempotency_key: &str,
    is_test: bool,
    status: &str,
    error: Option<&str>,
    duration_ms: i64,
) -> AppResult<()> {
    let settings = serde_json::json!({
        "copies": copies,
        "remote_printer": pc_printer,
    })
    .to_string();
    let data_json = data.as_ref().and_then(|d| serde_json::to_string(d).ok());
    conn.execute(
        "INSERT INTO print_jobs
           (template_id, printer_id, source, status, error, copies, settings_json,
            rendered_html, data_json, idempotency_key, is_test,
            created_at, started_at, finished_at, duration_ms,
            printed_by, template_revision)
         VALUES (?1, NULL, 'ui', ?2, ?3, ?4, ?5,
                 '', ?6, ?7, ?8,
                 datetime('now'), datetime('now'), datetime('now'), ?9,
                 ?10, ?11)",
        rusqlite::params![
            template_id,
            status,
            error,
            copies as i64,
            settings,
            data_json,
            idempotency_key,
            i64::from(is_test),
            duration_ms,
            pc_name,
            template_revision,
        ],
    )?;
    Ok(())
}

/// Print through the paired PC and record the outcome locally.
/// See the module docs for the no-fallback contract.
pub async fn remote_print_inner(
    db: &DbState,
    args: RemotePrintArgs,
) -> AppResult<RemotePrintResult> {
    let started = std::time::Instant::now();
    // One scoped lock, released before any network round trip: holding it
    // across the send would stall every other command, and the history
    // write below takes it again.
    let (pair, base, template_name, server_id, server_revision) = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        if setting(guard.connection(), "print_via_pc").as_deref() != Some("true") {
            return Err(AppError::Validation(
                "Print via PC is off. Turn it on to print through a paired PC.".into(),
            ));
        }
        let pairs = load_pairs(guard.connection());
        let stored_default = setting(guard.connection(), "print_via_pc_device");
        let pair = select_pair(
            &pairs,
            args.pair_id.as_deref().or(stored_default.as_deref()),
        )?;
        let base = pair_base(&pair).map_err(AppError::Validation)?;
        let (template_name, server_id, server_revision) =
            lookup_template(guard.connection(), args.template_id)?;
        (pair, base, template_name, server_id, server_revision)
    };

    let copies = check_copies(args.copies.unwrap_or(1))?;
    if args.records.is_some_and(|n| n > MAX_RECORDS) {
        return Err(AppError::Validation(format!(
            "Too many pages requested: {} (max {MAX_RECORDS})",
            args.records.unwrap_or(1)
        )));
    }
    let data = expand_records(args.data.clone(), args.records.unwrap_or(1).max(1));
    if let Some(d) = &data {
        let bytes = serde_json::to_string(d).map(|s| s.len()).unwrap_or(0);
        if bytes > MAX_API_DATA_BYTES {
            return Err(AppError::Validation(format!(
                "`data` is too large ({bytes} bytes, max {MAX_API_DATA_BYTES}); use `data_url`"
            )));
        }
    }
    let key = args
        .idempotency_key
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let is_test = args.test.unwrap_or(false);

    let mut settings = serde_json::json!({ "copies": copies });
    for (k, v) in [
        (
            "orientation",
            args.orientation.as_deref().map(|s| serde_json::json!(s)),
        ),
        (
            "fit",
            args.fit_mode.as_deref().map(|s| serde_json::json!(s)),
        ),
        (
            "page_range",
            args.page_range.as_deref().map(|s| serde_json::json!(s)),
        ),
        ("grayscale", args.grayscale.map(|b| serde_json::json!(b))),
        (
            "http_method",
            args.http_method.as_deref().map(|s| serde_json::json!(s)),
        ),
    ] {
        if let Some(v) = v {
            settings[k] = v;
        }
    }
    let mut body = serde_json::json!({
        "template": template_name,
        "printer": args.printer_name,
        "settings": settings,
    });
    if let Some(sid) = server_id {
        body["template_server_id"] = sid.into();
    }
    if let Some(rev) = server_revision {
        body["template_server_revision"] = rev.into();
    }
    if let Some(d) = &data {
        body["data"] = d.clone();
    }
    if let Some(url) = &args.data_url {
        body["data_url"] = url.clone().into();
    }
    if is_test {
        body["test"] = true.into();
    }

    let client = print_client(POST_TIMEOUT_SECS)?;
    let res = client
        .post(format!("{base}/v1/print"))
        .header("Authorization", format!("Bearer {}", pair.secret))
        .header("Idempotency-Key", &key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            AppError::Internal(describe_no_answer_for(
                &pair.name, &pair.host, pair.port, &e,
            ))
        })?;
    let status = res.status();
    let reply: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);

    // The PC's answer, normalised to (terminal status, error, code).
    // Success already ran the whole pipeline, so no poll is needed;
    // a duplicate replays an earlier key, so poll that job instead.
    let (final_status, error, code, pc_job_id): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = if status.is_success() && reply.get("status").and_then(|s| s.as_str()) != Some("duplicate")
    {
        (
            reply
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("success")
                .to_string(),
            None,
            None,
            reply
                .get("job_id")
                .and_then(|j| j.as_str())
                .map(str::to_string),
        )
    } else if status.is_success() {
        let job_id = reply
            .get("job_id")
            .and_then(|j| j.as_str())
            .unwrap_or("")
            .to_string();
        let client2 = print_client(POLL_TIMEOUT_SECS + 10)?;
        match poll_job(&client2, &base, &pair.secret, &job_id).await {
            Ok((st, err)) => (st, err, None, Some(job_id)),
            Err(e) => {
                let msg = e.to_string();
                record_remote_job(
                    db.lock()
                        .map_err(|_| AppError::Internal("DB lock poisoned".into()))?
                        .connection(),
                    args.template_id,
                    server_revision,
                    copies,
                    &args.printer_name,
                    &pair.name,
                    &data,
                    &key,
                    is_test,
                    "failed",
                    Some(&msg),
                    started.elapsed().as_millis() as i64,
                )?;
                return Err(e);
            }
        }
    } else if status == reqwest::StatusCode::CONFLICT {
        // A version refusal is an answered print, not an error: the
        // dialog offers Sync from `code`, like the local pipeline's
        // `Ok(success: false)` shape.
        let code = reply
            .get("code")
            .and_then(|c| c.as_str())
            .unwrap_or("template_stale")
            .to_string();
        let msg = reply
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("The PC's template does not match. Sync templates, then retry.")
            .to_string();
        record_remote_job(
            db.lock()
                .map_err(|_| AppError::Internal("DB lock poisoned".into()))?
                .connection(),
            args.template_id,
            server_revision,
            copies,
            &args.printer_name,
            &pair.name,
            &data,
            &key,
            is_test,
            "failed",
            Some(&msg),
            started.elapsed().as_millis() as i64,
        )?;
        return Ok(RemotePrintResult {
            success: false,
            status: "failed".into(),
            pc_job_id: None,
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(msg),
            code: Some(code),
            pc_name: pair.name.clone(),
        });
    } else if status == reqwest::StatusCode::INTERNAL_SERVER_ERROR {
        // The pipeline ran and failed (offline printer, …): an
        // outcome, like the local `Ok(success: false)` shape.
        let msg = reply
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("The PC failed to print.")
            .to_string();
        record_remote_job(
            db.lock()
                .map_err(|_| AppError::Internal("DB lock poisoned".into()))?
                .connection(),
            args.template_id,
            server_revision,
            copies,
            &args.printer_name,
            &pair.name,
            &data,
            &key,
            is_test,
            "failed",
            Some(&msg),
            started.elapsed().as_millis() as i64,
        )?;
        return Ok(RemotePrintResult {
            success: false,
            status: "failed".into(),
            pc_job_id: None,
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(msg),
            code: None,
            pc_name: pair.name.clone(),
        });
    } else {
        let err = refusal(status, &reply);
        let msg = err.to_string();
        // A refused print still leaves a local row: the attempt and
        // the PC's reason.
        record_remote_job(
            db.lock()
                .map_err(|_| AppError::Internal("DB lock poisoned".into()))?
                .connection(),
            args.template_id,
            server_revision,
            copies,
            &args.printer_name,
            &pair.name,
            &data,
            &key,
            is_test,
            "failed",
            Some(&msg),
            started.elapsed().as_millis() as i64,
        )?;
        return Err(err);
    };

    let success = final_status == "success";
    record_remote_job(
        db.lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?
            .connection(),
        args.template_id,
        server_revision,
        copies,
        &args.printer_name,
        &pair.name,
        &data,
        &key,
        is_test,
        &final_status,
        error.as_deref(),
        started.elapsed().as_millis() as i64,
    )?;
    Ok(RemotePrintResult {
        success,
        status: final_status,
        pc_job_id,
        duration_ms: started.elapsed().as_millis() as u64,
        error,
        code,
        pc_name: pair.name.clone(),
    })
}

/// Print one job through the paired PC (phone side, ARCHITECTURE §9).
#[tauri::command(rename_all = "snake_case")]
pub async fn remote_print(
    db: State<'_, DbState>,
    args: RemotePrintArgs,
) -> AppResult<RemotePrintResult> {
    remote_print_inner(db.inner(), args).await
}

/// The paired PC's printers, for the print dialog. Live when the PC
/// answers, else the last good list with `cached: true` so the dialog
/// can still offer something rather than nothing.
#[tauri::command(rename_all = "snake_case")]
pub async fn remote_printers(
    db: State<'_, DbState>,
    pair_id: Option<String>,
    refresh: Option<bool>,
) -> AppResult<RemotePrintersResult> {
    let (pair, cached_raw) = {
        let guard = db
            .lock()
            .map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
        let pairs = load_pairs(guard.connection());
        let stored_default = setting(guard.connection(), "print_via_pc_device");
        let pair = select_pair(&pairs, pair_id.as_deref().or(stored_default.as_deref()))?;
        let cached_raw = setting(guard.connection(), "print_via_pc_printers");
        (pair, cached_raw)
    };

    let cached: Option<(i64, String, Vec<PcPrinterInfo>)> = cached_raw.and_then(|s| {
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        Some((
            v.get("at").and_then(|a| a.as_i64()).unwrap_or(0),
            v.get("pair")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string(),
            serde_json::from_value(v.get("printers").cloned()?).ok()?,
        ))
    });
    let now = chrono::Utc::now().timestamp();
    if refresh != Some(true) {
        if let Some((at, whose, list)) = &cached {
            if whose == &pair.provider_id && now - at < PRINTERS_CACHE_TTL_SECS {
                return Ok(RemotePrintersResult {
                    printers: list.clone(),
                    cached: false,
                });
            }
        }
    }

    let base = pair_base(&pair).map_err(AppError::Validation)?;
    let client = print_client(PRINTERS_TIMEOUT_SECS)?;
    let send = client
        .get(format!("{base}/v1/printers"))
        .header("Authorization", format!("Bearer {}", pair.secret))
        .send()
        .await;
    let mut live: Option<Vec<PcPrinterInfo>> = None;
    let mut unreachable: Option<String> = None;
    match send {
        Ok(res) => match res.error_for_status() {
            Ok(res) => match res.json::<serde_json::Value>().await {
                Ok(v) => {
                    match serde_json::from_value::<Vec<PcPrinterInfo>>(
                        v.get("printers")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    ) {
                        Ok(list) => live = Some(list),
                        Err(e) => {
                            unreachable = Some(format!(
                                "{} sent a printer list this app could not read ({e})",
                                pair.name
                            ));
                        }
                    }
                }
                Err(e) => {
                    unreachable = Some(format!(
                        "{} sent an unreadable printer list: {e}",
                        pair.name
                    ));
                }
            },
            Err(e) if e.status() == Some(reqwest::StatusCode::UNAUTHORIZED) => {
                unreachable = Some(
                    "This phone was removed on the PC, or the PC switched account. Pair again."
                        .into(),
                );
            }
            Err(e) => {
                unreachable = Some(format!("The PC refused the printer list ({e})"));
            }
        },
        Err(e) => {
            unreachable = Some(describe_no_answer_for(
                &pair.name, &pair.host, pair.port, &e,
            ));
        }
    }
    match live {
        Some(printers) => {
            if let Ok(guard) = db.lock() {
                let _ = guard.connection().execute(
                    "INSERT INTO settings (key, value) VALUES ('print_via_pc_printers', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [serde_json::json!({
                        "at": now,
                        "pair": pair.provider_id,
                        "printers": printers,
                    })
                    .to_string()],
                );
            }
            Ok(RemotePrintersResult {
                printers,
                cached: false,
            })
        }
        None => cached
            .filter(|(_, whose, _)| whose == &pair.provider_id)
            .map(|(_, _, list)| RemotePrintersResult {
                printers: list,
                cached: true,
            })
            .ok_or_else(|| {
                AppError::Internal(unreachable.unwrap_or_else(|| "The PC did not answer.".into()))
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(id: &str) -> RenderPair {
        RenderPair {
            id: id.into(),
            name: format!("PC {id}"),
            host: "192.168.1.9".into(),
            port: 17717,
            secret: "s".into(),
            fingerprint: String::new(),
            provider_id: id.into(),
            platform: "linux".into(),
            paired_at: String::new(),
            device_id: "phone".into(),
            replaced_stale: false,
        }
    }

    #[test]
    fn refusals_say_what_to_do_next() {
        let body = |error: &str| serde_json::json!({ "error": error });
        let r = refusal(reqwest::StatusCode::UNAUTHORIZED, &body("x"));
        assert!(r.to_string().contains("Pair again"), "{r}");
        let r = refusal(
            reqwest::StatusCode::FORBIDDEN,
            &body("printing is not allowed"),
        );
        assert!(r.to_string().contains("not allowed"), "{r}");
        let r = refusal(
            reqwest::StatusCode::NOT_FOUND,
            &body("Printer 'X' not found"),
        );
        assert!(r.to_string().contains("Printer 'X' not found"), "{r}");
        let r = refusal(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            &serde_json::json!({}),
        );
        assert!(r.to_string().contains("refused"), "{r}");
    }

    #[test]
    fn reads_the_pc_printer_list_as_the_pc_sends_it() {
        // Exactly what `GET /v1/printers` returns: `type`, plus extra keys.
        let body = serde_json::json!({
            "printers": [
                {"id": 1, "name": "Front desk", "type": "ipp",
                 "address": "192.168.1.20:631", "language": "pdf"}
            ],
            "count": 1
        });
        let list: Vec<PcPrinterInfo> =
            serde_json::from_value(body["printers"].clone()).expect("PC wire format");
        assert_eq!(list[0].name, "Front desk");
        assert_eq!(list[0].printer_type, "ipp");
        // The phone's own cache uses `printer_type` and must still round-trip.
        let cached = serde_json::to_value(&list).unwrap();
        let again: Vec<PcPrinterInfo> = serde_json::from_value(cached).unwrap();
        assert_eq!(again[0].printer_type, "ipp");
    }

    #[test]
    fn pair_choice_never_guesses() {
        assert!(select_pair(&[], None).is_err());
        let two = vec![pair("a"), pair("b")];
        assert!(select_pair(&two, None).is_err(), "two pairs need a choice");
        assert_eq!(select_pair(&two, Some("b")).unwrap().name, "PC b");
        assert!(select_pair(&two, Some("zzz")).is_err());
        let one = vec![pair("a")];
        assert_eq!(select_pair(&one, None).unwrap().name, "PC a");
    }

    #[test]
    fn records_expand_like_the_pipeline() {
        let obj = serde_json::json!({"a": 1});
        assert_eq!(
            expand_records(Some(obj.clone()), 3),
            Some(serde_json::json!([{"a": 1}, {"a": 1}, {"a": 1}]))
        );
        assert_eq!(expand_records(Some(obj.clone()), 1), Some(obj));
        assert_eq!(
            expand_records(None, 2),
            Some(serde_json::json!([{}, {}])),
            "no data still prints blank pages, like the preview"
        );
        let arr = serde_json::json!([1, 2]);
        assert_eq!(
            expand_records(Some(arr.clone()), 9),
            Some(arr),
            "arrays ignore records"
        );
    }
}
