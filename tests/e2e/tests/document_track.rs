//! Document-track e2e: html → browser PDF → delivery → verification
//! (plan §5.3).
//!
//! Where the machine has a headless browser (Edge on Windows,
//! Chromium/Chrome on Linux), this runs the whole document track end
//! to end: the template's document gets its data substituted in, the
//! browser prints it to a PDF, and the PDF is delivered over IPP to a
//! page printer, byte-verified on disk. Where no browser is installed
//! (the CI test container), the test verifies the honest no-browser
//! error instead — the pipeline must say what is missing, not fake a
//! document.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use pn_browser::BrowserError;
use pn_e2e::Printer;
use pn_job::{run, IppFactory, JobResult, JobSpec};
use pn_planner::{plan, OutputPath};
use pn_profiles::Profile;
use pn_scene::{substitute, Field, Format, Media, Records, Template};

const HOST: &str = "127.0.0.1";

static WORK_SEQ: AtomicUsize = AtomicUsize::new(0);

/// A scratch directory for one render; unique per test thread.
fn work_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "pn-e2e-doc-{}-{}",
        std::process::id(),
        WORK_SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

/// A page profile with no status dialect: page printers confirm through
/// the IPP reply, not through a query on the line.
fn pdf_profile() -> Profile {
    pn_profiles::parse(
        r#"
[profile]
model = "Virtual Page"
language = "pdf"
media = ["page"]
[delivery]
chunk_bytes = 512
pause_ms = 0
close_delay_ms = 0
keep_open_for_status = false
"#,
    )
    .expect("test profile is valid")
}

fn ipp_factory(ipp_port: u16) -> IppFactory {
    IppFactory {
        address: format!("{HOST}:{ipp_port}"),
        user: None,
        document_format: "application/pdf",
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}

/// An A4 invoice: the whole document is HTML, bound to two fields.
fn document_template() -> Template {
    Template {
        format: Format::Html,
        html: Some(
            "<!doctype html><html><head><meta charset=\"utf-8\"><style>@page{size:210mm 297mm;margin:20mm}body{font-family:sans-serif}</style></head><body><h1>{{title}}</h1><p>{{body}}</p></body></html>"
                .into(),
        ),
        media: Media::Page {
            width_mm: 210.0,
            height_mm: 297.0,
        },
        fields: vec![
            Field {
                name: "title".into(),
                kind: Default::default(),
            },
            Field {
                name: "body".into(),
                kind: Default::default(),
            },
        ],
        elements: Vec::new(),
        fonts: vec![],
    }
}

#[test]
fn an_html_document_is_rendered_by_the_browser_and_printed() {
    let template = document_template();
    template.validate().expect("the document template is valid");
    let profile = pdf_profile();

    // The planner routes an html document to the browser track. The
    // document track never reads the job, so an empty one stands in.
    let job = pn_scene::ExpandedJob { outputs: vec![] };
    assert_eq!(
        plan(&job, &template, &profile).unwrap().path,
        OutputPath::Browser
    );

    // One record fills the document's bindings.
    let records =
        Records::from_json(r#"[{"title":"INVOICE 1042","body":"Two bolts, one nut. Thank you."}]"#)
            .unwrap();
    let record = &records.0[0];
    let doc = substitute(template.html.as_deref().unwrap(), record);
    assert!(!doc.contains("{{"), "every binding was filled");

    match pn_browser::render_pdf(&doc, &work_dir()) {
        // No browser on this machine: the renderer says so in plain
        // words and names every location it checked.
        Err(BrowserError::NoBrowser { searched }) => {
            assert!(
                !searched.is_empty(),
                "a no-browser error names where it looked"
            );
        }
        Err(e) => panic!("the render failed: {e}"),
        Ok(pdf) => {
            assert!(pdf.starts_with(b"%PDF-"), "the browser printed a PDF");

            // The PDF is the document: delivered over IPP like any page
            // job, and verified on disk at the printer.
            let vp = Printer::spawn("ok");
            let spec = JobSpec::new("one document", vec![pdf.clone()]);
            let result = run(&spec, &profile, &ipp_factory(vp.ipp_port));
            assert_eq!(result, JobResult::SentUnconfirmed);

            let jobs = vp.wait_for_jobs(1, Duration::from_secs(10));
            assert_eq!(jobs.len(), 1, "exactly one document is one saved job");
            let data = vp.read_job(&jobs[0]);
            assert!(
                contains_bytes(&data, &pdf),
                "the rendered PDF is missing from the saved job"
            );
        }
    }
}
