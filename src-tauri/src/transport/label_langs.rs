//! Label printer command language encoders

/// TSPL/TSPL2 encoder for thermal label printers
pub mod tspl {
    use crate::render::raster::RasterImage;

    pub fn init(dpi: u32) -> String {
        let _ = dpi;
        // SIZE, GAP, DIRECTION commands
        String::new()
    }

    /// How the printer finds the end of a label.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum TsplMedia {
        /// Die-cut labels separated by a gap (`GAP`). The default.
        #[default]
        Gap,
        /// Labels marked on the back with a black bar (`BLINE`).
        Bline,
        /// Continuous roll, no gap or mark (`GAP 0,0`).
        Continuous,
    }

    /// Per-printer TSPL print tuning. Every field defaults to "send
    /// nothing", so a printer without settings gets exactly the bytes it
    /// always got.
    #[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize, serde::Deserialize)]
    #[serde(default)]
    pub struct TsplTuning {
        /// Print darkness, 0 (lightest) to 15. `None` keeps the printer's own.
        pub density: Option<u8>,
        /// Print speed, 1 to 10 (units depend on the model). `None` keeps
        /// the printer's own.
        pub speed: Option<f64>,
        pub media: TsplMedia,
    }

    impl TsplTuning {
        pub const MAX_DENSITY: u8 = 15;
        pub const MIN_SPEED: f64 = 1.0;
        pub const MAX_SPEED: f64 = 10.0;

        /// Strict check for values a person is saving.
        pub fn validate(&self) -> Result<(), String> {
            if let Some(d) = self.density {
                if d > Self::MAX_DENSITY {
                    return Err(format!(
                        "TSPL density must be between 0 and {}",
                        Self::MAX_DENSITY
                    ));
                }
            }
            if let Some(v) = self.speed {
                if !v.is_finite() || !(Self::MIN_SPEED..=Self::MAX_SPEED).contains(&v) {
                    return Err(format!(
                        "TSPL speed must be between {} and {}",
                        Self::MIN_SPEED,
                        Self::MAX_SPEED
                    ));
                }
            }
            Ok(())
        }

        /// Lenient read for printing: the `tspl` object inside a printer's
        /// `default_settings_json`. Anything missing, malformed or out of
        /// range falls back to "send nothing" — a bad stored value must
        /// never break a print.
        pub fn from_settings_json(raw: Option<&str>) -> Self {
            let Some(raw) = raw else {
                return Self::default();
            };
            let Ok(root) = serde_json::from_str::<serde_json::Value>(raw) else {
                return Self::default();
            };
            let Some(node) = root.get("tspl") else {
                return Self::default();
            };
            match serde_json::from_value::<Self>(node.clone()) {
                Ok(t) if t.validate().is_ok() => t,
                _ => Self::default(),
            }
        }
    }

    /// Canonical TSPL2: setup commands, then `BITMAP x,y,width-bytes,
    ///height,mode` followed by the **raw packed bytes** (not their hex —
    /// TSPL's BITMAP takes binary data), then `PRINT`.
    ///
    /// Commands are `\r\n`-terminated like the real dialect. The image's own
    /// row packing (`width.div_ceil(8)` bytes per row) is what BITMAP's
    /// width-bytes argument counts.
    pub fn print_bitmap(
        image: &RasterImage,
        label_w_mm: f64,
        label_h_mm: f64,
        gap_mm: f64,
        dpi: u32,
    ) -> Vec<u8> {
        print_bitmap_tuned(
            image,
            label_w_mm,
            label_h_mm,
            gap_mm,
            dpi,
            &TsplTuning::default(),
        )
    }

    /// [`print_bitmap`] with darkness, speed and media type applied.
    /// With `TsplTuning::default()` the output is byte-for-byte the same.
    pub fn print_bitmap_tuned(
        image: &RasterImage,
        label_w_mm: f64,
        label_h_mm: f64,
        gap_mm: f64,
        _dpi: u32,
        tuning: &TsplTuning,
    ) -> Vec<u8> {
        let bytes_per_row = image.width.div_ceil(8);

        let mut cmd = Vec::new();
        cmd.extend_from_slice(format!("SIZE {} mm,{} mm\r\n", label_w_mm, label_h_mm).as_bytes());
        match tuning.media {
            TsplMedia::Gap => {
                cmd.extend_from_slice(format!("GAP {} mm,0 mm\r\n", gap_mm).as_bytes())
            }
            TsplMedia::Bline => {
                cmd.extend_from_slice(format!("BLINE {} mm,0 mm\r\n", gap_mm).as_bytes())
            }
            TsplMedia::Continuous => cmd.extend_from_slice(b"GAP 0 mm,0 mm\r\n"),
        }
        if let Some(d) = tuning.density {
            cmd.extend_from_slice(format!("DENSITY {}\r\n", d.min(TsplTuning::MAX_DENSITY)).as_bytes());
        }
        if let Some(v) = tuning.speed {
            let v = v.clamp(TsplTuning::MIN_SPEED, TsplTuning::MAX_SPEED);
            cmd.extend_from_slice(format!("SPEED {}\r\n", v).as_bytes());
        }
        cmd.extend_from_slice(b"DIRECTION 1\r\n");
        cmd.extend_from_slice(b"REFERENCE 0,0\r\n");
        cmd.extend_from_slice(b"CLS\r\n");
        cmd.extend_from_slice(
            format!("BITMAP 0,0,{},{},0\r\n", bytes_per_row, image.height).as_bytes(),
        );
        cmd.extend_from_slice(&image.dots);
        cmd.extend_from_slice(b"\r\nPRINT 1\r\n");
        cmd
    }
}

