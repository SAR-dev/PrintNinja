package com.printninja.android_print

import java.io.File

/**
 * Large writes cross the Rust→Kotlin bridge by file path instead of
 * base64: the Rust side stages the bytes
 * under a unique name, and the write commands read and delete the file.
 * Either side's delete suffices, so a crash mid-print leaves at most one
 * orphaned file per print.
 *
 * No Android classes on purpose: JUnit can drive it with temp files.
 *
 * @throws IllegalArgumentException when [path] is blank, an I/O error
 * when it is missing or unreadable.
 */
internal fun readHandoffFile(path: String): ByteArray {
    require(path.isNotBlank()) { "handoff path is blank" }
    val file = File(path)
    try {
        return file.readBytes()
    } finally {
        runCatching { file.delete() }
    }
}
