//! Text: shaped with swash (OpenType layout, full CJK coverage),
//! rasterized glyph by glyph with ab_glyph's outline drawer into an
//! 8-bit coverage buffer, and thresholded at half coverage to the
//! 1-bit page.
//!
//! Font fallback is per character: the family the scene named shapes
//! the line, and any character it lacks (`.notdef`) is re-shaped in
//! the next embedded font — so a Japanese phrase inside a Latin line,
//! or a kanji in a name, finds its glyph in Noto Sans JP while
//! everything else stays in Noto Sans (plan §5.2: text shaping with
//! font fallback, including Japanese).
//!
//! Bold is a second strike offset a few dots to the right — the way
//! low-resolution heads have always faked weight — and italic is a
//! 12° oblique shear of the finished rows. Both are deterministic
//! functions of the size, so the bytes they produce are pinned by the
//! golden cases like everything else.
//!
//! Coordinates: the scene speaks millimetres, the page speaks dots,
//! and one line of text is laid out in a coverage buffer as wide as
//! the text box — pen positions, the baseline and every glyph stroke
//! are buffer-local (rows grow down, the baseline sits `ascent` rows
//! from the line's top), and only the thresholded rows are stamped
//! onto the page, where the box edges and the page edges clip.

use ab_glyph::{point, Font as _, GlyphId as AbGlyphId, OutlinedGlyph, PxScale, PxScaleFactor};
use pn_scene::TextStyle;
use swash::shape::cluster::GlyphCluster;
use swash::shape::ShapeContext;

use crate::draw::Renderer;
use crate::fonts::{Font, FontSet};
use crate::geometry::{dots_for_mm, signed_dots};

/// Coverage (0–255) at or above this becomes a dot: half coverage, the
/// geometric edge of an outline.
const THRESHOLD: u8 = 128;
/// The italic shear, in dots of horizontal shift per dot above the
/// baseline (tan 12°).
const ITALIC_SHEAR: f64 = 0.2126;
/// The faux-bold second strike, as a fraction of the font size.
const BOLD_FRACTION: f64 = 0.05;

impl Renderer {
    /// Text in a layout box at `(x_mm, y_mm)` of `w_mm` × `h_mm`:
    /// aligned per the style, drawn from the top of the box, `\n`
    /// starting a new line. `style.size_mm` is the font size in
    /// millimetres (the em square); `style.font` picks the family from
    /// [`FontSet`], and a character the family lacks falls back to the
    /// next embedded font. Clipped to the box and to the page.
    pub fn draw_text(
        &mut self,
        x_mm: f32,
        y_mm: f32,
        w_mm: f32,
        h_mm: f32,
        content: &str,
        style: &TextStyle,
    ) {
        let size_dots = dots_for_mm(style.size_mm, self.dpi) as f64;
        if size_dots <= 0.0 || content.is_empty() {
            return;
        }
        let box_x = signed_dots(x_mm, self.dpi);
        let box_y = signed_dots(y_mm, self.dpi);
        let box_w = dots_for_mm(w_mm, self.dpi) as i64;
        let box_h = dots_for_mm(h_mm, self.dpi) as i64;
        if box_w <= 0 || box_h <= 0 {
            return;
        }

        let set = FontSet::embedded();
        let primary = set.primary(style.font.as_deref());
        let fallbacks: Vec<&Font> = set
            .chain(style.font.as_deref())
            .into_iter()
            .filter(|f| **f != *primary)
            .collect();
        let upem = primary.raster.units_per_em().unwrap_or(1000.0) as f64;
        let scale = size_dots / upem; // dots per font unit
                                      // ab_glyph metrics are font units; the em is size_dots.
        let ascent_row = (primary.raster.ascent_unscaled() as f64 * scale).round() as i64;
        let line_rows = ((primary.raster.height_unscaled() + primary.raster.line_gap_unscaled())
            as f64
            * scale)
            .round() as i64;
        if line_rows <= 0 {
            return;
        }
        let bold_dx = if style.bold {
            (size_dots * BOLD_FRACTION).max(1.0)
        } else {
            0.0
        };

        for (line_i, logical) in content.split('\n').enumerate() {
            let line_y = box_y + line_rows * line_i as i64;
            if line_y >= box_y + box_h {
                break; // the box is full
            }
            let glyphs = Self::shape_line(logical, primary, &fallbacks, scale);
            if glyphs.is_empty() {
                continue;
            }
            let line_w: f64 = glyphs.iter().map(|g| g.x + g.advance).sum();
            // Pen in box-local dots: the left of the first glyph.
            let pen = match style.align {
                pn_scene::Align::Left => 0.0,
                pn_scene::Align::Center => (box_w as f64 - line_w) / 2.0,
                pn_scene::Align::Right => box_w as f64 - line_w,
            };

            // One line of coverage, then threshold it onto the page.
            let w = box_w as usize;
            let rows = line_rows as usize;
            let mut cover = vec![0u8; w * rows];
            let mut x = pen;
            for g in &glyphs {
                let gx = x + g.x;
                Self::stroke_glyph(&mut cover, w, g.font, g.id, gx, ascent_row as f64, scale);
                if bold_dx > 0.0 {
                    Self::stroke_glyph(
                        &mut cover,
                        w,
                        g.font,
                        g.id,
                        gx + bold_dx,
                        ascent_row as f64,
                        scale,
                    );
                }
                x += g.advance;
            }

            // Threshold the line onto the page. The box bottom clips;
            // the italic shear slants every row above the baseline to
            // the right, and the box edges clip the shifted rows.
            for row in 0..rows {
                let y = line_y + row as i64;
                if y < box_y || y >= box_y + box_h {
                    continue;
                }
                let shift = if style.italic {
                    ((ascent_row - row as i64) as f64 * ITALIC_SHEAR).round() as i64
                } else {
                    0
                };
                for col in 0..w {
                    if cover[row * w + col] >= THRESHOLD {
                        let bx = col as i64 + shift;
                        if bx < 0 || bx >= box_w {
                            continue;
                        }
                        self.page.set((box_x + bx) as u32, y as u32, true);
                    }
                }
            }
        }
    }