/// ZPL (Zebra) encoder for thermal label printers
pub mod zpl {
    use crate::render::raster::RasterImage;

    pub fn init() -> String {
        "^XA\n".to_string() // Start format
    }

    /// `^PW` (print width) and `^LL` (label length) come from the job so a
    /// label no longer depends on the size stored in the printer; `^LH0,0`
    /// pins the label home. Darkness (`~SD`) is still left to the printer.
    pub fn print_bitmap(
        image: &RasterImage,
        _label_w_mm: f64,
        label_h_mm: f64,
        dpi: u32,
    ) -> String {
        let bytes_per_row = image.width.div_ceil(8);
        let total_bytes = bytes_per_row * image.height;

        let mut cmd = String::new();
        cmd.push_str("^XA\n"); // Start format
        cmd.push_str("^MMT\n"); // Media tracking
        cmd.push_str(&format!("^PW{}\n", image.width)); // Print width, dots
        if label_h_mm > 0.0 {
            cmd.push_str(&format!(
                "^LL{}\n",
                crate::render::raster::dots_for_mm(label_h_mm, dpi)
            )); // Label length, dots
        }
        cmd.push_str("^LH0,0\n"); // Label home
        cmd.push_str("^PR6\n"); // Print rate
                                // Graphic field command
        cmd.push_str(&format!(
            "^FO0,0^GFA,{},{}",
            total_bytes,
            bytes_per_row * image.height
        ));
        cmd.push_str(&format!(",{},", bytes_per_row));

        for byte in &image.dots {
            cmd.push_str(&format!("{:02X}", byte));
        }

        cmd.push_str("^FS\n");
        cmd.push_str("^XZ\n"); // End format
        cmd
    }
}

/// CPCL (Comtec) encoder for thermal label printers
pub mod cpcl {
    use crate::render::raster::RasterImage;

    pub fn init() -> String {
        "! 0 200 200 210 1\r\n".to_string()
    }

