# PrintNinja: Frontend Design Improvement Report (final)

**Repository:** https://github.com/SAR-dev/PrintNinja
**Branch reviewed:** `develop` (version `2026.1117.5`)
**Review date:** 17 November 2026
**Method:** code review of `src/` plus visual review of screenshots captured with the new `pnpm shots` script

---

## 1. Summary

PrintNinja's interface is already in good shape. It has a consistent color-token system, a clear sidebar, accessible status badges, a good dark theme and a well-built phone layer. The problems that remain are mostly about **width ranges the layout was not designed for, dense or repeated controls, and information that is cut off on phones**. Underneath, the code needs structural work so design changes stay safe.

**The ten changes that matter most**

| # | Change | Where | Severity |
|---|--------|-------|----------|
| 1 | Fix the 768 to ~1100px width range: the Templates table overflows and hides the Edit/Print buttons; Print wastes space | Tablet and narrow desktop windows | High |
| 2 | Add error boundaries so a crashing page cannot blank the app | App-wide | High |
| 3 | Simplify the Templates table rows: one clear primary action, labeled overflow menu, hide the "Sync ID" column | Templates (desktop) | Medium |
| 4 | Make hidden tabs discoverable on phones (only "Mine (4)" and "All (3)" are visible) | Templates, Printers (phone) | Medium |
| 5 | Stop truncating the most important text in History on phones (job names, error messages) | History (phone) | Medium |
| 6 | Shrink the phone page headers so content starts higher | All phone pages | Medium |
| 7 | Replace the full-width "Printer is ready" strip with a compact status | Print (all platforms) | Medium |
| 8 | Split the giant page files and reduce state sprawl | Code | High (engineering) |
| 9 | Introduce a type scale and remove 10–11px text | Code and UI | Medium |
| 10 | Add screenshot-based regression checks at more widths | Tooling | High (process) |

---

## 2. How this review was done

### 2.1 Sources

1. **Code review** of `src/` (273 files), `tailwind.config.ts`, `src/index.css` and `src/mobile.css`, with pattern searches for accessibility, responsiveness, tokens and motion.
2. **Visual review** of the screenshots produced by the new script (`scripts/screenshots.mjs`, run as `pnpm shots`). The full matrix is 88 images: 4 platforms (Windows desktop, Android phone, small Android phone, Android tablet) × light and dark × 11 pages. I examined about 25 representative images in detail:
   - Desktop light: Print, Designer, Templates, Printers, History, Settings, Profile, Automation, Devices, API explorer, Sign-in.
   - Desktop dark: Print, Templates, Designer.
   - Phone light: Print, Templates, History, Printers, Designer, Settings, Automation, Devices.
   - Small phone (360px): Templates. Tablet (800px): Print, Templates.

### 2.2 Limits you should know about

- **The screenshots use sample data and a fake native layer.** I did not count these as bugs: blank or raw-HTML print previews, every template being 210 × 297 mm, history rows named "Template #N", printers all showing "Not checked", and "Checking connection…" or "disabled" status chips.
- **Screenshots only capture the first screen.** Pages scroll inside the main area, so long pages (Settings, Designer side panel, long tables) are cut at the viewport. Findings about content below the fold come from code, not images.
- **Only English, light and dark, comfortable density were checked.** Japanese and compact density are available in the script but were not reviewed in this pass.
- **macOS and iOS are not targets**, so they were not reviewed.
- This is a static review. I did not test with a screen reader, real printers or real data volumes.

### 2.3 Decisions that shaped priorities

| Question | Answer | Effect |
|----------|--------|--------|
| Platforms | Desktop (Windows) and Android phone | Full effort on those. Tablet is low priority, but the same widths appear when a desktop window is resized, so the tablet findings still matter. |
| Primary audience | English-speaking users | English first; Japanese typography is a later, lighter pass. |
| User mix | New and daily users | Keep guided defaults for beginners and speed (shortcuts, remembered choices) for daily users. |

