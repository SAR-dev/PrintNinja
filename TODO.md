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
