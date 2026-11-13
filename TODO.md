# Plan: Make Rust the only barcode and template renderer

**Repo:** SAR-dev/PrintNinja (Tauri-only)
**Status (2026-11-13):** Phases 1–3 are done in the working tree on `feat/template-renderer-fix` (not yet committed). Rust is the only renderer: the five formerly preview-only symbologies print, all six preview surfaces call the Rust `render_template_preview` command, and the JS render path (`renderTemplate.ts`), `bwip-js` and the parity-test machinery are deleted. `npx tsc -b` is clean and the full vitest suite is green (1049/1049). Phase 4: the Rust decode round-trip unit test is in `barcode.rs` and green in Docker, `cargo fmt --check` and `pnpm lint` are clean, and the changelog + docs updates are written (the whole changelog was rewritten to short, to-the-point bullets per the user). Rust verification is now fully green in Docker: clippy `-D warnings`, the full test suite (29/29 ok) including the new golden-pack render test — Android validation and the commit remain. See *Remaining* below.
**Decided (2026-11-12):** Phase 3 cuts over all preview surfaces at once, including the phone screens. The Rust `date` behavior wins over the JS locale behavior. If the Phase 1 spike fails, drop the uncovered symbologies from the app rather than hand-implementing encoders.

## Problem

Some barcode types show in the preview but print as an empty space. There are two renderers that are kept in sync by hand:

| Renderer | Where | Barcode support |
|---|---|---|
| Preview | JS: `handlebars.js` + `bwip-js` (Designer, Templates page preview) | All 14 types in `BARCODE_TYPES` |
| Print | Rust: `src-tauri/src/render/barcode.rs` (`barcoders` + `qrcode` crates) | `code128, code39, code93, ean13, ean8, upca, itf, codabar`, plus QR via `{{qrcode}}` |

Any type outside the Rust `SYMBOLOGIES` list makes `encode_linear()` return `None`, so it prints blank. `PREVIEW_ONLY_SYMBOLOGIES` (in `src/lib/utils/barcode.ts`) is derived automatically and currently holds five types:

- `upce`
- `itf14`
- `datamatrix`
- `pdf417`
- `aztec`

`docs/MISSING_FEATURES.md` #37 and `docs/TEST_CHECKLIST.md` list only three of these. The code treats five as preview-only.

## Goal

One source of truth: Rust. The preview calls the same code path as printing, and the JS render path is removed.

## Phase 1: Close the barcode gap in Rust — DONE

**Result:** `PREVIEW_ONLY_SYMBOLOGIES` becomes empty.

1. **Spike (about half a day).** In a scratch crate, evaluate `rxing` (ZXing port) for Data Matrix, PDF417, Aztec, UPC-E and ITF-14. Check:
    - It returns a module matrix that `barcode.rs` can turn into the existing inline SVG (no image features needed).
    - Binary size, compile time, and Android build impact (the project ships an Android plugin).
    - License.
    - If it fails any check, fall back per symbology: a standalone crate where one exists (e.g. `datamatrix`), otherwise **drop the type from `BARCODE_TYPES`** (decided 2026-11-12: the app offers only what it can print — no hand-rolled encoders). Dropped types disappear from the preview-only list on their own (it is derived from `BARCODE_TYPES`).
2. **Extend `barcode.rs`.**
    - Add a 2D path next to `qr_svg` for Data Matrix, PDF417 and Aztec.
    - Add UPC-E and ITF-14 to `encode_linear`. ITF-14 is ITF with 14 digits plus a bearer frame drawn by us.
3. **Update the symbology lists.**
    - Extend `SYMBOLOGIES` in Rust and `PRINT_SYMBOLOGIES` in `src/lib/utils/barcode.ts`.
    - Make `buildBarcodeSnippet` always emit `{{barcode ...}}` instead of a static SVG.
    - Extend `validateBarcode` in `src/lib/utils/barcode.ts` for `upce` and `itf14` (both skip validation today). Match what the new Rust encoders reject, so the Designer dialog reports a bad check digit at design time instead of the print engine silently drawing an empty spot.
4. **Remove the preview-only machinery.**
    - The "preview only" badge in `HelpersPanel.tsx`.
    - The Print-page confirmation.
    - `findPreviewOnlyBarcodes` and the related i18n strings.

## Phase 2: Parity test (safety net while two engines exist) — DONE (retired per plan)

The dual-engine parity test ran green, then was retired in Phase 3 as planned. The Rust print renderer is itself proven to decode all 14 symbologies (round-trip via rxing). A slim print-side decode round-trip is worth keeping as a Rust unit test in `barcode.rs` — see *Remaining*.

- For every symbology, encode a sample in both engines and **decode both outputs** (comparing raw module patterns is not practical: bwip-js does not expose its module grid).
- Practical recipe, pure Rust and CI-runnable without a browser: rasterize each engine's SVG to PNG with `resvg` (dev-dependency only — the test binary, not the app), decode with `rxing`, compare the decoded payloads. This covers the 2D types too.
- Run it in CI.
- Drop it after Phase 3.

