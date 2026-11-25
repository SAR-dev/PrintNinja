//! Expansion: a template and its data records become a list of pages
//! (plan §5.1) — the "expanded job" every delivery adapter takes.
//!
//! One record becomes one output. A label output is exactly one page;
//! a roll or page output is a strip cut at the page height, and
//! repeating groups flow down the strip, an item per row of the bound
//! field, wrapping to the next cut when an item would cross it.
//!
//! The layout is deterministic and in millimetres: the same template
//! and the same records always expand to the same pages, so the
//! preview and the print are the same object. `Last`-placed elements
//! (a receipt total, a document footer) reserve the bottom region of
//! every page so flowing content never collides with them.

use crate::records::{Record, Records, Value};
use crate::{At, Element, Placement, Template, TemplateError, TextStyle};
use serde::Serialize;
use std::fmt;

/// A millimetre tolerance for floating-point layout decisions (10 µm —
/// far below a printable step, large enough to absorb f32 drift).
const EPS: f32 = 0.0001;

/// An expanded job: one output per data record.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ExpandedJob {
    pub outputs: Vec<Output>,
}

/// One record's share of the job.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Output {
    /// The record this output was expanded from (0-based).
    pub record: usize,
    pub pages: Vec<Page>,
}

/// One page/label/cut of an output.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Page {
    /// 0-based page index.
    pub index: usize,
    /// The page's elements, in draw order (template order, groups
    /// expanded in row order).
    pub elements: Vec<Placed>,
}

/// An element with its bindings resolved and its placement settled:
/// ready to render at `x_mm`, `y_mm` on its page.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Placed {
    pub x_mm: f32,
    pub y_mm: f32,
    pub kind: PlacedKind,
}

/// What a placed element draws (an [`Element`] minus `group` and
/// `page` — groups are expanded, placements resolved).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum PlacedKind {
    Text {
        w_mm: f32,
        h_mm: f32,
        content: String,
        style: TextStyle,
    },
    Image {
        w_mm: f32,
        h_mm: f32,
        src: String,
    },
    Barcode {
        w_mm: f32,
        h_mm: f32,
        kind: crate::BarcodeKind,
        value: String,
        show_text: bool,
    },
    Qr {
        h_mm: f32,
        value: String,
    },
    Line {
        length_mm: f32,
        thickness_mm: f32,
        vertical: bool,
    },
    Rect {
        w_mm: f32,
        h_mm: f32,
        fill: bool,
        /// An outlined rect's own thickness (a frame's border). `None`
        /// for a plain `rect` element, which the renderer draws at its
        /// established 0.5 mm.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thickness_mm: Option<f32>,
    },
}

/// Expansion cannot go on: the data and the template do not meet.
#[derive(Debug)]
pub enum ExpandError {
    /// No records to expand — there is nothing to print.
    EmptyBatch,
    /// A group's bound field is missing from a record, or is not a
    /// list of rows.
    GroupField { record: usize, field: String },
    /// A group's flow ran out of room: the label is full (fixed-size
    /// media), or one item is taller than a page's usable region.
    Overflow { record: usize, field: String },
    /// A template that does not hold together (should have been
    /// caught by [`Template::validate`]).
    Template(TemplateError),
    /// A data file that is not records.
    BadData(String),
}

impl fmt::Display for ExpandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ExpandError::EmptyBatch => write!(
                f,
                "there is no data to print — the record list is empty, so the job \
                 has nothing to expand"
            ),
            ExpandError::GroupField { record, field } => write!(
                f,
                "record {record} has no list field \"{field}\" for the group to \
                 repeat over (CSV rows are flat — a group needs one row per object \
                 in a JSON array)"
            ),
            ExpandError::Overflow { record, field } => write!(
                f,
                "the group \"{field}\" ran out of room on record {record} — the \
                 label is full or one item is taller than a page"
            ),
            ExpandError::Template(e) => write!(f, "the template is invalid: {e}"),
            ExpandError::BadData(e) => write!(f, "the data could not be read: {e}"),
        }
    }
}

impl std::error::Error for ExpandError {}

impl From<TemplateError> for ExpandError {
    fn from(e: TemplateError) -> Self {
        ExpandError::Template(e)
    }
}