---

## 3. What is already good (keep it)

Confirmed in the screenshots, not just the code:

- **Consistent color tokens** (teal brand, soft status tints) in both themes. The code has zero raw hex colors in the TSX, enforced by tests.
- **Clear desktop navigation.** The sidebar groups pages under Work, Build and Admin, with an obvious active state and a collapse control.
- **Command palette is already discoverable.** The top bar search shows a `Ctrl+K` hint. (An earlier draft of this report suggested adding one. That is already done.)
- **Print page keeps advanced settings collapsed.** "Advanced options" shows a one-line summary ("Portrait · Fit to width · Template size") and one dominant Print button. (An earlier draft suggested progressive disclosure here. It is already in place.)
- **Phone layout is genuinely phone-first.** Card lists, a labeled bottom tab bar, a sticky Print button and large touch targets on Print, Templates, History, Printers and Settings.
- **Settings on phone** is a clean list with an icon, title and description per section.
- **Status badges always combine icon, color and text** ("Printed", "Failed", "Cancelled").
- **Dark mode is solid.** Text is readable, borders carry the layering, accents stay on brand.
- **Sign-in has a clear guest path** and a single obvious primary button.

---

## 4. Findings confirmed from screenshots

Severity: **High** blocks or breaks use. **Medium** slows people down or hides information. **Low** is polish.

### 4.1 Layout at in-between widths (High)

**Seen on:** Android tablet at 800px (and expected on any desktop window narrower than about 1100px).

- **Templates:** the table is wider than the screen. The "Page size" cell wraps to four lines ("210 / × / 297 / mm"), the "Updated" date is clipped ("2026-11 / 17") and the **Edit and Print buttons are cut off the right edge**. Users at this width cannot reach the main actions.
- **Print:** the form and the preview stack in one narrow column. The 224px sidebar still takes about 28% of the width, so little room is left, and the preview is pushed below the fold.

**Why:** the app switches from the desktop layout to the phone layout at 768px, but the desktop layout needs about 1100px before its tables and two-column pages fit.

**Fix:**
1. Add a middle layout between 768 and ~1100px: collapse the sidebar to an icon rail, and switch tables to the card list that phones already use.
2. Drop low-value columns first (Sync ID, Page size) before wrapping.
3. Use container queries so a table adapts to the space it actually has.
4. Test every page at 800, 900, 1024 and 1280px (see section 8.1 for adding these to the screenshot script).

### 4.2 Templates table: too many competing controls (Medium)

**Seen on:** desktop Templates.

- Every row has an outlined **Edit** button, a filled **Print** button and **three unlabeled icon buttons** (upload, sync, delete). Four rows means eight strong buttons and twelve icons. The eye has no resting place.
- The icons have no text. Upload versus sync is ambiguous, and the red trash icon sits next to the Print button with no separation.
- A **"Sync ID" column ("00000000 · r1")** shows developer data to every user.
- There is no visual preview of a template, although the phone cards already show a small document thumbnail.

**Fix:**
1. Keep one visible action per row (Print) plus a text "Edit" link. Move upload, sync and delete into a labeled "More" menu, with delete last and in the danger color.
2. Move Sync ID and revision into a details panel or tooltip.
3. Add the same thumbnail the phone view uses.
4. Where a sync action matters, show state in words ("Synced", "Changes not uploaded") rather than a bare icon.

### 4.3 Hidden tabs on phones (Medium)

**Seen on:** phone Templates (only "Mine (4)") and phone Printers (only "All (3)"). The desktop shows "Mine / Saved / Community" and "All / Network / USB / Bluetooth / System".

If the other tabs are scrolled out of view or collapsed, nothing tells the user they exist. If they are intentionally removed, the user loses access to Saved and Community templates on phones. **Verify which it is**, then:

- Use a segmented control that fits, or a horizontally scrolling row with a visible fade on the edge and the active tab scrolled into view.
- Or replace the tabs with a single filter select ("Show: Mine, Saved, Community").

