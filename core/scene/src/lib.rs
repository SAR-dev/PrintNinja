//! Scene format and data model — the single template language for the
//! `scene` track (plan §5.1, built in phase 4).
//!
//! A scene is a JSON description of a template: page geometry (fixed-size
//! label, continuous roll, or page-paper), then a list of elements (text,
//! image, barcode, QR, line, rectangle, and repeating groups bound to
//! data arrays) with position, size, style and data bindings such as
//! `{{name}}`. The same file drives preview and print; expansion against
//! data records ([`expand`]) is deterministic, so the same template and
//! the same data always give the same pages.
//!
//! The track is chosen by the template's `format` field (plan §5.3):
//! `scene` for every media kind, `html` for `page` media only —
//! [`Template::validate`] rejects the combination.
//!
//! All geometry is in millimetres. The TypeScript mirror of this schema
//! lives at `app/ui/src/scene/schema.ts` and must stay field-for-field
//! identical; the golden round-trip test pins the wire format.

mod expand;
mod records;

pub use expand::{expand, ExpandError, ExpandedJob, Output, Page, Placed, PlacedKind};
pub use records::{Record, Records, Value};

use serde::{Deserialize, Serialize};
use std::fmt;

// ─────────────────────────────────────────────────────────────────────
// Track and media

/// Which track renders the template (plan §5.3).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    /// The structured scene track (every media kind).
    #[default]
    Scene,
    /// The HTML/CSS document track (`page` media only).
    Html,
}

/// The media a template prints on, with its geometry in millimetres.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Media {
    /// Fixed-size label stock: one page of `width_mm` × `height_mm` per
    /// record (a batch of N records is N labels).
    Label { width_mm: f32, height_mm: f32 },
    /// Continuous roll: fixed `width_mm`, one cut per `label_height_mm`;
    /// the strip grows as content flows, so one record can span several
    /// cuts (a variable-length receipt).
    Roll { width_mm: f32, label_height_mm: f32 },
    /// Page-paper for document printers: `width_mm` × `height_mm` per
    /// page (A4 portrait is 210 × 297).
    Page { width_mm: f32, height_mm: f32 },
}

impl Media {
    /// Width of one page/label/cut.
    pub fn width_mm(&self) -> f32 {
        match self {
            Media::Label { width_mm, .. }
            | Media::Roll { width_mm, .. }
            | Media::Page { width_mm, .. } => *width_mm,
        }
    }

    /// Height of one page/label/cut.
    pub fn height_mm(&self) -> f32 {
        match self {
            Media::Label { height_mm, .. } => *height_mm,
            Media::Roll {
                label_height_mm, ..
            } => *label_height_mm,
            Media::Page { height_mm, .. } => *height_mm,
        }
    }

    /// Whether one record can span more than one page/label/cut (flow
    /// content paginates on `roll` and `page`; a `label` is fixed).
    pub fn flows(&self) -> bool {
        !matches!(self, Media::Label { .. })
    }
}

// ─────────────────────────────────────────────────────────────────────
// Placement

/// Where a fixed element sits in a multi-page output.
///
/// Serializes as the unit-variant name, except `Only`, which carries the
/// 1-based page number: `"every"`, `"first"`, `"last"`, `{"only": 2}`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    /// Every page (the default — a single-page label ignores it).
    #[default]
    Every,
    /// Only the first page.
    First,
    /// Only the last page.
    Last,
    /// Only the given 1-based page.
    Only(u32),
    /// The group's items flow across pages, one item per record of the
    /// bound array (groups only).
    Flow,
}

impl Placement {
    /// Whether this placement puts the element on the 1-based page
    /// `page` of an output with `total` pages.
    pub fn on_page(self, page: u32, total: u32) -> bool {
        debug_assert!(total > 0);
        match self {
            Placement::Every => true,
            Placement::First => page == 1,
            Placement::Last => page == total,
            Placement::Only(n) => page == n,
            Placement::Flow => unreachable!("flow is resolved by expansion"),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// Elements

/// A position in millimetres from the page's top-left corner.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct At {
    pub x_mm: f32,
    pub y_mm: f32,
}

/// A size in millimetres.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub w_mm: f32,
    pub h_mm: f32,
}

/// Text appearance. Sizes are in millimetres.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TextStyle {
    /// Character height, in mm.
    pub size_mm: f32,
    /// Font family hint; `None` lets the renderer choose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub align: Align,
}

/// Horizontal text alignment inside the element's box.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// A 1-D barcode kind.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum BarcodeKind {
    #[default]
    Code128,
    Code39,
    Code93,
    Ean13,
    Upca,
    Itf,
}

