# Mobile UX, unpaired banner and toast plan

Status: all four phases implemented on `develop` (unreleased):
Phase 1 (top bar, sort default, theme, nav labels), Phase 2 (unpaired
vs unreachable strip), Phase 3 (notify funnel, tokens, actions),
Phase 4 (Designer, Print and Printers layouts). Kept as the design
record; behavior now lives in the code and `docs/UI_GUIDE.md`.

Based on a read of the code and the committed phone screenshots in
`e2e/tests/mobile.mobile.e2e.ts-snapshots/` (Pixel 7 and 360px). The app was not run.

## Decisions

| Question | Decision |
|---|---|
| Where does the unpaired / unreachable banner show? | A thinner strip on every page (one line, one primary action). |
| Toast position on desktop | Keep bottom-right. |
| Toast position on phones | Above the bottom nav and the sticky Print bar (not covered by them). |

## Findings

### Unpaired banner (`src/components/PcStatusBanner.tsx`, mounted at `Layout.tsx` ~472)

- When a PC removes a phone, the Rust side returns "{name} removed this phone. Pair again."
  (`src-tauri/src/api/peer_consume.rs` ~620). The banner ignores that and shows the generic
  "Can't reach {name}. Prints from this phone will fail until it answers."
- The strip carries four controls in one `text-xs` row (Details, Check again, Devices, ✕).
  "Check again" can never succeed for an unpaired phone.
- It is shown under the top bar on every page and returns after an app restart (by design).
- `usePcStatus` keeps probing every 30 s even when the phone is unpaired and cannot recover.

### Toasts (`src/main.tsx`, `src/components/ui/sonner.tsx`)

- About 160 `toast.*` calls, all through one default `<Toaster richColors closeButton />`.
- Default placement is at the bottom, where the floating bottom nav and the sticky Print bar sit.
- Errors disappear after the default ~4 s, same as "Saved".
- Form validation is a toast instead of an inline field error (`ChangePasswordForm.tsx`,
  `Designer.tsx` name required / name exists).
- Loops fire one toast per item (`GetFromServerDialog.tsx` ~117) and nothing is deduplicated
  (`DevicesCard.tsx`, 18 calls).
- No toast has an action button (no Undo after delete, no link after reprint).
- `richColors` uses sonner's own palette rather than the app's status tokens (verify visually).
- `describeError` shows unmapped backend text as-is.

### Mobile layout (from screenshots)

- At 360px the top bar clips the search icon, so the command palette cannot be opened.
- Designer: three rows of buttons before the canvas, Save appears twice, canvas is short and
  partly behind the bottom nav.
- Print: the form starts below the fold (title, subtitle, Refresh, status banner come first).
- Templates: the Sort select shows the placeholder "Sort" next to a "Sort" label.
- Printers: the tab strip cuts a tab mid-word.
- `theme-color` is `#FFFFFF` but the phone header background is `#F4F7F7`.

## Plan

Each phase is its own commit so it can be reviewed separately.

### Phase 1: quick fixes (small, low risk)

1. Search icon clipped at 360px: on phones hide the version text and tighten the status icons
   (`Layout.tsx` top bar).
2. Templates Sort select: default `sortKey` to the real sort ("Last updated") so the trigger
   shows the active value (`Templates.tsx` ~549-563).
3. `theme-color`: change `#FFFFFF` to `#F4F7F7` in `index.html`. Check the Android build
   separately (`scripts/patch-android-theme.mjs`).
4. Bottom nav labels: 11px to 12px (`src/mobile.css`).

### Phase 2: unpaired / unreachable strip (medium)

Goal: still a thin strip on every page, but it says the right thing and offers the right action.

1. **Classify the failure in `usePcStatus`.** Add a `kind`: `unpaired` (PC removed this phone)
   or `unreachable` (off, asleep, firewall, timeout). Match the leading "removed this phone"
   text through one shared constant, the same convention `src/lib/errors.ts` already uses.
2. **Unpaired strip.** One line, truncated: "{name} removed this phone." One primary button:
   **Pair again** (goes straight to pairing). Dismiss (✕) kept. No Details, no Check again.
3. **Unreachable strip.** One line: "Can't reach {name}." Primary button: **Check again**.
   Details and Devices move behind a "⋯" menu or a tap on the text (opens a bottom sheet with
   the reason).