## Phase 3: Move preview to Rust — DONE (in working tree)

All six callers cut over at once (desktop and phone), Designer calls debounced (150ms, stale-cancelled), the JS render path and `bwip-js` deleted, and the parity-test machinery retired. The command is `render_template_preview(html, css, compiled_css, records)` in `src-tauri/src/commands/print.rs`, registered in `lib.rs`.

1. Add a Tauri command, for example `render_template_preview(html, css, compiled_css, records: Vec<Value>) -> Result<Vec<String>, String>`:
    - **One document per record.** The JS callers use `renderDesignPages` — one framed document per record, so each record can paginate independently. A single joined document does not fit that.
    - **Reuse the print wrapper.** `commands/print.rs` already wraps rendered pages in `<!DOCTYPE html>…<style>{styles}</style>` (`print.rs:384`) using the private `build_template_css` (`print.rs:349`) — lift that function to a shared location and call it from both paths.
    - **Keep the preview's CSP hardening.** The JS `wrapDocument` injects a CSP meta tag; the print wrapper does not. The preview command should inject the same CSP so the sandboxed preview iframe stays as hardened as it is today.
    - **Surface errors instead of hiding them.** `TemplateEngine::render` returns `Err` on a broken template; the JS preview renders the escaped raw source. The command should return the engine's error string, and the UI falls back to the raw source locally (it already holds it). Note: handlebars-rs error messages may be less navigable than handlebars.js's (which include the source line and a caret pointer) — check the Designer error UX after the cutover.
