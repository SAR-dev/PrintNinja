# Guest pairing (invite codes)

Status: design decided, not implemented.
Branch: `feat/guest-pairing`.

## Why

Same-account pairing is right for owners but impractical for sharing —
family, shop staff, visitors. An owner shares a time-boxed credential
and the guest prints/renders with it. No account, no sign-in on the
guest side.

## Decisions

| Question | Decision |
|---|---|
| Guest identity | Invite code only. No account, no sign-in; the device name is the audit identity. |
| Owner rule (§8) amended | Owners prove who they are; guests prove they hold a time-boxed invite. |
| Guest scope | Per invite: render-only or print (`can_print` preset, still togglable after). |
| Templates | Read-only structurally: the API serves names/geometry, never bodies. Nothing to build. |
| Invite defaults | 24 h expiry, multi-use, print allowed; owner narrows at mint. |
| Expired/exhausted | Generic 401, like revoked. |

## Design

- `paired_devices`: `role` (`owner`/`guest`, default `owner`),
  `expires_at` (nullable; owners NULL). Guest rows store NULL account.
- Invites live server-side on the PC (code hash, expiry, uses-left,
  `can_print`). Redemption mints a per-device token exactly like a
  claim and burns/limits the invite. 5-guess lockout applies.
- Claim with an invite code skips the account presence check; the
  one-time-code window path is unchanged.
- Gate recheck splits by role: owner rows compare against the PC's
  current account (unchanged); guest rows check expiry + sharing only.
- History shows guest jobs with name + guest badge (existing
  `requested_by_device_id` attribution).
- UI: PC mints/copies/revokes invites (expiry picker, active list);
  phone pairs with the same code field; guest badge in both device
  lists.

## Non-goals

- Per-template grants (a second permission system; no stated need).
- Kiosk/open mode (deletes the Release A guarantee).
- Merging guest rows by device name (collides across phones).

## Security notes

The invite is the credential: entropy + expiry + max-uses + lockout.
Account UUIDs were never doing this work. Exposure is time-bounded by
expiry instead of switch-detected; revocation is per-row as today.