/// One element of a scene.
///
/// Top-level elements are placed absolutely on the page; elements inside
/// a [`Element::Group`] are placed relative to that item's top-left, so
/// one set of items renders once per record of the bound array, and
/// elements inside a [`Element::Frame`] are placed relative to the
/// frame's top-left, so the bordered box and its contents move together.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum Element {
    Text {
        at: At,
        /// Layout box the text wraps in.
        size: Size,
        /// The text, with `{{bindings}}` substituted from the record.
        content: String,
        style: TextStyle,
        #[serde(default)]
        page: Placement,
    },
    Image {
        at: At,
        size: Size,
        /// Resource path or data URI.
        src: String,
        #[serde(default)]
        page: Placement,
    },
    Barcode {
        at: At,
        size: Size,
        kind: BarcodeKind,
        /// The encoded value, with `{{bindings}}`.
        value: String,
        /// Print the human-readable text under the bars.
        #[serde(default)]
        show_text: bool,
        #[serde(default)]
        page: Placement,
    },
    Qr {
        at: At,
        /// Module-box height; the QR is square.
        h_mm: f32,
        /// The encoded value, with `{{bindings}}`.
        value: String,
        #[serde(default)]
        page: Placement,
    },
    Line {
        at: At,
        length_mm: f32,
        thickness_mm: f32,
        /// Vertical instead of horizontal.
        #[serde(default)]
        vertical: bool,
        #[serde(default)]
        page: Placement,
    },
    Rect {
        at: At,
        size: Size,
        /// Filled instead of outlined.
        #[serde(default)]
        fill: bool,
        #[serde(default)]
        page: Placement,
    },
    Frame {
        at: At,
        size: Size,
        /// The outline's thickness in mm; 0 = no border.
        border_mm: f32,
        /// Placed relative to the frame's top-left, like group items.
        /// Fixed elements and other frames — not groups (v1).
        children: Vec<Element>,
        /// The frame's children take this page; a child's own `page`
        /// must stay the default (the validator rejects a conflict).
        #[serde(default)]
        page: Placement,
    },
    Group {
        /// Where the flow starts (top-left of the first item).
        at: At,
        /// Column width items lay out in.
        w_mm: f32,
        /// Gap between items, in mm.
        item_gap_mm: f32,
        /// The record field holding this group's rows (a list).
        bind: String,
        items: Vec<Element>,
        #[serde(default)]
        page: Placement,
    },
}

impl Element {
    /// The data bindings `{{name}}` this element's text carries.
    pub fn bindings(&self) -> Vec<String> {
        match self {
            Element::Text { content, .. } => binding_names(content),
            Element::Barcode { value, .. } | Element::Qr { value, .. } => binding_names(value),
            Element::Group { items, .. } => items.iter().flat_map(Element::bindings).collect(),
            Element::Frame { children, .. } => {
                children.iter().flat_map(Element::bindings).collect()
            }
            Element::Image { .. } | Element::Line { .. } | Element::Rect { .. } => Vec::new(),
        }
    }

    /// The lowest point of this element, relative to its own origin:
    /// the height the layout reserves for it.
    pub fn height_mm(&self) -> f32 {
        match self {
            Element::Text { size, .. } => size.h_mm,
            Element::Image { size, .. } => size.h_mm,
            Element::Barcode { size, .. } => size.h_mm,
            Element::Qr { h_mm, .. } => *h_mm,
            Element::Line {
                length_mm,
                thickness_mm,
                vertical,
                ..
            } => {
                if *vertical {
                    *length_mm
                } else {
                    *thickness_mm
                }
            }
            Element::Rect { size, .. } | Element::Frame { size, .. } => size.h_mm,
            // One repeated item is as tall as its lowest element; the
            // gap is between items, so it does not add to one item.
            Element::Group { items, .. } => items
                .iter()
                .map(|e| other_at(e).y_mm + e.height_mm())
                .fold(0.0f32, f32::max),
        }
    }

    /// Width of this element relative to its own origin.
    pub fn width_mm(&self) -> f32 {
        match self {
            Element::Text { size, .. }
            | Element::Image { size, .. }
            | Element::Barcode { size, .. } => size.w_mm,
            Element::Qr { h_mm, .. } => *h_mm,
            Element::Line {
                length_mm,
                vertical,
                ..
            } => {
                if *vertical {
                    0.0
                } else {
                    *length_mm
                }
            }
            Element::Rect { size, .. } | Element::Frame { size, .. } => size.w_mm,
            Element::Group { w_mm, .. } => *w_mm,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────
// The template

/// A data field a template binds to (plan §5.1). Optional: when present,
/// every binding and group `bind` must name a declared field, and a
/// group's field must be a `list`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Field {
    pub name: String,
    #[serde(default)]
    pub kind: FieldKind,
}

/// What a field holds.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    #[default]
    String,
    Number,
    Date,
    Boolean,
    /// A list of records (group bindings).
    List,
}

/// One template: the media it prints on and the elements it draws.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Template {
    /// Which track renders this template (default `scene`).
    #[serde(default)]
    pub format: Format,
    /// The document's HTML, when `format: html` (plan §5.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    pub media: Media,
    /// Declared data fields (optional; see [`Field`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<Field>,
    pub elements: Vec<Element>,
    /// The document's embedded fonts (document track only; see
    /// [`TemplateFont`]). Ignored by the scene track.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fonts: Vec<TemplateFont>,
}

/// An embedded font for the document track (the previous app's
/// "upload a font" feature): the UI turns each entry into an
/// `@font-face` data URI before the HTML reaches the browser, so the
/// rendered document carries its own font and nothing is installed on
/// the machine.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TemplateFont {
    /// The `font-family` the template's CSS references.
    pub family: String,
    /// The `@font-face` format: `truetype`, `opentype`, `woff` or
    /// `woff2`.
    pub format: String,
    /// The font file's bytes, base64.
    pub data: String,
}

