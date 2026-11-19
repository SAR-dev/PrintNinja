package com.printninja.android_print

/**
 * Pacing for a driverless Bluetooth job (B4): the RFCOMM socket is
 * written in slices of [clampChunkBytes] with a short pause between them,
 * so a slow thermal printer's buffer has a chance to drain and the job
 * does not arrive as one flood it drops. The pace is per-printer (the
 * Rust side reads it from the row's `default_settings_json`); the
 * defaults are safe for 2-inch receipt printers.
 *
 * Every number here is chosen so a whole send stays far under the Rust
 * side's 30 s Bluetooth deadline even for the largest handoff payload:
 * the total pause time is capped at [BT_PAUSE_BUDGET_MS] and the final
 * settle wait tops out at [settleDelayMs] for a 1 MiB job.
 */

/** Default bytes per RFCOMM write. */
const val BT_CHUNK_BYTES_DEFAULT = 512L

/** Default pause between RFCOMM writes, in ms. */
const val BT_CHUNK_PAUSE_MS_DEFAULT = 50L

/** Bounds a caller-chosen chunk size; mirrors the Rust `validate()`. */
const val BT_CHUNK_BYTES_MIN = 32L

/** @see BT_CHUNK_BYTES_MIN */
const val BT_CHUNK_BYTES_MAX = 8192L

/** Bounds a caller-chosen pause, in ms. */
const val BT_CHUNK_PAUSE_MS_MAX = 2000L

/**
 * The total pause budget for one send, in ms: the whole write must stay
 * under the Rust side's 30 s deadline with room for the connect, the
 * socket writes and the settle wait themselves.
 */
const val BT_PAUSE_BUDGET_MS = 5000L

/** Clamp a caller-chosen chunk size into the sane range. */
fun clampChunkBytes(requested: Long): Long =
    requested.coerceIn(BT_CHUNK_BYTES_MIN, BT_CHUNK_BYTES_MAX)

/** Clamp a caller-chosen pause into the sane range. */
fun clampChunkPauseMs(requested: Long): Long =
    requested.coerceIn(0L, BT_CHUNK_PAUSE_MS_MAX)

/**
 * The `[first, last]` slices one paced write of [size] bytes is broken
 * into: equal chunks of [chunkBytes] except the last. The ranges are in
 * order and tile `0 until size` exactly once, so writing them in order
 * sends the bytes in order. Empty data has no slices at all.
 */
fun chunkRanges(size: Int, chunkBytes: Long): List<IntRange> {
    if (size <= 0) return emptyList()
    val step = clampChunkBytes(chunkBytes).toInt()
    val ranges = ArrayList<IntRange>()
    var offset = 0
    while (offset < size) {
        val end = minOf(offset + step, size)
        ranges.add(offset until end)
        offset = end
    }
    return ranges
}

/**
 * The pause actually used between the chunks of a [size]-byte job: the
 * requested pause, shortened proportionally when the job's chunks would
 * together outrun [BT_PAUSE_BUDGET_MS]. A job of one chunk pauses at
 * all; a zero pause stays zero.
 */
fun pacedChunkPauseMs(size: Int, chunkBytes: Long, requested: Long): Long {
    val pauses = chunkRanges(size, chunkBytes).size - 1
    if (pauses <= 0 || requested <= 0L) return 0L
    val natural = pauses * requested
    if (natural <= BT_PAUSE_BUDGET_MS) return requested
    return maxOf(1L, BT_PAUSE_BUDGET_MS / pauses)
}

/**
 * The settle wait after the final flush, in ms: the platen may still be
 * mid-stroke when the socket closes, and a close mid-stroke is exactly
 * the "two letters printed" failure. A fixed 300 ms for small jobs,
 * growing by 1 ms per 1 KiB, capped so even a 1 MiB job pays 1.3 s —
 * long enough to matter, short enough to stay under the send deadline.
 */
fun settleDelayMs(bytesWritten: Int): Long {
    if (bytesWritten <= 0) return 0L
    return 300L + (bytesWritten.toLong() / 1024L).coerceAtMost(1000L)
}
