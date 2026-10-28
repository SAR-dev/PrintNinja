//! The consumer half of shared rendering (device A).
//!
//! While `render_share` serves peer renders, this module *buys* them: it
//! reads the paired providers and the auto/local policy from settings,
//! probes each candidate's `/v1/capabilities`, sends the finished HTML to
//! the best one, and returns `None` on any failure so the caller renders
//! locally. Sharing can only speed a print up, never fail it.
//!
//! The trust root is the pairing secret the operator typed from device
//! B's screen (see docs/PEER_RENDERING.md). Hosts are restricted to
//! LAN names and private addresses, so a pasted secret cannot turn the
//! command into a proxy for the public internet.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::time::timeout;

use super::render_share::{Capabilities, PeerRenderResponse};

/// How long one capabilities probe may take. Probed concurrently, so
/// three dead providers cost one timeout, not three.
///
/// Windows needs one second more: see [`PEER_CONNECT_TIMEOUT_MS`]. The
/// probe limit must stay above the connect limit or the outer timer wins
/// and a refusal is reported as a silent PC.
#[cfg(not(windows))]
pub const PEER_CAPS_TIMEOUT_SECS: u64 = 3;
#[cfg(windows)]
pub const PEER_CAPS_TIMEOUT_SECS: u64 = 4;
/// How long opening the TCP connection may take. A PC that is off, or a
/// phone on mobile data, must cost a print about a second, not eight:
/// on a LAN a live host answers in milliseconds.
///
/// A Windows client does not give up on the first RST: it retransmits the
/// SYN and only reports "connection refused" after about two seconds. A
/// 1.5 s limit would cut that short and turn "PrintNinja is not sharing
/// there" into "blocked or unreachable", so Windows gets 2.5 s. Phones
/// (Android) and Linux report a refusal immediately and keep 1.5 s.
#[cfg(not(windows))]
pub const PEER_CONNECT_TIMEOUT_MS: u64 = 1500;
#[cfg(windows)]
pub const PEER_CONNECT_TIMEOUT_MS: u64 = 2500;
/// Upper bound for one peer render attempt. A label or receipt renders in
/// seconds; if the provider is wedged the phone should be printing locally
/// well before the provider's own 180s limit.
pub const PEER_RENDER_TIMEOUT_SECS: u64 = 30;

/// How long a successful probe stays trusted. Repeated prints skip the
/// handshake while the provider is known-good; a disabled or changed
/// peer is re-probed at most a minute later.
pub(crate) const CAPS_TTL_SECS: u64 = 60;

/// How long a failed probe (or a failed render) keeps the provider
/// skipped. Without this every print would re-pay the connect timeout
/// while the PC is off, making printing slower than not pairing at all.
pub(crate) const FAIL_TTL_SECS: u64 = 30;

/// How many times a busy provider is asked again before giving up. A 429
/// means "I am printing my own job" — a moment later it is usually free.
/// Only the required path (no local fallback) retries; best-effort prints
/// fall back locally instead of waiting.
pub const PEER_BUSY_RETRIES: u32 = 3;
/// Wait between busy retries when the provider names no delay.
pub const PEER_BUSY_WAIT_SECS: u64 = 5;
/// Upper bound for one busy wait: a provider naming an hour still only
/// costs half a minute per retry.
pub const PEER_BUSY_WAIT_MAX_SECS: u64 = 30;

static CAPS_CACHE: LazyLock<Mutex<HashMap<String, (Instant, Capabilities)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static FAIL_CACHE: LazyLock<Mutex<HashMap<String, (Instant, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Cache key: address plus a hash of the secret, so rotating the secret
/// re-probes instead of trusting a stale acceptance.
fn caps_key(pair: &RenderPair) -> String {
    use sha2::Digest as _;
    let fp = format!(
        "{:x}",
        sha2::Sha256::digest(format!("{}:{}:{}", pair.host, pair.port, pair.secret))
    );
    format!("{}:{}:{}", pair.host, pair.port, &fp[..16])
}

/// Arguments for a one-off peer render: who to call plus the finished
/// document. The pipeline uses stored pairs instead; this shape exists
/// so a future caller can prove the round-trip end to end.
#[derive(Debug, Clone, Deserialize)]
pub struct PeerRenderArgs {
    pub host: String,
    pub port: u16,
    pub secret: String,
    pub html: String,
    pub paper_w_mm: f64,
    pub paper_h_mm: f64,
    pub orientation: String,
    pub language: String,
    pub dpi: u32,
}

/// One paired provider, as stored in the `render_pairs` setting (JSON
/// array, managed from Settings → Devices).
///
/// `secret` holds the per-device token minted by `POST /v1/pair/claim`
/// (the name is kept so nothing else changes). The newer fields are
/// optional with `#[serde(default)]`, so pairs stored by older versions
/// still load — they just fail auth until re-paired (plan §10).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderPair {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub secret: String,
    #[serde(default)]
    pub fingerprint: String,
    /// The PC's stable id: re-pairing the same PC replaces the old entry.
    #[serde(default)]
    pub provider_id: String,
    /// The PC's platform (`windows`, `linux`, …).
    #[serde(default)]
    pub platform: String,
    /// RFC-3339 timestamp of the claim.
    #[serde(default)]
    pub paired_at: String,
    /// This phone's id, as the PC has it in `paired_devices.id`.
    #[serde(default)]
    pub device_id: String,
}

