//! The fonts the renderer ships.
//!
//! The renderer must produce identical bytes on every platform, so it
//! does not use the system fonts — it embeds two OFL-licensed variable
//! fonts (license texts in `assets/fonts/`) and falls back between
//! them per character. Noto Sans covers Latin, Greek, Cyrillic and
//! friends; Noto Sans JP covers Japanese (kana and kanji). A character
//! that neither font has gets the font's `.notdef` box.
//!
//! A template can also bring its own fonts ([`CustomFont`], TrueType or
//! OpenType bytes). They are looked up by family name, case-insensitively,
//! and sit *after* the embedded fonts in the fallback chain, so a custom
//! font that lacks a character still gets it from Noto. Nothing is read
//! from the system: the bytes come with the job, so the same job renders
//! the same dots on every machine.
//!
//! Each embedded font carries one reference per engine: swash's, for
//! OpenType layout (shaping), and ab_glyph's, for the outlines the
//! rasterizer fills. Both point at the same embedded bytes, so the two
//! can never disagree.

use ab_glyph::FontRef as RasterFont;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
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

/// A font a template brings along, loaded from TrueType/OpenType bytes.
///
/// The renderer's font references are `'static` (they point into the
/// embedded fonts), so a loaded font's bytes are kept for the life of
/// the process — once per distinct file: loading the same bytes again
/// reuses them. Fonts are few and small, and an uploaded font is
/// typically used for many prints.
#[derive(Debug, Clone)]
pub struct CustomFont {
    family: String,
    font: Font,
}

/// Why a font file could not be loaded.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FontError {
    /// The bytes are not a TrueType/OpenType font the renderer can use
    /// (WOFF and WOFF2 are web formats and are not supported here).
    #[error("the font \"{0}\" is not a TrueType or OpenType file the label renderer can read")]
    Unreadable(String),
    #[error("a custom font needs a family name")]
    NoFamily,
    /// A template's embedded font is not valid base64.
    #[error("the font \"{0}\" is not valid base64 data")]
    BadBase64(String),
}

impl CustomFont {
    /// Load `bytes` as the font `family`. Fails for anything that is not
    /// a TrueType/OpenType font (including WOFF/WOFF2).
    pub fn load(family: &str, bytes: &[u8]) -> Result<Self, FontError> {
        let family = family.trim();
        if family.is_empty() {
            return Err(FontError::NoFamily);
        }
        let unreadable = || FontError::Unreadable(family.to_string());
        let bytes = keep(bytes);
        let shape = ShapeFont::from_index(bytes, 0).ok_or_else(unreadable)?;
        let raster = RasterFont::try_from_slice(bytes).map_err(|_| unreadable())?;
        Ok(Self {
            family: family.to_string(),
            font: Font { shape, raster },
        })
    }

    /// The family name templates ask for.
    pub fn family(&self) -> &str {
        &self.family
    }

    /// Load the fonts a template embeds (`Template::fonts`, base64
    /// bytes). The first unreadable one fails the lot, by name — a
    /// label must not quietly print in another face.
    pub fn from_template(fonts: &[pn_scene::TemplateFont]) -> Result<Vec<Self>, FontError> {
        use base64::Engine as _;
        fonts
            .iter()
            .map(|f| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(f.data.trim())
                    .map_err(|_| FontError::BadBase64(f.family.clone()))?;
                Self::load(&f.family, &bytes)
            })
            .collect()
    }
}

/// Font files kept for the life of the process, bucketed by (hash, len).
type Kept = Mutex<HashMap<(u64, usize), Vec<&'static [u8]>>>;

/// Keep font bytes for the life of the process, once per distinct file.
fn keep(bytes: &[u8]) -> &'static [u8] {
    static KEPT: OnceLock<Kept> = OnceLock::new();
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let key = (hasher.finish(), bytes.len());
    let mut kept = KEPT
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let bucket = kept.entry(key).or_default();
    // A hash match is confirmed byte for byte, so a collision can never
    // hand one font's bytes to another.
    if let Some(found) = bucket.iter().find(|b| **b == bytes) {
        return found;
    }
    let leaked: &'static [u8] = Box::leak(bytes.to_vec().into_boxed_slice());
    bucket.push(leaked);
    leaked
}

/// The font chain: the embedded fonts, then any custom fonts. Loading
/// the embedded fonts can only fail if their bytes are corrupt — a build
/// break, not a runtime condition — so a failure there is a bug and
/// panics.
#[derive(Debug)]
pub struct FontSet {
    fonts: Vec<(String, Font)>,
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
                (name.to_string(), Font { shape, raster })
            })
            .collect();
        Self { fonts }
    }

    /// The embedded fonts plus `custom`, which follow them in the
    /// fallback chain. A custom font never replaces an embedded family
    /// of the same name: the embedded one is found first.
    pub fn with_custom(custom: &[CustomFont]) -> Self {
        let mut set = Self::embedded();
        set.fonts
            .extend(custom.iter().map(|c| (c.family.clone(), c.font.clone())));
        set
    }

    /// The font a scene asked for, or the default when it named
    /// nothing. Family names match case-insensitively. An unknown family
    /// name falls back to the default rather than failing the print.
    pub fn primary(&self, family: Option<&str>) -> &Font {
        family
            .and_then(|f| {
                let f = f.trim();
                self.fonts.iter().find(|(n, _)| n.eq_ignore_ascii_case(f))
            })
            .map(|(_, f)| f)
            .unwrap_or(&self.fonts[0].1)
    }

    /// The fallback chain for text in the given family: the primary
    /// first, then every other font, in order.
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