impl Template {
    /// Structural checks that catch a bad template before a job is
    /// queued. Geometry checks use the media's page/label/cut size.
    pub fn validate(&self) -> Result<(), TemplateError> {
        // Track routing (plan §5.3): HTML is the document track and
        // exists only for page media.
        if self.format == Format::Html && !matches!(self.media, Media::Page { .. }) {
            return Err(TemplateError::HtmlOnThermalMedia(
                self.media.width_mm(),
                self.media.height_mm(),
            ));
        }
        let w = self.media.width_mm();
        let h = self.media.height_mm();
        if !(w.is_finite() && w > 0.0 && h.is_finite() && h > 0.0) {
            return Err(TemplateError::BadGeometry {
                width_mm: w,
                height_mm: h,
            });
        }

        let declared: Vec<&Field> = self.fields.iter().collect();
        // The document track (plan §5.3): an html template carries the
        // document in `html`, not scene elements.
        if self.format == Format::Html {
            match self.html.as_deref().map(str::trim) {
                None | Some("") => return Err(TemplateError::NoHtml),
                Some(html) => {
                    if !self.elements.is_empty() {
                        return Err(TemplateError::HtmlHasElements);
                    }
                    if !declared.is_empty() {
                        for name in binding_names(html) {
                            if !declared.iter().any(|f| f.name == name) {
                                return Err(TemplateError::UnknownBinding(name));
                            }
                        }
                    }
                }
            }
        } else if let Some(html) = self.html.as_deref().map(str::trim) {
            if !html.is_empty() {
                return Err(TemplateError::HtmlOnScene);
            }
        }
        for el in &self.elements {
            Self::validate_element(el, w, h, &declared, 0, 0)?;
        }
        for name in self.elements.iter().flat_map(Element::bindings) {
            if !declared.is_empty() && !declared.iter().any(|f| f.name == name) {
                return Err(TemplateError::UnknownBinding(name));
            }
        }
        Ok(())
    }

    /// How deep frames may nest before the document is "runaway".
    const FRAME_DEPTH_LIMIT: u32 = 4;

    fn validate_element(
        el: &Element,
        page_w: f32,
        page_h: f32,
        declared: &[&Field],
        depth: u32,
        frame_depth: u32,
    ) -> Result<(), TemplateError> {
        match el {
            Element::Frame {
                size,
                border_mm,
                children,
                ..
            } => {
                Self::validate_fixed(el, page_w, page_h)?;
                if frame_depth + 1 > Self::FRAME_DEPTH_LIMIT {
                    return Err(TemplateError::FrameTooDeep);
                }
                if !border_mm.is_finite() || *border_mm < 0.0 {
                    return Err(TemplateError::BadBorder(*border_mm));
                }
                for child in children {
                    // A frame holds fixed elements; the repeating case
                    // is a group, and a group cannot sit in a frame
                    // (v1).
                    if matches!(child, Element::Group { .. }) {
                        return Err(TemplateError::GroupInFrame);
                    }
                    // The frame decides which page its children appear
                    // on; a child that tries to choose its own is a
                    // conflict the author almost certainly did not mean.
                    if other_page(child) != Placement::default() {
                        return Err(TemplateError::FrameChildPage(element_name(child)));
                    }
                    // A child must stay inside the frame's box — the
                    // frame's own size, not the page's.
                    let child_at = other_at(child);
                    let over_x = child_at.x_mm + child.width_mm() > size.w_mm;
                    let over_y = child_at.y_mm + child.height_mm() > size.h_mm;
                    if over_x || over_y {
                        let (edge, limit) = if over_x {
                            (child_at.x_mm + child.width_mm(), size.w_mm)
                        } else {
                            (child_at.y_mm + child.height_mm(), size.h_mm)
                        };
                        return Err(TemplateError::FrameChildOutside {
                            element: element_name(child),
                            edge,
                            limit,
                        });
                    }
                    Self::validate_element(
                        child,
                        size.w_mm,
                        size.h_mm,
                        declared,
                        depth,
                        frame_depth + 1,
                    )?;
                }
                Ok(())
            }
            Element::Group {
                at,
                w_mm,
                item_gap_mm,
                bind,
                items,
                page,
            } => {
                if depth + 1 > 1 {
                    return Err(TemplateError::NestedGroups);
                }
                if *page != Placement::Flow {
                    return Err(TemplateError::GroupNotFlow(bind.clone()));
                }
                if bind.trim().is_empty() {
                    return Err(TemplateError::GroupNotFlow(bind.clone()));
                }
                if !declared.is_empty() {
                    match declared.iter().find(|f| &f.name == bind) {
                        Some(f) if f.kind != FieldKind::List => {
                            return Err(TemplateError::GroupBindNotList(bind.clone()))
                        }
                        None => return Err(TemplateError::UnknownBinding(bind.clone())),
                        _ => {}
                    }
                }
                if items.is_empty() {
                    return Err(TemplateError::EmptyGroup(bind.clone()));
                }
                if !item_gap_mm.is_finite() || *item_gap_mm < 0.0 {
                    return Err(TemplateError::NegativeGap(bind.clone()));
                }
                if !w_mm.is_finite() || *w_mm <= 0.0 || at.x_mm < 0.0 || at.x_mm + w_mm > page_w {
                    return Err(TemplateError::OffPage {
                        element: bind.clone(),
                        edge: at.x_mm + w_mm,
                        limit: page_w,
                    });
                }
                for item in items {
                    Self::validate_element(
                        item,
                        *w_mm,
                        f32::INFINITY,
                        declared,
                        depth + 1,
                        frame_depth,
                    )?;
                }
                Ok(())
            }
            other => Self::validate_fixed(other, page_w, page_h),
        }
    }

    /// A fixed (non-group) element: it sits on a page and must stay on
    /// it — no `flow`, a 1-based `only`, and its box inside
    /// `page_w`×`page_h`. Frames run these checks on themselves before
    /// checking their children.
    fn validate_fixed(el: &Element, page_w: f32, page_h: f32) -> Result<(), TemplateError> {
        // Flow is for groups only; everything else sits on a page.
        if other_page(el) == Placement::Flow {
            return Err(TemplateError::FlowOnFixedElement(element_name(el)));
        }
        if let Placement::Only(n) = other_page(el) {
            if n == 0 {
                return Err(TemplateError::PageNumberZero);
            }
        }
        let at = other_at(el);
        let w = el.width_mm();
        let h = el.height_mm();
        if at.x_mm < 0.0 || at.y_mm < 0.0 || !w.is_finite() || !h.is_finite() {
            return Err(TemplateError::OffPage {
                element: element_name(el),
                edge: at.y_mm,
                limit: page_h,
            });
        }
        if at.x_mm + w > page_w || at.y_mm + h > page_h {
            return Err(TemplateError::OffPage {
                element: element_name(el),
                edge: (at.x_mm + w).max(at.y_mm + h),
                limit: page_w.max(page_h),
            });
        }
        Ok(())
    }
}