    /// Shape one line: the primary font lays it out (advances,
    /// kerning, ligatures, marks), and any single-character cluster it
    /// cannot render (`.notdef`) is re-shaped in the first fallback
    /// font that has it, with that font's advance. Advances come back
    /// in font units and are scaled to dots here.
    fn shape_line<'f>(
        line: &str,
        primary: &'f Font,
        fallbacks: &[&'f Font],
        scale: f64,
    ) -> Vec<ShapedGlyph<'f>> {
        let mut ctx = ShapeContext::new();
        let mut shaper = ctx.builder(primary.shape).build();
        shaper.add_str(line);
        let mut out: Vec<ShapedGlyph<'f>> = Vec::new();
        shaper.shape_with(|cluster: &GlyphCluster| {
            if cluster.glyphs.is_empty() {
                return;
            }
            if cluster.glyphs.len() == 1 && cluster.glyphs[0].id == 0 {
                // `.notdef`: the primary has no glyph for this
                // character — ask the fallbacks for it.
                let piece = &line[cluster.source.to_range()];
                for f in fallbacks {
                    if let Some((id, advance)) = fallback_glyph(f.shape, piece) {
                        out.push(ShapedGlyph {
                            font: f,
                            id: AbGlyphId(id),
                            x: 0.0,
                            advance: advance as f64 * scale,
                        });
                        return;
                    }
                }
            }
            for g in cluster.glyphs {
                out.push(ShapedGlyph {
                    font: primary,
                    id: AbGlyphId(g.id),
                    x: g.x as f64 * scale,
                    advance: g.advance as f64 * scale,
                });
            }
        });
        out
    }

    /// Rasterize one glyph into the line's coverage buffer, taking the
    /// maximum over whatever is already there. `pen` is the glyph
    /// origin (baseline) in dots from the box's left edge;
    /// `baseline_row` is the baseline in rows from the line's top.
    fn stroke_glyph(
        cover: &mut [u8],
        w: usize,
        font: &Font,
        id: AbGlyphId,
        pen: f64,
        baseline_row: f64,
        scale: f64,
    ) {
        let Some(outline) = font.raster.outline(id) else {
            return;
        };
        let s = scale as f32;
        // The glyph position is buffer-local: x from the box edge,
        // rows from the line top, y growing down.
        let glyph =
            id.with_scale_and_position(PxScale::from(s), point(pen as f32, baseline_row as f32));
        let og = OutlinedGlyph::new(
            glyph,
            outline,
            PxScaleFactor {
                horizontal: s,
                vertical: s,
            },
        );
        // The drawer's (x, y) are pixels inside `px_bounds()`, which
        // lives in the same space as the glyph position.
        let bb = og.px_bounds();
        let x0 = bb.min.x as i64;
        let y0 = bb.min.y as i64;
        let rows = (cover.len() / w) as i64;
        let w = w as i64;
        og.draw(|x, y, c| {
            if c <= 0.0 {
                return;
            }
            let col = x0 + x as i64;
            let row = y0 + y as i64;
            if row < 0 || row >= rows || col < 0 || col >= w {
                return;
            }
            let v = (c * 255.0).min(255.0) as u8;
            let i = row as usize * w as usize + col as usize;
            if v > cover[i] {
                cover[i] = v;
            }
        });
    }
}