### 4.4 History on phones truncates the key facts (Medium)

**Seen on:** phone History.

- Each row shortens the template and printer to "Template #1 · Zebra ZD…".
- On a failed job the reason is cut to "Printer offline: co…". The error text is the most important content on a failure.
- A checkbox appears on every row at all times, taking about 12% of the row width.

**Fix:**
1. Give the error line up to two lines, and put the full text behind a tap (an expandable row or a bottom sheet).
2. Show checkboxes only in a selection mode (long-press or a "Select" button).
3. Put the printer name on its own line, or drop it from the row and show it in the detail view.

### 4.5 Phone page headers use too much of the screen (Medium)

**Seen on:** all phone pages.

Each page spends about a quarter to a third of the first screen before real content begins: app bar, a very large page title, a subtitle, an info banner ("Templates are edited on a computer…") and a row of actions. On Automation, the three section tabs are stacked as three full-width rows (see 4.9) and add to this.

**Fix:**
- Use a collapsing large title (large at the top, compact when scrolling).
- Drop the subtitle on phones, or show it only on first visit.
- Make informational banners dismissible and remember the dismissal. The "edited on a computer" banner appears on both Templates and Designer.
- Keep the primary action on the same row as the title when there is room.

### 4.6 Print: the "ready" banner repeats itself (Medium)

**Seen on:** Print, all platforms and themes.

A full-width green strip reads "Printer is ready — Ready to print on Zebra ZD421." The two halves say the same thing. When everything is fine, the strip is the loudest element on the page, and it pushes the form down (more noticeable on phones).

**Fix:** show a compact "Ready" chip next to the printer select, and use the full banner only for problems (offline, paper mismatch, driver missing). Keep the success state quiet.

### 4.7 Print: paper-mismatch warning is cramped and vague (Medium)

**Seen on:** Print.

The amber warning is set in small text and offers two buttons: "Set to 210 mm" and "Other…". They do not say what changes (the template, the printer or the job), and "Other…" does not say what it opens.

**Fix:** use explicit wording ("Change template size to 210 mm", "Choose a different paper size…"), raise the text to at least 13–14px, and keep the warning attached to the printer field (it already is).

### 4.8 Designer: balance, state and empty space (Low to Medium)

**Seen on:** desktop Designer.

- The **Save** button looks very pale when there is nothing to save. It is hard to tell "disabled" from "broken", and nothing says whether the work is saved.
- The editor column is wide while the canvas is a narrow column, and the canvas shows the page at 38% with a lot of empty dotted space. Large areas stay empty while the left panel (page setup, 25 sample variables) is dense and scrolls.
- Helper text ("Printing never touches the network…") is small and gray at the top of the editor.
- On the phone, the Designer is a read-only preview with a "Templates are edited on a computer" notice. That is a clear decision; the large page title then repeats the template name.

**Fix:**
1. Replace the disabled Save look with a state label ("Saved", "Unsaved changes") next to the button.
2. Give the canvas a larger default share, and zoom to fit the actual label size (not the A4 default) when the template is small.
3. Collapse "Sample data" by default and keep "Page setup" open, so the first view is less dense.
4. Show the helper text as an info icon with a tooltip once it has been seen.

### 4.9 Phone Automation and Devices pages (Low to Medium)

**Seen on:** phone Automation and phone Devices.

- The three tabs (API server, Try the API, Deep links) are stacked in three rows rather than shown as one segmented control, and they take a large part of the first screen.
- The page shows PC-oriented controls (port, "Start Server", "Allow LAN access") on an Android phone. If a phone cannot host the local API, these should be hidden or explained ("Available on the PC app"). **Verify whether the phone can run it.**
- The Devices page is titled "Connect to PC" on phone but "Devices" in the navigation and on desktop.
- A card is headed "3. Connected to Front Desk PC" although steps 1 and 2 are not visible. The numbering reads as an error.
- "Shared rendering" is a five-line paragraph before any control.

