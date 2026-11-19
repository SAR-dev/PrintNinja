# Print Flow Security Review

End-to-end review of the printing pipeline for vulnerabilities. The flow spans three
layers, all of which were examined:

1. **Frontend (React)** — `src/pages/print/*`, `src/lib/store/printStore.ts`,
   `src/lib/printViaPc.ts`, `src/lib/render/printLayout.ts` — orchestration and preview.
2. **Rust core (Tauri)** — `src-tauri/src/commands/print.rs` (the pipeline),
   `src-tauri/src/api/*` (the paired-device REST API, auth and pairing),
   `src-tauri/src/render/*` (template engine + headless-browser rendering),
   `src-tauri/src/transport/*` (IPP / raw TCP / USB / Bluetooth / CUPS / spooler send).
3. **Server (Node)** — `server/src/domain/templates/*` (template validation at publish).

The codebase is unusually well-hardened: every intake path funnels through one
shared validation rulebook (`validate_orientation_and_fit`, `validate_margins`,
`check_copies`, `validate_pdf_input`, `MAX_RECORDS` / `MAX_COPIES` / `MAX_PDF_BYTES`),
the REST API runs the *same* pipeline as the desktop UI, the `data_url` fetch has a
DNS-resolving SSRF guard, the paired-device API uses per-device SHA-256 token hashes
with per-address throttling, and rendered HTML is sanitized (scripts, event handlers,
`javascript:` URLs and remote fetches stripped) before it reaches the browser.

The findings below are the *residual* gaps — places where the boundary is incomplete
or where a check is weaker than the code around it.

---

## Findings

### 1. `callback_url` SSRF guard is string-based and DNS-rebinding-bypassable — Medium

**Location:** `src-tauri/src/api/callback.rs:118` → `src-tauri/src/api/peer_consume.rs:418` (`is_private_host`)

`POST /v1/print` accepts a `callback_url`. After the job reaches a terminal state the
PC POSTs a JSON payload to it (`callback.rs:dispatch_callback`). The URL is validated
up front by `validate_callback_url`, which blocks private hosts via:

```rust
if !allow_private && crate::api::peer_consume::is_private_host(host) { ... }
```

`is_private_host` does **no DNS resolution**. It only:

- parses IP literals and rejects private / loopback / link-local ones, and
- for names, returns `true` for `localhost`, `*.local`, or a single-label name.

A hostname such as `127.0.0.1.nip.io`, `169.254.169.254.sslip.io`, or any attacker
domain whose A/AAAA record points at a private or link-local address resolves to
`false` from `is_private_host` (it contains dots and is not `.local`), so it passes
validation. The actual `reqwest::post` in `dispatch_callback` then resolves the name
again at connect time — a classic TOCTOU — and reaches the internal target.

Contrast this with the `data_url` fetch guard (`src-tauri/src/data/fetcher.rs:137`),
which *does* resolve the host and rejects every address that is private / loopback /
link-local / carrier-grade NAT / multicast.

**Impact:** A paired device (or any loopback caller) can make the PC issue a POST to
internal services or the cloud metadata endpoint (`169.254.169.254`). The callback body
is a fixed JSON envelope (no request reflection), so this is blind POST SSRF rather than
full request forgery, but it still reaches anything listening on an internal HTTP
endpoint that tolerates a JSON POST.

**Recommendation:** Reuse the same resolution-and-check-all-addresses logic as
`DataFetcher::validate_url` in `validate_callback_url`, and pin the validated address
for the connection (or re-validate immediately before dispatch). As an additional
control, perform the outbound POST through a client that resolves and connects using
the validated address rather than re-resolving the name.

---

### 2. Template CSS is not re-sanitized at print time — Low (defense-in-depth)

**Location:** `src-tauri/src/commands/print.rs` (`apply_layout` → `design_document`),
`src-tauri/src/render/handlebars.rs`

The template engine sanitizes *rendered HTML* on every print:

```rust
// handlebars.rs:27
pub fn render(&self, template: &str, data: &serde_json::Value) -> Result<String> {
    let out = self.hb.render_template(template, data)...?;
    Ok(sanitize_html(&out)) // strips <script>, on* handlers, javascript:, remote src/href/url()/@import
}
```