/// The finished document the pipeline hands to a peer: stage 1–3 output.
/// No template, no data, no printer — the peer never sees anything but
/// the pixels to produce.
#[derive(Debug, Clone)]
pub struct PeerRenderJob {
    pub html: String,
    pub paper_w_mm: f64,
    pub paper_h_mm: f64,
    pub orientation: String,
    pub language: String,
    pub dpi: u32,
}

/// A successful offload: the bytes to send, who rendered them (for the
/// print log and the History badge), and how long the peer took.
#[derive(Debug, Clone)]
pub struct PeerOutcome {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub peer_name: String,
    pub render_ms: u64,
}

/// Read the consumer config: pairs plus the auto policy. `None` means
/// local rendering: policy off, or nothing paired.
///
/// Android has no local renderer, so it always uses its paired PCs and the
/// stored `render_policy` is ignored there (older versions let people turn
/// it off, which could only make every print fail).
pub fn load_consumer_config(conn: &rusqlite::Connection) -> Option<Vec<RenderPair>> {
    load_consumer_config_for(conn, cfg!(target_os = "android"))
}

/// `load_consumer_config` with the platform passed in, so the Android
/// rule can be tested on any host.
fn load_consumer_config_for(
    conn: &rusqlite::Connection,
    is_android: bool,
) -> Option<Vec<RenderPair>> {
    let policy: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'render_policy'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "local".into());
    if policy != "auto" && !is_android {
        return None;
    }
    let raw: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'render_pairs'",
            [],
            |r| r.get(0),
        )
        .ok()?;
    let pairs: Vec<RenderPair> = serde_json::from_str(&raw).ok()?;
    if pairs.is_empty() {
        return None;
    }
    Some(pairs)
}

/// Wire name for a printer language, matching what the provider's
/// `/v1/render` accepts. The pipeline stores display names; the peer
/// protocol uses these canonical tokens.
pub fn language_name(lang: &crate::transport::PrinterLanguage) -> &'static str {
    match lang {
        crate::transport::PrinterLanguage::Pdf => "pdf",
        crate::transport::PrinterLanguage::Escpos => "escpos",
        crate::transport::PrinterLanguage::Tspl => "tspl",
        crate::transport::PrinterLanguage::Zpl => "zpl",
        crate::transport::PrinterLanguage::Cpcl => "cpcl",
        crate::transport::PrinterLanguage::Raster => "raster",
    }
}

/// Largest total of inlined font bytes per document. Uploaded label
/// fonts are tens of kilobytes; anything past this is a mistake. Base64
/// inflates by a third, so 5MB of fonts (≈6.7MB) plus the document still
/// fits under the provider's 10MB HTML cap instead of being refused
/// after a slow upload.
pub const MAX_INLINE_FONTS_BYTES: usize = 5 * 1024 * 1024;

/// In-memory `@font-face` CSS per lowercased family, with the
/// fingerprint it was built from. Reading and re-encoding up to ~7MB of
/// font files on every peer print is pure overhead: fonts change only
/// through upload/delete, which change the rows, so the fingerprint
/// invalidates the entry with no call-site bookkeeping. One entry,
/// bounded by the byte budget above. Only fully successful builds are
/// stored; a degraded build (unreadable file) recomputes every time,
/// exactly like the uncached code.
/// Cached build: the fingerprint plus per-family CSS.
type FontFaceCache = Option<(u64, HashMap<String, String>)>;

static FONT_FACE_CACHE: LazyLock<Mutex<FontFaceCache>> = LazyLock::new(|| Mutex::new(None));

/// Fingerprint of everything one build depends on: the directory and
/// every row. Uploads store under fresh UUID filenames plus an INSERT
/// and deletes remove the row, so content changes always change the
/// rows — file mtimes need no tracking, and a build is never served
/// stale. (A file appearing out-of-band with identical rows would be
/// missed until the rows change; the fonts dir is app-managed, so that
/// cannot happen through the app.)
fn font_cache_fingerprint(
    fonts_dir: &std::path::Path,
    rows: &[(String, String, String, String, String)],
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    fonts_dir.to_string_lossy().hash(&mut hasher);
    for (family, style, weight, file_path, format) in rows {
        family.hash(&mut hasher);
        style.hash(&mut hasher);
        weight.hash(&mut hasher);
        file_path.hash(&mut hasher);
        format.hash(&mut hasher);
    }
    hasher.finish()
}

