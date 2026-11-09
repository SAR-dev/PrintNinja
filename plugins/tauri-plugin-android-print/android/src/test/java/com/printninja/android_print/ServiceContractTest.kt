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

    // The USB grant-result action is the integration surface between the
    // manifest receiver (UsbAttachReceiver) and the in-process request
    // (AndroidPrintPlugin.ensureUsbPermission): the receiver is declared
    // in the plugin AndroidManifest.xml with this literal, so renaming
    // it here silently breaks the grant handoff.
    @Test
    fun usbPermissionActionIsNamespacedToThePlugin() {
        assertEquals("com.printninja.android_print.USB_PERMISSION", USB_PERMISSION_ACTION)
    }

    @Test
    fun usbAttachActionIsThePlatformOne() {
        assertEquals(
            "android.hardware.usb.action.USB_DEVICE_ATTACHED",
            UsbAttachReceiver.USB_ATTACHED_ACTION,
        )
    }

    // The notification text is the app's only visible proof of what is
    // actually alive in the background (queue worker, API server), so
    // the wording (and the address) is pinned here.

    @Test
    fun apiRunningNotificationShowsTheLiveAddress() {
        val (title, text) = PrintNinjaService.notificationText(true, true, "192.168.1.24:17717")
        assertEquals("PrintNinja is running", title)
        assertEquals("API server listening on 192.168.1.24:17717", text)
    }

    @Test
    fun apiStoppedNotificationFallsBackToThePrintQueueWording() {
        val (title, text) = PrintNinjaService.notificationText(true, false, null)
        assertEquals("PrintNinja print service is running", title)
        assertEquals("The print queue stays available in the background.", text)
    }

    @Test
    fun aStaleAddressNeverShowsWhileTheServerIsDown() {
        val (title, text) = PrintNinjaService.notificationText(true, false, "127.0.0.1:17717")
        assertEquals("PrintNinja print service is running", title)
        assertFalse(text.contains("17717"))
    }

    // After Android kills the process, only the service is restarted:
    // the Rust queue worker does not come back until the app is opened.
    // The notification must say the queue is paused — never claim it is
    // draining — so the paused wording is pinned here too.

    @Test
    fun serviceRestartWithoutTheAppSaysTheQueueIsPaused() {
        val (title, text) = PrintNinjaService.notificationText(false, false, null)
        assertEquals("PrintNinja restarted", title)
        assertEquals("The print queue is paused. Open the app to resume printing.", text)
    }

    @Test
    fun aPausedQueueNeverShowsAnAddressOrALiveWording() {
        val (title, text) = PrintNinjaService.notificationText(false, true, "127.0.0.1:17717")
        assertEquals("PrintNinja restarted", title)
        assertFalse(text.contains("17717"))
        assertFalse(text.contains("available"))
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