**Fix:** use one segmented control; hide or explain unsupported features; use one page name everywhere; either show the full step list or drop the numbers; cut the explanatory paragraph to one or two lines with a "Learn more" link.

### 4.10 Selection cards rely on a faint tint (Low)

**Seen on:** Settings (Language, Theme, Density).

The selected card is distinguished by a light teal fill and a slightly darker border. A user with low color perception or a washed-out screen may not see which option is active.

**Fix:** add a check icon or a filled radio mark to the selected card, and use a 2px border in the primary color. Keep the whole card clickable.

### 4.11 Copy and naming inconsistencies (Low)

- Profile says "Sign in from the Share section", but the settings list calls it "Account & sync".
- Connection types read "network" (lowercase) next to "USB" and "System".
- The `/api-explorer` route lands on the Automation page's "Try the API" tab, so one screen has two addresses.
- "Devices" (desktop) versus "Connect to PC" (phone), already mentioned.

**Fix:** keep a single glossary of page and section names (`docs/GLOSSARY.md` already exists), apply it in the English strings, and add a test that fails on references to section names that do not exist.

### 4.12 Printers page (Low)

- Every row shows a gray "Not checked" chip, which adds noise and little meaning.
- The edit action is a bare pencil icon, and the Test Print icon is hard to recognize.

**Fix:** run a quiet connection check on load and show "Online / Offline / Last checked 2 min ago". Hide the chip until there is something to say, and add text labels to icon buttons or tooltips with keyboard access.

### 4.13 Sign-in (Low)

The screen is clean, but its first field is "Server address", a technical setting every new user must fill in before their handle. Pre-fill it when known, or move it under an "Advanced" disclosure for the default hosted service.

### 4.14 Dark mode (Low)

Good overall. Two small notes: the primary button in dark mode is a very bright cyan that outshines everything else, and the success banner is a dim olive with weaker contrast than the light version. Check both against the contrast tests and soften the button slightly.

---

## 5. Findings from the code (not visible in screenshots)

### 5.1 No error boundaries (High)

A search for `componentDidCatch`, `ErrorBoundary` and `errorElement` in `src` found nothing. Pages are lazy-loaded, so a failed chunk load or a render exception can leave a blank screen, in a tool people use mid-print.

**Fix:**
- Add a top-level boundary and one per route. Keep the navigation outside the page boundary so people can leave a broken page.
- The fallback shows a plain message, "Try again", a link back to Print, and "Copy diagnostics" (`src/lib/diagnostics.ts` exists).
- Treat lazy chunk-load failures separately with a "Reload" action.
- Add a test that throws inside a page and expects the fallback.

### 5.2 Very large files and state sprawl (High, engineering)

| File | Lines | `useState` calls |
|------|-------|------------------|
| `pages/Print.tsx` | 2,109 | 29 |
| `pages/Designer.tsx` | 1,859 | 43 |
| `pages/Settings.tsx` | 1,789 | 39 |
| `pages/PrinterSetup.tsx` | 1,713 | 26 |
| `components/DevicesCard.tsx` | 1,596 | – |
| `pages/History.tsx` | 1,399 | 12 |
| `pages/Templates.tsx` | 1,275 | – |

Every finding in section 4 is harder to fix when a page is one 2,000-line file with dozens of independent state variables.

**Fix:**
- Split into feature folders (`pages/print/`, `pages/settings/`, and so on) with a thin page file composing sections. Settings is the easiest start: it already switches on a `?section=` query.
- Group related state with `useReducer` or small hooks, and model screens as explicit states (loading, ready, error, offline).
- Keep user layout choices (open panels, split sizes, last tab) in the prefs store.
- Target page files under about 300 lines and sections under about 250. Do one page per pull request with the existing tests as a safety net.

### 5.3 No type scale; text under 12px (Medium)

