# Decisions

> **Who this is for:** maintainers and reviewers who need to know *why* a rule exists before changing it.
> **What you will know after reading:** the recorded design decisions behind shared rendering and guest invites, with enough context that each "why" survives its plan file.

This file collects the decisions that used to live at the end of the
architecture doc so that the plan files they came from could go. Dates mark
when each block was recorded; the decisions themselves predate the record.
When a decision stops holding, delete it here rather than amending the
explanatory docs.

## Shared rendering (phones ↔ PCs)

Recorded 2026-11 (moved from ARCHITECTURE.md). All still hold, except
sign-in, which guest pairing has since narrowed to owners.

- Paired-only LAN, no API keys. Non-paired clients lose access completely;
  scripts run on the PC itself over loopback.
- `can_print` defaults true; the PC toggles render-only phones off.
- No local fallback or override while Print-via-PC is on: unreachable PC or
  rejected token fails the job with the reason.
- Same-account owner pairing: the server `User.id` plus service URL, saved on
  each device at login, checked locally at claim time, works offline. Guests
  prove a time-boxed invite instead (see [Guest invites](#guest-invites)).
- No backfill or migration support: development phase, reset the database;
  schema changes go straight into the schema.
- A phone may use all of the PC's printers; no per-printer switch.
- Template mismatches are refused, never printed around: match by
  `server_id` plus `server_revision`, `409` with a Sync prompt.

See the working explanation in
[phone and PC sharing](./architecture/phone-and-pc-sharing.md).

## Guest invites

Recorded 2026-11 (moved from ARCHITECTURE.md).

- Identity: invite code only. The invite *is* the credential (entropy +
  expiry + max-uses + 5-guess lockout); an account UUID was never doing that
  work, and guests are the users least able to bear sign-in friction.
- Scope per invite (render-only or print), stamped onto the fresh row, still
  togglable per phone afterwards. All templates by name.
- Defaults: 24 h, multi-use, print allowed; the owner narrows at mint.
- Expired/exhausted invites answer 410 at claim ("ask for a new one"); spent
  pairs fail like revocations. Re-pairing follows the credential just used
  (owner window promotes, invite demotes).
- No per-template grants, no kiosk mode, no auto-merging guest rows by device
  name (names collide across physical phones).

See the working explanation in
[phone and PC sharing](./architecture/phone-and-pc-sharing.md#guests).
