use pn_profiles::{
    checklist_for, checklist_text, load_dir, merge, parse, ChecklistKind, Language, Media,
    ProfileError,
};

const GK420D: &str = r#"
[profile]
model = "GK420d"
aliases = ["zebra gk420"]
status = "untested"
language = "zpl"
mode = "zpl"
dpi = 203
head_width_dots = 864
media = ["label"]
min_gap_dots = 8

[fonts]
native = ["0", "1", "2", "3", "4"]
code_pages = ["437", "850", "1252"]
unicode_native = false

[barcodes]
native = ["CODE128", "EAN13", "QR", "PDF417"]

[delivery]
chunk_bytes = 1024
pause_ms = 10
close_delay_ms = 500
flow_control = "pace"
keep_open_for_status = true

[status]
query = "^U"
expected_prefix = "STATUS"
poll_after_ms = 200
reports_paper = true
reports_cover = false
reports_paused = true

[[quirks]]
id = "needs-finalize"
note = "Last line must be followed by ^PKS or a 200ms delay"
evidence = "raw-console/2026-11-18-gk420d.txt"
"#;

#[test]
fn parses_the_plan_example() {
    let p = parse(GK420D).unwrap();
    assert_eq!(p.profile.model, "GK420d");
    assert_eq!(p.profile.language, Language::Zpl);
    assert_eq!(p.profile.mode.as_deref(), Some("zpl"));
    assert_eq!(p.profile.dpi, Some(203));
    assert_eq!(p.profile.head_width_dots, Some(864));
    assert_eq!(p.profile.media, vec![Media::Label]);
    assert!(p.answers_status());
    assert_eq!(p.first_native_barcode(), Some("CODE128"));
    assert!(!p.unicode_native());
    assert_eq!(p.quirks.len(), 1);
}

#[test]
fn minimal_profile_gets_sane_defaults() {
    let p = parse(
        r#"
[profile]
model = "Tiny"
language = "escpos"
media = ["continuous"]
"#,
    )
    .unwrap();
    assert_eq!(p.profile.status, pn_profiles::Status::Untested);
    let d = &p.delivery;
    assert_eq!(d.chunk_bytes, 1024);
    assert_eq!(d.pause_ms, 10);
    assert_eq!(d.close_delay_ms, 500);
    assert_eq!(d.flow_control, pn_profiles::FlowControl::Pace);
    assert!(d.keep_open_for_status);
    assert_eq!(p.profile.aliases, Vec::<String>::new());
    assert!(p.fonts.native.is_empty());
    assert!(!p.answers_status());
}

#[test]
fn pdf_language_is_for_document_printers() {
    let p = parse(
        r#"
[profile]
model = "HP LaserJet 1010"
language = "pdf"
media = ["page"]
"#,
    )
    .unwrap();
    assert_eq!(p.profile.language, Language::Pdf);
    assert_eq!(p.profile.media, vec![Media::Page]);
}

#[test]
fn empty_model_is_rejected() {
    let e = parse(
        r#"
[profile]
model = " "
language = "zpl"
media = ["label"]
"#,
    )
    .unwrap_err();
    assert!(matches!(
        e,
        pn_profiles::ParseError::Validation(ProfileError::EmptyModel)
    ));
}

#[test]
fn missing_media_is_rejected() {
    let e = parse(
        r#"
[profile]
model = "X"
language = "zpl"
media = []
"#,
    )
    .unwrap_err();
    assert!(matches!(
        e,
        pn_profiles::ParseError::Validation(ProfileError::NoMedia)
    ));
}

#[test]
fn status_query_without_prefix_is_rejected() {
    let e = parse(
        r#"
[profile]
model = "X"
language = "zpl"
media = ["label"]

[status]
query = "^U"
"#,
    )
    .unwrap_err();
    assert!(matches!(
        e,
        pn_profiles::ParseError::Validation(ProfileError::StatusPrefixMissing)
    ));
}

#[test]
fn width_inconsistency_is_rejected() {
    let e = parse(
        r#"
[profile]
model = "X"
language = "zpl"
media = ["label"]
dpi = 203
head_width_dots = 864
printable_width_mm = 104
"#,
    )
    .unwrap_err();
    match e {
        pn_profiles::ParseError::Validation(ProfileError::WidthMismatch { head, expected }) => {
            assert_eq!(head, 864);
            assert_eq!(expected, 831);
        }
        other => panic!("expected WidthMismatch, got {other:?}"),
    }
}

