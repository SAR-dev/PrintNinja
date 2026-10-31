# TODO: pair-phone vs invite-guest clarity (PC Phones tab)

Status: implemented on branch `pair-guest-automation-ux`.

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

# TODO: mobile opens on Automation with the PC tab first

Status: implemented on branch `pair-guest-automation-ux`.

Findings: `startOnPrint()` rewrites bare `/` → `/print` for everyone,
and the mobile bottom bar is Print/History/Templates/Printers + More
(Automation hides under More) — so a phone user opens on Print and
must dig for Automation. Default tab: missing/unknown `?tab=` →
`"server"` (`parseAutomationTab`, only used by `Automation.tsx`); on
Android the tab that matters — pairing + Print via PC — is `phones`
(labeled PC/Computer there). Header badges already link explicitly to
`/automation?tab=phones`, so they are unaffected.

1. `startOnPrint()` becomes platform-aware: bare `/` → `/automation`
   on Android, `/print` elsewhere. Deep links and bookmarks untouched
   (only bare `/` is rewritten — same guarantee as today).
2. Default Automation tab becomes
   `isAndroid() ? "phones" : "server"`, applied in both the
   `parseAutomationTab` fallback and `openTab`'s param cleanup (which
   currently deletes `?tab=` only for `"server"` — it must delete for
   whichever the default is, so shared/bookmarked URLs stay clean).
3. Tests: extend the "opens on the server" + "falls back to server"
   cases with Android-UA variants asserting the phones tab; add a
   `startOnPrint` unit test for both platforms. Then `tsc -b`,
   `pnpm lint`, targeted vitest.
4. Docs: one-line updates in `docs/UI_GUIDE.md` (automation row:
   unknown-tab rule becomes platform-dependent) and the
   `startRoute.ts` comment.

Deliberately out of scope: bottom-bar composition (Templates stays;
only the landing changes), badge links, desktop behavior. Swapping
Templates out of the bottom bar for Automation would be a separate,
bigger change.

# TODO: show the guest name of the paired phone on the PC

Status: implemented on branch `pair-guest-automation-ux`.

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

Status: implemented on branch `pair-guest-automation-ux`.

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
