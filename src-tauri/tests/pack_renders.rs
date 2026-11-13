//! Golden pack renders: the shipped template packs (invoice, receipt,
//! shipping label, delivery slip) must render through the built-in engine —
//! the same code every preview surface and the print path use. A pack that
//! stops rendering (a dropped helper, a renamed data key, a broken barcode
//! call) fails here instead of showing blank to a user.
//!
//! The packs live in TypeScript (`src/lib/templates/packs/*.ts`); the
//! checked-in fixture `tests/fixtures/pack_renders.json` is generated from
//! them by `src/test/packRenders.test.ts` (run it with
//! `UPDATE_PACK_FIXTURES=1` after a pack change). That same test fails when
//! the packs drift from the fixture, so the coverage cannot rot silently.
//! The e2e suite cannot carry this check: it fakes the Tauri IPC surface,
//! so no Rust ever runs in it.

use printninja_lib::render::handlebars::TemplateEngine;
use serde_json::Value;

#[test]
fn golden_packs_render_through_the_engine() {
    let text = std::fs::read_to_string("tests/fixtures/pack_renders.json")
        .expect("read pack_renders.json");
    let doc: Value = serde_json::from_str(&text).expect("parse pack_renders.json");
    let packs = doc["packs"].as_array().expect("packs array");
    assert!(!packs.is_empty());

    let engine = TemplateEngine::new();
    for pack in packs {
        let id = pack["id"].as_str().unwrap_or("?");
        let html = pack["html"].as_str().unwrap_or("");
        let record = &pack["mockData"];

        let out = engine
            .render(html, record)
            .unwrap_or_else(|e| panic!("{id}: render failed: {e}"));

        // Mock values that must survive the render: a renamed data key
        // renders empty, which the needle catches (an unresolved path
        // alone only leaves the page sparse, not broken-looking).
        let needles = pack["needles"].as_array().expect("needles array");
        assert!(!needles.is_empty(), "{id}: fixture has no needles");
        for needle in needles {
            let text = needle.as_str().expect("needle is a string");
            assert!(
                out.contains(text),
                "{id}: rendered page is missing `{text}`"
            );
        }

        assert!(
            !out.contains("{{"),
            "{id}: unresolved mustache in rendered page"
        );

        // Every golden pack draws its tracking number as a Code 128, so a
        // dead `{{barcode}}` call is a blank label, not a silent no-op.
        if html.contains("{{barcode") || html.contains("{{qrcode") {
            assert!(out.contains("<svg"), "{id}: barcode SVG missing");
        }
    }
}