/// The `page` field of a non-group element.
fn other_page(el: &Element) -> Placement {
    match el {
        Element::Text { page, .. }
        | Element::Image { page, .. }
        | Element::Barcode { page, .. }
        | Element::Qr { page, .. }
        | Element::Line { page, .. }
        | Element::Rect { page, .. }
        | Element::Frame { page, .. } => *page,
        Element::Group { .. } => Placement::default(),
    }
}

/// The `at` field of a non-group element.
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

/// A stable, readable name for errors.
fn element_name(el: &Element) -> String {
    match el {
        Element::Text { content, .. } => format!("text \"{content}\""),
        Element::Image { src, .. } => format!("image \"{src}\""),
        Element::Barcode { .. } => "barcode".to_string(),
        Element::Qr { .. } => "qr".to_string(),
        Element::Line { .. } => "line".to_string(),
        Element::Rect { .. } => "rectangle".to_string(),
        Element::Frame { .. } => "frame".to_string(),
        Element::Group { bind, .. } => format!("group \"{bind}\""),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Bindings

/// The data bindings `{{name}}` in a string, in order of first use.
/// A name is `[A-Za-z_][A-Za-z0-9_]*`; anything else between the
/// braces is not a binding and is left for the renderer to draw as-is.
pub fn binding_names(s: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = s;
    while let Some(open) = rest.find("{{") {
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
            && !names.contains(&name)
        {
            names.push(name);
        }
        rest = after;
    }
    names
}

/// One record's values into a document: every binding [`binding_names`]
/// would recognize is replaced by the record's value (a missing field
/// becomes the empty string); anything else between braces is left
/// exactly as written, so what the validator sees and what the browser
/// prints are the same text.
pub fn substitute(html: &str, record: &Record) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let name: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let recognized = !name.is_empty()
            && name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && after.get(name.len()..name.len() + 2) == Some("}}");
        if recognized {
            out.push_str(record.get(&name).map(Value::as_text).unwrap_or(""));
            rest = &after[name.len() + 2..];
        } else {
            out.push_str("{{");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

// ─────────────────────────────────────────────────────────────────────
// Serialization

impl Template {
    /// Deterministic JSON: field order is the struct's declaration
    /// order, so the same template always serializes to the same bytes.
    pub fn to_json(&self) -> Result<String, TemplateError> {
        serde_json::to_string(self).map_err(TemplateError::Json)
    }

    /// Parse a template from JSON.
    pub fn from_json(s: &str) -> Result<Template, TemplateError> {
        serde_json::from_str(s).map_err(TemplateError::from_json_error)
    }
}

impl TemplateError {
    /// A JSON error that names an element type this build does not know
    /// (`unknown variant \`x\``) is not a broken template — it is a
    /// template from a newer PrintNinja, and is said so.
    fn from_json_error(e: serde_json::Error) -> TemplateError {
        let msg = e.to_string();
        if let Some(start) = msg.find("unknown variant `") {
            let rest = &msg[start + "unknown variant `".len()..];
            if let Some(end) = rest.find('`') {
                return TemplateError::TooNew(rest[..end].to_string());
            }
        }
        TemplateError::Json(e)
    }
}

// ─────────────────────────────────────────────────────────────────────
// Errors

/// A template that does not hold together.
#[derive(Debug)]
pub enum TemplateError {
    /// `format: html` on label or roll media (plan §5.3).
    HtmlOnThermalMedia(f32, f32),
    /// `format: html` but the `html` field is missing or empty.
    NoHtml,
    /// `format: html` with scene elements — the document track renders
    /// the document, not elements.
    HtmlHasElements,
    /// `format: scene` but the template carries HTML content.
    HtmlOnScene,
    /// Media geometry is missing or non-positive.
    BadGeometry { width_mm: f32, height_mm: f32 },
    /// A group placed without `page: flow`.
    GroupNotFlow(String),
    /// A group bound to a field that is not declared `list`.
    GroupBindNotList(String),
    /// A group with no items.
    EmptyGroup(String),
    /// A group with a negative item gap.
    NegativeGap(String),
    /// Groups may not contain groups (v1).
    NestedGroups,
    /// A `page: flow` on a non-group element.
    FlowOnFixedElement(String),
    /// `page: only` with page number 0 (pages are 1-based).
    PageNumberZero,
    /// A binding (or group `bind`) that no declared field has.
    UnknownBinding(String),
    /// An element that leaves its page.
    OffPage {
        element: String,
        edge: f32,
        limit: f32,
    },
    /// Frames nested deeper than the limit.
    FrameTooDeep,
    /// A frame's border that is not a non-negative number of mm.
    BadBorder(f32),
    /// A frame child with a `page` of its own — the frame decides.
    FrameChildPage(String),
    /// A group inside a frame (v1: frames hold fixed elements only).
    GroupInFrame,
    /// A frame child that leaves the frame's size.
    FrameChildOutside {
        element: String,
        edge: f32,
        limit: f32,
    },
    /// The JSON is well-formed but names a scene element this build
    /// does not know — the template was written by a newer PrintNinja.
    TooNew(String),
    /// Malformed JSON.
    Json(serde_json::Error),
}

impl fmt::Display for TemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TemplateError::HtmlOnThermalMedia(w, h) => write!(
                f,
                "an HTML template needs page media (A4, letter, …); this one is \
                 {w}×{h} mm thermal media — use format \"scene\""
            ),
            TemplateError::NoHtml => write!(
                f,
                "the format is \"html\" but the template carries no HTML \
                 document — put the document in the \"html\" field"
            ),
            TemplateError::HtmlHasElements => write!(
                f,
                "the format is \"html\" renders the document, not scene \
                 elements — move the design into the HTML"
            ),
            TemplateError::HtmlOnScene => write!(
                f,
                "the format is \"scene\" but the template carries an HTML \
                 document — use format \"html\" for the document track"
            ),
            TemplateError::BadGeometry {
                width_mm,
                height_mm,
            } => write!(
                f,
                "the media size must be a positive number of millimetres (got \
                 {width_mm}×{height_mm})"
            ),
            TemplateError::GroupNotFlow(bind) => write!(
                f,
                "group \"{bind}\" needs \"page\": \"flow\" — a repeating group \
                 flows across pages, it does not sit on one"
            ),
            TemplateError::GroupBindNotList(bind) => write!(
                f,
                "group \"{bind}\" binds to a field that is not declared a list — \
                 a group needs one row per array entry"
            ),
            TemplateError::EmptyGroup(bind) => {
                write!(f, "group \"{bind}\" has no items to repeat")
            }
            TemplateError::NegativeGap(bind) => {
                write!(f, "group \"{bind}\" has a negative item gap")
            }
            TemplateError::NestedGroups => write!(
                f,
                "groups cannot contain groups (v1) — flatten the inner items into \
                 the outer group"
            ),
            TemplateError::FlowOnFixedElement(name) => write!(
                f,
                "\"{name}\" cannot flow — only repeating groups do; give it a \
                 page (\"every\", \"first\", \"last\" or \"only\")"
            ),
            TemplateError::PageNumberZero => {
                write!(f, "page numbers start at 1, not 0")
            }
            TemplateError::UnknownBinding(name) => write!(
                f,
                "the template binds \"{{{name}}}\" but no field named \"{name}\" \
                 is declared"
            ),
            TemplateError::OffPage {
                element,
                edge,
                limit,
            } => write!(
                f,
                "{element} runs past the page: it reaches {edge:.2} mm, but the \
                 page ends at {limit:.2} mm"
            ),
            TemplateError::FrameTooDeep => write!(
                f,
                "frames nest to a depth of {} — one frame too many; flatten the \
                 inner frame into its parent",
                Template::FRAME_DEPTH_LIMIT
            ),
            TemplateError::BadBorder(b) => write!(
                f,
                "a frame's border must be a non-negative number of millimetres \
                 (got {b})"
            ),
            TemplateError::FrameChildPage(name) => write!(
                f,
                "\"{name}\" sits in a frame and cannot choose its own page — \
                 the frame decides which page its children appear on"
            ),
            TemplateError::GroupInFrame => write!(
                f,
                "a repeating group cannot sit inside a frame (v1) — a frame \
                 holds fixed elements; repeat the frame from the outside"
            ),
            TemplateError::FrameChildOutside {
                element,
                edge,
                limit,
            } => write!(
                f,
                "{element} runs past the frame: it reaches {edge:.2} mm, but \
                 the frame ends at {limit:.2} mm"
            ),
            TemplateError::TooNew(name) => write!(
                f,
                "this template uses \"{name}\", which needs a newer PrintNinja \
                 — update the app to open it"
            ),
            TemplateError::Json(e) => write!(f, "the template is not valid JSON: {e}"),
        }
    }
}

