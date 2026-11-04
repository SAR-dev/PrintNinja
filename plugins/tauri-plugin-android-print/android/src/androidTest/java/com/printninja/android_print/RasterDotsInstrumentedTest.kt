package com.printninja.android_print

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Device-side evidence for PLAN §4 (D4.1/D4.2): runs only on a real
 * device or an emulator, via the generated app project's
 * `./gradlew connectedDebugAndroidTest` — CI stays compile+unit (D4.2).
 *
 * These tests prove the density-160 trick actually yields 1 CSS px = 1
 * printer dot. The pages paint pure colors with no antialiasing, so
 * every pixel is either black (dot) or white (no dot) and the packed
 * byte stream has an exact pattern. If the WebView ever resamples —
 * e.g. the device's own density leaks into the layout — the color edge
 * stops landing on the expected byte boundary and these fail.
 *
 * `renderDots` is top-level in the main source set precisely so this
 * test can call it with a bare [Context]; it needs no Activity and no
 * Tauri runtime.
 */
@RunWith(AndroidJUnit4::class)
class RasterDotsInstrumentedTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
    }

    /** Renders [html] at [widthPx] × [heightPx] and returns the packed dots. */
    private fun renderToDots(html: String, widthPx: Int, heightPx: Int): ByteArray {
        val latch = CountDownLatch(1)
        var dots: ByteArray? = null
        var failure: String? = null
        renderDots(context, html, widthPx, heightPx) {
            if (it.isSuccess) {
                val f = it.getOrThrow()
                dots = f.readBytes()
                f.delete()
            } else {
                failure = it.exceptionOrNull()?.message
            }
            latch.countDown()
        }
        assertTrue(
            "render did not settle within 30s (error: $failure)",
            latch.await(30, TimeUnit.SECONDS),
        )
        failure?.let { throw AssertionError("raster render failed: $it") }
        return dots!!
    }

    @Test
    fun aFullBleedBlackPageFillsEveryDot() {
        // 320 × 20: 40 bytes per row, every one of them fully set.
        val dots = renderToDots(
            "<html><body style=\"margin:0;padding:0;background:#000\"></body></html>",
            320,
            20,
        )
        assertArrayEquals(ByteArray(320 * 20 / 8) { 0xFF.toByte() }, dots)
    }

    @Test
    fun oneCssPixelIsOnePrinterDot() {
        // The left 160 CSS px are black, the right 160 white. With 1 CSS
        // px = 1 dot, each 40-byte row is exactly 20 bytes of 0xFF then
        // 20 bytes of 0x00 — resampling would smear that edge across
        // neighboring bytes.
        val dots = renderToDots(
            "<html><body style=\"margin:0;padding:0\">" +
                "<div style=\"width:160px;height:20px;background:#000\"></div>" +
                "</body></html>",
            320,
            20,
        )
        val expectedRow = ByteArray(40) { if (it < 20) 0xFF.toByte() else 0x00.toByte() }
        for (y in 0 until 20) {
            assertArrayEquals(
                "row $y",
                expectedRow,
                dots.copyOfRange(y * 40, (y + 1) * 40),
            )
        }
    }
}
