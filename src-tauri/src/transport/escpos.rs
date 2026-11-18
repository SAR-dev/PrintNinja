/// ESC/POS command encoder for thermal receipt printers
pub struct EscPosEncoder;

impl EscPosEncoder {
    /// Initialize printer
    pub fn init() -> Vec<u8> {
        vec![0x1B, 0x40]
    }

    /// Set text alignment (0=left, 1=center, 2=right)
    pub fn set_alignment(align: u8) -> Vec<u8> {
        vec![0x1B, 0x61, align]
    }

    /// Set text size (1x1 to 8x8)
    pub fn set_text_size(width: u8, height: u8) -> Vec<u8> {
        let combined = (height << 4) | width;
        vec![0x1D, 0x21, combined]
    }

    /// Bold on/off
    pub fn set_bold(on: bool) -> Vec<u8> {
        vec![0x1B, 0x45, if on { 0x01 } else { 0x00 }]
    }

    /// Print text with newline
    pub fn text(text: &str) -> Vec<u8> {
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(0x0A);
        bytes
    }

    /// Most rows one `GS v 0` command carries.
    ///
    /// A whole page as one command is a bad bet on receipt printers: the
    /// spec caps the height (Epson documents 2303 rows) and cheap
    /// Bluetooth heads have a small receive buffer, so an oversized
    /// command is dropped or ignored and nothing prints. Short bands
    /// print back to back as one image.
    pub const RASTER_BAND_ROWS: usize = 256;

    /// Print raster bitmap (GS v 0), as a run of bands of at most
    /// [`Self::RASTER_BAND_ROWS`] rows each.
    pub fn print_raster(image: &crate::render::raster::RasterImage) -> Vec<u8> {
        let width_bytes = image.width.div_ceil(8);
        if width_bytes == 0 || image.height == 0 {
            return Vec::new();
        }
        let mut cmd = Vec::with_capacity(image.dots.len() + 8 * (image.height / 256 + 1));
        for band in image.dots.chunks(width_bytes * Self::RASTER_BAND_ROWS) {
            let rows = band.len() / width_bytes;
            cmd.extend_from_slice(&[
                0x1D,
                0x76,
                0x30,
                0x00, // GS v 0, mode: normal
                (width_bytes & 0xFF) as u8,
                ((width_bytes >> 8) & 0xFF) as u8,
                (rows & 0xFF) as u8,
                ((rows >> 8) & 0xFF) as u8,
            ]);
            cmd.extend_from_slice(band);
        }
        cmd
    }

    /// The image without its all-white bottom rows (at least one row is
    /// kept). A receipt is printed on a continuous roll, so blank rows
    /// at the end are only wasted paper and transfer time: a test page
    /// laid out on an A4-tall canvas would otherwise send ~30 cm of
    /// nothing.
    pub fn trim_trailing_blank_rows(
        image: &crate::render::raster::RasterImage,
    ) -> crate::render::raster::RasterImage {
        let width_bytes = image.width.div_ceil(8);
        if width_bytes == 0 || image.height == 0 {
            return crate::render::raster::RasterImage {
                width: image.width,
                height: image.height,
                dots: image.dots.clone(),
            };
        }
        let last_ink_row = image
            .dots
            .chunks(width_bytes)
            .rposition(|row| row.iter().any(|&b| b != 0));
        let keep = last_ink_row.map_or(1, |r| r + 1);
        crate::render::raster::RasterImage {
            width: image.width,
            height: keep,
            dots: image.dots[..keep * width_bytes].to_vec(),
        }
    }

    /// Feed lines
    pub fn feed(lines: u8) -> Vec<u8> {
        vec![0x1B, 0x64, lines]
    }

    /// Cut paper (full or partial)
    pub fn cut(partial: bool) -> Vec<u8> {
        if partial {
            vec![0x1D, 0x56, 0x01]
        } else {
            vec![0x1D, 0x56, 0x00]
        }
    }

    /// Open cash drawer (kick)
    pub fn open_drawer() -> Vec<u8> {
        vec![0x1B, 0x70, 0x00, 0x32, 0x32]
    }

    /// Set codepage for international characters
    pub fn set_codepage(codepage: u8) -> Vec<u8> {
        vec![0x1B, 0x74, codepage]
    }

    /// Build a complete receipt from a template
    pub fn build_receipt(
        image: &crate::render::raster::RasterImage,
        cut_after: bool,
        open_drawer: bool,
    ) -> Vec<u8> {
        let mut receipt = Vec::new();
        receipt.extend_from_slice(&Self::init());
        receipt.extend_from_slice(&Self::print_raster(&Self::trim_trailing_blank_rows(image)));
        receipt.extend_from_slice(&Self::feed(3));
        if cut_after {
            receipt.extend_from_slice(&Self::cut(false));
        }
        if open_drawer {
            receipt.extend_from_slice(&Self::open_drawer());
        }
        receipt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::raster::RasterImage;

    fn image(width: usize, height: usize, ink_rows: &[usize]) -> RasterImage {
        let mut img = RasterImage::new(width, height);
        let wb = width.div_ceil(8);
        for &r in ink_rows {
            img.dots[r * wb] = 0x80;
        }
        img
    }

    /// Walk the stream and return (rows, payload) of every GS v 0 band.
    fn bands(bytes: &[u8], width_bytes: usize) -> Vec<usize> {
        let mut out = Vec::new();
        let mut i = 0;
        while i + 8 <= bytes.len() && bytes[i..i + 4] == [0x1D, 0x76, 0x30, 0x00] {
            assert_eq!(
                bytes[i + 4] as usize | (bytes[i + 5] as usize) << 8,
                width_bytes
            );
            let rows = bytes[i + 6] as usize | (bytes[i + 7] as usize) << 8;
            out.push(rows);
            i += 8 + rows * width_bytes;
        }
        assert_eq!(i, bytes.len(), "stream must be exactly whole bands");
        out
    }

    #[test]
    fn tall_image_is_split_into_bands_that_cover_every_row() {
        let img = image(384, 2374, &[0, 2373]);
        let out = EscPosEncoder::print_raster(&img);
        let rows = bands(&out, 48);
        assert!(rows.iter().all(|&r| r <= EscPosEncoder::RASTER_BAND_ROWS));
        assert_eq!(rows.iter().sum::<usize>(), 2374);
    }

    #[test]
    fn short_image_stays_one_command() {
        let out = EscPosEncoder::print_raster(&image(16, 2, &[0]));
        assert_eq!(bands(&out, 2), vec![2]);
    }

    #[test]
    fn receipt_drops_blank_tail_but_keeps_the_frame() {
        // Ink only in the first 10 rows of an A4-tall canvas.
        let img = image(384, 2374, &[3, 9]);
        let out = EscPosEncoder::build_receipt(&img, true, false);
        assert!(out.starts_with(&[0x1B, 0x40]));
        assert!(out.ends_with(&[0x1B, 0x64, 0x03, 0x1D, 0x56, 0x00]));
        let body = &out[2..out.len() - 6];
        assert_eq!(bands(body, 48), vec![10]);
    }

    #[test]
    fn fully_blank_image_keeps_one_row() {
        let t = EscPosEncoder::trim_trailing_blank_rows(&image(16, 50, &[]));
        assert_eq!((t.height, t.dots.len()), (1, 2));
    }
}