/// Per-family `@font-face` CSS, from memory when nothing changed.
/// Pure build: unreadable or oversize files are skipped with a warning,
/// never fatal — exactly like the uncached path it replaces.
fn family_face_css(
    fonts_dir: &std::path::Path,
    rows: &[(String, String, String, String, String)],
) -> HashMap<String, String> {
    let fingerprint = font_cache_fingerprint(fonts_dir, rows);
    if let Ok(cache) = FONT_FACE_CACHE.lock() {
        if let Some((old, map)) = cache.as_ref() {
            if *old == fingerprint {
                return map.clone();
            }
        }
    }
    let mut map: HashMap<String, String> = HashMap::new();
    let mut total = 0usize;
    // Only a fully successful build is stored: an unreadable file may
    // reappear, and then the degraded path recomputes exactly like the
    // uncached code always did.
    let mut complete = true;
    for (family, style, weight, file_path, format) in rows {
        if family.trim().is_empty() {
            continue;
        }
        let mime = match format.to_ascii_lowercase().as_str() {
            "woff2" => ("font/woff2", "woff2"),
            "woff" => ("font/woff", "woff"),
            "ttf" => ("font/ttf", "truetype"),
            "otf" => ("font/otf", "opentype"),
            _ => continue,
        };
        let path = crate::commands::font::resolve_font_path(fonts_dir, file_path);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(family = %family, error = %e, "peer font unreadable; skipping");
                complete = false;
                continue;
            }
        };
        if total + bytes.len() > MAX_INLINE_FONTS_BYTES {
            tracing::warn!(family = %family, "peer font budget spent; skipping");
            continue;
        }
        total += bytes.len();
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        map.insert(
            family.to_lowercase(),
            format!(
                "@font-face{{font-family:\"{family}\";font-style:{style};font-weight:{weight};\
                 src:url(data:{mime};base64,{b64}) format(\"{hint}\");}}",
                family = family.replace('"', ""),
                mime = mime.0,
                hint = mime.1,
            ),
        );
    }
    if complete {
        if let Ok(mut cache) = FONT_FACE_CACHE.lock() {
            *cache = Some((fingerprint, map.clone()));
        }
    }
    map
}

/// Inline uploaded fonts as `@font-face` data URIs so a peer renders
/// what the template means. A provider may lack this device's fonts
/// entirely (different OS, nothing installed) — without inlining it
/// would silently substitute and reflow the label. Only families named
/// in the document are embedded; unreadable or oversize files are
/// skipped with a warning, never fatal. Peer-only: the local path
/// keeps resolving fonts exactly as before.
pub fn inline_fonts(conn: &rusqlite::Connection, html: &str) -> String {
    let Some(fonts_dir) = crate::commands::font::fonts_dir_from_settings(conn) else {
        return html.into();
    };
    let mut stmt = match conn.prepare(
        "SELECT family, style, weight, file_path, format FROM fonts
          WHERE sync_state <> 'deleted_pending'",
    ) {
        Ok(s) => s,
        Err(_) => return html.into(),
    };
    let rows: Vec<(String, String, String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    if rows.is_empty() {
        return html.into();
    }
    let faces = family_face_css(&fonts_dir, &rows);
    if faces.is_empty() {
        return html.into();
    }
    let haystack = html.to_lowercase();
    let mut css = String::new();
    for (family, face) in &faces {
        if family.trim().is_empty() || !haystack.contains(family.as_str()) {
            continue;
        }
        css.push_str(face);
    }
    if css.is_empty() {
        return html.into();
    }
    let style_tag = format!("<style>{css}</style>");
    if let Some(at) = html.find("<head>") {
        let at = at + "<head>".len();
        format!("{}{style_tag}{}", &html[..at], &html[at..])
    } else {
        format!("{style_tag}{html}")
    }
}

/// LAN-only guard for the host the operator paired. Accepts private,
/// loopback, and link-local IPs plus `.local` / single-label LAN names;
/// anything else (public IPs, weird characters) is refused before any
/// socket opens.
pub(crate) fn is_private_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => {
                v6.is_unique_local() || v6.is_loopback() || v6.is_unicast_link_local()
            }
        };
    }
    host == "localhost" || host.ends_with(".local") || !host.contains('.')
}

/// Base URL for a pair, validated. HTTP only: the provider serves the
/// same cleartext API as the local server.
fn pair_base(pair: &RenderPair) -> Result<String, String> {
    let host = pair.host.trim().trim_matches(|c| c == '[' || c == ']');
    if host.is_empty() || host.len() > 253 {
        return Err("empty pairing host".into());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
    {
        return Err(format!("bad characters in pairing host `{host}`"));
    }
    if !is_private_host(host) {
        return Err(format!(
            "pairing host `{host}` is not a LAN address (private IP or .local name required)"
        ));
    }
    if pair.port == 0 {
        return Err("pairing port must be 1–65535".into());
    }
    Ok(format!("http://{host}:{port}", port = pair.port))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(PEER_CONNECT_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("http client failed: {e}"))
}

/// Why a request to the PC never got an answer. The three cases need
/// different advice, so the message must not collapse them into one
/// bare timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoAnswer {
    /// The PC answered "nothing listens here": it is awake and reachable,
    /// but PrintNinja is closed or LAN sharing is off.
    Refused,
    /// No reply at all (timeout, no route). A powered-off or sleeping PC,
    /// another Wi-Fi network and a firewall that silently drops the port
    /// look identical from the phone.
    Silent,
    /// Anything else (DNS, TLS, protocol): keep the raw detail.
    Other,
}