#[test]
fn width_consistency_passes_within_one_dot() {
    // 203 dpi × 101.6 mm / 25.4 = 812.8 → 813; head 812 is within one dot.
    parse(
        r#"
[profile]
model = "X"
language = "zpl"
media = ["label"]
dpi = 203
head_width_dots = 812
printable_width_mm = 101.6
"#,
    )
    .unwrap();
}

#[test]
fn duplicate_quirk_ids_are_rejected() {
    let e = parse(
        r#"
[profile]
model = "X"
language = "zpl"
media = ["label"]

[[quirks]]
id = "a"
note = "n"
evidence = "e"

[[quirks]]
id = "a"
note = "n"
evidence = "e"
"#,
    )
    .unwrap_err();
    assert!(matches!(
        e,
        pn_profiles::ParseError::Validation(ProfileError::DuplicateQuirk { .. })
    ));
}

#[test]
fn quirk_without_evidence_is_rejected() {
    let e = parse(
        r#"
[profile]
model = "X"
language = "zpl"
media = ["label"]

[[quirks]]
id = "a"
note = "n"
evidence = ""
"#,
    )
    .unwrap_err();
    assert!(matches!(
        e,
        pn_profiles::ParseError::Validation(ProfileError::QuirkMissingEvidence { .. })
    ));
}

#[test]
fn invalid_toml_is_reported() {
    let e = parse("[profile\nmodel = ").unwrap_err();
    assert!(
        matches!(e, pn_profiles::ParseError::Toml(_)),
        "expected Toml error, got {e:?}"
    );
}

#[test]
fn merge_overrides_field_by_field() {
    let base = parse(GK420D).unwrap();
    let user = r#"
[profile]
aliases = ["my printer"]

[delivery]
pause_ms = 25
"#;
    let merged = merge(&base, user).unwrap();
    // Overridden:
    assert_eq!(merged.profile.aliases, vec!["my printer".to_string()]);
    assert_eq!(merged.delivery.pause_ms, 25);
    // Everything else kept:
    assert_eq!(merged.profile.model, "GK420d");
    assert_eq!(merged.delivery.chunk_bytes, 1024);
    assert_eq!(merged.status.as_ref().unwrap().query, "^U");
    assert_eq!(merged.quirks.len(), 1);
}

#[test]
fn merge_arrays_are_replaced_not_concatenated() {
    let base = parse(GK420D).unwrap();
    let user = r#"
[barcodes]
native = ["QR"]
"#;
    let merged = merge(&base, user).unwrap();
    assert_eq!(merged.first_native_barcode(), Some("QR"));
    // Fonts array untouched:
    assert_eq!(merged.fonts.native.len(), 5);
}

#[test]
fn merge_that_breaks_validation_is_rejected() {
    // The deep merge keeps the base's expected_prefix for a
    // query-only override, so the section stays valid; a width
    // override that contradicts the base's dpi × head is not.
    let base = parse(GK420D).unwrap();
    let user = r#"
[profile]
printable_width_mm = 104
"#;
    let e = merge(&base, user).unwrap_err();
    assert!(
        matches!(
            e,
            pn_profiles::ParseError::Validation(ProfileError::WidthMismatch { .. })
        ),
        "expected WidthMismatch, got {e:?}"
    );
}

#[test]
fn loads_the_shipped_profile_dir() {
    let set = load_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/profiles")).unwrap();
    let profiles: Vec<_> = set.profiles().collect();
    assert!(
        !profiles.is_empty(),
        "shipped profile dir must not be empty"
    );
    let gk = set.find("gk420d").expect("gk420d by model");
    assert_eq!(gk.profile.model, "GK420d");
    assert!(set.find("zebra gk420").is_some(), "lookup by alias");
    assert!(set.find("GK420D").is_some(), "lookup is case-insensitive");
    assert!(set.find("nope").is_none());
}