/// Expand `records` against `template` into pages, one output per
/// record. The template is validated first, so a bad template is
/// reported as a template problem, not a data problem.
pub fn expand(template: &Template, records: &Records) -> Result<ExpandedJob, ExpandError> {
    template.validate().map_err(ExpandError::Template)?;
    if records.is_empty() {
        return Err(ExpandError::EmptyBatch);
    }
    let page_h = template.media.height_mm();
    // The bottom region every page keeps clear for `Last` elements —
    // the receipt total, the document footer.
    let reserved = last_reserve(template);
    let mut outputs = Vec::with_capacity(records.len());
    for (i, record) in records.0.iter().enumerate() {
        outputs.push(expand_one(template, record, i, page_h, reserved)?);
    }
    Ok(ExpandedJob { outputs })
}

/// The height of the bottom strip kept clear on every page for the
/// `Last`-placed elements (a receipt total, a document footer): the
/// flowable region of a page ends at the top edge of the lowest
/// `Last` element.
fn last_reserve(template: &Template) -> f32 {
    let page_h = template.media.height_mm();
    template
        .elements
        .iter()
        .filter(|el| fixed_placement(el) == Some(Placement::Last))
        // The bottom strip a page keeps clear: from the top edge of the
        // `Last` element to the bottom edge of the page.
        .map(|el| page_h - other_at(el).y_mm)
        .fold(0.0f32, f32::max)
}

/// Where a non-group element sits, if it has a `page` at all.
fn fixed_placement(el: &Element) -> Option<Placement> {
    match el {
        Element::Group { .. } => None,
        Element::Text { page, .. }
        | Element::Image { page, .. }
        | Element::Barcode { page, .. }
        | Element::Qr { page, .. }
        | Element::Line { page, .. }
        | Element::Rect { page, .. }
        | Element::Frame { page, .. } => Some(*page),
    }
}

/// The `at` of a non-group element.
fn other_at(el: &Element) -> At {
    match el {
        Element::Text { at, .. }
        | Element::Image { at, .. }
        | Element::Barcode { at, .. }
        | Element::Qr { at, .. }
        | Element::Line { at, .. }
        | Element::Rect { at, .. }
        | Element::Frame { at, .. } => *at,
        Element::Group { .. } => At {
            x_mm: 0.0,
            y_mm: 0.0,
        },
    }
}

/// `expand` for one record.
fn expand_one(
    template: &Template,
    record: &Record,
    record_index: usize,
    page_h: f32,
    reserved: f32,
) -> Result<Output, ExpandError> {
    let label = !template.media.flows();
    // Pass 1: lay every group's rows down the strip and find where
    // the output ends.
    let mut flows: Vec<Vec<FlowItem>> = Vec::with_capacity(template.elements.len());
    for el in &template.elements {
        if let Element::Group { bind, .. } = el {
            let rows = record.get(bind).and_then(Value::as_rows).ok_or_else(|| {
                ExpandError::GroupField {
                    record: record_index,
                    field: bind.clone(),
                }
            })?;
            flows.push(flow_group(el, rows, page_h, reserved, label, record_index)?);
        } else {
            flows.push(Vec::new());
        }
    }
    let mut total = 1usize;
    for items in &flows {
        for item in items {
            total = total.max(item.page + 1);
        }
    }
    for el in &template.elements {
        if let Placement::Only(n) = fixed_placement(el).unwrap_or(Placement::Every) {
            total = total.max(n as usize);
        }
    }

    let mut pages: Vec<Page> = (0..total)
        .map(|index| Page {
            index,
            elements: Vec::new(),
        })
        .collect();
    // Place the elements in template order, so the page's elements are
    // in draw order: a group contributes its items in row order at its
    // place in the template, a fixed element on the pages its
    // `page` says.
    for (el, items) in template.elements.iter().zip(flows) {
        match el {
            Element::Group {
                bind,
                at,
                items: item_els,
                ..
            } => {
                // Each item's elements sit relative to the item's
                // top-left, which is the group's x plus the flow
                // cursor on its page.
                let rows = record
                    .get(bind)
                    .and_then(Value::as_rows)
                    .expect("checked in pass 1");
                for (row, item) in rows.iter().zip(items) {
                    let y = item.y - item.page as f32 * page_h;
                    let pg = &mut pages[item.page];
                    for it in item_els {
                        let at_it = other_at(it);
                        let at = At {
                            x_mm: at.x_mm + at_it.x_mm,
                            y_mm: y + at_it.y_mm,
                        };
                        match it {
                            // A frame in a group item flattens on every
                            // row, like its other items.
                            Element::Frame { .. } => place_frame(it, at, row, pg),
                            _ => pg.elements.push(placed_at(it, at, row)),
                        }
                    }
                }
            }
            Element::Frame { .. } => {
                // Like any fixed element: the frame's `page` decides the
                // pages, and each gets the border plus the children.
                let Some(page) = fixed_placement(el) else {
                    continue;
                };
                let at = other_at(el);
                for pg in &mut pages {
                    if page.on_page((pg.index + 1) as u32, total as u32) {
                        place_frame(el, at, record, pg);
                    }
                }
            }
            el => {
                let Some(page) = fixed_placement(el) else {
                    continue;
                };
                let at = other_at(el);
                for pg in &mut pages {
                    if page.on_page((pg.index + 1) as u32, total as u32) {
                        pg.elements.push(placed_at(el, at, record));
                    }
                }
            }
        }
    }
    Ok(Output {
        record: record_index,
        pages,
    })
}

