package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Golden bytes for `dotsFromArgb` — the device-side twin of Rust's
 * `png_to_raster` + `RasterImage::threshold`. The same 8×1 row is pinned
 * to `0xAD` in the Rust test `raster_threshold_matches_the_kotlin_contract`
 * (src-tauri/src/render/mod.rs), so a drift in either implementation fails
 * one of the two tests.
 *
 * The golden row, left to right (ARGB, opacity irrelevant to the formula):
 *   x0 (0,0,0)      lum 0     -> dot
 *   x1 (255,255,255) lum 255   -> no dot
 *   x2 (127,127,127) lum 127   -> dot
 *   x3 (128,128,128) lum 128   -> no dot   (the `< 128` cut, exactly at it)
 *   x4 (200,100,50)  lum 124.2 -> dot
 *   x5 (199,99,49)   lum 123.2 -> dot
 *   x6 (250,250,250) lum 250   -> no dot
 *   x7 (10,10,10)    lum 10    -> dot
 * Dots at x = {0,2,4,5,7} -> bits 7,5,3,2,0 -> 0xAD.
 */
class RasterDotsTest {

    /** The shared 8×1 golden row. */
    private val goldenRow = intArrayOf(
        0xFF000000.toInt(),
        0xFFFFFFFF.toInt(),
        0xFF7F7F7F.toInt(),
        0xFF808080.toInt(),
        0xFFC86432.toInt(),
        0xFFC76331.toInt(),
        0xFFFAFAFA.toInt(),
        0xFF0A0A0A.toInt(),
    )

    @Test
    fun goldenRowPacksToAd() {
        assertEquals(listOf(0xAD.toByte()), dotsFromArgb(goldenRow, 8, 1).toList())
    }

    @Test
    fun allBlackRowIsAllDots() {
        assertEquals(listOf(0xFF.toByte()), dotsFromArgb(intArrayOf(0, 0, 0, 0, 0, 0, 0, 0), 8, 1).toList())
    }

    @Test
    fun allWhiteRowIsNoDots() {
        assertEquals(
            listOf(0x00.toByte()),
            dotsFromArgb(intArrayOf(-1, -1, -1, -1, -1, -1, -1, -1), 8, 1).toList(),
        )
    }

    @Test
    fun aWidthNotMultipleOfEightStartsEachRowAtBit7() {
        // 10 dots wide, dots only at x=0 and x=8: each 8-dot group's leftmost
        // dot, so byte 0 and byte 1 both get only bit 7.
        val pixels = IntArray(10) { if (it == 0 || it == 8) 0 else -1 }
        assertEquals(
            listOf(0x80.toByte(), 0x80.toByte()),
            dotsFromArgb(pixels, 10, 1).toList(),
        )
    }

    @Test
    fun rowsDoNotLeakIntoEachOther() {
        // Row 0: the golden (0xAD). Row 1: all dots (0xFF).
        val pixels = goldenRow + IntArray(8) { 0 }
        assertEquals(
            listOf(0xAD.toByte(), 0xFF.toByte()),
            dotsFromArgb(pixels, 8, 2).toList(),
        )
    }

    @Test
    fun thePixelCountMustMatchTheSize() {
        assertThrows(IllegalArgumentException::class.java) {
            dotsFromArgb(intArrayOf(0, 0), 4, 1)
        }
    }
}
