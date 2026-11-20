# Encrypting printer credentials and pairing secrets (design, not yet implemented)

Status: **deferred — design ready, no code.** The last open item of the
print-flow security/correctness follow-up: plaintext printer credentials /
pairing tokens in SQLite. Everything below is the intended shape for a later
implementation pass; it is not a record of working code.

## What is stored in plaintext today

Two stores, both inside the app's SQLite / settings JSON, neither encrypted:

1. **`printers.password`** — `src/db/schema.sql` (`password TEXT`, the column
   next to `username`). Written by the add/update printer commands
   (`src/commands/printer.rs`; blank credentials are stored as `NULL`), read
   back into the public `Printer` DTO (`Printer.password: Option<String>`),
   and **returned to the frontend by `list_printers` / `get_printer`**. At
   print and test time it flows `StoredPrinter` →
   `transport::TransportSettings.password` → `transport/ipp.rs::auth_header`
   (`Authorization: Basic …`). Anyone who can read the DB file (or the webview
   devtools / frontend state) has every printer's HTTP credential.
2. **`render_pairs`** — the phone-side settings key holding the JSON array of
   `RenderPair` rows (`src/commands/api.rs`, persisted after each
   `pair_with_code`; consumed by `src/api/peer_consume.rs` and the via-PC
   print path). Each row carries the raw per-device **Bearer `secret`** that
   authorizes printing to that PC. It sits in the phone's settings JSON in
   the clear.

Out of scope: `paired_devices.token_hash` / `pairing_invites.code_hash` are
already SHA-256 hashes (`src/api/pair_code.rs::token_hash`), and the pairing
code itself never lands in a DB.

No keychain or crypto infrastructure exists yet: no `keyring` crate in
`src-tauri/Cargo.toml`, no `androidx.security` in the plugin.

## Intended design

### Desktop — OS keychain via the `keyring` crate

- Add `keyring` as a **desktop-only** dependency (a `[target.'cfg(not(target_os = "android"))'.dependencies]`
  section, mirroring how `pdfium` is split in `src/render/mod.rs`). It maps to
  Windows Credential Manager (DPAPI-backed), macOS Keychain, and libsecret /
  gnome-keyring on Linux.
- New `src-tauri/src/secret_store.rs`, a cfg-split module (the pdfium cfg
  pattern): `store(key, value)`, `read(key) -> Option<String>`,
  `delete(key) -> Result<(), …>`, keys `"printer-{id}"`.
- **DTO change**: `Printer.password` becomes `has_password: bool`. The
  add/update request keeps a transient `password: Option<String>` (sent on
  add/change; `None` = keep what is stored, `Some("")` = clear). This is a
  frontend-breaking change — land the Rust, frontend and i18n changes together
  (see blast radius below).
- **Print time**: a `resolve_printer_secret(conn, printer_id) -> Option<String>`
  that reads the keychain first and falls back to the legacy
  `printers.password` column. On a legacy hit, **self-heal**: write the value
  to the keychain and `UPDATE printers SET password = NULL` — idempotent, so a
  keychain-absent environment (CI, Docker) simply keeps re-reading the column
  and never fails.
- **Migration**: an idempotent `ensure_credentials_encrypted(conn)` step in
  `db/mod.rs::init`, following the `ensure_idempotency_scope` pattern
  (`src/db/mod.rs`): for each row with a non-NULL `password`, move it to the
  keychain and clear the column. Must be **non-fatal at DB open** — a
  keychain failure logs and leaves the column as the fallback.
- Keychain-absent environments (CI, headless Docker) keep the legacy column
  as the fallback: add/update must never fail for that reason.

### Android — EncryptedSharedPreferences through the android-print plugin

