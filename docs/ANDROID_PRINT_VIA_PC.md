# Android "Print via PC" and Paired-Only LAN Access

Branch reviewed: `develop` at `ef161c6` (v0.12.1)
Status: **Final, decisions confirmed** (section 8)
Method: code reading only (app, plugin and `server/`), nothing built or run. All earlier open checks are now verified.

**Scope rule (decided): no backfill.** This is a development-phase project and the database can be reset, so nothing in this plan migrates, converts or repairs existing data. New columns go straight into the schema.

---

## 1. Goals

1. A device on the LAN that is **not paired** must not be able to use the PC's API to print, or to read printers, templates or jobs.
2. **Paired** devices keep LAN access, using their own per-device token.
3. New feature: an Android setting, "Print via PC". When on, the phone does not print itself. It only sends a request to the PC's shared API, and the PC prints.
4. Only devices signed in to the **same account** can pair, and a template that is missing or out of date on the PC is reported, never printed wrongly.

---

## 2. What exists today

| Area | State |
|---|---|
| Pairing | 8-character one-time code, 30 s window, 5 wrong guesses close it. Claiming mints a per-device token. The PC stores only its hash in `paired_devices` (`pair_code.rs`, `pair_routes.rs`). |
| Revocation | Removing a phone on the PC deletes its row, and its token is refused from the next request. |
| Peer render routes | `/v1/render` and `/v1/capabilities` sit behind `require_peer_auth` (Bearer token checked against `paired_devices`, plus the sharing switch). |
| **Main routes** | `/v1/print`, `/v1/printers`, `/v1/templates`, `/v1/jobs*`, `/v1/metrics*`, `/v1/openapi.json` have **no authentication** (`routes.rs`). |
| LAN switch | `api_lan_access` binds the server to `0.0.0.0` and sets CORS to allow any origin. |
| Phone side | Phone is always paired to a PC for rendering, but sends the bytes to its own printers and writes its own history. |

**The gap behind your first requirement:** with LAN access on, any device on the network can call `POST /v1/print` with no credentials. Pairing protects only the render routes.

---

## 3. Design

### 3.1 Authenticate every LAN request (security fix, independent of the new feature)