#[test]
fn every_printer_the_current_app_ships_has_a_profile() {
    // Phase 2 exit: every model the current app knows (fixtures in
    // capabilities.rs, seeds in scripts/screenshots.mjs, the plan's
    // reference example, and the on-hand device) exists as a profile.
    let set = load_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/profiles")).unwrap();
    for model in [
        "GK420d",
        "ZT411",
        "ZD421",
        "TTP-244 Pro",
        "CT-S500",
        "TM-T88VII",
        "QL-820NWB",
        "Generic Thermal Printer 58mm",
        "RP325",
        "Office Laser (CUPS)",
        "B-FP2D",
    ] {
        assert!(set.find(model).is_some(), "missing profile for {model}");
    }
    // And none is marked verified yet: hardware verification of the
    // on-hand profile is the rest of the phase 2 exit, the other
    // profiles are verified in phase 10.
    for (_, p) in set.profiles() {
        assert_ne!(
            p.profile.status,
            pn_profiles::Status::Verified,
            "{} must not be verified yet",
            p.profile.model
        );
    }
}

#[test]
fn duplicate_models_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["a.toml", "b.toml"] {
        std::fs::write(
            dir.path().join(name),
            r#"
[profile]
model = "Dup"
language = "zpl"
media = ["label"]
"#,
        )
        .unwrap();
    }
    let e = load_dir(dir.path()).unwrap_err();
    assert!(
        matches!(e, pn_profiles::ProfileSetError::DuplicateModel { .. }),
        "expected DuplicateModel, got {e:?}"
    );
}

#[test]
fn alias_colliding_with_a_model_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("a.toml"),
        r#"
[profile]
model = "A"
language = "zpl"
media = ["label"]
"#,
    )
    .unwrap();
    std::fs::write(
        dir.path().join("b.toml"),
        r#"
[profile]
model = "B"
aliases = ["a"]
language = "zpl"
media = ["label"]
"#,
    )
    .unwrap();
    let e = load_dir(dir.path()).unwrap_err();
    assert!(
        matches!(e, pn_profiles::ProfileSetError::AliasCollision { .. }),
        "expected AliasCollision, got {e:?}"
    );
}

#[test]
fn empty_dir_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        load_dir(dir.path()).unwrap_err(),
        pn_profiles::ProfileSetError::EmptyDir(_)
    ));
}

#[test]
fn thermal_checklist_covers_all_kinds() {
    let p = parse(GK420D).unwrap();
    let items = checklist_for(&p);
    let kinds: Vec<_> = items.iter().map(|i| i.kind).collect();
    assert!(kinds.contains(&ChecklistKind::MinimalText));
    assert!(kinds.contains(&ChecklistKind::Label));
    assert!(kinds.contains(&ChecklistKind::LongJob));
    assert!(kinds.contains(&ChecklistKind::TwoJobsBackToBack));
    assert!(kinds.contains(&ChecklistKind::StatusQuery));
    // The barcode item names the first native symbol.
    let label = items
        .iter()
        .find(|i| i.kind == ChecklistKind::Label)
        .unwrap();
    assert!(label.description.contains("CODE128"));
}

#[test]
fn page_printers_get_the_os_print_path() {
    let p = parse(
        r#"
[profile]
model = "HP LaserJet 1010"
language = "pdf"
media = ["page"]
"#,
    )
    .unwrap();
    let items = checklist_for(&p);
    let kinds: Vec<_> = items.iter().map(|i| i.kind).collect();
    assert!(kinds.contains(&ChecklistKind::MinimalText));
    assert!(kinds.contains(&ChecklistKind::Label));
    assert!(kinds.contains(&ChecklistKind::TwoJobsBackToBack));
    assert!(!kinds.contains(&ChecklistKind::LongJob));
    assert!(!kinds.contains(&ChecklistKind::StatusQuery));
    let minimal = items
        .iter()
        .find(|i| i.kind == ChecklistKind::MinimalText)
        .unwrap();
    assert!(minimal.description.contains("OS print path"));
}

#[test]
fn checklist_text_carries_the_model_name() {
    let p = parse(GK420D).unwrap();
    let text = checklist_text(&p);
    assert!(text.contains("GK420d"));
    assert!(text.contains("zpl"));
    assert!(text.contains("203"));
}
