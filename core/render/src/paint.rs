//! Painting an expanded scene page — the scene → render link in the
//! pipeline (plan §5.2).
//!
//! [`paint_page`] draws one expanded [`Page`]'s placed elements onto a
//! [`Renderer`], dispatching each [`PlacedKind`] to its drawing call.
//! This is the bridge that turns a template (pn-scene) into raster:
//! the production pipeline and the e2e tests both run through it, so
//! preview and print draw the same dots.
//!
//! `Image` elements draw nothing: the raster renderer has no bitmap
//! resource support yet, which is the renderer's established behaviour
//! for a shape it cannot draw (as with a barcode value its symbology
//! cannot carry) — the job prints, it does not fail.

use pn_scene::{Page, Placed, PlacedKind};

use crate::Renderer;

/// The frame thickness an outlined rect is drawn at: the scene's
/// `Rect` carries no thickness of its own.
const FRAME_THICKNESS_MM: f32 = 0.5;

/// Draw every element of `page` (in draw order) onto the renderer.
pub fn paint_page(page: &Page, r: &mut Renderer) {
    for placed in &page.elements {
        paint(placed, r);
    }
}

fn paint(placed: &Placed, r: &mut Renderer) {
    match &placed.kind {
        PlacedKind::Text {
            w_mm,
            h_mm,
            content,
            style,
        } => r.draw_text(placed.x_mm, placed.y_mm, *w_mm, *h_mm, content, style),
        PlacedKind::Barcode {
            w_mm,
            h_mm,
            kind,
            value,
            show_text,
        } => r.draw_barcode(
            placed.x_mm,
            placed.y_mm,
            *w_mm,
            *h_mm,
            kind,
            value,
            *show_text,
        ),
        PlacedKind::Qr { h_mm, value } => r.draw_qr(placed.x_mm, placed.y_mm, *h_mm, value),
        PlacedKind::Line {
            length_mm,
            thickness_mm,
            vertical,
        } => r.draw_line(
            placed.x_mm,
            placed.y_mm,
            *length_mm,
            *thickness_mm,
            *vertical,
        ),
        PlacedKind::Rect {
            w_mm,
            h_mm,
            fill,
            thickness_mm,
        } => {
            // A plain scene rect carries no thickness; a frame's border
            // does, and it is drawn at the border the template asked for.
            let outlined = match thickness_mm {
                Some(t) => *t,
                None => FRAME_THICKNESS_MM,
            };
            let thickness = if *fill { 0.0 } else { outlined };
            r.draw_rect(placed.x_mm, placed.y_mm, *w_mm, *h_mm, thickness, *fill);
        }
        // The raster renderer has no bitmap resource support yet.
        PlacedKind::Image { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dots_for_mm;
    use pn_scene::{Align, TextStyle};

    /// A page with a line, a framed rect and a text block: each lands
    /// ink where the scene says it goes.
    #[test]
    fn a_page_paints_each_of_its_elements() {
        let page = Page {
            index: 0,
            elements: vec![
                Placed {
                    x_mm: 5.0,
                    y_mm: 5.0,
                    kind: PlacedKind::Line {
                        length_mm: 30.0,
                        thickness_mm: 0.5,
                        vertical: false,
                    },
                },
                Placed {
                    x_mm: 3.0,
                    y_mm: 10.0,
                    kind: PlacedKind::Rect {
                        w_mm: 40.0,
                        h_mm: 20.0,
                        fill: false,
                        thickness_mm: None,
                    },
                },
                Placed {
                    x_mm: 5.0,
                    y_mm: 14.0,
                    kind: PlacedKind::Text {
                        w_mm: 30.0,
                        h_mm: 6.0,
                        content: "PRINT NINJA".into(),
                        style: TextStyle {
                            size_mm: 3.0,
                            font: None,
                            bold: true,
                            italic: false,
                            align: Align::Center,
                        },
                    },
                },
            ],
        };

        let dpi = 203u32;
        let w = dots_for_mm(50.0, dpi);
        let h = dots_for_mm(35.0, dpi);
        let mut r = Renderer::new(dpi, w, h);
        paint_page(&page, &mut r);
        let bmp = r.into_page();

        // A dot inside the line (y 5–5.5 mm, x 5–35 mm).
        assert!(bmp.get(100, 42), "the line covers its dot");
        // A dot inside the rect's top frame (y 10–30 mm, 0.5 mm frame).
        assert!(bmp.get(200, 82), "the frame covers its dot");
        // A dot above every element is blank.
        assert!(!bmp.get(100, 10), "nothing is drawn above the line");
    }

    /// An image-only page draws nothing — the renderer has no bitmap
    /// support yet — so the page comes out blank.
    #[test]
    fn an_image_only_page_comes_out_blank() {
        let page = Page {
            index: 0,
            elements: vec![Placed {
                x_mm: 5.0,
                y_mm: 5.0,
                kind: PlacedKind::Image {
                    w_mm: 20.0,
                    h_mm: 20.0,
                    src: "data:,".into(),
                },
            }],
        };
        let dpi = 203u32;
        let w = dots_for_mm(30.0, dpi);
        let h = dots_for_mm(30.0, dpi);
        let mut r = Renderer::new(dpi, w, h);
        paint_page(&page, &mut r);
        assert!(
            r.into_page().to_bytes().iter().all(|&b| b == 0),
            "an unsupported image draws nothing"
        );
    }
}