- Add one middleware, `require_paired_or_local`, over the whole router.
  - Loopback callers (the PC's own UI and local scripts) pass through unchanged.
  - Any other caller must send `Authorization: Bearer <pairing token>`, checked against `paired_devices` with the same hash lookup `require_peer_auth` already uses. Move that lookup into a shared function.
  - Exempt only what must be reachable before pairing: `/v1/pair/hello` and `/v1/pair/claim`, which have their own guards.
- Update `last_seen_at` on each authenticated request.
- Make the middleware read the peer address. The server already starts with `into_make_service_with_connect_info::<SocketAddr>()` (`commands/api.rs`), and `pair_routes.rs` already reads `ConnectInfo<SocketAddr>` with a private-address check, so no server startup change is needed. Reuse that helper.
- Remove `allow_origin(Any)` for LAN mode. Paired phones call from native code, not a browser, so it is not needed, and it lets any web page on the LAN probe the API.
- Rate-limit failed token attempts per source address.

**Behaviour change to announce (decided):** non-paired LAN clients lose access completely. There is no API key. Scripts that need the API run on the PC itself (loopback). Put this in the release notes for Release A.

### 3.2 One switch for the PC

Today there are two overlapping switches: LAN access and render sharing. Make "Share with paired devices" the single concept:

- On: bind to LAN, accept paired tokens, serve render and print routes.
- Off: loopback only, and all paired tokens are refused.
- Keep the raw port and bind controls under an "Advanced" fold. Remove the `api_lan_access` / `0.0.0.0` wording from the main view.

### 3.3 Optional permission per paired device

Add a `can_print` column on `paired_devices`, default **true** (decided), added straight to the schema (no migration of old rows, see the scope rule in section 8). The PC owner can switch it off per phone to allow rendering only. The toggle is small and included in Release B.

### 3.4 PC: print endpoint for paired devices

Reuse `POST /v1/print` rather than adding a second one. It already takes `template`, `printer`, `data` or `data_url`, `settings` (copies and similar), an `Idempotency-Key` header, and returns a job id that `GET /v1/jobs/{id}` reports on.

Needed changes:
- Record the paired device on the job (`requested_by_device_id`), so the PC's history shows "printed for <phone name>".
- Return the job state so the phone can show the real outcome (printed, failed, with the message).
- Limits on a remote job: max `data` size, max copies, and the existing per-printer queue. A phone cannot flood a printer past the queue.

**Template rule (decided):** `/v1/print` resolves the template by **name in the PC's own database** and has no inline-HTML body. Both devices always have the same templates (synced), so `/v1/print` is reused, with the version check in 3.7 added so a stale or renamed template is caught instead of printing the wrong thing.

### 3.5 Android: the "Print via PC" flag

- New setting `print_via_pc` (boolean, default off), stored with the other settings. Only shown on Android, and only enabled when at least one PC is paired.
- Choice of PC when more than one is paired (`print_via_pc_device`).
- When on, the print entry point on the phone does **not** call the local pipeline or any local transport (USB, Bluetooth, network). It calls a new `remote_print` command that:
  1. Builds the request (template name, data, printer name on the PC, settings, copies).
  2. Sends `POST /v1/print` with the pairing token and a generated `Idempotency-Key`.
  3. Polls `GET /v1/jobs/{id}` until printed, failed or timed out.
  4. Writes a history row marked "printed by <PC name>".
- **No fallback, no override (decided).** If the PC is unreachable or the token is rejected, the job fails with a clear message ("PC not reachable" or "this phone was removed on the PC"). The phone never prints locally while the flag is on. To print locally the user turns the flag off.
- Retries reuse the same idempotency key, so a timeout never prints twice.
- The printer list in the print dialog comes from `GET /v1/printers` on the PC (cached, with a refresh), not from the phone's own printers.
- Reuse the host safety rules already in `peer_consume.rs` (private addresses only, short connect timeout), so the token cannot be sent to a public host.

### 3.6 Same-account pairing (extra layer)

Pairing succeeds only when the phone and the PC are signed in to the **same account on the same server**. This sits on top of the 8-character code and the per-device token, and does not replace either.

**The stable account id exists on the server (verified in `server/`).**
- `model User` in `server/prisma/schema.prisma` has `id String @id @default(uuid())`. The handle can be typed with any case, and `handleKey` is the lowercase unique key, so the handle is not a good identity. The `id` is.
- The server returns the id in `POST /v2/auth/register`, `POST /v2/auth/login` (`user: { id, handle, created_at }`) and `GET /v2/auth/me`.
- A deleted user is tombstoned, and a re-registered handle gets a **new** id, so the id correctly separates "same handle, different person".

**The client does not keep it yet.** The desktop and phone app store only `share_service_url` and `share_session_token` in `settings`, and the session check returns just the `handle`. So the id must be saved:
- At login and register, write `share_user_id` (and the server URL it belongs to) to `settings`, alongside the token.
- Clear it on sign-out, and on a 401 that removes the token.

**The check (local, works offline once the id is stored):**
- At claim time (`/v1/pair/claim`) the phone sends `{ account_id, service_url }`. The PC compares both with its own stored values and refuses on a mismatch ("this phone is signed in to a different account").
- The service URL is compared too, because the same UUID cannot appear on two servers, but two self-hosted servers are still different "accounts" for sync purposes.
- Store `account_id` on the `paired_devices` row, show it in the devices list, and re-check it on later requests if the PC's own account changes.
- Sign-in is required on both devices (decided). If either is signed out, show "sign in first" instead of a generic failure. There is no guest pairing.
- **No backfill (decided).** The project is in development, so the database is reset. Old pairings and old sessions are not migrated or repaired, and no code is written for them. A device that has no stored account id (signed in before this change) simply signs in again.
- If a device signs out or switches account later, existing pairings are disabled and must be redone.
- The account id is an identifier, not a secret. It never replaces the pairing token. The PC must not trust an id sent by a client that has not also presented the token or a valid one-time code.

### 3.7 Template version check

The mismatch problem comes from templates being matched by **name** on a PC whose copy may be older, renamed or missing. The data needed to do better already exists on both sides.

**Already available (verified):**
- Server: `Template.revision` goes up by 1 on every content change, and the API already uses it as the ETag (`"<revision>"`) on single-template reads.
- Each device's local `templates` table stores `server_id`, `server_revision`, `base_revision` and `sync_state`, from the sync work. Local integer ids differ per device, but `server_id` is the same everywhere. `server_id` is the current identity (verified in `db/mod.rs`): it is unique and never null, a migration copies the legacy `remote_id` into it, and templates created locally get a fresh UUID there. `remote_id` is legacy and must not be used.

**Flow:**
- The phone sends, with each print, the template's `server_id` and `server_revision`, as well as the name.
- The PC finds its copy by `server_id`. Do not fall back to the name, since every template has a `server_id` and a name match could pick a different template. It compares revisions and replies:
  - match: print as normal;
  - not found: `409 template_missing`;
  - revisions differ: `409 template_stale`, with both revisions in the reply. The PC also refuses when its own copy has unsynced local edits (`sync_state` not synced), since it would print content the server and the phone do not have.
- The phone shows the reason and a **Sync templates** action, then lets the user retry. It never prints a stale template silently.
- A template never synced to the server (`server_revision` empty, `sync_state` `dirty`) has a `server_id` but the PC will not have it, so it returns `template_missing`. The phone then says "sync this template first".
- Store the revision on the PC job record, so history shows exactly which revision printed.
- No server change is needed for this part.

---

## 4. UI changes

### PC (desktop)

| Screen | Change |
|---|---|
| Settings → API server panel (`ApiServerPanel.tsx`) | Replace the "LAN access" switch and its warning with "Share with paired devices". Move port and bind into an Advanced section. Warning text changes to: only paired devices can connect. |
| Devices card (`DevicesCard.tsx`) | Per phone: last seen, account (same-account badge), a "Can print" toggle, rename and remove (already exist). |
| Pairing | Code flow unchanged. Add: an error "phone is signed in to a different account" and a "sign in first" state. Show a short note that a paired phone can print here. |
| History / jobs | Show a "from <phone name>" label on remote jobs. |
| First enable | One-time confirm dialog: "Paired phones will be able to print on this PC's printers." |

### Android

| Screen | Change |
|---|---|
| Settings | New "Print via PC" switch with a short explanation, and a PC picker when several are paired. Disabled with a hint when no PC is paired. |
| Print dialog | When on: banner "Printing on <PC name>", printer list from the PC, local printers hidden. |
| Pairing screen (`PairingGate.tsx`) | Show the signed-in account, and a clear message when the PC is on a different account. |
| Job result | Statuses for "sent to PC", "printing", "printed", "PC unreachable", "removed by PC", "template missing", "template out of date". The last two show a **Sync templates** button. |
| Status banner (`PcStatusBanner.tsx`) | Reuse it to show PC reachability while the flag is on. |
| Strings | New keys in the locale files, in English and Japanese, since your docs are bilingual. The locale files are `src/lib/i18n/locales/en.ts` and `ja.ts`. |

---

## 5. Security checklist

- Token on every non-loopback request; hashed at rest (already so).
- Failed-token rate limit and generic error text.
- Revocation takes effect on the next request (already so; keep a test).
- No CORS wildcard.
- Remote print uses the same private-address-only rule.
- Per-job size and copies limits.
- Idempotency to avoid duplicate prints.
- Audit: record which device sent each job.
- Same-account check at claim time, with the account id stored per paired device.
- Template version check, so a stale template is refused instead of printed.

---

## 6. Testing

- Rust unit tests: middleware allows loopback and valid token, rejects missing, wrong, removed and public-looking sources.
- API tests: every route, authenticated and not, with LAN mode on and off.
- Existing e2e tests that call the API over LAN (`printSubmit`, `printPath`, `printIsolation`, `twoPc`) need a token or loopback. Update them.
- New e2e using `virtual-printer`: pair a phone, turn "Print via PC" on, print, check that the PC printer receives the job and the phone sends nothing to its own printers.
- Negative e2e: unpaired client gets 401 on `/v1/print`; removed phone gets 401 on its next request.
- Pairing: same account succeeds; different account is refused; signed-out device is refused with the "sign in first" message; works with the network off.
- Templates: matching revision prints; missing returns `template_missing`; a different revision returns `template_stale`; a PC copy with unsynced edits is refused; a renamed template is still found by `server_id`; a never-synced template returns `template_missing`.
- Account id: saved at login and register, cleared on sign-out and on 401.
- Android: unit tests for the flag routing (no local transport call when on) and for retry with the same idempotency key. A manual test on a real device is needed, since the plugin code cannot be run here.

---

## 7. Size of the work

| Part | Estimate |
|---|---|
| 3.1 Auth middleware, connect-info, rate limit, CORS, update existing tests | 2 days |
| 3.2 / 3.3 Single switch, `can_print` column, settings wiring | 1 day |
| 3.4 PC print endpoint changes, device on job, limits | 1 day |
| 3.5 Android `remote_print` command, flag routing, polling, history | 2.5 days |
| 3.6 Same-account pairing: store the user id at login, claim check, UI messages | 1 day |
| 3.7 Template version check: send `server_id` + `server_revision`, `409` replies, sync prompt on the phone (revision already stored locally) | 1 day |
| UI work, PC and Android, with i18n | 2 days |
| Tests (Rust, e2e, Android) and device testing | 2 days |
| Docs (`ARCHITECTURE.md`, `ENV.md`, release notes) | 0.5 day |
| **Total** | **about 12.5 days for one developer (roughly 2.5 weeks with review)** |

**Size: medium to large.** The risky part is not the new feature. It is closing the unauthenticated routes, which changes behaviour for anything calling the API over LAN today.

### Suggested release order
1. **Release A (about 3 days):** 3.1 and 3.2 alone. This closes the security gap fast and does not depend on the Android work.
2. **Release B (about 8 days):** 3.3 to 3.5 and the UI.
3. **Release C (about 3 days):** 3.6 same-account pairing and 3.7 template version check. Because there is no backfill, the order of A, B and C does not affect existing data. These can move into Release B if you prefer fewer releases.

---

## 8. Decisions

| Question | Decision | Effect |
|---|---|---|
| Can a phone print a template the PC lacks? | No, both always have it | Reuse `/v1/print`; add the version check (3.7); clear error if missing |
| Can a newly paired phone print by default? | Yes | `can_print` defaults to true; per-phone toggle to turn off |
| Non-paired LAN automation clients | Access dropped | No API key feature; release note for Release A |
| PC off while flag is on | Fail with a clear message | No local fallback or override |
| Same-account pairing | Yes, as an extra layer | Server `User.id` (UUID) plus service URL, saved on each device at login, checked locally at claim time, works offline |
| Old data (pairings, sessions, templates) | No backfill or migration support | Development phase: reset the database; schema changes go straight into the schema |
| Sign-in | Required on both devices | No guest pairing; "sign in first" message |
| Which PC printers a phone may use | All of them | No per-printer sharing switch in this scope |
| Release plan | Three releases, A, B, C | A closes the open routes first |
| Fixing template mismatches | Version check, not the account | Match by `server_id` plus `server_revision`; `409` with a Sync prompt |

Total estimate is **about 12.5 developer days**, with none of the optional extra work (second render route, API keys) included. The earlier unknown is resolved: the server has a stable account id, and the only extra work is saving it on the device.