/// Sort a transport failure by walking its source chain: reqwest wraps
/// the OS error, and only the inner `io::ErrorKind` tells "refused" apart
/// from "nobody home".
pub(crate) fn classify_transport(e: &reqwest::Error) -> NoAnswer {
    use std::error::Error as _;
    use std::io::ErrorKind;
    if e.is_timeout() {
        return NoAnswer::Silent;
    }
    let mut cur: Option<&(dyn std::error::Error + 'static)> = e.source();
    while let Some(err) = cur {
        if let Some(io) = err.downcast_ref::<std::io::Error>() {
            match io.kind() {
                ErrorKind::ConnectionRefused => return NoAnswer::Refused,
                ErrorKind::TimedOut
                | ErrorKind::HostUnreachable
                | ErrorKind::NetworkUnreachable => return NoAnswer::Silent,
                _ => {}
            }
        }
        cur = err.source();
    }
    NoAnswer::Other
}

/// Classify a transport failure for a host the operator typed in (the
/// pairing-code manual-address path), where there is no stored pair name
/// yet. `display` names the target in the message.
pub(crate) fn describe_no_answer_for(
    display: &str,
    host: &str,
    port: u16,
    e: &reqwest::Error,
) -> String {
    let name = if display.is_empty() {
        format!("{host}:{port}")
    } else {
        display.to_string()
    };
    describe_no_answer(&name, port, classify_transport(e), &e.to_string())
}

/// The one-line reason shown in Settings → Devices and in a failed job.
/// Pure, so the wording is unit-tested without a network.
///
/// "blocked or unreachable" is deliberate: a Windows PC whose firewall
/// has not allowed PrintNinja yet drops the connection exactly like a PC
/// that is switched off, and the person needs to be told both are
/// possible. Keep the leading `{name} is blocked or unreachable` and
/// `{name} refused the connection` text in sync with `src/lib/errors.ts`.
pub(crate) fn describe_no_answer(name: &str, port: u16, kind: NoAnswer, detail: &str) -> String {
    match kind {
        NoAnswer::Refused => format!(
            "{name} refused the connection on port {port}: the PC is reachable but PrintNinja is not sharing there. Open PrintNinja on it and turn on Wi-Fi access."
        ),
        NoAnswer::Silent => format!(
            "{name} is blocked or unreachable (no answer on port {port}). Check that the PC is on and awake, on the same Wi-Fi, and that its firewall allows PrintNinja."
        ),
        NoAnswer::Other => format!("{name} unreachable: {detail}"),
    }
}

/// Probe one candidate. `Err` covers unreachable, too slow, wrong
/// protocol, and render-incapable — the caller treats them all as
/// "not this peer". Successes are cached for [`CAPS_TTL_SECS`] and
/// failures for [`FAIL_TTL_SECS`], so a PC that is off costs one short
/// timeout per half minute rather than one per print.
pub(crate) async fn probe(pair: &RenderPair) -> Result<(RenderPair, Capabilities), String> {
    probe_inner(pair, true).await
}

/// Probe skipping the failure memory: the required path (thermal jobs
/// with no local fallback) always asks instead of trusting a stale skip
/// — the attempt is cheap and its error is the accurate one. Successes
/// still use and refresh the capabilities cache, and failures are still
/// recorded for everyone else's benefit.
async fn probe_inner(
    pair: &RenderPair,
    use_fail_memory: bool,
) -> Result<(RenderPair, Capabilities), String> {
    let key = caps_key(pair);
    if let Ok(cache) = CAPS_CACHE.lock() {
        if let Some((at, caps)) = cache.get(&key) {
            if at.elapsed() < Duration::from_secs(CAPS_TTL_SECS) {
                return Ok((pair.clone(), caps.clone()));
            }
        }
    }
    if use_fail_memory {
        if let Ok(cache) = FAIL_CACHE.lock() {
            if let Some((at, msg)) = cache.get(&key) {
                if at.elapsed() < Duration::from_secs(FAIL_TTL_SECS) {
                    return Err(msg.clone());
                }
            }
        }
    }
    match probe_network(pair).await {
        Ok(caps) => {
            if let Ok(mut cache) = CAPS_CACHE.lock() {
                cache.insert(key.clone(), (Instant::now(), caps.clone()));
            }
            if let Ok(mut cache) = FAIL_CACHE.lock() {
                cache.remove(&key);
            }
            Ok((pair.clone(), caps))
        }
        Err(msg) => {
            note_failure(pair, &msg);
            Err(msg)
        }
    }
}

/// Probe ignoring both caches: the Settings "Test" button must show the
/// provider's state right now, not a verdict from 20 seconds ago.
pub async fn probe_fresh(pair: &RenderPair) -> Result<(RenderPair, Capabilities), String> {
    forget_cached(pair);
    probe(pair).await
}

/// Drop any remembered verdict for this provider.
pub fn forget_cached(pair: &RenderPair) {
    let key = caps_key(pair);
    if let Ok(mut cache) = CAPS_CACHE.lock() {
        cache.remove(&key);
    }
    if let Ok(mut cache) = FAIL_CACHE.lock() {
        cache.remove(&key);
    }
}

/// Remember that this provider just failed: skip it for [`FAIL_TTL_SECS`].
pub(crate) fn note_failure(pair: &RenderPair, msg: &str) {
    let key = caps_key(pair);
    if let Ok(mut cache) = CAPS_CACHE.lock() {
        cache.remove(&key);
    }
    if let Ok(mut cache) = FAIL_CACHE.lock() {
        cache.insert(key, (Instant::now(), msg.to_string()));
    }
}

async fn probe_network(pair: &RenderPair) -> Result<Capabilities, String> {
    let base = pair_base(pair)?;
    let res = timeout(
        Duration::from_secs(PEER_CAPS_TIMEOUT_SECS),
        client()?
            .get(format!("{base}/v1/capabilities"))
            .header("authorization", format!("Bearer {}", pair.secret))
            .send(),
    )
    .await
    .map_err(|_| describe_no_answer(&pair.name, pair.port, NoAnswer::Silent, "probe timeout"))?;
    let res = res.map_err(|e| {
        describe_no_answer(
            &pair.name,
            pair.port,
            classify_transport(&e),
            &e.to_string(),
        )
    })?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        // The per-device token is unknown: the PC removed this phone
        // (or the pair predates pairing codes). Pair again. Keep the
        // leading "{name} removed this phone" text in sync with
        // `src/lib/errors.ts`.
        return Err(format!("{} removed this phone. Pair again.", pair.name));
    }
    if res.status() == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("{} has sharing disabled", pair.name));
    }
    if !res.status().is_success() {
        return Err(format!("{} answered {}", pair.name, res.status()));
    }
    let caps: Capabilities = res
        .json()
        .await
        .map_err(|e| format!("{} sent bad capabilities: {e}", pair.name))?;
    if caps.protocol != super::render_share::PROTOCOL_VERSION {
        return Err(format!("{} speaks protocol {}", pair.name, caps.protocol));
    }
    if !caps.can_render {
        return Err(format!("{} cannot render on its platform", pair.name));
    }
    Ok(caps)
}

