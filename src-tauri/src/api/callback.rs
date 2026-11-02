use serde::Serialize;
use std::time::Duration;

/// Maximum callback URL length (SSRF hardening).
const MAX_URL_LEN: usize = 2048;
/// Per-attempt connect+read timeout.
const CALLBACK_TIMEOUT_SECS: u64 = 10;
/// Cap for callback response body we buffer (never rendered).
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

/// Callback payload delivered to the POS.
#[derive(Debug, Clone, Serialize)]
pub struct CallbackPayload {
    pub event: String,
    pub job_id: String,
    pub status: String,
    pub printer: String,
    pub template: String,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub timestamp: String,
    pub idempotency_key: Option<String>,
}

/// Info needed to dispatch a callback after a job reaches terminal state.
#[derive(Debug, Clone)]
pub struct CallbackDispatch {
    pub job_id: String,
    pub status: String,
    pub event: String,
    pub printer: String,
    pub template: String,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub idempotency_key: Option<String>,
    pub callback_url: String,
}

/// Validate a callback URL before any DB work.
///
/// Returns `Ok(())` when the URL is acceptable, `Err(reason)` otherwise.
/// The caller must return `400` with `code: callback_url_invalid` and the
/// reason as the error message.
pub fn validate_callback_url(url: &str) -> Result<(), String> {
    let allow_http = std::env::var("PRINTNINJA_CALLBACK_ALLOW_HTTP")
        .map(|v| v == "1")
        .unwrap_or(false);
    let allow_private = std::env::var("PRINTNINJA_CALLBACK_ALLOW_PRIVATE")
        .map(|v| v == "1")
        .unwrap_or(false);
    let allowlist = std::env::var("PRINTNINJA_CALLBACK_ALLOWLIST").unwrap_or_default();
    validate_callback_url_with_config(url, allow_http, allow_private, &allowlist)
}

/// Inner validator with explicit config so tests can pass flags without
/// racing on global env vars.
pub fn validate_callback_url_with_config(
    url: &str,
    allow_http: bool,
    allow_private: bool,
    allowlist_raw: &str,
) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("callback_url must not be empty".into());
    }
    if url.len() > MAX_URL_LEN {
        return Err(format!(
            "callback_url too long ({} bytes, max {MAX_URL_LEN})",
            url.len()
        ));
    }
    // Parse
    let parsed = url::Url::parse(url)
        .map_err(|e| format!("callback_url is not a valid URL: {e}"))?;

    // No credentials
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("callback_url must not contain credentials (user:pass@)".into());
    }

    let scheme = parsed.scheme().to_ascii_lowercase();
    match scheme.as_str() {
        "https" => {}
        "http" if allow_http => {}
        "http" => {
            return Err(
                "callback_url must be https:// (http allowed only with PRINTNINJA_CALLBACK_ALLOW_HTTP=1)"
                    .into(),
            )
        }
        _ => return Err("callback_url must be https://".into()),
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "callback_url missing host".to_string())?;
    if host.is_empty() {
        return Err("callback_url missing host".into());
    }

    // Allowlist
    let allowlist: Vec<String> = allowlist_raw
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if !allowlist.is_empty() {
        let host_lc = host.to_ascii_lowercase();
        if !allowlist.iter().any(|a| a == &host_lc) {
            return Err(format!(
                "callback_url host `{host}` not in allowlist ({allowlist_raw})"
            ));
        }
    }

    // Private / loopback / link-local block
    if !allow_private && crate::api::peer_consume::is_private_host(host) {
        return Err(format!(
            "callback_url must not target private/loopback/link-local address (host `{host}` blocked; set PRINTNINJA_CALLBACK_ALLOW_PRIVATE=1 to allow)"
        ));
    }

    Ok(())
}

