package com.printninja.android_print

import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.Rule

/**
 * The file handoff (large writes travel by path, not base64) is plain
 * `java.io`, so JUnit drives it with temp files — no Activity needed.
 */
class HandoffTest {

    @Rule
    @JvmField
    val temp = TemporaryFolder()

    @Test
    fun readReturnsTheBytesAndDeletesTheFile() {
        val file = temp.newFile("payload.bin")
        val bytes = ByteArray(300_000) { (it % 251).toByte() }
        Files.write(file.toPath(), bytes)
        assertArrayEquals(bytes, readHandoffFile(file.absolutePath))
        assertFalse("staged file must not linger", file.exists())
    }

    @Test
    fun missingFileThrows() {
        val missing = temp.root.resolve("gone.bin").absolutePath
        var threw = false
        try {
            readHandoffFile(missing)
        } catch (_: Exception) {
            threw = true
        }
        assertTrue("missing handoff file must fail loudly, not print zeros", threw)
    }

    @Test
    fun blankPathThrows() {
        var threw = false
        try {
            readHandoffFile("   ")
        } catch (_: IllegalArgumentException) {
            threw = true
        }
        assertTrue(threw)
    }
}