/// Best reachable provider: same-platform first (a desktop Chromium
/// and an Android WebView can lay out subtly differently), then highest
/// score.
pub fn pick_best(
    mut candidates: Vec<(RenderPair, Capabilities)>,
) -> Option<(RenderPair, Capabilities)> {
    candidates.sort_by(|a, b| {
        let here = std::env::consts::OS;
        let a_same = a.1.platform == here;
        let b_same = b.1.platform == here;
        b_same.cmp(&a_same).then_with(|| b.1.score.cmp(&a.1.score))
    });
    candidates.into_iter().next()
}

/// Probe every pair concurrently and split the answers into reachable
/// candidates and failure messages. Shared by both render paths — and by
/// the print pipeline, which starts this before the template stage so
/// probing overlaps local work instead of following it (see
/// `run_stages`). Failures are returned, not just logged, because the
/// required path names every reason in its error.
pub async fn probe_candidates(
    pairs: &[RenderPair],
    use_fail_memory: bool,
) -> (Vec<(RenderPair, Capabilities)>, Vec<String>) {
    let mut probes = tokio::task::JoinSet::new();
    for pair in pairs {
        let owned = pair.clone();
        probes.spawn(async move { probe_inner(&owned, use_fail_memory).await });
    }
    let mut candidates: Vec<(RenderPair, Capabilities)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    while let Some(done) = probes.join_next().await {
        match done {
            Ok(Ok(found)) => candidates.push(found),
            Ok(Err(e)) => errors.push(e),
            Err(e) => errors.push(format!("probe panicked: {e}")),
        }
    }
    (candidates, errors)
}

/// Buy the render from the best candidate, `None` on any failure: the
/// caller renders locally.
pub async fn render_best(
    candidates: Vec<(RenderPair, Capabilities)>,
    job: &PeerRenderJob,
) -> Option<PeerOutcome> {
    let (pair, _) = pick_best(candidates)?;
    render_on(&pair, job).await
}

/// Buy the render from the best candidate, failing loudly instead of
/// falling back. Busy providers are retried with backoff; a stale skip
/// is never consulted because the candidates were probed fresh.
pub async fn render_best_required(
    candidates: Vec<(RenderPair, Capabilities)>,
    probe_errors: Vec<String>,
    job: &PeerRenderJob,
) -> Result<PeerOutcome, String> {
    let Some((pair, _)) = pick_best(candidates) else {
        return Err(format!(
            "no paired PC answered this {} job: {} (or pair another PC in Settings → Devices)",
            job.language,
            probe_errors.join("; ")
        ));
    };
    render_attempt(&pair, job, PEER_BUSY_RETRIES).await
}

/// Pick the best reachable provider and buy one render. Same-platform
/// peers first (a desktop Chromium and an Android WebView can lay out
/// subtly differently), then highest score. Any failure — no candidates,
/// peer error, timeout — is `None`: the caller renders locally.
pub async fn try_peer_render(pairs: &[RenderPair], job: &PeerRenderJob) -> Option<PeerOutcome> {
    if pairs.is_empty() {
        return None;
    }
    let (candidates, errors) = probe_candidates(pairs, true).await;
    for e in &errors {
        tracing::debug!("peer probe skipped: {e}");
    }
    render_best(candidates, job).await
}

