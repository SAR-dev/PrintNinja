package com.printninja.android_print

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log

/** The USB permission-grant result action. Shared with
 *  AndroidPrintPlugin.ensureUsbPermission so the two request paths
 *  never drift apart. */
const val USB_PERMISSION_ACTION = "com.printninja.android_print.USB_PERMISSION"

/**
 * Manifest receiver for USB_DEVICE_ATTACHED (printer-class devices,
 * res/xml/device_filter.xml). Two jobs:
 *
 * 1. Being declared in the manifest is what lets Android remember the
 *    USB permission grant: once the user has allowed a matching device,
 *    the system re-grants it on the next plug-in without a dialog, and
 *    background jobs can open a re-plugged printer with the app out of
 *    the foreground.
 * 2. When a printer arrives without a remembered grant, it asks for
 *    one — from the receiver, so the app does not need to be in the
 *    foreground. The grant result comes back to this same receiver
 *    (USB_PERMISSION_ACTION); by then hasPermission() is true and the
 *    print flow opens the device without asking again.
 *
 * The in-process request (ensureUsbPermission) stays as the fallback
 * for devices the manifest filter does not match.
 */
class UsbAttachReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
        when (intent.action) {
            USB_PERMISSION_ACTION -> {
                val granted =
                    intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                Log.i(TAG, "usb permission result: granted=$granted")
            }
            USB_ATTACHED_ACTION -> {
                val device = deviceFromIntent(intent) ?: return
                if (!isPrinter(device)) return
                if (manager.hasPermission(device)) return
                Log.i(TAG, "printer attached without permission, requesting")
                requestPermission(context, manager, device)
            }
        }
    }

    /** Printers declare the class at the interface level per the USB
     *  spec, but many also set it on the device descriptor — accept
     *  either so the in-process request path is not class-dependent. */
    private fun isPrinter(device: UsbDevice): Boolean {
        if (device.classId == UsbConstants.USB_CLASS_PRINTER) return true
        for (i in 0 until device.interfaceCount) {
            if (device.getInterface(i).classId == UsbConstants.USB_CLASS_PRINTER) {
                return true
            }
        }
        return false
    }

    private fun deviceFromIntent(intent: Intent): UsbDevice? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }
    }

    private fun requestPermission(
        context: Context,
        manager: UsbManager,
        device: UsbDevice,
    ) {
        // Mutable: the system fills in the grant result extras before
        // delivering the broadcast back to this receiver.
        val flags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
        val pending =
            PendingIntent.getBroadcast(
                context,
                device.deviceId,
                Intent(USB_PERMISSION_ACTION).setPackage(context.packageName),
                flags,
            )
        manager.requestPermission(device, pending)
    }

    companion object {
        private const val TAG = "UsbAttachReceiver"
        const val USB_ATTACHED_ACTION = "android.hardware.usb.action.USB_DEVICE_ATTACHED"
    }
}