impl std::error::Error for TemplateError {}

impl From<serde_json::Error> for TemplateError {
    fn from(e: serde_json::Error) -> Self {
        TemplateError::Json(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label() -> Media {
        Media::Label {
            width_mm: 58.0,
            height_mm: 40.0,
        }
    }

    fn text(y: f32, content: &str) -> Element {
        text_xy(4.0, y, content, Placement::default())
    }

    /// A text element at an explicit `x`, on an explicit `page`. Group
    /// items sit at the item origin (x 0), not at the page margin.
    fn text_xy(x: f32, y: f32, content: &str, page: Placement) -> Element {
        Element::Text {
            at: At { x_mm: x, y_mm: y },
            size: Size {
                w_mm: 50.0,
                h_mm: 4.0,
            },
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

    #[test]
    fn a_minimal_label_template_round_trips_to_the_same_bytes() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: vec![Field {
                name: "customer".to_string(),
                kind: FieldKind::String,
            }],
            elements: vec![text(6.0, "Hello {{customer}}")],
            fonts: vec![],
        };
        let once = t.to_json().unwrap();
        let back = Template::from_json(&once).unwrap();
        assert_eq!(back, t, "parse must invert serialize");
        assert_eq!(
            back.to_json().unwrap(),
            once,
            "serialization is deterministic"
        );
        t.validate().unwrap();
    }

    #[test]
    fn the_default_track_is_scene_and_the_default_placement_is_every() {
        let t: Template = serde_json::from_str(
            r#"{ "media": { "kind": "label", "width_mm": 58, "height_mm": 40 },
                  "elements": [ { "type": "text",
                                  "at": { "x_mm": 4, "y_mm": 6 },
                                  "size": { "w_mm": 50, "h_mm": 4 },
                                  "content": "x",
                                  "style": { "size_mm": 3 } } ] }"#,
        )
        .unwrap();
        assert_eq!(t.format, Format::Scene);
        assert_eq!(other_page(&t.elements[0]), Placement::Every);
    }

    #[test]
    fn placement_serializes_with_the_only_variant_carrying_its_number() {
        let p: Placement = serde_json::from_str(r#"{ "only": 2 }"#).unwrap();
        assert_eq!(p, Placement::Only(2));
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"only":2}"#);
    }

    #[test]
    fn an_html_template_is_rejected_on_thermal_media() {
        let t = Template {
            format: Format::Html,
            html: None,
            media: label(),
            fields: vec![],
            elements: vec![],
            fonts: vec![],
        };
        let err = t.validate().unwrap_err();
        assert!(
            err.to_string().contains("HTML template needs page media"),
            "{err}"
        );
        assert!(!err.to_string().is_empty());
        // The same template with its document, on page media, is fine.
        let mut ok = Template {
            media: Media::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
            ..t.clone()
        };
        ok.html = Some("<html></html>".into());
        ok.validate().unwrap();
    }

    #[test]
    fn a_group_must_flow_and_may_not_nest() {
        let items = vec![text_xy(0.0, 0.0, "{{line.item}}", Placement::default())];
        let flow = Element::Group {
            at: At {
                x_mm: 4.0,
                y_mm: 20.0,
            },
            w_mm: 50.0,
            item_gap_mm: 1.0,
            bind: "lines".to_string(),
            items: items.clone(),
            page: Placement::Flow,
        };
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: vec![],
            elements: vec![flow],
            fonts: vec![],
        };
        t.validate().unwrap();

        // Not flow:
        let not_flow = Element::Group {
            at: At {
                x_mm: 4.0,
                y_mm: 20.0,
            },
            w_mm: 50.0,
            item_gap_mm: 1.0,
            bind: "lines".to_string(),
            items: vec![text_xy(0.0, 0.0, "row", Placement::default())],
            page: Placement::Every,
        };
        let bad = Template {
            elements: vec![not_flow],
            ..t.clone()
        };
        assert!(matches!(
            bad.validate(),
            Err(TemplateError::GroupNotFlow(_))
        ));

        // Nested:
        let inner = Element::Group {
            at: At {
                x_mm: 0.0,
                y_mm: 0.0,
            },
            w_mm: 50.0,
            item_gap_mm: 0.0,
            bind: "inner".to_string(),
            items: vec![text_xy(0.0, 0.0, "x", Placement::default())],
            page: Placement::Flow,
        };
        let outer = Element::Group {
            at: At {
                x_mm: 4.0,
                y_mm: 20.0,
            },
            w_mm: 50.0,
            item_gap_mm: 1.0,
            bind: "lines".to_string(),
            items: vec![inner],
            page: Placement::Flow,
        };
        let nested = Template {
            elements: vec![outer],
            ..t.clone()
        };
        assert!(matches!(
            nested.validate(),
            Err(TemplateError::NestedGroups)
        ));
    }