/// Buy the render from a paired provider, failing loudly instead of
/// falling back. For jobs this device cannot render itself (thermal
/// languages on a platform without a rasterizer) there is no local
/// fallback to take, so a quiet `None` would only surface later as a
/// confusing local render error.
///
/// Differences from [`try_peer_render`]: the failure memory is not
/// consulted (a stale skip would fail the job without ever asking — the
/// attempt itself is cheap and its error is the accurate one), and a
/// busy provider (429) is retried with backoff instead of abandoned.
pub async fn try_peer_render_required(
    pairs: &[RenderPair],
    job: &PeerRenderJob,
) -> Result<PeerOutcome, String> {
    if pairs.is_empty() {
        return Err(format!(
            "no paired PC can render this {} job (pair one in Settings → Devices)",
            job.language
        ));
    }
    let (candidates, probe_errors) = probe_candidates(pairs, false).await;
    render_best_required(candidates, probe_errors, job).await
}

/// Buy one render from an already-chosen provider. `None` on any
/// failure: the caller renders locally.
pub async fn render_on(pair: &RenderPair, job: &PeerRenderJob) -> Option<PeerOutcome> {
    // Best-effort never waits out a busy provider: the local fallback is
    // right there, and retrying would only delay it.
    render_attempt(pair, job, 0).await.ok()
}

/// One render attempt, with up to `busy_retries` extra tries when the
/// provider answers 429 (busy printing its own job). `Err` carries the
/// reason: unreachable, timed out, refused, or still busy.
async fn render_attempt(
    pair: &RenderPair,
    job: &PeerRenderJob,
    busy_retries: u32,
) -> Result<PeerOutcome, String> {
    let base = pair_base(pair).map_err(|e| format!("{}: {e}", pair.name))?;
    let body = serde_json::json!({
        "protocol": super::render_share::PROTOCOL_VERSION,
        "html": job.html,
        "paper_w_mm": job.paper_w_mm,
        "paper_h_mm": job.paper_h_mm,
        "orientation": job.orientation,
        "language": job.language,
        "dpi": job.dpi,
    });
    let started = std::time::Instant::now();
    let res = timeout(
        Duration::from_secs(PEER_RENDER_TIMEOUT_SECS),
        client()
            .map_err(|e| format!("{} unreachable: {e}", pair.name))?
            .post(format!("{base}/v1/render"))
            .header("authorization", format!("Bearer {}", pair.secret))
            .json(&body)
            .send(),
    )
    .await;
    let res = match res {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            tracing::warn!(peer = %pair.name, "peer render transport failed: {e}");
            let msg = describe_no_answer(
                &pair.name,
                pair.port,
                classify_transport(&e),
                &e.to_string(),
            );
            note_failure(pair, &msg);
            return Err(msg);
        }
        Err(_) => {
            tracing::warn!(peer = %pair.name, "peer render timed out; rendering locally");
            note_failure(pair, &format!("{} timed out", pair.name));
            return Err(format!(
                "{} timed out after {}s",
                pair.name, PEER_RENDER_TIMEOUT_SECS
            ));
        }
    };
    if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS && busy_retries > 0 {
        let wait = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(PEER_BUSY_WAIT_SECS)
            .min(PEER_BUSY_WAIT_MAX_SECS);
        tracing::info!(
            peer = %pair.name,
            wait_secs = wait,
            retries_left = busy_retries,
            "peer is busy; retrying the render"
        );
        tokio::time::sleep(Duration::from_secs(wait)).await;
        return Box::pin(render_attempt(pair, job, busy_retries - 1)).await;
    }
    if !res.status().is_success() {
        tracing::warn!(peer = %pair.name, status = %res.status(), "peer render refused; rendering locally");
        // A 5xx means the provider itself is unwell, so skip it for a
        // while. 429 (busy), 413 and 422 describe this job, not the
        // provider, and the next print may well succeed.
        if res.status().is_server_error() {
            note_failure(pair, &format!("{} answered {}", pair.name, res.status()));
        }
        let detail = match res.status() {
            s if s == reqwest::StatusCode::UNAUTHORIZED => {
                format!("{} removed this phone. Pair again.", pair.name)
            }
            s if s == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                format!("{} is busy printing its own job", pair.name)
            }
            s if s == reqwest::StatusCode::PAYLOAD_TOO_LARGE => {
                format!("{} refused the document as too large", pair.name)
            }
            s if s == reqwest::StatusCode::UNPROCESSABLE_ENTITY => {
                format!("{} could not render it", pair.name)
            }
            s => format!("{} answered {s}", pair.name),
        };
        return Err(detail);
    }
    let out: PeerRenderResponse = res
        .json()
        .await
        .map_err(|e| format!("{} sent an unreadable render: {e}", pair.name))?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&out.bytes_b64)
        .map_err(|e| format!("{} sent undecodable bytes: {e}", pair.name))?;
    tracing::info!(
        peer = %pair.name,
        render_ms = out.render_ms,
        waited_ms = started.elapsed().as_millis() as u64,
        "peer render succeeded"
    );
    Ok(PeerOutcome {
        bytes,
        mime: out.mime,
        peer_name: pair.name.clone(),
        render_ms: out.render_ms,
    })
}

