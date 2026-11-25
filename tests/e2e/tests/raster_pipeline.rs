//! Raster pipeline e2e: scene → render → raster bytes → delivery →
//! verification (plan §5).
//!
//! The full thermal track, end to end, against the virtual printer:
//! a scene template and its data records expand to one page per label,
//! the planner picks the raster path, each page is painted onto the
//! renderer at the profile's dpi, the rendered dots are wrapped in the
//! printer's language (ZPL), the job is delivered over raw TCP, and the
//! bytes that reached the printer are verified on disk. This is the
//! whole §5 pipeline — nothing between the scene and the wire is stubbed.

use std::time::Duration;

use pn_e2e::Printer;
use pn_encoders::raster;
use pn_job::{run, JobResult, JobSpec, TcpFactory};
use pn_planner::{plan, OutputPath};
use pn_profiles::Profile;
use pn_render::{dots_for_mm, fit_to_head, paint_page, RasterPage, Renderer};
use pn_scene::{
    expand, At, BarcodeKind, Element, Format, Media, Placement, Records, Size, Template, TextStyle,
};

const HOST: &str = "127.0.0.1";

fn factory(raw_port: u16) -> TcpFactory {
    TcpFactory {
        host: HOST.into(),
        port: raw_port,
        connect_deadline: Duration::from_secs(2),
    }
}

/// A ZPL label profile that carries its physicals (dpi, head width) and
/// a status dialect, so the job can end `Confirmed`. The three
/// physicals agree within a dot, as cross-field validation requires.
fn zpl_profile() -> Profile {
    pn_profiles::parse(
        r#"
[profile]
model = "Virtual ZPL"
language = "zpl"
mode = "zpl"
media = ["label"]
dpi = 203
head_width_dots = 384
printable_width_mm = 48
[fonts]
native = ["0"]
code_pages = ["437"]
[barcodes]
native = ["CODE128"]
[delivery]
chunk_bytes = 512
pause_ms = 10
close_delay_ms = 0
keep_open_for_status = true
[status]
query = "~HS"
expected_prefix = "\u0002"
poll_after_ms = 200
"#,
    )
    .expect("test profile is valid")
}

/// A 40 × 50 mm label: a bound heading, a Code 128, a rule and a framed
/// box — one of each shape the scene track can place.
fn label_template() -> Template {
    Template {
        format: Format::Scene,
        html: None,
        media: Media::Label {
            width_mm: 40.0,
            height_mm: 50.0,
        },
        fields: vec![
            pn_scene::Field {
                name: "name".into(),
                kind: Default::default(),
            },
            pn_scene::Field {
                name: "sn".into(),
                kind: Default::default(),
            },
        ],
        elements: vec![
            Element::Text {
                at: At {
                    x_mm: 2.0,
                    y_mm: 2.0,
                },
                size: Size {
                    w_mm: 36.0,
                    h_mm: 4.0,
                },
                content: "{{name}}".into(),
                style: TextStyle {
                    size_mm: 3.0,
                    font: None,
                    bold: true,
                    italic: false,
                    align: pn_scene::Align::Left,
                },
                page: Placement::Every,
            },
            Element::Barcode {
                at: At {
                    x_mm: 2.0,
                    y_mm: 10.0,
                },
                size: Size {
                    w_mm: 36.0,
                    h_mm: 12.0,
                },
                kind: BarcodeKind::Code128,
                value: "{{sn}}".into(),
                show_text: true,
                page: Placement::Every,
            },
            Element::Line {
                at: At {
                    x_mm: 2.0,
                    y_mm: 26.0,
                },
                length_mm: 36.0,
                thickness_mm: 0.3,
                vertical: false,
                page: Placement::Every,
            },
            Element::Rect {
                at: At {
                    x_mm: 2.0,
                    y_mm: 30.0,
                },
                size: Size {
                    w_mm: 36.0,
                    h_mm: 15.0,
                },
                fill: false,
                page: Placement::Every,
            },
        ],
        fonts: vec![],
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}

/// Render one expanded page onto the renderer at the profile's dpi, the
/// raster width capped to the head, and wrap it for the encoder.
fn render_page(page: &pn_scene::Page, profile: &Profile) -> RasterPage {
    let dpi = profile.profile.dpi.expect("the profile pins its dpi") as u32;
    let w = fit_to_head(dots_for_mm(40.0, dpi), profile.profile.head_width_dots);
    let h = dots_for_mm(50.0, dpi);
    let mut r = Renderer::new(dpi, w, h);
    paint_page(page, &mut r);
    let bmp = r.into_page();
    assert!(
        bmp.to_bytes().iter().any(|&b| b != 0),
        "the painted label has ink"
    );
    RasterPage::new(bmp, 40.0, 50.0)
}

#[test]
fn a_scene_label_job_renders_raster_bytes_and_prints_confirmed() {
    let template = label_template();
    let profile = zpl_profile();

    // Two records expand to two label outputs, one page each.
    let records = Records::from_json(
        r#"[{"name":"BOLT M8","sn":"SN-1001"},{"name":"NUT M8","sn":"SN-1002"}]"#,
    )
    .unwrap();
    let job = expand(&template, &records).expect("the template and records agree");
    assert_eq!(job.outputs.len(), 2, "one output per record");
    assert!(
        job.outputs.iter().all(|o| o.pages.len() == 1),
        "a label output is exactly one page"
    );

    // The planner tries the native path first and refuses it: the
    // heading is bold, and the printer's native fonts are plain. The
    // raster path takes the job, and the plan records why.
    let plan = plan(&job, &template, &profile).unwrap();
    assert_eq!(plan.path, OutputPath::Raster);
    assert!(plan.fallback.as_deref().unwrap().contains("bold"));

    // Each page renders and wraps into one ZPL unit — a ^XA…^XZ holding
    // the whole label as a single ^GFA graphic.
    let units: Vec<Vec<u8>> = job
        .outputs
        .iter()
        .map(|o| raster(&[render_page(&o.pages[0], &profile)], &profile).unwrap())
        .collect();
    for unit in &units {
        let zpl = String::from_utf8_lossy(unit);
        assert!(
            zpl.contains("^XA") && zpl.contains("^XZ"),
            "one label per unit"
        );
        assert!(zpl.contains("^GFA"), "the label is a raster graphic");
    }

    // The job is delivered and confirmed, and the bytes reached the
    // printer: the saved job holds every unit.
    let vp = Printer::spawn("ok");
    let spec = JobSpec::new("two labels", units.clone());
    let result = run(&spec, &profile, &factory(vp.raw_port));
    assert_eq!(result, JobResult::Confirmed);

    let jobs = vp.wait_for_jobs(1, Duration::from_secs(5));
    assert_eq!(jobs.len(), 1, "exactly one connection is one saved job");
    let data = vp.read_job(&jobs[0]);
    for unit in &units {
        assert!(
            contains_bytes(&data, unit),
            "a rendered label is missing from the saved job"
        );
    }
}