/// Flatten a frame at `at` onto `pg`: its border (when `border_mm` is
/// not 0) as an outlined rect, then its children — a nested frame
/// recurses, everything else places — with the frame's origin added to
/// each child's position. A child's own `page` is ignored here: the
/// frame decides (the validator rejects a conflicting value).
fn place_frame(el: &Element, at: At, record: &Record, pg: &mut Page) {
    let Element::Frame {
        size,
        border_mm,
        children,
        ..
    } = el
    else {
        unreachable!("place_frame called on a non-frame")
    };
    if *border_mm > 0.0 {
        pg.elements.push(Placed {
            x_mm: at.x_mm,
            y_mm: at.y_mm,
            kind: PlacedKind::Rect {
                w_mm: size.w_mm,
                h_mm: size.h_mm,
                fill: false,
                thickness_mm: Some(*border_mm),
            },
        });
    }
    for child in children {
        let child_at = At {
            x_mm: at.x_mm + other_at(child).x_mm,
            y_mm: at.y_mm + other_at(child).y_mm,
        };
        match child {
            Element::Frame { .. } => place_frame(child, child_at, record, pg),
            Element::Group { .. } => unreachable!("a group cannot sit in a frame (validated)"),
            other => pg.elements.push(placed_at(other, child_at, record)),
        }
    }
}

/// One row of a group: the page it lands on and its top edge on the
/// strip (absolute strip coordinates; the page-relative y is `y −
/// page × page_h`).
struct FlowItem {
    page: usize,
    y: f32,
}

/// Lay a group's rows down the strip: the cursor starts at the
/// group's `at.y_mm` on page 0 and at the top of each later page; an
/// item that would cross a cut moves to the top of the next cut. An
/// item taller than a page's usable region, or a flow that runs out
/// of a fixed-size label, is an overflow — expansion fails rather
/// than silently dropping rows.
fn flow_group(
    el: &Element,
    rows: &[Record],
    page_h: f32,
    reserved: f32,
    label: bool,
    record_index: usize,
) -> Result<Vec<FlowItem>, ExpandError> {
    let Element::Group {
        at,
        item_gap_mm,
        bind,
        ..
    } = el
    else {
        unreachable!("flow_group called on a non-group")
    };
    let h = item_els_height(el);
    if h > page_h - reserved + EPS {
        return Err(ExpandError::Overflow {
            record: record_index,
            field: bind.clone(),
        });
    }
    let mut out = Vec::with_capacity(rows.len());
    let mut y = at.y_mm;
    for _row in rows {
        loop {
            // A label is one page: the cursor never rolls over onto a
            // second page it does not exist on.
            let page = if label {
                0
            } else {
                (y / page_h).floor() as usize
            };
            let limit = (page + 1) as f32 * page_h - reserved;
            if y + h <= limit + EPS {
                out.push(FlowItem { page, y });
                break;
            }
            if label {
                return Err(ExpandError::Overflow {
                    record: record_index,
                    field: bind.clone(),
                });
            }
            y = (page + 1) as f32 * page_h;
        }
        y += h + item_gap_mm;
    }
    Ok(out)
}