`text-[11px]` (6 uses), `text-[10px]` (2) and `text-[13px]` (1) exist next to 301 `text-xs` and 186 `text-sm` uses. Examples: `PackChooser.tsx`, `SampleDataPanel.tsx`. The screenshots show this in the paper-mismatch note, helper lines and table captions.

**Fix:** define a named scale in `tailwind.config.ts` (caption 12px, body-sm 13–14px, body, title, display) with line heights, set a 12px floor (14px for phone body copy), replace arbitrary sizes, and add a test like the existing `noRawColors.test.ts` that fails on `text-[Npx]`.

### 5.4 Arbitrary widths and heights (Low)

Repeated values such as `w-[130px]`, `w-[150px]`, `w-[160px]`, `w-[170px]`, `w-[180px]`, `w-[300px]` and several `max-h-[40vh|60vh|70vh|85dvh]`. Turn these into a few named width and sheet-height tokens, use `dvh` consistently, and prefer `min-w-0` with flex or grid over fixed widths.

### 5.5 Responsive coverage is thin above `md` (Medium)

Breakpoint usage: `sm:` 59, `md:` 68, `lg:` 19, `xl:` 2. This matches the screenshot finding in 4.1: the layout is designed for "phone" and "large desktop", with little in between.

### 5.6 Two places define how a component looks (Medium)

`src/mobile.css` re-themes the app under 767px using `data-slot` hooks and load order, and components also carry `max-md:` classes (for example `EmptyState`). The result looks good, but it is easy for the two to drift.

**Fix:** move per-component phone styling into component variants (CVA is already a dependency), keep `mobile.css` for shared tokens (radius, control height, shadow, easing), and replace load-order overrides with explicit variants.

### 5.7 Focus and keyboard (Medium)

`aria-label` appears in 44 files, but `focus-visible` appears only 21 times in the TSX. Radix covers most primitives, but custom clickable rows, the designer canvas controls, toolbar buttons and resize handles need a keyboard check.

**Fix:** keyboard-only pass over every page with a single shared focus-ring utility; roving tabindex in the Designer toolbar; arrow-key support for resize handles; an `aria-live` region for save, print and sync results; automated axe checks on each page in both themes. Also confirm `AppLogo`'s `alt` handling.

### 5.8 Loading states (Medium)

Route loading is a bare spinner (`PageLoading`), and one nested Suspense uses `fallback={null}`. A `Skeleton` component exists but is used only inside `DataTable`, `PrintPreview` and `CanvasPane`.

**Fix:** page-shaped skeletons per route, a visible fallback instead of `null`, a short delay (~150ms) to avoid flicker, and `aria-busy` with a hidden "Loading" label.

### 5.9 Motion (Low)

59 transition and animation usages. Reduced motion is handled globally in `index.css`, but the easing token `--ease-out` exists only in the phone media query. Define shared duration and easing tokens for all breakpoints and make sure every animation (including spinners, sheets and dialogs) respects reduced motion.

### 5.10 Tables (Medium)

`DataTable.tsx` has no horizontal-overflow handling, which is the root of the Templates problem in 4.1. Add a card layout below a width threshold, a scroll container with sticky header and first column above it, virtualized rows for long lists (History grows without bound) and sort or filter state in the URL.

### 5.11 Other

- **Density:** compact mode on desktop (2rem controls, 0.25rem cell padding) should be checked for clipped focus rings and minimum target size.
- **Long text:** audit handles, template names and printer names for `min-w-0` + `truncate` with a tooltip, and test very long and no-space strings.
- **Feedback rules:** write down when to use a toast (completed actions), an inline message (field or section errors), a banner (persistent conditions) and a full screen (blocking failure).
- **Disabled controls:** use `DisabledReason` for every disabled primary action, visible without hover (touch has no hover).
- **Destructive actions:** one `ConfirmDialog` wording pattern (verb plus object, consequence stated, danger-styled confirm), and undo toasts for quick reversible actions.
- **Japanese typography** (later pass): bundle or choose a Japanese font pairing, tune line height, avoid uppercase and wide letter-spacing treatments for Japanese strings, and allow labels to wrap rather than truncate.

