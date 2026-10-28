package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Test

class ResolveQueueTest {

    /** Fake resolver: records the order and lets the test finish each item by hand. */
    private class Fake {
        val started = mutableListOf<String>()
        val dones = mutableMapOf<String, () -> Unit>()
        val queue = ResolveQueue<String> { item, done ->
            started += item
            dones[item] = done
        }
    }

    @Test
    fun onlyOneResolveRunsAtATime() {
        val f = Fake()
        f.queue.add("a")
        f.queue.add("b")
        f.queue.add("c")
        assertEquals(listOf("a"), f.started)
        f.dones["a"]!!()
        assertEquals(listOf("a", "b"), f.started)
        f.dones["b"]!!()
        assertEquals(listOf("a", "b", "c"), f.started)
    }

    @Test
    fun aFailedResolveStillStartsTheNext() {
        // Found three, the second fails: the third must still run, and the
        // rows that did resolve (first and third) are what the user sees.
        val rows = mutableListOf<String>()
        val queue =
            ResolveQueue<String> { item, done ->
                if (item != "b") rows += item
                done()
            }
        queue.add("a")
        queue.add("b")
        queue.add("c")
        assertEquals(listOf("a", "c"), rows)
    }

    @Test
    fun aResolverThatThrowsDoesNotStallTheQueue() {
        val ran = mutableListOf<String>()
        val queue =
            ResolveQueue<String> { item, done ->
                ran += item
                if (item == "a") throw IllegalStateException("boom")
                done()
            }
        queue.add("a")
        queue.add("b")
        assertEquals(listOf("a", "b"), ran)
    }

    @Test
    fun callingDoneTwiceDoesNotStartTwoResolves() {
        val f = Fake()
        f.queue.add("a")
        f.queue.add("b")
        f.queue.add("c")
        f.dones["a"]!!()
        f.dones["a"]!!()
        assertEquals(listOf("a", "b"), f.started)
    }

    @Test
    fun itemsAddedAfterTheQueueDrainedStartImmediately() {
        val f = Fake()
        f.queue.add("a")
        f.dones["a"]!!()
        f.queue.add("b")
        assertEquals(listOf("a", "b"), f.started)
    }

    @Test
    fun closeDropsWaitingItemsAndRefusesNewOnes() {
        val f = Fake()
        f.queue.add("a")
        f.queue.add("b")
        f.queue.close()
        f.dones["a"]!!()
        f.queue.add("c")
        assertEquals(listOf("a"), f.started)
    }
}