/// One repeated item is as tall as its lowest element.
fn item_els_height(el: &Element) -> f32 {
    let Element::Group { items, .. } = el else {
        unreachable!("item_els_height called on a non-group")
    };
    items
        .iter()
        .map(|e| other_at(e).y_mm + e.height_mm())
        .fold(0.0f32, f32::max)
}

/// An element, bindings resolved, at `at`.
fn placed_at(el: &Element, at: At, record: &Record) -> Placed {
    let sub = |s: &str| substitute_bindings(s, record);
    let kind = match el {
        Element::Text {
            size,
            content,
            style,
            ..
        } => PlacedKind::Text {
            w_mm: size.w_mm,
            h_mm: size.h_mm,
            content: sub(content),
            style: style.clone(),
        },
        Element::Image { size, src, .. } => PlacedKind::Image {
            w_mm: size.w_mm,
            h_mm: size.h_mm,
            src: src.clone(),
        },
        Element::Barcode {
            size,
            kind,
            value,
            show_text,
            ..
        } => PlacedKind::Barcode {
            w_mm: size.w_mm,
            h_mm: size.h_mm,
            kind: *kind,
            value: sub(value),
            show_text: *show_text,
        },
        Element::Qr { h_mm, value, .. } => PlacedKind::Qr {
            h_mm: *h_mm,
            value: sub(value),
        },
        Element::Line {
            length_mm,
            thickness_mm,
            vertical,
            ..
        } => PlacedKind::Line {
            length_mm: *length_mm,
            thickness_mm: *thickness_mm,
            vertical: *vertical,
        },
        Element::Rect { size, fill, .. } => PlacedKind::Rect {
            w_mm: size.w_mm,
            h_mm: size.h_mm,
            fill: *fill,
            // A plain rect has no thickness of its own; the renderer
            // and encoders draw the outline at their established 0.5 mm.
            thickness_mm: None,
        },
        Element::Frame { .. } => unreachable!("a frame is flattened, not placed"),
        Element::Group { .. } => unreachable!("a group is expanded, not placed"),
    };
    Placed {
        x_mm: at.x_mm,
        y_mm: at.y_mm,
        kind,
    }
}