---

## 6. Page-by-page checklist

| Page | Desktop | Phone | Top items |
|------|---------|-------|-----------|
| Sign-in | Clean | Skipped on Android until paired | Hide server address under Advanced (4.13) |
| Print | Good, two-column | Good, sticky Print button | Quiet the "ready" banner (4.6), clearer paper warning (4.7), fix 768–1100px (4.1) |
| Templates | Busy rows, overflow at narrow width | Good cards; tabs hidden | 4.1, 4.2, 4.3 |
| Designer | Dense three-pane | Read-only preview | Save state, balance, collapse sample data (4.8) |
| Printers | Clean | Good cards; tabs hidden | Status noise, labeled actions (4.12, 4.3) |
| History | Good table | Truncated rows, constant checkboxes | 4.4 |
| Automation | Clear tabs | Stacked tabs, PC-only controls | 4.9 |
| Devices | Clear | Naming and numbering | 4.9, 4.11 |
| Settings | Good, selection cue faint | Good list | 4.10, copy fixes (4.11) |
| API explorer | Redirects to Automation tab | – | Remove the duplicate address (4.11) |

---

## 7. Detailed recommendations by theme

### 7.1 Responsive structure
- Define three layouts: phone (under 768), compact (768–1100: icon sidebar, cards for tables, stacked panes with the primary action pinned) and desktop (1100+).
- Pages that need a decision at each size: Templates, History, Print, Designer, Devices.
- Verify safe-area insets on Android devices with notches and gesture bars.

### 7.2 Information hierarchy and actions
- One dominant action per page; everything else secondary or in a menu.
- Status belongs near the thing it describes (printer status beside the printer select; sync state beside the template name).
- Icon-only buttons need a visible label or a keyboard-accessible tooltip, and destructive ones need separation.

### 7.3 Phones
- Collapsing large titles, dismissible banners, and two-line error text with tap-to-expand.
- A visible way to reach every tab or filter.
- Keep the sticky Print button and bottom bar; they work well.

### 7.4 Feedback, trust and clarity
- Quiet success, loud problems.
- Specific button labels ("Change template size to 210 mm" instead of "Set to 210 mm" / "Other…").
- One naming glossary applied across navigation, page titles and cross-references.

### 7.5 Accessibility
- Non-color selection cues, a consistent focus ring, keyboard operation for custom controls, an `aria-live` region, heading order checks and an axe pass per page in both themes.

### 7.6 Visual identity (optional)
- The slate-teal look is clean and accessible but generic. Add small brand moments (empty states, first print success, sign-in) and consider a secondary accent for non-status highlights such as "new" or "recommended". Keep every addition as a token so contrast tests still cover it.

### 7.7 Engineering foundations
- Error boundaries, file splits, state grouping, type scale, width tokens, CVA phone variants, skeletons and motion tokens (sections 5.1 to 5.9).

---

## 8. Process and tooling

### 8.1 Screenshot script (added)

- **Run:** `pnpm shots` (full guide in `docs/SCREENSHOTS.md`, delivered as a patch). Output goes to `screenshots/<platform>/<lang>-<theme>-<density>/<page>.png` with an `index.html` contact sheet.
- **Matrix:** Windows desktop, Android phone, small Android phone, Android tablet; light and dark; optional compact density and Japanese.
- **No backend needed:** it reuses the e2e fake agent with seeded templates, printers and history. A full run takes about 3 to 4 minutes.
- **Suggested additions** (from what this review ran into):
  1. Add `windows-narrow` presets at 900×700 and 1024×768 to cover the width range in 4.1.
  2. Capture the scroll content (scroll the main area and stitch, or enlarge the viewport) so below-the-fold content is reviewable.
  3. Seed more realistic data: long names, 200 history rows, failed jobs with long errors.
  4. Seed a second set of printers in error and offline states.