#[cfg(test)]
mod peer_consume_tests {
    use super::*;

    /// The font-face cache is process-global and single-entry: tests
    /// that assert hit/miss behavior hold this while they run, so a
    /// parallel test thread cannot evict the entry mid-sequence. (A miss
    /// in production is only ever slower, never wrong — the build
    /// recomputes from disk.)
    static FONT_CACHE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_silent_pc_is_described_as_blocked_or_unreachable() {
        let msg = describe_no_answer("Studio PC", 17717, NoAnswer::Silent, "probe timeout");
        assert!(
            msg.starts_with("Studio PC is blocked or unreachable"),
            "{msg}"
        );
        assert!(msg.contains("17717"), "{msg}");
        assert!(msg.contains("firewall"), "{msg}");
        assert!(msg.contains("awake"), "{msg}");
        assert!(!msg.contains("probe timeout"), "no raw jargon: {msg}");
    }

    #[test]
    fn a_refused_connection_says_the_pc_is_up_but_not_sharing() {
        let msg = describe_no_answer("Studio PC", 17717, NoAnswer::Refused, "connection refused");
        assert!(msg.starts_with("Studio PC refused the connection"), "{msg}");
        assert!(msg.contains("not sharing"), "{msg}");
        assert!(
            !msg.contains("firewall"),
            "refused is not a firewall drop: {msg}"
        );
    }

    #[test]
    fn an_unclassified_failure_keeps_its_detail() {
        let msg = describe_no_answer("Studio PC", 17717, NoAnswer::Other, "dns error");
        assert_eq!(msg, "Studio PC unreachable: dns error");
    }

    fn pair(host: &str) -> RenderPair {
        RenderPair {
            id: "p1".into(),
            name: "B".into(),
            host: host.into(),
            port: 17717,
            secret: "s".into(),
            fingerprint: String::new(),
            provider_id: String::new(),
            platform: String::new(),
            paired_at: String::new(),
            device_id: String::new(),
        }
    }

