//! Drawing placed shapes onto the page: lines and rectangles in
//! millimetres, at the renderer's dpi. Text, barcodes and images join
//! this in later phase-5 increments.
//!
//! Coordinates match the scene: `x` and `y` in millimetres from the top
//! left, `y` growing downward. Shapes are computed in dots end to end
//! and only then clipped to the page, so a shape that runs off the page
//! keeps its scene-specified size.

use crate::bitmap::Bitmap;
use crate::geometry::signed_dots;

/// Draws onto a fixed-size page of 1-bit dots.
#[derive(Debug)]
pub struct Renderer {
    // crate-visible: the text module stamps the page the same way.
    pub(crate) dpi: u32,
    pub(crate) page: Bitmap,
}

impl Renderer {
    /// A blank page of `width_dots` × `height_dots` at `dpi`.
    ///
    /// `width_dots` should already be capped by the head
    /// ([`crate::fit_to_head`]); the renderer draws what it is given.
    pub fn new(dpi: u32, width_dots: u32, height_dots: u32) -> Self {
        Self {
            dpi,
            page: Bitmap::new(width_dots, height_dots),
        }
    }

    pub fn dpi(&self) -> u32 {
        self.dpi
    }

    /// The page so far — borrow it for preview or take the bytes.
    pub fn page(&self) -> &Bitmap {
        &self.page
    }

    /// Consume the renderer into its finished page.
    pub fn into_page(self) -> Bitmap {
        self.page
    }

    /// Fill the intersection of `[x0, x1) × [y0, y1)` (dots) with the
    /// page. Ranges may extend off the page; they are clipped.
    pub(crate) fn fill(&mut self, x0: i64, y0: i64, x1: i64, y1: i64) {
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let w = self.page.width() as i64;
        let h = self.page.height() as i64;
        let (x0, y0) = (x0.max(0), y0.max(0));
        let (x1, y1) = (x1.min(w), y1.min(h));
        for y in y0..y1 {
            for x in x0..x1 {
                self.page.set(x as u32, y as u32, true);
            }
        }
    }

    /// A line from `(x_mm, y_mm)`: horizontal by default, vertical when
    /// `vertical`. `length_mm` along its axis, `thickness_mm` across it.
    /// Clipped to the page; a zero length or thickness draws nothing.
    pub fn draw_line(
        &mut self,
        x_mm: f32,
        y_mm: f32,
        length_mm: f32,
        thickness_mm: f32,
        vertical: bool,
    ) {
        // Both ends in dots, then clip — a shape that starts off the
        // page keeps its scene-specified size.
        if vertical {
            let x0 = signed_dots(x_mm, self.dpi);
            let x1 = signed_dots(x_mm + thickness_mm, self.dpi);
            let y0 = signed_dots(y_mm, self.dpi);
            let y1 = signed_dots(y_mm + length_mm, self.dpi);
            self.fill(x0, y0, x1, y1);
        } else {
            let x0 = signed_dots(x_mm, self.dpi);
            let x1 = signed_dots(x_mm + length_mm, self.dpi);
            let y0 = signed_dots(y_mm, self.dpi);
            let y1 = signed_dots(y_mm + thickness_mm, self.dpi);
            self.fill(x0, y0, x1, y1);
        }
    }

