package com.printninja.android_print

/**
 * Open connection handles shared across plugin calls so one print pays
 * one connect instead of one per operation (probe, status query, write).
 *
 * Handles are opaque strings minted by the caller (a UUID per open). The
 * store never closes anything itself: [sweepIdle] hands idle values back
 * and the caller closes them, so closing stays with the code that knows
 * how (a USB connection's `close()` vs a socket's throwing `close()`).
 *
 * No Android classes on purpose: JUnit can drive it with fake values.
 * All methods are safe to call from any thread (every plugin command
 * runs on the shared I/O pool).
 */
class ConnectionHandles<T : Any> {
    private val maxIdleMs: Long
    private val clockMs: () -> Long

    constructor(maxIdleMs: Long, clockMs: () -> Long) {
        this.maxIdleMs = maxIdleMs
        this.clockMs = clockMs
    }

    constructor(maxIdleMs: Long) : this(maxIdleMs, System::currentTimeMillis)

    constructor() : this(DEFAULT_MAX_IDLE_MS, System::currentTimeMillis)

    private data class Entry<V : Any>(val value: V, var lastUsedMs: Long)

    private val lock = Any()
    private val entries = HashMap<String, Entry<T>>()

    /**
     * Store [value] under [handle]. Returns the previous value when the
     * handle was already taken (a caller bug — practically impossible
     * with UUID handles); the caller must close it.
     */
    fun put(handle: String, value: T): T? {
        synchronized(lock) {
            val previous = entries.put(handle, Entry(value, clockMs()))
            return previous?.value
        }
    }

    /** The live value for [handle], or null when unknown or reaped. Touches it. */
    fun get(handle: String): T? {
        synchronized(lock) {
            val entry = entries[handle] ?: return null
            entry.lastUsedMs = clockMs()
            return entry.value
        }
    }

    /** Forget [handle] without closing; the caller owns the returned value. */
    fun remove(handle: String): T? {
        synchronized(lock) {
            return entries.remove(handle)?.value
        }
    }

    /**
     * Forget every handle idle longer than [maxIdleMs] and hand the
     * values back for the caller to close. Call on every open so a
     * process that dies mid-print cannot leak connections forever.
     */
    fun sweepIdle(): List<T> {
        val now = clockMs()
        synchronized(lock) {
            val idle = entries
                .filterValues { now - it.lastUsedMs > maxIdleMs }
                .keys
                .toList()
            if (idle.isEmpty()) return emptyList()
            return idle.mapNotNull { entries.remove(it)?.value }
        }
    }

    fun size(): Int {
        synchronized(lock) {
            return entries.size
        }
    }

    companion object {
        /** Reaps connections no print has touched for two minutes. */
        const val DEFAULT_MAX_IDLE_MS = 120_000L
    }
}