2. Switch these callers to it:
    - `CanvasPane.tsx` (designer canvas, `renderTemplate`)
    - `CanvasWorkspace.tsx` (its call is `getTemplateError`, a compile-only check — cover it through the command's error path)
    - `PhoneDesignerViewer.tsx`
    - `PhonePrintFlow.tsx`
    - `Templates.tsx` (`openPreview`)
    - `Print.tsx`
    (`Designer.tsx` itself does not call the render functions — it hosts the canvas components above.)
3. Debounce Designer calls and cancel stale ones.
4. Delete from the JS side:
    - The helper set in `src/lib/render/renderTemplate.ts`.
    - The JS `{{barcode}}` / `{{qrcode}}` helpers.
    - `bwip-js` (after Phase 2 is retired) and the bwip-js-dependent functions in `src/lib/utils/barcode.ts` (`generateBarcodeSvg`, `buildBarcodeHtml`). **Keep** the rest of `barcode.ts`: `validateBarcode`, `BARCODE_TYPES` and `buildBarcodeSnippet` (always a helper after Phase 1) are pure JS and still serve the Designer dialog.
5. **Keep `compileTemplateCss` (Tailwind) in JS.** It runs at save time and the result is stored as `compiled_css`, so it is not part of this cutover.

## Phase 4: Tests and docs — PARTIAL

Done so far:
- `renderTemplate.test.ts` → `templateCss.test.ts`: base-CSS, `buildTemplateCss`, `resolvePaper` blocks kept; new blocks for `rawSourceDocument`, `shortTemplateError`, `renderDesignPagesRust` and `renderTemplateRust` (the IPC command is mocked; the engine itself is tested in Rust).
- `packs.test.ts`: the render-based "no leftover mustache" check is replaced by a static resolver (`unresolvedMustaches`) — every mustache well-formed, only known helpers/blocks, and every data path resolves against the pack's `mockData` with `#each` context tracking. The render itself is covered by the Rust tests and the e2e suite.
- `barcode.test.ts`: rewritten without `bwip-js`; the `validateBarcode` and `buildBarcodeSnippet` cases kept verbatim.
- `designer.test.tsx`: `CanvasPane` tests rewritten for the presentational `doc` prop; the deleted `getTemplateError` tests removed; the `CanvasWorkspace` error-banner test now drives the mocked `render_template_preview` command (reject → banner, resolve → clears).

## Remaining (deferred — vitest-only for now, per user 2026-11-12)

1. ~~**Get `pnpm test` fully green**~~ — **DONE (2026-11-13, 1049/1049 in 81 files)**. The original 7 failures were fixed first: `packs.test.ts` (resolver bugs: block args must be tokenized from `inner.slice(1)`, paths need a per-part `walk()`, `{{/each}}` must pop the context) and `designer.test.tsx` (file-level `beforeEach` defaulting `invokeMock` to a resolved document). The full-suite run then exposed 70 failures in 9 files (`print`, `designerPage`, `printSelection*`, `paperSelect`, `mobile`, `templates`, `printMatching`, `agentContract`) with one root cause: those files mock `@tauri-apps/api/core` with a catch-all `return null`, and the new `render_template_preview` IPC resolved `null` straight into `setPreviewPages(null)` → crash at `Print.tsx:1775` → the React error boundary took down every test in the tree. Fixed in `src/lib/render/rustPreview.ts`: a non-array/non-string resolve is thrown into the fallback path (raw-source pages + `error`), with a regression test in `templateCss.test.ts`. The last 4 failures: `agentContract` (the fake agent now acknowledges `render_template_preview` as a stub, like `print_html`), and the `designerPage`/`templates` mocks, which now emulate the engine (`fakeRenderTemplatePreview`: one document per record, unbalanced `{{#}}` blocks throw, CSS carried into the document) — plus a file-level `beforeEach` in `designerPage.test.tsx` resetting the invoke implementation, because one test leaked its custom mock into later tests.
2. ~~**Rust unit test**~~ — **DONE (2026-11-13).** The 14-symbology decode round-trip (`print_renderer_decodes_to_expected_payload`) lives in the `#[cfg(test)]` module of `src-tauri/src/render/barcode.rs`: every `SYMBOLOGIES` entry must have an inline sample, each is encoded, rasterized via `rxing::SVGLuminanceSource` (resvg) and decoded with `MultiFormatReader`, and the payload is compared (UPC-E → 8-digit form, Codabar → start/stop chars stripped). The fixture file is inlined as `ROUNDTRIP_SAMPLES`; the rxing dev-dependency stays. Green in Docker: 16/16 barcode+handlebars tests pass.
3. ~~**Rust verification**~~ — **DONE (2026-11-13).** `cargo fmt --check` clean; `cargo clippy --all-targets -- -D warnings` and the full `cargo test` suite both green in the Docker test container (29/29 test binaries ok), including the new `tests/pack_renders.rs` golden-pack render test.
4. ~~**Lint**~~ — **DONE (2026-11-13):** `pnpm lint` exits 0 (four auto-format fixes applied to `rustPreview.ts`, `designerPage.test.tsx`, `packs.test.ts`, `templateCss.test.ts`; the only remaining warnings are broken symlinks in the gitignored local `src-tauri/gen/android` artifacts).
5. ~~**CHANGELOG.md**~~ — **DONE (2026-11-13):** Unreleased now carries the engine-cutover entry (preview rendered by the built-in engine on all six surfaces, `bwip-js` deleted) with the `{{date}}` behavior change (locale formats → fixed patterns + strftime, RFC 3339 only, non-dates print as-is) and the error-banner UX note. Helper diff audited: `currency`, `number`, `padLeft`, `upper`, `lower` are behaviorally identical between the deleted JS and the Rust engine — only `date` changed, so it is the only one called out.
6. ~~**Docs**~~ — **DONE (2026-11-13):** `docs/TEST_CHECKLIST.md:21` now says every barcode type prints (with a scanner-capability note for 2D/UPC-E/ITF-14); `docs/MISSING_FEATURES.md` — the stale known-gaps bullet for item 37 is removed and the status table row says it was solved the Rust way (option b), all five types drawn by the built-in engine, preview through the same engine as print.
7. **Android build validation** of the new command (phone surfaces cut over at once).
8. ~~**Golden pack renders**~~ — **DONE (2026-11-13).** Implemented as a Rust integration test `src-tauri/tests/pack_renders.rs` (the e2e suite fakes the Tauri IPC, so no Rust runs there): the checked-in fixture `src-tauri/tests/fixtures/pack_renders.json` — generated from the TS packs by `src/test/packRenders.test.ts`, which fails when packs drift from the fixture (regenerate with `UPDATE_PACK_FIXTURES=1 pnpm vitest run src/test/packRenders.test.ts`) — renders invoice, receipt, shipping label and delivery slip through `TemplateEngine`; asserts needle values, no unresolved mustaches, and a barcode SVG where the pack draws one. Green in Docker.
9. **Commit** the working tree once the above is green.

## Risks

- **`date` helper — decided: Rust wins.** JS: default `toLocaleString()`, `"short"` = `toLocaleDateString()`, any other format string falls back to `toLocaleString()`. Rust: default `%Y-%m-%d`, fixed `"short"` / `"long"` / `"time"` / `"datetime"`, any other string is a strftime pattern. After the cutover, `{{date x}}` output changes in every locale, and `"long"` / `"datetime"` get real formats where JS showed a locale string. Audit the bundled packs and call the change out in the changelog.
- **Other JS/Rust helper differences.** Beyond `date`, diff the remaining helpers (`currency`, `number`, `padLeft`, `upper`, `lower`) before deleting the JS side.
- **Broken-template behavior differs today.** The JS preview renders the escaped raw source; the Rust print path fails the job (P14, `commands/print.rs`). After the cutover the preview surfaces the engine error and falls back to the raw source locally — print behavior stays as is.
- **Preview latency.** One IPC call per keystroke needs debouncing.
- **Android and phone viewers — in scope (decided: cut over at once).** `PhoneDesignerViewer` and `PhonePrintFlow` switch in the same change; validate the new command on the Android build in that phase.
- **New dependencies.** Check binary size and the Windows and Android builds. `resvg` (Phase 2) is a dev-dependency only — test binary, not the app.

## Order of work

1. Phase 1 (fixes the actual bug).
2. Phase 2 (guard).
3. Phase 3 (the long-term fix).
4. Phase 4 (cleanup).

Phases 1 and 2 can ship on their own and leave the app in a working state. Phase 3 is a single cutover of all preview surfaces, desktop and phone (decided 2026-11-12).