/// Shape a single-character piece in `font`; its first non-`.notdef`
/// glyph and advance (font units) when the font has it.
fn fallback_glyph(font: swash::FontRef, piece: &str) -> Option<(u16, f32)> {
    let mut ctx = ShapeContext::new();
    let mut shaper = ctx.builder(font).build();
    shaper.add_str(piece);
    let mut hit = None;
    shaper.shape_with(|cluster: &GlyphCluster| {
        if let Some(g) = cluster.glyphs.first() {
            if g.id != 0 {
                hit = Some((g.id, g.advance));
            }
        }
    });
    hit
}

/// One glyph ready to stroke: which font it came from, its id, its
/// offset from the cluster start and its advance — in dots.
struct ShapedGlyph<'f> {
    font: &'f Font,
    id: AbGlyphId,
    x: f64,
    advance: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pn_scene::Align;

    fn style(size_mm: f32, align: Align) -> TextStyle {
        TextStyle {
            size_mm,
            font: None,
            bold: false,
            italic: false,
            align,
        }
    }

    fn black_dots(p: &crate::bitmap::Bitmap) -> usize {
        (0..p.height())
            .flat_map(|y| (0..p.width()).map(move |x| p.get(x, y)))
            .filter(|&on| on)
            .count()
    }

    /// Text lands in the box: a 3 mm line in a 10 × 4 mm box at 203 dpi
    /// leaves ink between the box edges, none outside them.
    #[test]
    fn text_is_drawn_inside_its_box() {
        let mut r = Renderer::new(203, 200, 120);
        r.draw_text(10.0, 10.0, 10.0, 4.0, "Hi", &style(3.0, Align::Left));
        let p = r.page();
        let mut any = false;
        for y in 0..120 {
            for x in 0..200 {
                if p.get(x, y) {
                    any = true;
                    // 10 mm = 80 dots; 10 + 10 mm = 160; 4 mm = 32
                    assert!((80..160).contains(&x));
                    assert!((80..112).contains(&y));
                }
            }
        }
        assert!(any);
        assert!(!p.get(79, 80));
        assert!(!p.get(160, 80));
        assert!(!p.get(80, 79));
    }

    /// Japanese — which Noto Sans does not carry — falls back to
    /// Noto Sans JP per character and still draws solid. At 5 mm the
    /// strokes are a dot or two wide; at 3 mm on a 203 dpi head they
    /// are sub-pixel, so the test sizes up.
    #[test]
    fn japanese_text_falls_back_to_the_japanese_font() {
        let mut r = Renderer::new(203, 320, 80);
        r.draw_text(
            2.0,
            2.0,
            40.0,
            8.0,
            "プリント忍者",
            &style(5.0, Align::Left),
        );
        let p = r.page();
        let black = black_dots(p);
        // six full-width characters at 5 mm: real strokes, far more
        // ink than a row of `.notdef` boxes would leave.
        assert!(black > 500, "expected solid Japanese ink, got {black} dots");
    }

    /// A line mixing Latin and Japanese draws both halves on one line:
    /// Latin in Noto Sans, Japanese in the fallback.
    #[test]
    fn mixed_latin_and_japanese_stay_on_one_line() {
        let mut r = Renderer::new(203, 400, 60);
        r.draw_text(0.0, 2.0, 60.0, 6.0, "OK 合格 100", &style(3.0, Align::Left));
        let p = r.page();
        let black = black_dots(p);
        assert!(black > 300);
    }

    /// Bold is a second strike: more ink than the same line unbolded,
    /// at the same position.
    #[test]
    fn bold_is_a_second_strike_more_ink() {
        let mut plain = Renderer::new(203, 200, 100);
        plain.draw_text(10.0, 10.0, 10.0, 6.0, "Bold", &style(4.0, Align::Left));
        let mut bold_style = style(4.0, Align::Left);
        bold_style.bold = true;
        let mut bold = Renderer::new(203, 200, 100);
        bold.draw_text(10.0, 10.0, 10.0, 6.0, "Bold", &bold_style);
        let count = |r: &Renderer| black_dots(r.page());
        assert!(count(&bold) > count(&plain));
    }

    /// Italic slants the strokes: the top of a tall stem shifts right
    /// of its foot, the foot itself staying put.
    #[test]
    fn italic_slants_the_strokes_right() {
        let mut upright = Renderer::new(203, 200, 100);
        upright.draw_text(10.0, 10.0, 10.0, 6.0, "l", &style(5.0, Align::Left));
        let mut i_style = style(5.0, Align::Left);
        i_style.italic = true;
        let mut ital = Renderer::new(203, 200, 100);
        ital.draw_text(10.0, 10.0, 10.0, 6.0, "l", &i_style);
        let extremes = |r: &Renderer| -> (i64, i64) {
            // (x of the topmost inked dot, x of the bottommost)
            let mut top: Option<(i64, i64)> = None;
            let mut bot: Option<(i64, i64)> = None;
            for y in 0..r.page().height() {
                for x in 0..r.page().width() {
                    if r.page().get(x, y) {
                        let (x, y) = (x as i64, y as i64);
                        if top.is_none_or(|(_, ty)| y < ty) {
                            top = Some((x, y));
                        }
                        if bot.is_none_or(|(_, by)| y > by) {
                            bot = Some((x, y));
                        }
                    }
                }
            }
            (top.unwrap().0, bot.unwrap().0)
        };
        let (_, u_bot) = extremes(&upright);
        let (i_top, i_bot) = extremes(&ital);
        assert!(i_top > i_bot); // slanted stem: top right of foot
        assert!(i_bot >= u_bot - 1); // the foot stays where it was
    }

    /// Left, center and right align the line at the box's left edge,
    /// middle and right edge respectively.
    #[test]
    fn alignment_positions_the_line_in_the_box() {
        let render = |align: Align| {
            let mut r = Renderer::new(203, 256, 100);
            r.draw_text(10.0, 10.0, 20.0, 6.0, "abc", &style(3.0, align));
            r
        };
        let leftmost = |r: &Renderer| -> i64 {
            (0..r.page().width())
                .find(|&x| (0..r.page().height()).any(|y| r.page().get(x, y)))
                .unwrap() as i64
        };
        let rightmost = |r: &Renderer| -> i64 {
            ((0..r.page().width())
                .rev()
                .find(|&x| (0..r.page().height()).any(|y| r.page().get(x, y)))
                .unwrap()) as i64
        };
        let l = leftmost(&render(Align::Left));
        let c = leftmost(&render(Align::Center));
        let r_left = leftmost(&render(Align::Right));
        let r_right = rightmost(&render(Align::Right));
        // the box runs 80..240 dots
        assert!(l < c && c < r_left);
        assert!((80..88).contains(&l)); // left: flush with the left edge
        assert!((232..240).contains(&r_right)); // right: flush with the right edge
    }

    /// A zero size, an empty box, and an empty string all draw nothing.
    #[test]
    fn degenerate_text_draws_nothing() {
        let mut r = Renderer::new(203, 100, 100);
        r.draw_text(10.0, 10.0, 10.0, 5.0, "x", &style(0.0, Align::Left));
        r.draw_text(10.0, 10.0, 0.0, 5.0, "x", &style(3.0, Align::Left));
        r.draw_text(10.0, 10.0, 10.0, 0.0, "x", &style(3.0, Align::Left));
        r.draw_text(10.0, 10.0, 10.0, 5.0, "", &style(3.0, Align::Left));
        assert_eq!(r.page().to_bytes(), &[0; 100 * 13]);
    }
}
