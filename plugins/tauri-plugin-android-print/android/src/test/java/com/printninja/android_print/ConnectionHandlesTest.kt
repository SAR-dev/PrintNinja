package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionHandlesTest {

    /** Fake values stand in for sockets: close-ability is the caller's job. */
    private class Fake(val name: String)

    private class Clock(var now: Long = 1_000L) {
        fun get(): Long = now
    }

    @Test
    fun getReturnsWhatPutStoredAndTouchesIt() {
        val clock = Clock()
        val handles = ConnectionHandles<Fake>(120_000L, clock::get)
        val device = Fake("usb")
        assertNull(handles.put("h1", device))
        assertEquals(device, handles.get("h1"))
        assertEquals(1, handles.size())
    }

    @Test
    fun unknownHandleResolvesToNull() {
        val handles = ConnectionHandles<Fake>()
        assertNull(handles.get("nope"))
        assertNull(handles.remove("nope"))
        assertEquals(0, handles.size())
    }

    @Test
    fun removeForgetsWithoutClosing() {
        val handles = ConnectionHandles<Fake>()
        val device = Fake("usb")
        handles.put("h1", device)
        assertEquals(device, handles.remove("h1"))
        assertNull(handles.get("h1"))
        assertEquals(0, handles.size())
    }

    @Test
    fun putOnATakenHandleHandsBackThePreviousValue() {
        val handles = ConnectionHandles<Fake>()
        val first = Fake("first")
        val second = Fake("second")
        handles.put("h1", first)
        assertEquals(first, handles.put("h1", second))
        assertEquals(second, handles.get("h1"))
    }

    @Test
    fun sweepReapsOnlyIdleHandles() {
        val clock = Clock()
        val handles = ConnectionHandles<Fake>(10_000L, clock::get)
        val idle = Fake("idle")
        val busy = Fake("busy")
        handles.put("old", idle)
        clock.now += 9_000L
        handles.put("new", busy)
        clock.now += 2_000L
        // "old" is 11 s idle (reaped); "new" is 2 s idle (kept).
        val reaped = handles.sweepIdle()
        assertEquals(listOf(idle), reaped)
        assertNull(handles.get("old"))
        assertEquals(busy, handles.get("new"))
    }

    @Test
    fun aTouchResetsTheIdleClock() {
        val clock = Clock()
        val handles = ConnectionHandles<Fake>(10_000L, clock::get)
        val device = Fake("usb")
        handles.put("h1", device)
        clock.now += 9_000L
        handles.get("h1")
        clock.now += 9_000L
        // Last touched 9 s ago: still live.
        assertTrue(handles.sweepIdle().isEmpty())
        assertEquals(device, handles.get("h1"))
    }

    @Test
    fun sweepOnAnEmptyStoreIsEmpty() {
        val handles = ConnectionHandles<Fake>()
        assertTrue(handles.sweepIdle().isEmpty())
    }
}