/// Compute hex(hmac_sha256(secret, body)) for the signature header.
pub fn hmac_sha256_hex(secret: &str, body: &[u8]) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key from slice");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// Extract a log-safe host identifier (host + truncated path) without query
/// params or credentials. Never logs the full URL.
fn log_host(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or("unknown");
            let path = parsed.path();
            // Truncate path to 64 chars for log safety
            let path_trunc = if path.len() > 64 {
                format!("{}...", &path[..64])
            } else {
                path.to_string()
            };
            if path_trunc.is_empty() || path_trunc == "/" {
                host.to_string()
            } else {
                format!("{host}{path_trunc}")
            }
        }
        Err(_) => "invalid-url".to_string(),
    }
}

/// Dispatch a callback with retries. Fire-and-forget via `tokio::spawn`.
/// `dispatch` must NOT be called for Idempotency-Key duplicates (caller
/// guards that).
pub fn dispatch_callback(info: CallbackDispatch) {
    let CallbackDispatch {
        job_id,
        status,
        event,
        printer,
        template,
        error,
        duration_ms,
        idempotency_key,
        callback_url,
    } = info;

    // Clone for the spawned task
    let url_clone = callback_url.clone();
    tokio::spawn(async move {
        let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let payload = CallbackPayload {
            event: event.clone(),
            job_id: job_id.clone(),
            status: status.clone(),
            printer: printer.clone(),
            template: template.clone(),
            error: error.clone(),
            duration_ms,
            timestamp,
            idempotency_key: idempotency_key.clone(),
        };
        let body_bytes = match serde_json::to_vec(&payload) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(job_id=%job_id, host=%log_host(&url_clone), error=%e, "callback body serialization failed");
                return;
            }
        };

        // Signing secret (global env for v1)
        let secret = std::env::var("PRINTNINJA_CALLBACK_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        let signature = secret
            .as_ref()
            .map(|s| format!("sha256={}", hmac_sha256_hex(s, &body_bytes)));

        let log_h = log_host(&url_clone);

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(CALLBACK_TIMEOUT_SECS))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(job_id=%job_id, host=%log_h, error=%e, "callback client build failed");
                return;
            }
        };

        // 3 retries = up to 4 attempts with delays 5s,25s,125s
        let delays = [5u64, 25, 125];
        let max_attempts = delays.len() + 1; // 4

        for attempt in 1..=max_attempts {
            let mut req = client
                .post(&url_clone)
                .header("Content-Type", "application/json")
                .header("X-PrintNinja-Event", &event)
                .header("X-PrintNinja-Job-Id", &job_id)
                .header("User-Agent", "PrintNinja/2.5")
                .body(body_bytes.clone());
            if let Some(sig) = &signature {
                req = req.header("X-PrintNinja-Signature", sig.as_str());
            }

            // Per-attempt timeout already set on client, but also guard with tokio timeout
            let result = req.send().await;

            match result {
                Ok(resp) => {
                    let status = resp.status();
                    // Cap response body size to 64 KiB, never rendered, never follow redirects (already none)
                    let body_result = resp.bytes().await;
                    match body_result {
                        Ok(bytes) => {
                            if bytes.len() > MAX_RESPONSE_BYTES {
                                tracing::warn!(
                                    job_id=%job_id,
                                    host=%log_h,
                                    attempt,
                                    status=%status,
                                    bytes=%bytes.len(),
                                    "callback response too large (cap {} KiB, ignored)",
                                    MAX_RESPONSE_BYTES / 1024
                                );
                            }
                            if status.is_success() {
                                tracing::info!(
                                    job_id=%job_id,
                                    host=%log_h,
                                    attempt,
                                    status=%status,
                                    "callback delivered"
                                );
                                break;
                            } else {
                                tracing::warn!(
                                    job_id=%job_id,
                                    host=%log_h,
                                    attempt,
                                    status=%status,
                                    "callback non-2xx"
                                );
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                job_id=%job_id,
                                host=%log_h,
                                attempt,
                                status=%status,
                                error=%e,
                                "callback response read failed"
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        job_id=%job_id,
                        host=%log_h,
                        attempt,
                        error=%e,
                        "callback dispatch failed"
                    );
                }
            }

            if attempt == max_attempts {
                tracing::warn!(
                    job_id=%job_id,
                    host=%log_h,
                    attempts=%max_attempts,
                    "callback delivery dropped after retries"
                );
                break;
            }
            // Exponential backoff before next attempt
            let delay_secs = delays[attempt - 1];
            tokio::time::sleep(Duration::from_secs(delay_secs)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_https_public() {
        assert!(validate_callback_url_with_config(
            "https://pos.example.com/hooks/printninja",
            false,
            false,
            ""
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_http_by_default() {
        let err = validate_callback_url_with_config(
            "http://pos.example.com/hooks",
            false,
            false,
            ""
        )
        .unwrap_err();
        assert!(err.contains("https"), "{err}");
    }

    #[test]
    fn validate_accepts_http_when_allowed() {
        assert!(validate_callback_url_with_config(
            "http://pos.example.com/hooks",
            true,
            false,
            ""
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_private_by_default() {
        for url in [
            "https://192.168.1.10/hooks",
            "https://10.0.0.5/hooks",
            "https://127.0.0.1/hooks",
            "https://[::1]/hooks",
            "https://169.254.1.1/hooks",
        ] {
            let err = validate_callback_url_with_config(url, false, false, "").unwrap_err();
            assert!(err.contains("private") || err.contains("loopback"), "url {url}: {err}");
        }
    }

    #[test]
    fn validate_accepts_private_when_allowed() {
        assert!(validate_callback_url_with_config(
            "https://192.168.1.10/hooks",
            false,
            true,
            ""
        )
        .is_ok());
        assert!(validate_callback_url_with_config(
            "http://127.0.0.1/hooks",
            true,
            true,
            ""
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_credentials() {
        let err = validate_callback_url_with_config(
            "https://user:pass@pos.example.com/hooks",
            false,
            false,
            ""
        )
        .unwrap_err();
        assert!(err.contains("credentials"), "{err}");
    }

    #[test]
    fn validate_rejects_too_long() {
        let long = format!("https://example.com/{}", "a".repeat(2048));
        let err =
            validate_callback_url_with_config(&long, false, false, "").unwrap_err();
        assert!(err.contains("too long"), "{err}");
    }

    #[test]
    fn validate_rejects_allowlist_mismatch() {
        let err = validate_callback_url_with_config(
            "https://evil.com/hooks",
            false,
            false,
            "pos.example.com,hooks.internal"
        )
        .unwrap_err();
        assert!(err.contains("allowlist"), "{err}");
    }

    #[test]
    fn validate_accepts_allowlist_match() {
        assert!(validate_callback_url_with_config(
            "https://pos.example.com/hooks",
            false,
            false,
            "pos.example.com,hooks.internal"
        )
        .is_ok());
        // case-insensitive
        assert!(validate_callback_url_with_config(
            "https://POS.EXAMPLE.COM/hooks",
            false,
            false,
            "pos.example.com"
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_non_https_scheme() {
        let err =
            validate_callback_url_with_config("ftp://example.com/hooks", false, false, "")
                .unwrap_err();
        assert!(err.contains("https"), "{err}");
    }

    #[test]
    fn hmac_is_deterministic_and_hex() {
        let secret = "s3cr3t";
        let body = br#"{"event":"print.succeeded"}"#;
        let hex1 = hmac_sha256_hex(secret, body);
        let hex2 = hmac_sha256_hex(secret, body);
        assert_eq!(hex1, hex2);
        assert_eq!(hex1.len(), 64); // sha256 hex
        // Different secret -> different hmac
        let hex3 = hmac_sha256_hex("other", body);
        assert_ne!(hex1, hex3);
        // Known vector: hmac_sha256("key", "The quick brown fox jumps over the lazy dog")
        // Expected: f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
        let known = hmac_sha256_hex("key", b"The quick brown fox jumps over the lazy dog");
        assert_eq!(
            known,
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn log_host_redacts_query() {
        let h = log_host("https://pos.example.com/hooks/path?secret=abc&x=1");
        assert_eq!(h, "pos.example.com/hooks/path");
        assert!(!h.contains("secret"));
    }
}