/// Substitute `{{name}}` bindings in `s` from `record`; a missing
/// field reads as an empty string, and anything that is not a valid
/// binding stays in the text as-is.
pub fn substitute_bindings(s: &str, record: &Record) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let name: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !name.is_empty()
            && name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && after.get(name.len()..name.len() + 2) == Some("}}")
        {
            out.push_str(record.get(&name).map_or("", Value::as_text));
            rest = &after[name.len() + 2..];
        } else {
            // Not a binding: emit one brace and rescan from after it.
            out.push('{');
            rest = &rest[open + 1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Align, Field, FieldKind, Format, Media, Size};

    fn label(w: f32, h: f32) -> Media {
        Media::Label {
            width_mm: w,
            height_mm: h,
        }
    }

    fn text(x: f32, y: f32, w: f32, h: f32, content: &str) -> Element {
        text_page(x, y, w, h, content, Placement::default())
    }

    fn text_page(x: f32, y: f32, w: f32, h: f32, content: &str, page: Placement) -> Element {
        Element::Text {
            at: At { x_mm: x, y_mm: y },
            size: Size { w_mm: w, h_mm: h },
            content: content.to_string(),
            style: TextStyle {
                size_mm: 3.0,
                font: None,
                bold: false,
                italic: false,
                align: Align::Left,
            },
            page,
        }
    }

    fn group(bind: &str, at: At, items: Vec<Element>) -> Element {
        group_cfg(bind, at, 50.0, 1.0, items)
    }

    fn group_cfg(bind: &str, at: At, w: f32, gap: f32, items: Vec<Element>) -> Element {
        Element::Group {
            at,
            w_mm: w,
            item_gap_mm: gap,
            bind: bind.to_string(),
            items,
            page: Placement::Flow,
        }
    }

    fn frame(at: At, w: f32, h: f32, border: f32, children: Vec<Element>) -> Element {
        Element::Frame {
            at,
            size: Size { w_mm: w, h_mm: h },
            border_mm: border,
            children,
            page: Placement::default(),
        }
    }

    /// The kind of the placed element at `x`, `y` on a page.
    fn kind_at(page: &Page, x: f32, y: f32) -> Option<&PlacedKind> {
        page.elements
            .iter()
            .find(|p| (p.x_mm - x).abs() < EPS && (p.y_mm - y).abs() < EPS)
            .map(|p| &p.kind)
    }

    /// `n` receipt rows `L1..Ln` at `1.00..n.00`, as one JSON record.
    fn receipt_obj(n: usize, total: &str) -> String {
        let rows: Vec<String> = (1..=n)
            .map(|i| format!(r#"{{ "item": "L{i}", "price": "{i}.00" }}"#))
            .collect();
        format!(
            r#"{{ "total": "{total}", "lines": [ {} ] }}"#,
            rows.join(", ")
        )
    }

    fn receipt_record(n: usize, total: &str) -> Records {
        Records::from_json(&format!("[ {} ]", receipt_obj(n, total))).unwrap()
    }

    /// Receipt rows: `{{item}}` left, `{{price}}` right.
    fn line_items() -> Vec<Element> {
        vec![
            text(0.0, 0.0, 38.0, 3.0, "{{item}}"),
            text(40.0, 0.0, 10.0, 3.0, "{{price}}"),
        ]
    }

    fn json(s: &str) -> Records {
        Records::from_json(s).unwrap()
    }

    /// The content of the text element at `x`, `y` on a page.
    fn text_at(page: &Page, x: f32, y: f32) -> Option<&str> {
        page.elements
            .iter()
            .find(|p| (p.x_mm - x).abs() < EPS && (p.y_mm - y).abs() < EPS)
            .and_then(|p| match &p.kind {
                PlacedKind::Text { content, .. } => Some(content.as_str()),
                _ => None,
            })
    }

    #[test]
    fn a_batch_of_labels_is_one_page_each_with_its_own_data() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![Field {
                name: "customer".to_string(),
                kind: FieldKind::String,
            }],
            elements: vec![text(4.0, 6.0, 50.0, 4.0, "Hello {{customer}}")],
            fonts: vec![],
        };
        let job = expand(
            &t,
            &json(r#"[ { "customer": "Ada" }, { "customer": "Bob" } ]"#),
        )
        .unwrap();
        assert_eq!(job.outputs.len(), 2);
        for (i, out) in job.outputs.iter().enumerate() {
            assert_eq!(out.record, i);
            assert_eq!(out.pages.len(), 1, "a label is exactly one page");
        }
        assert_eq!(
            text_at(&job.outputs[0].pages[0], 4.0, 6.0),
            Some("Hello Ada")
        );
        assert_eq!(
            text_at(&job.outputs[1].pages[0], 4.0, 6.0),
            Some("Hello Bob")
        );
    }

    #[test]
    fn an_empty_batch_is_an_error_not_an_empty_print() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![text(4.0, 6.0, 50.0, 4.0, "x")],
            fonts: vec![],
        };
        assert!(matches!(
            expand(&t, &Records(Vec::new())),
            Err(ExpandError::EmptyBatch)
        ));
    }

    #[test]
    fn a_missing_group_field_is_named() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![group(
                "lines",
                At {
                    x_mm: 4.0,
                    y_mm: 20.0,
                },
                line_items(),
            )],
            fonts: vec![],
        };
        let err = expand(&t, &json(r#"[ { "nope": 1 } ]"#)).unwrap_err();
        assert!(matches!(
            err,
            ExpandError::GroupField { record: 0, field } if field == "lines"
        ));
    }

    #[test]
    fn a_label_full_of_rows_overflows_instead_of_silently_dropping() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![group(
                "lines",
                At {
                    x_mm: 4.0,
                    y_mm: 20.0,
                },
                line_items(),
            )],
            fonts: vec![],
        };
        // Six rows of 3.0 + 1.0 gap, from y 20 on a 40 mm label:
        // 20 + 6×3 + 5×1 = 43 > 40.
        let data = json(
            r#"[ { "lines": [
                { "item": 0, "price": 0 }, { "item": 1, "price": 1 },
                { "item": 2, "price": 2 }, { "item": 3, "price": 3 },
                { "item": 4, "price": 4 }, { "item": 5, "price": 5 } ] } ]"#,
        );
        assert!(matches!(
            expand(&t, &data),
            Err(ExpandError::Overflow { record: 0, field }) if field == "lines"
        ));
    }

    #[test]
    fn a_missing_binding_reads_as_empty_not_as_an_error() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![text(4.0, 6.0, 50.0, 4.0, "Hi {{who}}")],
            fonts: vec![],
        };
        let job = expand(&t, &json(r#"[ { "other": 1 } ]"#)).unwrap();
        assert_eq!(text_at(&job.outputs[0].pages[0], 4.0, 6.0), Some("Hi "));
    }

    #[test]
    fn substitution_keeps_unmatched_braces_as_text() {
        let rec = &json(r#"[ { "ok": "1" } ]"#).0[0];
        assert_eq!(substitute_bindings("a {{x} b} {{ok}}", rec), "a {{x} b} 1");
    }

    // A frame flattens: its border becomes a rect, its children shift
    // to the frame's origin, and a nested frame offsets again.

    #[test]
    fn a_frame_flattens_to_a_border_and_offset_children() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![frame(
                At {
                    x_mm: 10.0,
                    y_mm: 20.0,
                },
                30.0,
                20.0,
                0.5,
                vec![text(2.0, 3.0, 10.0, 4.0, "inside")],
            )],
            fonts: vec![],
        };
        let job = expand(&t, &json(r#"[ {} ]"#)).unwrap();
        let page = &job.outputs[0].pages[0];
        assert_eq!(page.elements.len(), 2);
        // The border is a rect at the frame's origin, with the
        // border the template asked for.
        match kind_at(page, 10.0, 20.0) {
            Some(PlacedKind::Rect {
                w_mm,
                h_mm,
                fill,
                thickness_mm,
            }) => {
                assert_eq!(*w_mm, 30.0);
                assert_eq!(*h_mm, 20.0);
                assert!(!fill);
                assert_eq!(*thickness_mm, Some(0.5));
            }
            other => panic!("expected the frame's border rect, got {other:?}"),
        }
        // The child sits at the frame's origin plus its own offset.
        assert_eq!(text_at(page, 12.0, 23.0), Some("inside"));
    }

    #[test]
    fn a_nested_frame_offsets_through_every_level() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![frame(
                At {
                    x_mm: 10.0,
                    y_mm: 20.0,
                },
                30.0,
                20.0,
                1.0,
                vec![frame(
                    At {
                        x_mm: 5.0,
                        y_mm: 5.0,
                    },
                    15.0,
                    10.0,
                    0.25,
                    vec![text(1.0, 2.0, 8.0, 3.0, "deep")],
                )],
            )],
            fonts: vec![],
        };
        let job = expand(&t, &json(r#"[ {} ]"#)).unwrap();
        let page = &job.outputs[0].pages[0];
        assert_eq!(page.elements.len(), 3);
        assert!(
            matches!(
                kind_at(page, 10.0, 20.0),
                Some(PlacedKind::Rect {
                    thickness_mm: Some(1.0),
                    ..
                })
            ),
            "the outer border, at the outer frame's origin"
        );
        assert!(
            matches!(
                kind_at(page, 15.0, 25.0),
                Some(PlacedKind::Rect {
                    thickness_mm: Some(0.25),
                    ..
                })
            ),
            "the inner border, offset by the outer frame"
        );
        assert_eq!(
            text_at(page, 16.0, 27.0),
            Some("deep"),
            "the text, offset through both frames"
        );
    }

    #[test]
    fn a_frame_with_no_border_places_only_its_children() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![],
            elements: vec![frame(
                At {
                    x_mm: 10.0,
                    y_mm: 20.0,
                },
                30.0,
                20.0,
                0.0,
                vec![text(2.0, 3.0, 10.0, 4.0, "inside")],
            )],
            fonts: vec![],
        };
        let job = expand(&t, &json(r#"[ {} ]"#)).unwrap();
        let page = &job.outputs[0].pages[0];
        assert_eq!(page.elements.len(), 1, "no border rect for a 0 border");
        assert_eq!(text_at(page, 12.0, 23.0), Some("inside"));
    }

    #[test]
    fn a_frame_inside_a_group_item_flattens_on_every_row() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 60.0),
            fields: vec![],
            elements: vec![group_cfg(
                "lines",
                At {
                    x_mm: 4.0,
                    y_mm: 30.0,
                },
                50.0,
                1.0,
                vec![frame(
                    At {
                        x_mm: 0.0,
                        y_mm: 0.0,
                    },
                    20.0,
                    10.0,
                    0.5,
                    vec![text(1.0, 1.0, 18.0, 3.0, "{{item}}")],
                )],
            )],
            fonts: vec![],
        };
        let job = expand(
            &t,
            &json(r#"[ { "lines": [ { "item": "A" }, { "item": "B" } ] } ]"#),
        )
        .unwrap();
        let page = &job.outputs[0].pages[0];
        assert_eq!(page.elements.len(), 4, "border + text, on each row");
        // Row 0: the frame's border and its text, at the group origin.
        assert!(matches!(
            kind_at(page, 4.0, 30.0),
            Some(PlacedKind::Rect {
                thickness_mm: Some(0.5),
                ..
            })
        ));
        assert_eq!(text_at(page, 5.0, 31.0), Some("A"));
        // Row 1: the whole frame again, shifted by the row stride
        // (10 mm of frame + 1 mm of gap).
        assert!(matches!(
            kind_at(page, 4.0, 41.0),
            Some(PlacedKind::Rect {
                thickness_mm: Some(0.5),
                ..
            })
        ));
        assert_eq!(text_at(page, 5.0, 42.0), Some("B"));
    }

    #[test]
    fn a_frame_sits_only_on_the_pages_its_page_says() {
        let mut t = Template {
            format: Format::Scene,
            html: None,
            media: Media::Page {
                width_mm: 100.0,
                height_mm: 80.0,
            },
            fields: vec![],
            elements: vec![group_cfg(
                "lines",
                At {
                    x_mm: 10.0,
                    y_mm: 20.0,
                },
                80.0,
                2.0,
                vec![text(0.0, 0.0, 80.0, 4.0, "{{item}}")],
            )],
            fonts: vec![],
        };
        let mut stamped = frame(
            At {
                x_mm: 5.0,
                y_mm: 5.0,
            },
            20.0,
            10.0,
            0.3,
            vec![text(1.0, 1.0, 18.0, 3.0, "STAMP")],
        );
        let Element::Frame { page, .. } = &mut stamped else {
            panic!("stamped is a frame");
        };
        *page = Placement::First;
        t.elements.push(stamped);
        // Ten rows per page, the way the document golden does.
        let job = expand(&t, &receipt_record(12, "0.00")).unwrap();
        assert_eq!(job.outputs[0].pages.len(), 2);
        let first = &job.outputs[0].pages[0];
        let second = &job.outputs[0].pages[1];
        assert!(
            matches!(
                kind_at(first, 5.0, 5.0),
                Some(PlacedKind::Rect {
                    thickness_mm: Some(0.3),
                    ..
                })
            ),
            "the stamp on page 1"
        );
        assert_eq!(text_at(first, 6.0, 6.0), Some("STAMP"));
        assert!(kind_at(second, 5.0, 5.0).is_none(), "no stamp on page 2");
        assert!(second
            .elements
            .iter()
            .all(|p| !matches!(p.kind, PlacedKind::Rect { .. })));
    }

    // The four shapes the phase-4 exit asks one schema to describe —
    // a single-page label, a batch of N labels with per-label data, an
    // N-page document, and a variable-length receipt — expanded to
    // their pinned golden pages.

    #[test]
    fn a_batch_of_labels_expands_to_the_pinned_golden_pages() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![
                Field {
                    name: "customer".to_string(),
                    kind: FieldKind::String,
                },
                Field {
                    name: "amount".to_string(),
                    kind: FieldKind::Number,
                },
            ],
            elements: vec![
                text(4.0, 5.0, 50.0, 4.0, "For {{customer}}"),
                Element::Line {
                    at: At {
                        x_mm: 4.0,
                        y_mm: 12.0,
                    },
                    length_mm: 50.0,
                    thickness_mm: 0.5,
                    vertical: false,
                    page: Placement::default(),
                },
                text(4.0, 16.0, 50.0, 4.0, "Total: {{amount}}"),
            ],
            fonts: vec![],
        };
        let data = json(
            r#"[ { "customer": "Ada", "amount": "12.50" },
                { "customer": "Bob", "amount": "7.25" } ]"#,
        );
        let job = expand(&t, &data).unwrap();
        golden_harness::assert_matches_golden(
            "scene/expand/label-batch.json",
            serde_json::to_string(&job).unwrap().as_bytes(),
        );
    }

    /// A framed label: the flattening — border rects and offset
    /// children — is part of the wire contract, so its pages are
    /// pinned too.
    #[test]
    fn a_framed_label_expands_to_the_pinned_golden_pages() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(58.0, 40.0),
            fields: vec![Field {
                name: "customer".to_string(),
                kind: FieldKind::String,
            }],
            elements: vec![
                text(4.0, 5.0, 50.0, 4.0, "For {{customer}}"),
                frame(
                    At {
                        x_mm: 4.0,
                        y_mm: 14.0,
                    },
                    50.0,
                    20.0,
                    0.5,
                    vec![
                        text(2.0, 2.0, 44.0, 4.0, "Amount {{customer}}"),
                        frame(
                            At {
                                x_mm: 2.0,
                                y_mm: 8.0,
                            },
                            24.0,
                            10.0,
                            0.25,
                            vec![text(2.0, 2.0, 20.0, 4.0, "Net")],
                        ),
                    ],
                ),
            ],
            fonts: vec![],
        };
        let data = json(r#"[ { "customer": "Ada" } ]"#);
        let job = expand(&t, &data).unwrap();
        golden_harness::assert_matches_golden(
            "scene/expand/framed-label.json",
            serde_json::to_string(&job).unwrap().as_bytes(),
        );
    }

    #[test]
    fn an_n_page_document_expands_to_the_pinned_golden_pages() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: Media::Page {
                width_mm: 100.0,
                height_mm: 80.0,
            },
            fields: vec![],
            elements: vec![
                text_page(10.0, 5.0, 80.0, 5.0, "INVOICE", Placement::First),
                group_cfg(
                    "lines",
                    At {
                        x_mm: 10.0,
                        y_mm: 20.0,
                    },
                    80.0,
                    2.0,
                    vec![
                        text(0.0, 0.0, 50.0, 4.0, "{{item}}"),
                        text(60.0, 0.0, 20.0, 4.0, "{{price}}"),
                    ],
                ),
            ],
            fonts: vec![],
        };
        // 12 rows of a 6 mm stride from y 20: ten on the first page,
        // two on the second.
        let job = expand(&t, &receipt_record(12, "0.00")).unwrap();
        assert_eq!(job.outputs[0].pages.len(), 2);
        golden_harness::assert_matches_golden(
            "scene/expand/document.json",
            serde_json::to_string(&job).unwrap().as_bytes(),
        );
    }

    #[test]
    fn a_variable_length_receipt_expands_to_the_pinned_golden_pages() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: Media::Roll {
                width_mm: 58.0,
                label_height_mm: 60.0,
            },
            fields: vec![],
            elements: vec![
                group_cfg(
                    "lines",
                    At {
                        x_mm: 4.0,
                        y_mm: 10.0,
                    },
                    50.0,
                    1.0,
                    line_items(),
                ),
                text_page(4.0, 55.0, 50.0, 4.0, "Total: {{total}}", Placement::Last),
            ],
            fonts: vec![],
        };
        // One long receipt (two cuts), one short (one cut) — the total
        // rides on each receipt's last cut.
        let data = Records::from_json(&format!(
            "[ {}, {} ]",
            receipt_obj(12, "99.00"),
            receipt_obj(5, "12.00")
        ))
        .unwrap();
        let job = expand(&t, &data).unwrap();
        assert_eq!(job.outputs[0].pages.len(), 2, "the long receipt");
        assert_eq!(job.outputs[1].pages.len(), 1, "the short receipt");
        golden_harness::assert_matches_golden(
            "scene/expand/receipt.json",
            serde_json::to_string(&job).unwrap().as_bytes(),
        );
    }
}