- `plugins/tauri-plugin-android-print`: add `androidx.security:security-crypto`
  and a small bridge exposing `storeSecret` / `readSecret` / `deleteSecret`
  commands (MasterKey + EncryptedSharedPreferences, the same pattern as the
  plugin's existing `pdf_to_raster`/`probePdf` command wiring).
- Keys: `"printer-{id}"` (if printer auth ever reaches Android) and
  `"pair-{provider_id}"` for the `render_pairs` Bearer secrets, which move out
  of the settings JSON. The `render_pairs` JSON keeps everything except the
  `secret` field.
- Interplay with the device-id squatting fix (item 3, implemented on this
  branch): the re-pair `previous_token` proof reads the stored secret — on
  Android that read comes from the secret store, so the two changes should
  land close together or be ordered so the secret store exists first.

### Frontend blast radius (desktop)

- `src/lib/` types: the `PrinterRow` type (`types.ts` / `lib` printer types)
  drops `password`, gains `has_password`.
- `src/pages/printer-setup/` (the split form components, per the
  Settings/PrinterSetup page split): `usePrinterForm.ts` stops prefilling the
  password field and shows "saved — leave blank to keep";
  `PrinterFormFields.tsx` renders the blank-means-keep hint;
  `src/lib/printerSchema.ts` validation: password optional, `""` = clear.
- Printer-form test mocks and fixtures that assert on `password`.
- i18n: new strings ("Password saved — leave blank to keep" etc.) in both
  `en.ts` and `ja.ts`.

## Risks

- **Keychain-absent CI / Docker**: the whole design must degrade to the
  legacy column, not to broken add/update. Every keychain call site needs a
  fallback path, and the migration step must be non-fatal.
- **MasterKey upgrade orphans secrets** (Android): a MasterKey migration
  (OS upgrade, backup/restore) can make old EncryptedSharedPreferences values
  unreadable. `readSecret` must treat "unreadable" as "missing" and surface a
  "re-enter the password / re-pair" state, never a crash.
- **DTO change breaks the frontend**: types, form, schema, tests and i18n
  must land in one PR; a half-migrated state fails tsc or the printer form
  tests.
- **iOS** (if the app ever ships there): no design here; it stays on the
  legacy-column fallback until a Keychain bridge is written. Documented out
  of scope.
- **Migration ordering**: `ensure_credentials_encrypted` runs on every DB
  open; keep it cheap (count-check first, as `ensure_idempotency_scope`
  does) and idempotent.

## Acceptance checklist (for the implementing pass)

- [ ] `cargo add keyring` desktop-only; `secret_store.rs` with store/read/delete
      and unit tests against an in-memory fake (no real keychain in tests).
- [ ] Add printer with password on a keychain-backed desktop:
      `SELECT password FROM printers WHERE id = ?` is `NULL` afterwards;
      `has_password` is `true`; the password field renders blank + hint.
- [ ] Same on a keychain-absent environment: add succeeds, the value stays in
      the legacy column, `has_password` is `true`.
- [ ] Update-with-blank keeps the stored secret; update-with-value replaces it
      (keychain + column fallback both); explicit clear removes it.
- [ ] Delete printer removes the keychain entry.
- [ ] Print/test to an IPP printer with HTTP auth still sends the right
      `Authorization` header (the existing `auth_header` tests cover the
      encoding; add one through the resolver).
- [ ] Migration: a DB seeded with legacy passwords upgrades on open
      (keychain path) without data loss; a second open is a no-op.
- [ ] Android: `storeSecret`/`readSecret`/`deleteSecret` plugin commands with
      the wire contract pinned by serde tests (the `PdfProbeRequest` pattern);
      no `secret` field in the persisted `render_pairs` JSON after a pair.
- [ ] Frontend: `tsc -b` clean, printer-form tests green, i18n complete in
      `en.ts` and `ja.ts`.
- [ ] e2e: the printer form add/update flow against a committed baseline.
- [ ] Docs: this file moves from `docs/todo/` to the fixed list (the
      print-flow follow-up tracker it was companion to is no longer in the
      repo; the CHANGELOG is the record of the fixed items).