    /// A rectangle at `(x_mm, y_mm)` of `w_mm` × `h_mm`. Filled when
    /// `fill`, otherwise a frame `thickness_mm` thick (at least one dot)
    /// on all four sides. Clipped to the page.
    pub fn draw_rect(
        &mut self,
        x_mm: f32,
        y_mm: f32,
        w_mm: f32,
        h_mm: f32,
        thickness_mm: f32,
        fill: bool,
    ) {
        let x0 = signed_dots(x_mm, self.dpi);
        let y0 = signed_dots(y_mm, self.dpi);
        let x1 = signed_dots(x_mm + w_mm, self.dpi);
        let y1 = signed_dots(y_mm + h_mm, self.dpi);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        if fill {
            self.fill(x0, y0, x1, y1);
            return;
        }
        let t = (signed_dots(x_mm + thickness_mm, self.dpi) - x0).max(1);
        let (w, h) = (x1 - x0, y1 - y0);
        if w <= t * 2 && h <= t * 2 {
            self.fill(x0, y0, x1, y1); // too small to frame: solid
            return;
        }
        self.fill(x0, y0, x1, y0 + t); // top
        self.fill(x0, y1 - t, x1, y1); // bottom
        self.fill(x0, y0, x0 + t, y1); // left
        self.fill(x1 - t, y0, x1, y1); // right
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// At 203 dpi: a 10 mm line is 80 dots, a 0.25 mm thickness is 2
    /// dots, and the line starts exactly at its coordinate.
    #[test]
    fn a_horizontal_line_runs_its_length_at_its_thickness() {
        let mut r = Renderer::new(203, 200, 100);
        r.draw_line(10.0, 10.0, 10.0, 0.25, false);
        let p = r.page();
        assert!(p.get(80, 80)); // start: 10 mm = 79.92 dots -> 80
        assert!(p.get(80, 81)); // 2 dots thick
        assert!(p.get(159, 80)); // end: 80 + 80 - 1
        assert!(!p.get(160, 80)); // one past the end
        assert!(!p.get(79, 80)); // one before the start
        assert!(!p.get(80, 82)); // one below the thickness
    }

    /// A vertical line runs down from its top coordinate, thickness
    /// across the x axis.
    #[test]
    fn a_vertical_line_runs_down_from_its_top() {
        let mut r = Renderer::new(203, 100, 200);
        r.draw_line(10.0, 10.0, 10.0, 0.25, true);
        let p = r.page();
        assert!(p.get(80, 80));
        assert!(p.get(81, 159));
        assert!(!p.get(80, 160));
        assert!(!p.get(82, 80));
    }

    /// A rectangle frame is its border, `thickness_mm` thick on all four
    /// sides, and the interior stays white.
    #[test]
    fn an_outlined_rect_is_a_frame_not_a_fill() {
        // 20 × 6 mm at 203 dpi, 0.5 mm frame (4 dots).
        let mut r = Renderer::new(203, 200, 100);
        r.draw_rect(2.0, 2.0, 20.0, 6.0, 0.5, false);
        let p = r.page();
        assert!(p.get(16, 16)); // top-left corner
        assert!(p.get(16, 19)); // inside the 4-dot frame
        assert!(!p.get(25, 25)); // interior, clear of all four sides
        assert!(!p.get(100, 40)); // dead centre
        assert!(p.get(16, 63)); // bottom edge: 16 + 48 - 1
        assert!(p.get(175, 16)); // right edge: 16 + 160 - 1
    }

    /// A filled rect covers its whole area, edge to edge.
    #[test]
    fn a_filled_rect_covers_its_whole_area() {
        let mut r = Renderer::new(203, 200, 200);
        r.draw_rect(10.0, 10.0, 10.0, 10.0, 0.25, true);
        let p = r.page();
        assert!(p.get(80, 80));
        assert!(p.get(159, 159));
        assert!(!p.get(160, 160));
        // fully black square: count the set bits
        let mut black = 0usize;
        for y in 0..200 {
            for x in 0..200 {
                if p.get(x, y) {
                    black += 1;
                }
            }
        }
        assert_eq!(black, 80 * 80);
    }

    /// A shape that starts off the page is clipped at the edge and keeps
    /// its scene-specified length — it does not get longer.
    #[test]
    fn shapes_clamp_to_the_page_edges() {
        let mut r = Renderer::new(203, 957, 957); // 120 × 120 mm
        r.draw_line(-5.0, 10.0, 30.0, 0.25, false); // 30 mm from x=-5 mm: on-page part is 0..25 mm
        r.draw_rect(100.0, 100.0, 30.0, 30.0, 0.25, true); // runs off the right and bottom edges
        let p = r.page();
        assert!(p.get(0, 80)); // the line starts at the left edge
        assert!(p.get(199, 80)); // and ends at 25 mm = 199.8 dots
        assert!(!p.get(200, 80)); // ...not 30 mm from the edge
        assert!(p.get(799, 799)); // the rect starts at 100 mm = 799 dots
        assert!(p.get(956, 956)); // and is clipped at the page corner
        assert!(!p.get(798, 798)); // one dot before the rect
        assert_eq!(p.width(), 957);
        assert_eq!(p.height(), 957);
    }

    /// Zero length or zero thickness draws nothing at all.
    #[test]
    fn zero_sized_shapes_draw_nothing() {
        let mut r = Renderer::new(203, 100, 100);
        r.draw_line(10.0, 10.0, 0.0, 1.0, false);
        r.draw_line(10.0, 10.0, 10.0, 0.0, false);
        r.draw_rect(10.0, 10.0, 0.0, 5.0, 0.25, true);
        r.draw_rect(10.0, 10.0, 5.0, 0.0, 0.25, false);
        assert_eq!(r.page().to_bytes(), &[0; 100 * 13]);
    }
}
