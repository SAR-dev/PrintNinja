package com.printninja.android_print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Framework-free contract tests: the action strings and channel ids
 * are the integration surface (MainActivity patch, notification taps,
 * the Open and Close actions). Renaming one silently breaks the handoff, so the
 * names are pinned here where plain JUnit can reach them.
 */
class ServiceContractTest {

    @Test
    fun stopActionIsNamespacedToThePlugin() {
        assertEquals(
            "com.printninja.android_print.STOP_SERVICE",
            PrintNinjaService.ACTION_STOP,
        )
    }

    @Test
    fun closeActionIsNamespacedAndDistinctFromStop() {
        assertEquals(
            "com.printninja.android_print.CLOSE_APP",
            PrintNinjaService.ACTION_CLOSE,
        )
        assertTrue(PrintNinjaService.ACTION_CLOSE != PrintNinjaService.ACTION_STOP)
    }

    @Test
    fun channelAndNotificationIdsAreStable() {
        assertEquals("printninja-print-service", PrintNinjaService.CHANNEL_ID)
        assertEquals(1, PrintNinjaService.NOTIFICATION_ID)
    }

    @Test
    fun stopActionIsDistinctFromLifecycleActions() {
        assertTrue(PrintNinjaService.ACTION_STOP.startsWith("com.printninja."))
    }

    // The notification text is the app's only visible proof that the
    // local API server is alive in the background, so the wording (and
    // the address) is pinned here.

    @Test
    fun apiRunningNotificationShowsTheLiveAddress() {
        val (title, text) = PrintNinjaService.notificationText(true, "192.168.1.24:17717")
        assertEquals("PrintNinja is running", title)
        assertEquals("API server listening on 192.168.1.24:17717", text)
    }

    @Test
    fun apiStoppedNotificationFallsBackToThePrintQueueWording() {
        val (title, text) = PrintNinjaService.notificationText(false, null)
        assertEquals("PrintNinja print service is running", title)
        assertEquals("The print queue stays available in the background.", text)
    }

    @Test
    fun aStaleAddressNeverShowsWhileTheServerIsDown() {
        val (title, text) = PrintNinjaService.notificationText(false, "127.0.0.1:17717")
        assertEquals("PrintNinja print service is running", title)
        assertFalse(text.contains("17717"))
    }

    // Android 13+ hides the foreground notification until the user allows
    // notifications; older versions never ask.
    @Test
    fun notificationPermissionIsOnlyAskedOnAndroid13AndUp() {
        assertTrue(PrintNinjaService.needsNotificationPermission(33, false))
        assertTrue(PrintNinjaService.needsNotificationPermission(34, false))
        assertFalse(PrintNinjaService.needsNotificationPermission(33, true))
        assertFalse(PrintNinjaService.needsNotificationPermission(32, false))
    }
}
