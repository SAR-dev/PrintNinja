//! Native pipeline e2e: scene → native commands → delivery →
//! verification (plan §5.3, phase 6).
//!
//! The full thermal track end to end on its preferred path: a scene a
//! printer's language can draw — plain text, a printer-generated
//! barcode, a rule and a framed box — plans to the native path,
//! encodes to the printer's own commands, and delivers over raw TCP to
//! the virtual printer. The same scene rendered the raster way is ten
//! times the bytes, which is the point of the native path.

use std::time::Duration;

use pn_e2e::Printer;
use pn_encoders::{native, raster};
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

/// A ZPL label printer with a built-in font and a Code 128 generator —
/// enough native capability for the test scene.
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

/// A 40 × 50 mm label: a plain heading, a Code 128, a rule and a
/// framed box — every element the profile's native language draws.
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
                    bold: false,
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
                show_text: false,
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

/// Render one expanded page the raster way, for the byte-count
/// comparison only.
fn render_page(page: &pn_scene::Page, profile: &Profile) -> RasterPage {
    let dpi = profile.profile.dpi.expect("the profile pins its dpi") as u32;
    let w = fit_to_head(dots_for_mm(40.0, dpi), profile.profile.head_width_dots);
    let h = dots_for_mm(50.0, dpi);
    let mut r = Renderer::new(dpi, w, h);
    paint_page(page, &mut r);
    RasterPage::new(r.into_page(), 40.0, 50.0)
}

#[test]
fn a_scene_label_job_prints_natively_and_confirms() {
    let template = label_template();
    let profile = zpl_profile();

    let records = Records::from_json(
        r#"[{"name":"BOLT M8","sn":"SN-1001"},{"name":"NUT M8","sn":"SN-1002"}]"#,
    )
    .unwrap();
    let job = expand(&template, &records).expect("the template and records agree");
    assert_eq!(job.outputs.len(), 2, "one output per record");

    // The planner's preferred path is native — the scene is inside the
    // printer's language — with no fallback recorded.
    let plan = plan(&job, &template, &profile).unwrap();
    assert_eq!(plan.path, OutputPath::Native);
    assert_eq!(plan.fallback, None);

    // One native stream for the whole job: two labels, each an
    // ^XA…^XZ of commands — and no ^GFA graphic anywhere.
    let out = native(&job, &template, &profile).expect("the scene fits the native path");
    let zpl = String::from_utf8_lossy(&out);
    assert_eq!(zpl.matches("^XA\n").count(), 2, "one label per record");
    assert_eq!(zpl.matches("^XZ\n").count(), 2, "one label per record");
    assert!(!zpl.contains("^GFA"), "native output has no raster graphic");
    // The data bindings made it to the wire: the text field in the
    // built-in font, the serial in the printer-generated barcode.
    assert!(zpl.contains("^FD"));
    for value in ["BOLT M8", "NUT M8", "SN-1001", "SN-1002"] {
        assert!(
            zpl.contains(value),
            "{value} is missing from the native output"
        );
    }

    // The same scene the raster way: one ^GFA per label. The native
    // stream is a fraction of it — the whole point of the path.
    let raster_bytes =
        raster(&[render_page(&job.outputs[0].pages[0], &profile)], &profile).unwrap();
    assert!(
        out.len() * 10 < raster_bytes.len(),
        "native is {} bytes, one raster label is {} — native should be a fraction",
        out.len(),
        raster_bytes.len()
    );

    // Delivered and confirmed; the bytes reached the printer.
    let vp = Printer::spawn("ok");
    let spec = JobSpec::new("two labels, native", vec![out.clone()]);
    let result = run(&spec, &profile, &factory(vp.raw_port));
    assert_eq!(result, JobResult::Confirmed);

    let jobs = vp.wait_for_jobs(1, Duration::from_secs(5));
    assert_eq!(jobs.len(), 1, "exactly one connection is one saved job");
    let data = vp.read_job(&jobs[0]);
    assert!(
        contains_bytes(&data, &out),
        "the native stream is missing from the saved job"
    );
}
