package com.printninja.android_print

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Makes Android-side failures visible in the app's own log file.
 *
 * The Rust log only sees Rust panics. A crash in Kotlin/Java (for
 * example `ForegroundServiceDidNotStopInTimeException`) or a kill by
 * the system never reached it, so the in-app Diagnostics export said
 * nothing while `adb logcat` showed the cause.
 *
 * Two sources, both read back by Rust at the next start (see the
 * `drainCrashReports` command) and written to `printninja.log`:
 *  1. Uncaught exceptions: a handler writes the stack trace to a small
 *     file before the process dies, then hands over to the previous
 *     handler so Android still shows its usual crash behaviour.
 *  2. Android's own record of why this app's process last ended
 *     ([ActivityManager.getHistoricalProcessExitReasons], API 30+):
 *     crash, native crash, low memory, killed, ANR, and so on.
 *
 * Everything here is best-effort and must never throw: it runs while
 * the process is already failing.
 */
object CrashReporter {
    private const val TAG = "PrintNinjaCrash"
    private const val DIR = "crash-reports"
    private const val MAX_FILES = 5
    private const val MAX_CHARS = 16_000
    private const val PREFS = "pn_crash_reporter"
    private const val KEY_LAST_EXIT = "last_exit_ts"

    @Volatile
    private var installed = false

    /** Idempotent: safe from the plugin, the service and any process start. */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                write(app, thread, error)
            } catch (_: Throwable) {
                // Nothing sensible left to do while crashing.
            }
            if (previous != null) {
                previous.uncaughtException(thread, error)
            } else {
                Process.killProcess(Process.myPid())
            }
        }
    }

    private fun write(app: Context, thread: Thread, error: Throwable) {
        val dir = File(app.filesDir, DIR)
        dir.mkdirs()
        // Keep the folder small: drop the oldest reports first.
        val existing = dir.listFiles()?.sortedBy { it.name } ?: emptyList()
        if (existing.size >= MAX_FILES) {
            existing.take(existing.size - MAX_FILES + 1).forEach { it.delete() }
        }
        val now = System.currentTimeMillis()
        val text = buildString {
            append("ANDROID CRASH ").append(stamp(now)).append('\n')
            append("process=").append(processName(app))
            append(" thread=").append(thread.name).append('\n')
            append("android=").append(Build.VERSION.RELEASE)
            append(" sdk=").append(Build.VERSION.SDK_INT)
            append(" device=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            append('\n')
            append(Log.getStackTraceString(error))
        }.take(MAX_CHARS)
        File(dir, "crash-$now.txt").writeText(text)
    }

    /**
     * Everything not yet reported: stored crash reports (deleted once
     * read) plus new system exit records for this app's main process.
     */
    fun drain(context: Context): List<String> {
        val app = context.applicationContext
        val out = ArrayList<String>()
        try {
            File(app.filesDir, DIR).listFiles()?.sortedBy { it.name }?.forEach { f ->
                try {
                    out.add(f.readText())
                } catch (_: Throwable) {
                }
                f.delete()
            }
        } catch (e: Throwable) {
            Log.w(TAG, "could not read crash reports: ${e.message}")
        }
        try {
            out.addAll(exitRecords(app))
        } catch (e: Throwable) {
            Log.w(TAG, "could not read exit reasons: ${e.message}")
        }
        return out
    }

    private fun exitRecords(app: Context): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            ?: return emptyList()
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val last = prefs.getLong(KEY_LAST_EXIT, 0L)
        var newest = last
        val lines = ArrayList<String>()
        am.getHistoricalProcessExitReasons(app.packageName, 0, 10)
            .filter { it.timestamp > last && it.processName == app.packageName }
            .sortedBy { it.timestamp }
            .forEach { info ->
                newest = maxOf(newest, info.timestamp)
                lines.add(
                    "ANDROID PROCESS EXIT ${stamp(info.timestamp)} " +
                        "reason=${reasonName(info.reason)} status=${info.status} " +
                        "importance=${info.importance} " +
                        "description=${info.description ?: "-"}",
                )
            }
        if (newest != last) prefs.edit().putLong(KEY_LAST_EXIT, newest).apply()
        return lines
    }

    /** Names of `ApplicationExitInfo.REASON_*`, by value (stable across SDKs). */
    private fun reasonName(reason: Int): String = when (reason) {
        1 -> "EXIT_SELF"
        2 -> "SIGNALED"
        3 -> "LOW_MEMORY"
        4 -> "CRASH"
        5 -> "CRASH_NATIVE"
        6 -> "ANR"
        7 -> "INITIALIZATION_FAILURE"
        8 -> "PERMISSION_CHANGE"
        9 -> "EXCESSIVE_RESOURCE_USAGE"
        10 -> "USER_REQUESTED"
        11 -> "USER_STOPPED"
        12 -> "DEPENDENCY_DIED"
        13 -> "OTHER"
        14 -> "FREEZER"
        15 -> "PACKAGE_STATE_CHANGE"
        16 -> "PACKAGE_UPDATED"
        else -> "UNKNOWN($reason)"
    }

    private fun processName(app: Context): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            android.app.Application.getProcessName()
        } else {
            app.packageName
        }

    private fun stamp(millis: Long): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date(millis))
}