But the template's **CSS** is a separate stream. In `apply_layout` / `design_document`
the stored `css` column is injected verbatim into a `<style>` block — the only
transformation is `strip_at_page`, which removes `@page` rules:

```rust
// print.rs:376
fn design_document(page_html: &str, css: &str) -> String {
    let styles = strip_at_page(css);   // no sanitize_html / scrub_css_urls / strip_remote_fetches
    ...
}
```

The CSS therefore relies entirely on **save-time** validation
(`find_remote_refs` in `commands/template.rs:154` and the server's equivalent in
`server/src/domain/templates/shared.ts`). Anything that bypasses or predates that
validation reaches the network during the headless-Chromium render:

- a template downloaded from the server that predates the server-side check,
- a hand-edited or legacy row,
- a save-time-check bypass (`find_remote_refs` is a substring scan, not a parser).

A malicious CSS payload (`@import url(http://169.254.169.254/…)`,
`background: url(https://attacker/…)`, `@font-face { src: url(…) }`) triggers fetches
from the PC's network position, and CSS can be used for data exfiltration
(`url()`-based side channels). `@font-face` and `url()` in user CSS are **not** run
through `scrub_css_urls`, which is only applied to `style` attributes and `<style>`
blocks that appear in the (already-sanitized) HTML.

**Impact:** Defense-in-depth gap. No path to script execution (modern Chromium does not
run `javascript:` from CSS `url()`), but remote fetches / SSRF / exfiltration are
possible if a stored template's CSS carries a remote reference.

**Recommendation:** Apply `scrub_css_urls` (and drop remote `@import`) to the template
CSS at print time — i.e., sanitize the `css` argument in `apply_layout`/`design_document`
the same way the HTML is sanitized — so the print path does not depend on a save-time
check that can be bypassed or predated.

---

### 3. Printer credentials and pairing tokens stored and exposed in plaintext — Low

**Location:** `src-tauri/src/commands/printer.rs` (`list_printers`, `get_printer`,
`add_printer`, `update_printer`), `src-tauri/src/api/peer_consume.rs:141` (`RenderPair`),
`src-tauri/src/commands/remote_print.rs` (`load_pairs`)

- `printers.password` (IPP sign-in password) is stored **plaintext** in SQLite and is
  returned in full by the Tauri commands `list_printers` / `get_printer` /
  `add_printer` / `update_printer`. It is serialized on the `Printer` struct, so the
  frontend holds it in plaintext in memory. (The REST `GET /v1/printers` correctly
  omits it — only `id/name/type/address/language`.)
- The paired-device Bearer tokens are stored in the `render_pairs` setting as a
  plaintext JSON array (`RenderPair.secret`), and `load_pairs` reads them back
  unencrypted.

