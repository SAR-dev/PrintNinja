//! A 1-bit bitmap: one dot per pixel, packed eight per byte, MSB first —
//! the layout the thermal raster commands (ESC/POS `GS v 0`, ZPL and TSPL
//! bitmaps) expect, and what the old app's `RasterImage` used.

/// A 1-bit bitmap of `width` × `height` dots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bitmap {
    width: u32,
    height: u32,
    dots: Vec<u8>,
}

impl Bitmap {
    /// A blank (all white) bitmap.
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            dots: vec![0u8; Bitmap::bytes_per_row(width) as usize * height as usize],
        }
    }

    /// Bytes per row: each byte holds eight dots.
    pub fn bytes_per_row(width: u32) -> u32 {
        width.div_ceil(8)
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// True when the dot is set (black). Out-of-bounds reads are white.
    pub fn get(&self, x: u32, y: u32) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        let idx = (y * Bitmap::bytes_per_row(self.width) + x / 8) as usize;
        let bit = 7 - (x % 8);
        (self.dots[idx] >> bit) & 1 == 1
    }

    /// Set or clear a dot. Out-of-bounds writes are ignored: a shape that
    /// runs off the page is clipped, never a panic.
    pub fn set(&mut self, x: u32, y: u32, on: bool) {
        if x >= self.width || y >= self.height {
            return;
        }
        let idx = (y * Bitmap::bytes_per_row(self.width) + x / 8) as usize;
        let mask = 1u8 << (7 - (x % 8));
        if on {
            self.dots[idx] |= mask;
        } else {
            self.dots[idx] &= !mask;
        }
    }

    /// The packed dots, row by row — ready to wrap in a raster command.
    pub fn to_bytes(&self) -> &[u8] {
        &self.dots
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Eight dots fill one byte with the leftmost dot as the high bit.
    #[test]
    fn packing_is_msb_first_within_a_byte() {
        let mut b = Bitmap::new(8, 1);
        for x in 0..8 {
            b.set(x, 0, true);
        }
        assert_eq!(b.to_bytes(), &[0xFF]);

        let mut one = Bitmap::new(8, 1);
        one.set(3, 0, true); // the fourth dot from the left: bit 4
        assert_eq!(one.to_bytes(), &[0b0001_0000]);
    }

    /// A row that is not a multiple of eight dots still pads to a whole
    /// number of bytes — the last partial byte holds the row's right
    /// edge, not the next row's start.
    #[test]
    fn rows_pad_to_a_byte_boundary() {
        let mut b = Bitmap::new(10, 1);
        b.set(9, 0, true); // second dot of the second byte: bit 6, MSB first
        assert_eq!(b.to_bytes(), &[0b0000_0000, 0b0100_0000]);
    }

    /// A shape that runs past the edge leaves the page and the bounds
    /// alone.
    #[test]
    fn out_of_bounds_bits_are_left_alone() {
        let mut b = Bitmap::new(4, 2); // two rows of one byte each
        b.set(99, 99, true);
        b.set(4, 0, true);
        b.set(0, 2, true);
        assert_eq!(b.to_bytes(), &[0, 0]);
    }

    /// Clearing an already-white dot is a no-op, and set-then-clear
    /// round-trips.
    #[test]
    fn set_and_clear_round_trip() {
        let mut b = Bitmap::new(16, 1);
        b.set(15, 0, true);
        assert!(b.get(15, 0));
        b.set(15, 0, false);
        assert!(!b.get(15, 0));
        assert_eq!(b.to_bytes(), &[0, 0]);
    }
}
