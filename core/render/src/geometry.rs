//! Millimetres-to-dots geometry at the printer's dpi.
//!
//! The scene speaks millimetres; the head speaks dots. Nothing in
//! between may be fractional, so every conversion rounds.

/// A length in millimetres, in dots at `dpi`, rounded.
///
/// Zero and negative lengths give zero dots — a shape with no length
/// draws nothing, which is what a zero-sized element should mean.
pub fn dots_for_mm(mm: f32, dpi: u32) -> u32 {
    (mm as f64 * dpi as f64 / 25.4).round().max(0.0) as u32
}

/// A coordinate in millimetres, in dots at `dpi`, rounded — signed, so
/// the caller can compute both ends of a shape and then clip against
/// the page. (`dots_for_mm` clamps at zero, which would make a shape
/// that starts off the page draw longer than the scene says.)
pub(crate) fn signed_dots(mm: f32, dpi: u32) -> i64 {
    (mm as f64 * dpi as f64 / 25.4).round() as i64
}

/// The raster is never wider than the physical head: the profile's
/// `head_width_dots` caps the geometric width.
///
/// This is what made the old code special-case the ESC/POS receipt
/// widths — a 58 mm roll at 203 dpi is 464 dots geometrically but the
/// receipt head carries 384. The profile holds that number
/// (`head_width_dots`) now, so the rule is one `min` and no language
/// table (plan §5.4: the profile replaces scattered special cases).
pub fn fit_to_head(width_dots: u32, head_width_dots: Option<u32>) -> u32 {
    head_width_dots.map_or(width_dots, |head| width_dots.min(head))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 40 × 30 mm at the common 203 dpi thermal head is 320 × 240 dots
    /// (319.69 × 239.76, rounded) — what the old app asked its
    /// rasterizer for.
    #[test]
    fn millimetres_round_to_dots_at_thermal_resolutions() {
        assert_eq!(dots_for_mm(40.0, 203), 320);
        assert_eq!(dots_for_mm(30.0, 203), 240);
        assert_eq!(dots_for_mm(58.0, 203), 464);
        assert_eq!(dots_for_mm(100.0, 300), 1181);
    }

    /// Degenerate sizes never go negative and never overshoot by a dot.
    #[test]
    fn degenerate_lengths_give_no_dots() {
        assert_eq!(dots_for_mm(0.0, 203), 0);
        assert_eq!(dots_for_mm(-4.0, 203), 0);
    }

    /// A receipt head is narrower than millimetres × dpi: 58 mm at
    /// 203 dpi is capped from 464 to the head's 384 dots, and a label
    /// that is narrower than its head keeps its geometric width.
    #[test]
    fn the_head_never_prints_wider_than_its_dots() {
        assert_eq!(fit_to_head(464, Some(384)), 384); // 58 mm receipt @ 203
        assert_eq!(fit_to_head(639, Some(576)), 576); // 80 mm receipt @ 203
        assert_eq!(fit_to_head(320, Some(864)), 320); // small label, wide head
        assert_eq!(fit_to_head(464, None), 464); // no head data: geometric
    }
}