4. **Keep the strip thin but tappable.** Single row, `text-xs` text with ellipsis, controls
   44px tall on touch (the mobile e2e spec asserts this), so the row is as tall as the 44px
   buttons and not taller.
5. **Stop probing when unpaired.** Re-probe only after a pairing change, on app foreground, or
   on "Pair again" completing. Keep the 30 s poll for `unreachable`.
6. **Print page.** When the phone is unpaired, the disabled Print button's blocker reads
   "Pair again to print" with a link, instead of a generic message.
7. Keep the existing per-episode dismiss behaviour (dismiss mutes only the current episode).
   An `unpaired` episode and an `unreachable` episode for the same PC are different keys.

Files: `src/components/PcStatusBanner.tsx`, `src/lib/shell/usePcStatus.ts`,
`src/lib/errors.ts`, `src/pages/Print.tsx`, `src/lib/i18n/locales/en.ts` and `ja.ts`.

### Phase 3: toasts (medium to large, mostly mechanical)

1. **Add `src/lib/notify.ts`**, the one place that calls `toast`:
   - success: 3 s.
   - info: 4 s.
   - error: stays until dismissed (or at least 8 s), with an optional action (Retry, Details).
   - Optional `id` for dedupe so a repeat replaces the earlier toast.
   - `visibleToasts: 2`.
2. **Position.**
   - Desktop: keep bottom-right.
   - Phones: bottom-center with `offset` set to the bottom nav height plus
     `env(safe-area-inset-bottom)`, plus the sticky Print bar height on `/print`.
     Use a CSS variable set by the layout so the offset follows the real heights.
3. **Style with app tokens** instead of `richColors` (status tokens, icon plus word, per
   `docs/UI_GUIDE.md`). Remove the `!important` overrides in `mobile.css` that fight sonner.
4. **Inline validation.** Move the password form checks and the Designer name checks to
   field-level errors (`aria-describedby`), no toast.
5. **Replace loops** with one summarized toast (for example "3 templates failed" with a
   Details action), starting with `GetFromServerDialog.tsx`.
6. **Add actions.** Undo after delete (History, Templates), "View" after reprint / requeue.
7. **Migrate the ~160 call sites** to `notify`, file by file (largest first: `Designer.tsx` 34,
   `Settings.tsx` 23, `PrinterSetup.tsx` 18, `DevicesCard.tsx` 18).
8. **Guard test**, like `noRawColors.test.ts`: fail if `toast` is imported from `sonner`
   outside `notify.ts` and `ui/sonner.tsx`. Add it after the migration is done.
9. Map more backend messages in `describeError` `PATTERNS` so fewer raw strings reach the user.

### Phase 4: layout work on phones (larger)

1. **Designer.** Keep only the sticky tab row with Save. Move New template and the
   Public/Private toggle into an overflow menu. Give the canvas more height above the bottom
   nav. Make the tab classes match the 44px the CSS already forces.
2. **Print.** Collapse the "Printer is ready" banner to one line (full size only when there is
   a problem). Fold Refresh printers into the printer field row so the form starts higher.
3. **Printers tab strip.** Scroll the active tab into view, or use a select on phones (as
   Templates does for sorting).

## Cross-cutting

- Every new string goes into both `en.ts` and `ja.ts` (`src/test/i18n.test.ts` fails if not).
- Update the e2e test ids that change (`pc-down-*`) and any tests that assert on toast text.
- Refresh mobile baselines after intentional visual changes:
  `pnpm --filter e2e exec playwright test --project=mobile-pixel7 --update-snapshots`
  (and `--project=mobile-small`).
- Run `pnpm check` (lint, types, unit tests) before each commit.
- Manual check at 360px, 390px and 1440px, and on a real phone for toast position over the
  bottom nav and the Print bar.

## Suggested order

1. Phase 1 (quick fixes)
2. Phase 2 (unpaired strip), the item that bothers you most
3. Phase 3 (toasts)
4. Phase 4 (Designer and Print layouts)

## Open points

- Whether "unpaired" in your report means this strip (PC removed the phone). Phase 2 assumes it
  does.
- How the toast offset should react when the keyboard is open on a phone (probably hide toasts
  below the keyboard, to be checked on a device).
