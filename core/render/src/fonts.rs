//! The fonts the renderer ships.
//!
//! The renderer must produce identical bytes on every platform, so it
//! does not use the system fonts — it embeds two OFL-licensed variable
//! fonts (license texts in `assets/fonts/`) and falls back between
//! them per character. Noto Sans covers Latin, Greek, Cyrillic and
//! friends; Noto Sans JP covers Japanese (kana and kanji). A character
//! that neither font has gets the font's `.notdef` box.
//!
//! Each embedded font carries one reference per engine: swash's, for
//! OpenType layout (shaping), and ab_glyph's, for the outlines the
//! rasterizer fills. Both point at the same embedded bytes, so the two
//! can never disagree.

use ab_glyph::FontRef as RasterFont;
use swash::FontRef as ShapeFont;

/// Noto Sans (variable, `wdth`/`wght` axes), SIL OFL.
const NOTO_SANS: &[u8] = include_bytes!("../assets/fonts/NotoSans.ttf");
/// Noto Sans JP (variable), SIL OFL.
const NOTO_SANS_JP: &[u8] = include_bytes!("../assets/fonts/NotoSansJP.ttf");

/// A font family name a scene may ask for; `None` means "the default".
pub const DEFAULT_FONT: &str = "noto-sans";

/// One embedded font: a reference for the layout engine and one for
/// the rasterizer, both into the same font bytes.
#[derive(Clone)]
pub struct Font {
    /// The OpenType layout reference — swash's shaper.
    pub shape: ShapeFont<'static>,
    /// The outline reference — ab_glyph's rasterizer.
    pub raster: RasterFont<'static>,
}

impl std::fmt::Debug for Font {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Font").finish_non_exhaustive()
    }
}

/// Two `Font`s are the same font when they reference the same bytes
/// and the same font inside them.
impl PartialEq for Font {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self.shape.data, other.shape.data) && self.shape.offset == other.shape.offset
    }
}
impl Eq for Font {}

/// The embedded font chain. Loading can only fail if the embedded
/// bytes are corrupt — a build break, not a runtime condition — so a
/// failure here is a bug and panics.
#[derive(Debug)]
pub struct FontSet {
    fonts: Vec<(&'static str, Font)>,
}

impl FontSet {
    /// The fonts bundled with the renderer: the default first, then the
    /// fallbacks in the order a missing character should try them.
    pub fn embedded() -> Self {
        let fonts = [(DEFAULT_FONT, NOTO_SANS), ("noto-sans-jp", NOTO_SANS_JP)]
            .into_iter()
            .map(|(name, bytes)| {
                let shape = ShapeFont::from_index(bytes, 0)
                    .unwrap_or_else(|| panic!("embedded font {name} is corrupt"));
                let raster = RasterFont::try_from_slice(bytes)
                    .unwrap_or_else(|e| panic!("embedded font {name} is corrupt: {e}"));
                (name, Font { shape, raster })
            })
            .collect();
        Self { fonts }
    }

    /// The font a scene asked for, or the default when it named
    /// nothing. An unknown family name falls back to the default rather
    /// than failing the print.
    pub fn primary(&self, family: Option<&str>) -> &Font {
        family
            .and_then(|f| self.fonts.iter().find(|(n, _)| *n == f))
            .map(|(_, f)| f)
            .unwrap_or(&self.fonts[0].1)
    }

    /// The fallback chain for text in the given family: the primary
    /// first, then every other embedded font, in order.
    pub fn chain(&self, family: Option<&str>) -> Vec<&Font> {
        let primary = self.primary(family);
        self.fonts
            .iter()
            .map(|(_, f)| f)
            .filter(|f| **f != *primary)
            .chain(std::iter::once(primary))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ab_glyph::Font as _;

    /// The embedded fonts parse, and a family the scene did not name
    /// resolves to the default.
    #[test]
    fn the_embedded_fonts_load_and_an_unknown_family_falls_back_to_the_default() {
        let set = FontSet::embedded();
        let default = set.primary(None);
        assert_eq!(set.primary(Some("no-such-font")), set.primary(None));
        assert!(set.primary(Some("noto-sans-jp")) != default);
        // both embedded fonts are real, non-empty outlines
        assert!(default.raster.units_per_em().is_some_and(|v| v > 0.0));
        assert!(set
            .primary(Some("noto-sans-jp"))
            .raster
            .units_per_em()
            .is_some_and(|v| v > 0.0));
    }
}
