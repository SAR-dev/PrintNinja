package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The B4 pacing math: the RFCOMM write is split into small slices so a
 * slow 2-inch head is not flooded, in byte order, and the whole send —
 * pauses plus the final settle wait — stays far under the Rust side's
 * 30 s Bluetooth deadline.
 */
class BluetoothPacingTest {

    @Test
    fun chunkRangesSplitInOrderWithoutGaps() {
        // 1000 bytes at 512: one full chunk, a short tail.
        assertEquals(listOf(0..511, 512..999), chunkRanges(1000, 512))
        // Exactly one chunk: no tail, no second write.
        assertEquals(listOf(0..511), chunkRanges(512, 512))
        // Smaller than a chunk: the whole job is one slice.
        assertEquals(listOf(0..99), chunkRanges(100, 512))
    }

    @Test
    fun chunkRangesKeepTheByteOrder() {
        // Walking the ranges in order must visit 0 until size exactly
        // once: the paced write sends the bytes as they were sent
        // before B4, just in smaller pieces.
        for (size in listOf(0, 1, 31, 32, 33, 511, 512, 513, 1000, 256 * 1024)) {
            for (chunk in listOf(32L, 256L, 512L, 8192L)) {
                val visited =
                    chunkRanges(size, chunk).flatMap { (it.first..it.last).toList() }
                assertEquals("size=$size chunk=$chunk", (0 until size).toList(), visited)
            }
        }
    }

    @Test
    fun emptyJobWritesNothing() {
        assertEquals(emptyList<IntRange>(), chunkRanges(0, 512))
    }

    @Test
    fun chunkSizesAreClampedToTheSaneRange() {
        assertEquals(BT_CHUNK_BYTES_MIN, clampChunkBytes(1))
        assertEquals(BT_CHUNK_BYTES_MAX, clampChunkBytes(999_999))
        assertEquals(512L, clampChunkBytes(512))
        assertEquals(0L, clampChunkPauseMs(-5))
        assertEquals(BT_CHUNK_PAUSE_MS_MAX, clampChunkPauseMs(99_999))
    }

    /**
     * The settle wait happens after the final flush and before the
     * socket close: long enough that a platen mid-stroke finishes its
     * line, capped so even the largest handoff payload stays under the
     * send deadline.
     */
    @Test
    fun settleWaitGrowsWithTheJobAndCaps() {
        assertEquals(0L, settleDelayMs(0))
        assertEquals(300L, settleDelayMs(100))
        // 1 ms per 1 KiB on top of the 300 ms base…
        assertEquals(301L, settleDelayMs(1024))
        // …and the growth stops, so a 1 MiB job pays 1.3 s, not more.
        assertEquals(1300L, settleDelayMs(1024 * 1024))
        assertEquals(1300L, settleDelayMs(10 * 1024 * 1024))
    }

    /**
     * A small job keeps its requested pause; a large one is shortened
     * so the pauses of the whole send never outrun the budget — the
     * difference between a 1 MiB raster finishing in ~8 s and hanging
     * the 30 s deadline.
     */
    @Test
    fun pauseBudgetKeepsLargeJobsUnderTheDeadline() {
        // A 1000-byte job: two pauses at the requested 50 ms fit the
        // budget, so nothing changes.
        assertEquals(50L, pacedChunkPauseMs(1000, 512, 50))
        // A 1 MiB job: 2047 pauses at 50 ms would be ~102 s; the
        // requested pause must come down, and the total must fit.
        val big = 1024 * 1024
        val scaled = pacedChunkPauseMs(big, 512, 50)
        assertTrue("must scale down: $scaled", scaled < 50L)
        val pauses = chunkRanges(big, 512).size - 1
        assertTrue(
            "pauses must fit the budget: $scaled × $pauses",
            pauses * scaled <= BT_PAUSE_BUDGET_MS,
        )
        // A zero pause stays zero.
        assertEquals(0L, pacedChunkPauseMs(big, 512, 0))
        // One chunk, no pauses at all.
        assertEquals(0L, pacedChunkPauseMs(100, 512, 50))
    }
}