### 8.2 Regression protection
- Turn the screenshot set into Playwright visual-regression tests for each page in light and dark, on desktop and phone widths.
- Extend the token tests with rules that fail on arbitrary text sizes and new raw colors, and add an axe check per page.
- Review screenshot diffs in pull requests.

---

## 9. Rollout plan

**Phase 1: quick wins (about 1–2 weeks)**
1. ✅ Error boundaries (5.1).
2. ✅ Quiet the Print "ready" banner and clarify the paper warning (4.6, 4.7).
3. ✅ Templates row simplification: one primary action, labeled menu, hide Sync ID (4.2).
4. ✅ Tab discoverability on phone (4.3) and History row fixes (4.4).
5. ✅ Naming and copy fixes (4.11).
6. ✅ Type scale tokens, 12px floor, width and height tokens (5.3, 5.4).
7. ✅ Add narrow-width presets to the screenshot script (8.1).

**Phase 2: foundation (about 3–5 weeks)**
1. ✅ The compact layout for 768–1100px and table card mode (4.1, 5.10).
2. ✅ Phone header slimming and dismissible banners (4.5).
3. ✅ Designer improvements: save state, canvas balance, collapsed sample data (4.8).
4. ✅ Automation and Devices phone cleanup (4.9).
5. ✅ Accessibility pass: focus ring, keyboard, axe, selection cues (4.10, 5.7); 44 px touch
   targets and label-in-name on compact top-bar controls and notice dismiss buttons.
6. ✅ Page skeletons and motion tokens (5.8, 5.9).
7. ✅ Visual regression tests (8.2) — desktop light/dark screenshot + axe spec added; baselines mint in CI.

**Phase 3: structural (ongoing, one page per pull request)**
1. ✅ Split large pages and group state: Settings, Print, Designer, PrinterSetup (5.2). All four are now thin shells (108–287 lines) composing section components and small state hooks in `src/pages/{settings,print,designer,printer-setup}/`; state grouped into per-feature hooks. Rendered markup, testids and behavior unchanged (verified by testid/`id`/`aria-*` multiset audit against the pre-split pages).
2. ✅ Fold phone styling into component variants (5.6). Per-component phone rules now live on the components as `max-md:` Tailwind variants (ui/ buttons, card, fields, switch, tabs, sheet, dialog, Layout, PageHeader, DataTable, History, PhonePrintFlow, PrinterFormFields); `src/mobile.css` keeps only shared tokens, cross-cutting touch/focus rules and outer-container descendant rules. Rendered output unchanged.
3. ✅ Optional brand moments and design-system documentation (7.6). `highlight` token (violet, off every status hue; dark value lifted for contrast) + `highlight` Badge variant for non-status attention: "New" badge on community templates published in the last 14 days, one-time "first print" pill in both the desktop success banner and the phone success card (localStorage flag). Brand-soft tiles in EmptyState and SignInScreen. `docs/UI_GUIDE.md` documents the token, the variant, the brand moments and the phone toast close button.
4. Japanese typography and screenshot runs once Phase 2 is stable.

---

## 10. Success criteria

- At 800, 900, 1024 and 1280px, no page has clipped content or hidden primary actions.
- No page can blank the app: every route has a tested error boundary.
- No text under 12px and no arbitrary `text-[Npx]` in the code.
- Every phone list shows a way to reach every tab or filter, and failure reasons are readable without leaving the list.
- Every page passes axe with no serious or critical issues in light and dark.
- The core flow (open template, fill data, print) works start to finish with the keyboard on desktop.
- No page file over about 300 lines in the pages that were split.
- Screenshot tests cover each page on desktop and phone.

---

## 11. Open question

- Is a light brand refresh wanted, or must the current palette stay? (Affects section 7.6 only.)