    /// `EG <width-bytes> <height-dot-rows> <x> <y> <hex data>` is CPCL's
    /// expanded-graphics command: width is in **bytes**, height in dot
    /// rows, and the data is ASCII hex. (`CG` takes the same arguments but
    /// raw binary data, so hex cannot go through it.) The geometry comes
    /// from the image itself, so it always matches the packed bytes that
    /// follow, whatever the label size says.
    pub fn print_bitmap(image: &RasterImage, _label_w_mm: f64, _dpi: u32) -> String {
        let bytes_per_row = image.width.div_ceil(8);

        let mut cmd = String::new();
        cmd.push_str(&format!("! 0 200 200 {} 1\r\n", image.height));
        cmd.push_str(&format!("EG {} {} 0 0 ", bytes_per_row, image.height));
        for byte in &image.dots {
            cmd.push_str(&format!("{:02X}", byte));
        }
        cmd.push_str("\r\n");
        cmd.push_str("PRINT\r\n");
        cmd
    }
}

/// Printer connection and data sending
pub struct LabelPrinterTransport {
    pub language: String,
    pub dpi: u32,
    pub label_w_mm: f64,
    pub label_h_mm: f64,
    pub gap_mm: f64,
    pub address: String,
    pub port: u16,
}

impl LabelPrinterTransport {
    pub fn encode(&self, image: &crate::render::raster::RasterImage) -> Vec<u8> {
        match self.language.as_str() {
            "tspl" => tspl::print_bitmap(
                image,
                self.label_w_mm,
                self.label_h_mm,
                self.gap_mm,
                self.dpi,
            ),
            "zpl" => {
                zpl::print_bitmap(image, self.label_w_mm, self.label_h_mm, self.dpi).into_bytes()
            }
            "cpcl" => cpcl::print_bitmap(image, self.label_w_mm, self.dpi).into_bytes(),
            _ => {
                // Fallback: raw ESC/POS
                let mut data = Vec::new();
                data.extend_from_slice(&crate::transport::escpos::EscPosEncoder::init());
                data.extend_from_slice(&crate::transport::escpos::EscPosEncoder::print_raster(
                    image,
                ));
                data
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::raster::RasterImage;

    fn image(width: usize, height: usize) -> RasterImage {
        let mut img = RasterImage::new(width, height);
        img.dots[0] = 0x80;
        img
    }

    #[test]
    fn zpl_sets_width_length_and_home() {
        // 40 x 30 mm at 203 dpi is 320 x 240 dots.
        let zpl = zpl::print_bitmap(&image(320, 240), 40.0, 30.0, 203);
        assert!(zpl.starts_with("^XA\n"), "{zpl}");
        assert!(zpl.contains("^PW320\n"), "{zpl}");
        assert!(zpl.contains("^LL240\n"), "{zpl}");
        assert!(zpl.contains("^LH0,0\n"), "{zpl}");
        assert!(zpl.contains("^GFA,9600,9600,40,"), "{zpl}");
        assert!(zpl.trim_end().ends_with("^XZ"), "{zpl}");
    }

    #[test]
    fn zpl_skips_label_length_for_a_zero_height() {
        let zpl = zpl::print_bitmap(&image(16, 2), 40.0, 0.0, 203);
        assert!(!zpl.contains("^LL"), "{zpl}");
        assert!(zpl.contains("^PW16\n"), "{zpl}");
    }

    /// The `EG` header must agree with the data that follows it: width in
    /// bytes, height in rows, and exactly width x height bytes of hex.
    #[test]
    fn cpcl_graphic_header_matches_its_data() {
        let img = image(20, 3); // 3 bytes per row, 3 rows
        let cpcl = cpcl::print_bitmap(&img, 40.0, 203);
        assert!(cpcl.starts_with("! 0 200 200 3 1\r\n"), "{cpcl}");
        let line = cpcl
            .lines()
            .find(|l| l.starts_with("EG "))
            .expect("EG line");
        let mut parts = line.split(' ');
        assert_eq!(parts.next(), Some("EG"));
        let width_bytes: usize = parts.next().unwrap().parse().unwrap();
        let height: usize = parts.next().unwrap().parse().unwrap();
        assert_eq!((width_bytes, height), (3, 3));
        assert_eq!(parts.next(), Some("0"));
        assert_eq!(parts.next(), Some("0"));
        let hex = parts.next().expect("hex data");
        assert_eq!(hex.len(), width_bytes * height * 2);
        assert!(hex.starts_with("80"), "{hex}");
        assert!(cpcl.trim_end().ends_with("PRINT"), "{cpcl}");
    }

    #[test]
    fn tspl_default_tuning_is_byte_identical_to_the_untuned_encoder() {
        let img = image(16, 2);
        let plain = tspl::print_bitmap(&img, 40.0, 30.0, 2.0, 203);
        let tuned = tspl::print_bitmap_tuned(&img, 40.0, 30.0, 2.0, 203, &tspl::TsplTuning::default());
        assert_eq!(plain, tuned);
        let text = String::from_utf8_lossy(&plain);
        assert!(text.contains("GAP 2 mm,0 mm\r\n"), "{text}");
        assert!(!text.contains("DENSITY") && !text.contains("SPEED"), "{text}");
    }

    #[test]
    fn tspl_tuning_emits_density_speed_and_media() {
        let img = image(16, 2);
        let t = tspl::TsplTuning {
            density: Some(10),
            speed: Some(2.5),
            media: tspl::TsplMedia::Continuous,
        };
        let out = tspl::print_bitmap_tuned(&img, 40.0, 30.0, 2.0, 203, &t);
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("GAP 0 mm,0 mm\r\n"), "{text}");
        assert!(!text.contains("GAP 2 mm"), "{text}");
        assert!(text.contains("DENSITY 10\r\n"), "{text}");
        assert!(text.contains("SPEED 2.5\r\n"), "{text}");
        // Setup precedes the bitmap.
        assert!(text.find("DENSITY").unwrap() < text.find("BITMAP").unwrap());

        let bline = tspl::TsplTuning {
            media: tspl::TsplMedia::Bline,
            ..Default::default()
        };
        let out = tspl::print_bitmap_tuned(&img, 40.0, 30.0, 3.0, 203, &bline);
        assert!(String::from_utf8_lossy(&out).contains("BLINE 3 mm,0 mm\r\n"));
    }

    #[test]
    fn tspl_tuning_reads_leniently_and_validates_strictly() {
        use tspl::{TsplMedia, TsplTuning};
        let t = TsplTuning::from_settings_json(Some(
            r#"{"tspl":{"density":8,"speed":4,"media":"continuous"}}"#,
        ));
        assert_eq!(t.density, Some(8));
        assert_eq!(t.speed, Some(4.0));
        assert_eq!(t.media, TsplMedia::Continuous);
        // Missing, malformed or out-of-range stored values mean defaults.
        assert_eq!(TsplTuning::from_settings_json(None), TsplTuning::default());
        assert_eq!(TsplTuning::from_settings_json(Some("not json")), TsplTuning::default());
        assert_eq!(TsplTuning::from_settings_json(Some(r#"{"x":1}"#)), TsplTuning::default());
        assert_eq!(
            TsplTuning::from_settings_json(Some(r#"{"tspl":{"density":99}}"#)),
            TsplTuning::default()
        );
        assert_eq!(
            TsplTuning::from_settings_json(Some(r#"{"tspl":{"media":"wat"}}"#)),
            TsplTuning::default()
        );
        // Saving is strict.
        assert!(TsplTuning { density: Some(16), ..Default::default() }.validate().is_err());
        assert!(TsplTuning { speed: Some(0.5), ..Default::default() }.validate().is_err());
        assert!(TsplTuning { speed: Some(f64::NAN), ..Default::default() }.validate().is_err());
        assert!(TsplTuning { density: Some(15), speed: Some(10.0), ..Default::default() }.validate().is_ok());
    }
}