**Impact:** No OS keychain / DPAPI / libsecret is used. Any process with read access to
the app's SQLite file — or any XSS / compromised renderer in the frontend — can read
printer passwords and the per-device pairing tokens (the tokens grant paired access to
the PC's REST API). Combined with the `skip_tls_verification` per-printer setting
(`danger_accept_invalid_certs`), an intercepted IPP connection would also leak the
plaintext credentials.

**Recommendation:** Store secrets with the platform keychain (Windows Credential
Manager / DPAPI, macOS Keychain, `libsecret`), keep them out of the `Printer` DTO
returned to the frontend (return a "credential set" flag instead), and consider
encrypting the `render_pairs` token material at rest.

---

### 4. Idempotency key is global, not scoped to the caller — Low / Info

**Location:** `src-tauri/src/commands/print.rs:2221` (`begin_job`),
`src-tauri/src/api/routes.rs:794` (`print_job` duplicate branch)

`print_jobs.idempotency_key` carries a unique index and is the atomic replay guard
(P12). On collision, `begin_job` returns `DuplicateJob(existing_id)`, and the API
handler answers `200` with that existing `job_id`:

```rust
Err(crate::error::AppError::DuplicateJob(id)) => Ok((
    StatusCode::OK,
    Json(json!({ "status": "duplicate", "job_id": id.to_string(), ... })),
)),
```

There is no check that the caller owns the key. Keys are minted as UUIDv4, so practical
guessing is out of reach, but two weaknesses remain:

- A key is **not scoped** to device/account. If two paired devices (or a device and a
  local script) reuse the same key, the loser's job is silently reported `duplicate`
  and does not print.
- A caller who can observe or guess a key learns the associated `job_id`, which then
  answers `GET /v1/jobs/{id}` (status, error, printer, template, settings — not the
  rendered HTML or data payload).

**Impact:** Low. Job suppression via key collision and minor cross-tenant information
disclosure, both requiring an already-authenticated caller.

**Recommendation:** Namespace the idempotency key by the authenticated device/account
(e.g., a composite unique index on `(requested_by_device_id, idempotency_key)`), and
only return the existing `job_id` when the same caller re-sends its own key.

---

### 5. Pairing-code entropy and claim lockout — Info

**Location:** `src-tauri/src/api/pair_code.rs`, `src-tauri/src/api/pair_routes.rs`

- Owner pairing codes are 8 characters from a 32-symbol alphabet (`32^8 ≈ 2^40`).
  This is small, but the practical exposure is limited by `MAX_WRONG_GUESSES = 5`:
  the window locks after five wrong guesses, and the window is single-use with a 90 s
  default TTL.
- The lockout is the weak point: an on-LAN attacker can burn the five guesses to lock
  the window (denial of the pairing operation), forcing the PC operator to open a new
  window. It is a nuisance DoS, not a takeover.
- `device_id` in `POST /v1/pair/claim` is fully client-supplied and used as the
  `paired_devices` primary key (`ON CONFLICT(id) DO UPDATE`). A device that claims with
  a valid code/invite can overwrite another device's row for the same `device_id`
  (identity squatting), and the value is later stamped on job history as
  `requested_by_device_id`.

**Impact:** Informational. No unauthenticated pairing; the code remains the credential.
The lockout DoS and client-chosen device identity are worth noting for future hardening.

**Recommendation:** Generate or validate `device_id` server-side (or bind it to the
per-device token), and rate-limit the claim endpoint per source address (the failure
counter in `render_share.rs` currently guards the main/peer gates, not the pairing
routes).

---

### 6. `data_url` fetch: DNS rebinding acknowledged (documented) — Info

**Location:** `src-tauri/src/data/fetcher.rs:130` (comment), `validate_url`

The `data_url` guard is the strongest in the codebase: it resolves the host and checks
*every* returned address against loopback / private / link-local / CGNAT / multicast,
and it re-runs the check on every redirect hop. The one gap is documented inline:
reqwest re-resolves the name when it connects, so a DNS answer that changes between the
check and the connect (DNS rebinding) is not pinned. This is a real but narrow residual
risk, and it is explicitly out of scope in the code's own notes.

**Recommendation:** Resolve once, then connect to the validated address directly (pin
the IP for the connection, as the comment suggests).

---

## Existing controls worth keeping

For completeness, the following are already in place and were *not* flagged:

- **Single pipeline for all entry points** — `run_print`/`run_print_with` is shared by
  the Tauri command and `POST /v1/print`, so no path skips the per-printer queue permit,
  render, or history write.
- **Uniform intake validation** — orientation, fit, margins, copies, records, page range,
  PDF size, and single-content-source are all rejected (not silently clamped) on intake,
  before a job row exists.
- **Per-device token auth** — the PC stores only `sha256(token)`; loopback callers are
  exempt by design; non-loopback callers get generic 401s and per-address 429 throttling.
- **Idempotency guard** — the unique index on `idempotency_key` makes the INSERT the
  atomic reservation, so a replayed request does not print twice.
- **Secret redaction in history** — `data` fields named like `token`/`password`/`secret`
  are collected and redacted from the persisted `rendered_html`.
- **Rendered-HTML sanitization** — scripts, `on*` handlers, `javascript:` URLs, remote
  `src`/`srcset`/`href`/`url()`/`@import`, `<base href>` and refresh metas are stripped
  before the browser renders.
- **Bounded resource usage** — `MAX_RECORDS`, `MAX_COPIES`, `MAX_PDF_BYTES`,
  `MAX_HTML_BYTES`, and per-render concurrency semaphores cap document, payload, and CPU
  consumption.
- **`--no-sandbox` is a last resort** — Chromium runs sandboxed by default and only
  retries unsandboxed once, loudly, when running as root without a usable sandbox.
