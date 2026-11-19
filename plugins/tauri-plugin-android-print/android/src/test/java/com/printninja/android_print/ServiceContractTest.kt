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

    // Item 41: the job-result notification is a different slot on a
    // different channel from the pinned service notification, so the
    // ids must stay distinct and stable.

    @Test
    fun jobNotificationUsesItsOwnChannelAndId() {
        assertEquals("printninja-print-jobs", PrintNinjaService.JOB_CHANNEL_ID)
        assertEquals(2, PrintNinjaService.JOB_NOTIFICATION_ID)
        assertTrue(PrintNinjaService.JOB_CHANNEL_ID != PrintNinjaService.CHANNEL_ID)
        assertTrue(PrintNinjaService.JOB_NOTIFICATION_ID != PrintNinjaService.NOTIFICATION_ID)
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

    // Item 41: the job-result wording is the only thing the user sees
    // when a background job ends, so it is pinned here too.

    @Test
    fun aSuccessfulJobSaysItFinished() {
        val (title, text) = PrintNinjaService.jobNotificationText("success", "Order #12", null)
        assertEquals("Print finished", title)
        assertEquals("Order #12 was printed.", text)
    }

    @Test
    fun aSuccessfulJobWithoutANameStillSaysItFinished() {
        val (title, text) = PrintNinjaService.jobNotificationText("success", null, null)
        assertEquals("Print finished", title)
        assertEquals("Your print job finished.", text)
    }

    // B3: a raw-wire success (USB, driverless Bluetooth) cannot know the
    // paper came out, so it says "sent", never "printed".

    @Test
    fun aRawWireSuccessSaysSentNotPrinted() {
        val (title, text) =
            PrintNinjaService.jobNotificationText("success", "Order #12", null, sentOnly = true)
        assertEquals("Print finished", title)
        assertEquals("Order #12 was sent to the printer.", text)
        assertFalse(text.contains("printed"))
    }

    @Test
    fun aRawWireSuccessWithoutANameStillSaysSent() {
        val (title, text) =
            PrintNinjaService.jobNotificationText("success", null, null, sentOnly = true)
        assertEquals("Print finished", title)
        assertEquals("Your print job was sent to the printer.", text)
    }

    @Test
    fun aRawWireFailureKeepsTheFailureWording() {
        val (title, text) =
            PrintNinjaService.jobNotificationText("failure", "Order #12", null, sentOnly = true)
        assertEquals("Print failed", title)
        assertEquals("Order #12 could not be printed.", text)
    }

    @Test
    fun aFailedJobShowsTheReasonWithTheName() {
        val (title, text) =
            PrintNinjaService.jobNotificationText("failure", "Order #12", "printer offline")
        assertEquals("Print failed", title)
        assertEquals("Order #12: printer offline", text)
    }

    @Test
    fun aFailedJobWithoutAReasonFallsBackToTheName() {
        val (title, text) = PrintNinjaService.jobNotificationText("failure", "Order #12", null)
        assertEquals("Print failed", title)
        assertEquals("Order #12 could not be printed.", text)
    }

    @Test
    fun aFailedJobWithoutANameShowsTheReasonAlone() {
        val (title, text) = PrintNinjaService.jobNotificationText("failure", null, "render timed out")
        assertEquals("Print failed", title)
        assertEquals("render timed out", text)
    }

    @Test
    fun aFailedJobWithNothingKnownPointsAtHistory() {
        val (title, text) = PrintNinjaService.jobNotificationText("failure", null, null)
        assertEquals("Print failed", title)
        assertEquals("A print job failed. Open History for details.", text)
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

    // The prompt is recoverable, once: Android offers it again while a
    // rationale remains (or before it was ever shown); after that it
    // auto-denies silently and only the settings screen can help — the
    // Settings → Background row routes on this answer.
    @Test
    fun theNotificationPromptIsOfferedUntilAndroidStopsOfferingIt() {
        assertTrue(PrintNinjaService.canPromptNotification(false, false))
        assertTrue(PrintNinjaService.canPromptNotification(false, true))
        assertTrue(PrintNinjaService.canPromptNotification(true, true))
        assertFalse(PrintNinjaService.canPromptNotification(true, false))
    }
}