    #[test]
    fn accepts_lan_hosts_and_rejects_the_public_internet() {
        for ok in [
            "192.168.1.4",
            "10.0.0.9",
            "172.16.0.2",
            "127.0.0.1",
            "::1",
            "[::1]",
            "169.254.9.9",
            "printninja.local",
            "desktop-pc",
            "localhost",
        ] {
            assert!(pair_base(&pair(ok)).is_ok(), "{ok} should be pairable");
        }
        for bad in [
            "8.8.8.8",
            "1.1.1.1",
            "example.com",
            "evil.com:8080:x",
            "host name",
            "",
        ] {
            assert!(pair_base(&pair(bad)).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn empty_pair_list_never_touches_the_network() {
        // try_peer_render with no pairs returns without spawning probes.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let out = rt.block_on(try_peer_render(
            &[],
            &PeerRenderJob {
                html: "x".into(),
                paper_w_mm: 100.0,
                paper_h_mm: 150.0,
                orientation: "portrait".into(),
                language: "pdf".into(),
                dpi: 203,
            },
        ));
        assert!(out.is_none());
    }

    #[test]
    fn inline_fonts_embeds_only_families_the_document_names() {
        let _cache = FONT_CACHE_TEST_LOCK.lock().unwrap();
        let conn = rusqlite::Connection::open_in_memory().expect("mem db");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE fonts (family TEXT, style TEXT, weight TEXT,
                 file_path TEXT, format TEXT, sync_state TEXT DEFAULT 'synced');",
        )
        .expect("tables");
        let dir = std::env::temp_dir().join(format!("pn-fonts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("fonts dir");
        std::fs::write(dir.join("custom_a.ttf"), b"FAKEFONTBYTES").expect("font file");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('fonts_dir', ?1)",
            [dir.to_str().expect("utf8").to_string()],
        )
        .expect("fonts_dir row");
        for (family, file) in [("Custom", "custom_a.ttf"), ("Unused", "missing.ttf")] {
            conn.execute(
                "INSERT INTO fonts (family, style, weight, file_path, format, sync_state)
                 VALUES (?1, 'normal', '400', ?2, 'ttf', 'synced')",
                [family, file],
            )
            .expect("font row");
        }

        let html = "<html><head></head><body style=\"font-family: Custom, serif\">hi</body></html>";
        let out = inline_fonts(&conn, html);
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"FAKEFONTBYTES");
        assert!(out.contains("@font-face"), "faces embedded");
        assert!(out.contains(&b64), "font bytes inlined");
        assert!(!out.contains("Unused"), "unnamed families skipped");

        // A document naming no uploaded family passes through untouched.
        let plain = "<html><head></head><body>hi</body></html>";
        assert_eq!(inline_fonts(&conn, plain), plain);

        // Unknown formats are skipped, never guessed.
        conn.execute(
            "UPDATE fonts SET format = 'eot' WHERE family = 'Custom'",
            [],
        )
        .expect("reformat");
        assert!(!inline_fonts(&conn, html).contains("@font-face"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inline_fonts_without_a_fonts_dir_is_a_passthrough() {
        let conn = rusqlite::Connection::open_in_memory().expect("mem db");
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);")
            .expect("settings");
        let html = "<html><body>hi</body></html>";
        assert_eq!(inline_fonts(&conn, html), html);
    }

    fn font_db(dir: &std::path::Path, rows: &[(&str, &str)]) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("mem db");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE fonts (family TEXT, style TEXT, weight TEXT,
                 file_path TEXT, format TEXT, sync_state TEXT DEFAULT 'synced');",
        )
        .expect("tables");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('fonts_dir', ?1)",
            [dir.to_str().expect("utf8").to_string()],
        )
        .expect("fonts_dir row");
        for (family, file) in rows {
            conn.execute(
                "INSERT INTO fonts (family, style, weight, file_path, format, sync_state)
                 VALUES (?1, 'normal', '400', ?2, 'ttf', 'synced')",
                [family, file],
            )
            .expect("font row");
        }
        conn
    }

    #[test]
    fn inline_fonts_serves_families_from_memory_after_files_vanish() {
        let _cache = FONT_CACHE_TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("pn-fontcache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("fonts dir");
        std::fs::write(dir.join("cached_a.ttf"), b"FAKEFONTBYTES").expect("font file");
        let conn = font_db(&dir, &[("Cached", "cached_a.ttf")]);
        let html = "<html><head></head><body style=\"font-family: Cached\">hi</body></html>";
        let first = inline_fonts(&conn, html);
        assert!(first.contains("@font-face"), "first call embeds");

        // The file is gone, but nothing about the rows changed: the
        // second call must serve the same CSS from memory, not fail.
        std::fs::remove_file(dir.join("cached_a.ttf")).expect("remove font");
        let second = inline_fonts(&conn, html);
        assert_eq!(second, first, "cache hit must be byte-identical");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inline_fonts_rebuilds_when_the_rows_change() {
        let _cache = FONT_CACHE_TEST_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("pn-fontcache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("fonts dir");
        std::fs::write(dir.join("a.ttf"), b"FONT_A").expect("font file");
        std::fs::write(dir.join("b.ttf"), b"FONT_B").expect("font file");
        let conn = font_db(&dir, &[("Alpha", "a.ttf")]);
        let html = "<html><head></head><body style=\"font-family: Alpha, Beta\">hi</body></html>";
        let before = inline_fonts(&conn, html);
        assert!(before.contains("font-family:\"Alpha\""));
        assert!(!before.contains("font-family:\"Beta\""));

        conn.execute(
            "INSERT INTO fonts (family, style, weight, file_path, format, sync_state)
             VALUES ('Beta', 'normal', '400', 'b.ttf', 'ttf', 'synced')",
            [],
        )
        .expect("add row");
        let after = inline_fonts(&conn, html);
        assert!(after.contains("font-family:\"Alpha\""));
        assert!(
            after.contains("font-family:\"Beta\""),
            "new row must invalidate the cache"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    const ONE_PAIR: &str = r#"[{"id":"a","name":"B","host":"192.168.1.9","port":17717,"secret":"s","fingerprint":"f"}]"#;
    fn settings_db(policy: Option<&str>, pairs: Option<&str>) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);")
            .expect("settings");
        for (key, value) in [("render_policy", policy), ("render_pairs", pairs)] {
            if let Some(value) = value {
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                    rusqlite::params![key, value],
                )
                .expect("insert setting");
            }
        }
        conn
    }

    #[test]
    fn off_android_a_local_policy_keeps_rendering_local() {
        for policy in [Some("local"), Some("off"), None] {
            let conn = settings_db(policy, Some(ONE_PAIR));
            assert!(
                load_consumer_config_for(&conn, false).is_none(),
                "policy {policy:?} must render locally off Android"
            );
        }
    }

    #[test]
    fn off_android_the_auto_policy_uses_the_pairs() {
        let conn = settings_db(Some("auto"), Some(ONE_PAIR));
        let pairs = load_consumer_config_for(&conn, false).expect("paired");
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].name, "B");
    }

    #[test]
    fn on_android_the_stored_policy_is_ignored() {
        for policy in [Some("local"), Some("off"), Some("auto"), None] {
            let conn = settings_db(policy, Some(ONE_PAIR));
            let pairs = load_consumer_config_for(&conn, true)
                .unwrap_or_else(|| panic!("policy {policy:?} must not disable pairs on Android"));
            assert_eq!(pairs.len(), 1);
            assert_eq!(pairs[0].name, "B");
        }
    }

    #[test]
    fn on_android_nothing_paired_or_broken_pairs_is_still_none() {
        for pairs in [None, Some("not json"), Some("[]")] {
            let conn = settings_db(Some("local"), pairs);
            assert!(
                load_consumer_config_for(&conn, true).is_none(),
                "pairs {pairs:?} give no peers, so Android has nothing to use"
            );
        }
    }
}