    #[test]
    fn a_group_bound_to_a_declared_field_must_be_a_list() {
        let group = Element::Group {
            at: At {
                x_mm: 4.0,
                y_mm: 20.0,
            },
            w_mm: 50.0,
            item_gap_mm: 1.0,
            bind: "lines".to_string(),
            items: vec![text_xy(0.0, 0.0, "row", Placement::default())],
            page: Placement::Flow,
        };
        let declared_string = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: vec![Field {
                name: "lines".to_string(),
                kind: FieldKind::String,
            }],
            elements: vec![group.clone()],
            fonts: vec![],
        };
        assert!(matches!(
            declared_string.validate(),
            Err(TemplateError::GroupBindNotList(_))
        ));

        let declared_list = Template {
            fields: vec![Field {
                name: "lines".to_string(),
                kind: FieldKind::List,
            }],
            ..declared_string.clone()
        };
        declared_list.validate().unwrap();
    }

    #[test]
    fn a_declared_binding_set_catches_a_typo() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: vec![Field {
                name: "customer".to_string(),
                kind: FieldKind::String,
            }],
            elements: vec![text(6.0, "Hello {{custmoer}}")],
            fonts: vec![],
        };
        assert!(matches!(
            t.validate(),
            Err(TemplateError::UnknownBinding(name)) if name == "custmoer"
        ));
        // Without a declared set, anything goes (the data may simply not
        // have the field; expansion then resolves it to nothing).
        let undeclared = Template {
            fields: vec![],
            ..t.clone()
        };
        undeclared.validate().unwrap();
    }

    #[test]
    fn an_element_that_runs_off_the_page_is_named() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: vec![],
            elements: vec![text(38.0, "too low")], // y 38 + h 4 = 42 > 40
            fonts: vec![],
        };
        let err = t.validate().unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("too low"), "{msg}");
        assert!(msg.contains("past the page"), "{msg}");
    }

    #[test]
    fn zero_is_not_a_page_number() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: Media::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
            fields: vec![],
            elements: vec![text_xy(4.0, 6.0, "x", Placement::Only(0))],
            fonts: vec![],
        };
        assert!(matches!(t.validate(), Err(TemplateError::PageNumberZero)));
    }

    // Frames: nested boxes that flatten to a border rect and offset
    // children at expand.

    /// `depth` frames nested inside each other, each at the origin.
    fn nested_frames(depth: u32) -> Element {
        let mut el: Element = Element::Frame {
            at: At {
                x_mm: 0.0,
                y_mm: 0.0,
            },
            size: Size {
                w_mm: 2.0,
                h_mm: 2.0,
            },
            border_mm: 0.0,
            children: vec![],
            page: Placement::default(),
        };
        for _ in 0..depth {
            el = Element::Frame {
                at: At {
                    x_mm: 0.0,
                    y_mm: 0.0,
                },
                size: Size {
                    w_mm: 4.0,
                    h_mm: 4.0,
                },
                border_mm: 0.0,
                children: vec![el],
                page: Placement::default(),
            };
        }
        el
    }

    fn frame_t(el: Element) -> Template {
        Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: vec![],
            elements: vec![el],
            fonts: vec![],
        }
    }

    #[test]
    fn frames_nest_to_the_limit_but_one_beyond_is_rejected() {
        // `nested_frames(3)` is four frames deep: the limit. One more
        // wrapper is one too many.
        frame_t(nested_frames(3)).validate().unwrap();
        let err = frame_t(nested_frames(4)).validate().unwrap_err();
        assert!(matches!(err, TemplateError::FrameTooDeep));
        assert!(
            err.to_string().contains("one frame too many"),
            "{}",
            err.to_string()
        );
    }

    #[test]
    fn a_frame_border_must_be_a_non_negative_number() {
        fn bordered(border: f32) -> Template {
            frame_t(Element::Frame {
                at: At {
                    x_mm: 4.0,
                    y_mm: 4.0,
                },
                size: Size {
                    w_mm: 30.0,
                    h_mm: 20.0,
                },
                border_mm: border,
                children: vec![],
                page: Placement::default(),
            })
        }
        bordered(0.5).validate().unwrap();
        assert!(matches!(
            bordered(-0.5).validate(),
            Err(TemplateError::BadBorder(b)) if b < 0.0
        ));
        assert!(matches!(
            bordered(f32::NAN).validate(),
            Err(TemplateError::BadBorder(_))
        ));
    }

    #[test]
    fn a_group_cannot_sit_in_a_frame() {
        let t = frame_t(Element::Frame {
            at: At {
                x_mm: 4.0,
                y_mm: 4.0,
            },
            size: Size {
                w_mm: 50.0,
                h_mm: 30.0,
            },
            border_mm: 0.5,
            children: vec![Element::Group {
                at: At {
                    x_mm: 0.0,
                    y_mm: 0.0,
                },
                w_mm: 46.0,
                item_gap_mm: 1.0,
                bind: "lines".to_string(),
                items: vec![text_xy(0.0, 0.0, "row", Placement::default())],
                page: Placement::Flow,
            }],
            page: Placement::default(),
        });
        assert!(matches!(t.validate(), Err(TemplateError::GroupInFrame)));
    }

    #[test]
    fn a_frame_child_cannot_choose_its_own_page() {
        let t = frame_t(Element::Frame {
            at: At {
                x_mm: 4.0,
                y_mm: 4.0,
            },
            size: Size {
                w_mm: 50.0,
                h_mm: 12.0,
            },
            border_mm: 0.5,
            children: vec![text_xy(2.0, 2.0, "stamped", Placement::First)],
            page: Placement::default(),
        });
        let err = t.validate().unwrap_err();
        assert!(
            matches!(
                err,
                TemplateError::FrameChildPage(ref name) if name.contains("stamped")
            ),
            "{err}"
        );
        assert!(
            err.to_string().contains("sits in a frame"),
            "{}",
            err.to_string()
        );
    }

    #[test]
    fn a_child_that_runs_past_the_frame_is_named() {
        let t = frame_t(Element::Frame {
            at: At {
                x_mm: 4.0,
                y_mm: 4.0,
            },
            size: Size {
                w_mm: 30.0,
                h_mm: 20.0,
            },
            border_mm: 0.5,
            // The helper text is 50 mm wide: 10 + 50 = 60, past the
            // frame's 30 mm.
            children: vec![text_xy(10.0, 2.0, "too wide", Placement::default())],
            page: Placement::default(),
        });
        let err = t.validate().unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("too wide"), "{msg}");
        assert!(msg.contains("runs past the frame"), "{msg}");
    }

    #[test]
    fn a_frame_template_round_trips_to_the_same_bytes() {
        let t = frame_t(Element::Frame {
            at: At {
                x_mm: 4.0,
                y_mm: 24.0,
            },
            size: Size {
                w_mm: 50.0,
                h_mm: 12.0,
            },
            border_mm: 0.3,
            children: vec![Element::Frame {
                at: At {
                    x_mm: 2.0,
                    y_mm: 2.0,
                },
                size: Size {
                    w_mm: 24.0,
                    h_mm: 8.0,
                },
                border_mm: 0.15,
                children: vec![Element::Text {
                    at: At {
                        x_mm: 2.0,
                        y_mm: 2.0,
                    },
                    size: Size {
                        w_mm: 20.0,
                        h_mm: 4.0,
                    },
                    content: "Ship to {{customer}}".to_string(),
                    style: TextStyle {
                        size_mm: 3.0,
                        font: None,
                        bold: false,
                        italic: false,
                        align: Align::Left,
                    },
                    page: Placement::default(),
                }],
                page: Placement::default(),
            }],
            page: Placement::default(),
        });
        t.validate().unwrap();
        let once = t.to_json().unwrap();
        let back = Template::from_json(&once).unwrap();
        assert_eq!(back, t, "parse must invert serialize");
        assert_eq!(
            back.to_json().unwrap(),
            once,
            "serialization is deterministic"
        );
    }

    #[test]
    fn an_element_type_this_build_does_not_know_says_update() {
        let json = r#"{ "media": { "kind": "label", "width_mm": 58, "height_mm": 40 },
                     "elements": [ { "type": "sparkle",
                                     "at": { "x_mm": 4, "y_mm": 6 },
                                     "size": { "w_mm": 50, "h_mm": 4 } } ] }"#;
        let err = Template::from_json(json).unwrap_err();
        assert!(
            matches!(err, TemplateError::TooNew(ref name) if name == "sparkle"),
            "{err}"
        );
        assert!(
            err.to_string().contains("newer PrintNinja"),
            "{}",
            err.to_string()
        );
    }

    /// The wire format is part of the contract with the UI (the TS
    /// mirror in `app/ui/src/scene/schema.ts`), so a representative
    /// template's bytes are pinned goldens, not re-derived.
    #[test]
    fn a_fixed_template_serializes_to_the_pinned_golden_bytes() {
        let t = Template {
            format: Format::Scene,
            html: None,
            media: Media::Label {
                width_mm: 58.0,
                height_mm: 40.0,
            },
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
                text_xy(4.0, 5.0, "For {{customer}}", Placement::default()),
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
                text_xy(4.0, 16.0, "Total: {{amount}}", Placement::default()),
                Element::Frame {
                    at: At {
                        x_mm: 4.0,
                        y_mm: 24.0,
                    },
                    size: Size {
                        w_mm: 50.0,
                        h_mm: 12.0,
                    },
                    border_mm: 0.3,
                    children: vec![Element::Text {
                        at: At {
                            x_mm: 2.0,
                            y_mm: 2.0,
                        },
                        size: Size {
                            w_mm: 44.0,
                            h_mm: 4.0,
                        },
                        content: "Ship to {{customer}}".to_string(),
                        style: TextStyle {
                            size_mm: 3.0,
                            font: None,
                            bold: false,
                            italic: false,
                            align: Align::Left,
                        },
                        page: Placement::default(),
                    }],
                    page: Placement::default(),
                },
            ],
            fonts: vec![],
        };
        let json = t.to_json().unwrap();
        golden_harness::assert_matches_golden("scene/label-template.json", json.as_bytes());
    }

    #[test]
    fn binding_names_skip_the_malformed_and_keep_first_use_order() {
        assert_eq!(
            binding_names("{{a}} {{b}} {{a}} {{1x}} {{ a }} {{ok_2}}"),
            vec!["a".to_string(), "b".to_string(), "ok_2".to_string()]
        );
        assert!(binding_names("no bindings here").is_empty());
        assert_eq!(binding_names("{{a"), vec![] as Vec<String>);
    }

    fn html_template(html: &str) -> Template {
        Template {
            format: Format::Html,
            html: Some(html.to_string()),
            media: Media::Page {
                width_mm: 210.0,
                height_mm: 297.0,
            },
            fields: Vec::new(),
            elements: Vec::new(),
            fonts: Vec::new(),
        }
    }

    #[test]
    fn an_html_template_on_page_media_is_the_document_track() {
        let t = html_template("<html><body>{{title}}</body></html>");
        t.validate()
            .expect("an html document on page media is valid");
    }

    #[test]
    fn an_html_format_without_a_document_is_rejected() {
        let mut missing = html_template("<html></html>");
        missing.html = None;
        assert!(matches!(missing.validate(), Err(TemplateError::NoHtml)));
        let blank = html_template("   ");
        assert!(matches!(blank.validate(), Err(TemplateError::NoHtml)));
    }

    #[test]
    fn a_scene_format_with_html_content_is_rejected() {
        let mut t = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: Vec::new(),
            elements: Vec::new(),
            fonts: Vec::new(),
        };
        t.html = Some("<html></html>".into());
        assert!(matches!(t.validate(), Err(TemplateError::HtmlOnScene)));
    }

    #[test]
    fn an_html_template_with_scene_elements_is_rejected() {
        let mut t = html_template("<html></html>");
        t.elements = vec![text(10.0, "x")];
        assert!(matches!(t.validate(), Err(TemplateError::HtmlHasElements)));
    }

    #[test]
    fn an_html_binding_is_checked_against_the_declared_fields() {
        let mut t = html_template("<html><body>{{title}} {{missing}}</body></html>");
        t.fields = vec![Field {
            name: "title".into(),
            kind: Default::default(),
        }];
        assert!(matches!(
            t.validate(),
            Err(TemplateError::UnknownBinding(n)) if n == "missing"
        ));
        // No declared fields: bindings are left to the data, like scene.
        t.fields = Vec::new();
        t.validate()
            .expect("without declared fields, any binding goes");
    }

    #[test]
    fn the_html_field_round_trips_and_is_omitted_when_absent() {
        let t = html_template("<html></html>");
        let json = t.to_json().unwrap();
        assert!(json.contains("\"html\":\"<html></html>\""));
        assert_eq!(Template::from_json(&json).unwrap(), t);
        let scene = Template {
            format: Format::Scene,
            html: None,
            media: label(),
            fields: Vec::new(),
            elements: Vec::new(),
            fonts: Vec::new(),
        };
        let scene_json = scene.to_json().unwrap();
        assert!(
            !scene_json.contains("html"),
            "an absent html field does not change the scene bytes: {scene_json}"
        );
    }

    #[test]
    fn substitute_fills_the_record_and_keeps_the_rest_of_the_document() {
        let records = Records::from_json(r#"[{"title":"INVOICE 1042","qty":2}]"#).unwrap();
        let record = &records.0[0];
        let doc = "<html><body><h1>{{title}}</h1>× {{qty}} — {{missing}}</body></html>";
        assert_eq!(
            substitute(doc, record),
            "<html><body><h1>INVOICE 1042</h1>× 2 — </body></html>"
        );
        // Non-bindings between braces stay exactly as written:
        // `{{ a }}` (a space is not a name) and the outer braces of
        // `{{{{title}}}}` survive, and only the inner `{{title}}` is a
        // binding — the same text `binding_names` sees.
        let tricky = "{{ a }} {{x1}} {{{{title}}}}";
        assert_eq!(substitute(tricky, record), "{{ a }}  {{INVOICE 1042}}");
    }
}
