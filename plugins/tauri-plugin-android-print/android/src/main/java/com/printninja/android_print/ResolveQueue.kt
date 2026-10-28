package com.printninja.android_print

import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Runs asynchronous "resolve" steps strictly one at a time.
 *
 * Before Android 14, `NsdManager` allows a single `resolveService` in
 * flight; a second concurrent call fails with `FAILURE_ALREADY_ACTIVE`, so
 * a printer found while another is resolving was silently lost. Services
 * are queued here instead, and the next one starts when the previous one
 * reports it is done, whether it succeeded or failed.
 *
 * No Android classes on purpose: JUnit can drive it with a fake resolver.
 *
 * [resolve] must call the `done` callback exactly once when the item has
 * finished (extra calls are ignored). If [resolve] throws, the item counts
 * as finished and the queue moves on.
 */
class ResolveQueue<T : Any>(private val resolve: (item: T, done: () -> Unit) -> Unit) {
    private val lock = Any()
    private val pending = ArrayDeque<T>()
    private var busy = false
    private var closed = false

    /** Queue [item]; it starts at once when nothing else is resolving. */
    fun add(item: T) {
        synchronized(lock) {
            if (closed) return
            pending.addLast(item)
        }
        pump()
    }

    /** Stop starting new resolves (discovery ended). A running one may still finish. */
    fun close() {
        synchronized(lock) {
            closed = true
            pending.clear()
        }
    }

    private fun pump() {
        val item: T =
            synchronized(lock) {
                if (closed || busy) null else pending.pollFirst()?.also { busy = true }
            } ?: return
        val finished = AtomicBoolean(false)
        val done = {
            if (finished.compareAndSet(false, true)) {
                synchronized(lock) { busy = false }
                pump()
            }
        }
        try {
            resolve(item, done)
        } catch (_: Exception) {
            done()
        }
    }
}
