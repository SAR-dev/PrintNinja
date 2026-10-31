# TODO: pair-phone vs invite-guest clarity (PC Phones tab)

Status: plan only, not implemented.

Problem: both actions produce an identical-looking code typed into the
identical phone-side field. The only differences are invisible at a
glance — who may use it (same-account you vs. anyone) and how long it
lasts (90 s window vs. hours/days, limited uses). "Pair a phone" does
not say *your own* phone; "Invite guest" does not say what a guest
gets.

1. Split the two actions into two labeled groups on the PC tab
   (`src/components/DevicesCard.tsx`), mechanics untouched:
   - "Your own phone" — same account, permanent, full access → the
     90-second code panel (button renamed "Pair a phone" to
     "Pair my phone").
   - "Someone else's phone (guest)" — no account needed, expires
     automatically, printing optional, templates usable by name but
     never readable/changeable → the existing invite form unchanged.
2. Update en + ja strings (renames + two audience lines, no new flows).
3. Update specs that click the old names (e2e settingsAdmin pairing
   flows, any unit tests asserting the copy).
4. Verify: `tsc -b`, `pnpm lint`, targeted vitest + e2e pairing specs.
5. Docs: one line in `docs/UI_GUIDE.md` Pages table if the headings
   change the described blocks.

Deliberately out of scope: code mechanics, expiry defaults, phone UI
(it types a code either way; the server already tells kinds apart).

# TODO: show the guest name of the paired phone on the PC

Status: plan only, not implemented.

Today every guest shows up as "Android phone" because `pair_with_code`
hardcodes `device_name` to `phone_name()`. The claim
(`POST /v1/pair/claim`) already carries `device_name`, and the PC
already stores and shows it — only the phone side needs to send the
handle the guest (or session) picked.

1. Rust (`src-tauri/src/commands/api.rs`): `pair_with_code` gains
   optional `device_name`; `claim_at` sends it instead of
   `phone_name()`. Absent/blank keeps today's fallback.
2. Frontend: `pair_with_code` agent type gains `device_name?`;
   `DevicesCard` submit passes the welcome name (session handle, else
   guest handle).
3. e2e fake: mirror the parameter.
4. Tests: Rust unit for name threading + fallback; frontend test that
   the submit carries the handle. No new i18n strings.
5. Verify: `tsc -b`, `pnpm lint`, `cargo fmt --check`,
   `cargo clippy --all-targets -- -D warnings`, targeted suites.

# TODO: guest name step after "Continue as guest"

Status: plan only, not implemented.

The name field sitting inline on the sign-in form is noisy — most
visitors never use it. Instead: "Continue as guest" swaps the form to
a small guest step (name input + Back + Continue), and only that step
asks for the handle.

1. `SignInScreen`: guest section keeps just the button + hint;
   clicking it swaps the card to the guest step with the name field,
   validated as today (non-empty, `HANDLE_RE`), Back returns to the
   sign-in form. `onGuest(handle)` signature unchanged.
2. en + ja: relabel if needed (a title for the step, e.g. "Continue
   as guest" as the heading).
3. Tests: update the guest-entry cases (button reveals the step;
   handle required on Continue; Back returns). Then `tsc -b`,
   `pnpm lint`, targeted vitest.
