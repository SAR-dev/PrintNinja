package com.printninja.android_print

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.pdf.PdfDocument
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil
import kotlin.math.roundToInt

@InvokeArg
class HtmlToPdfArgs {
    var html: String? = null
    var pageWidthMm: Double? = null
    var pageHeightMm: Double? = null
    var orientation: String? = null
    var documentName: String? = null
}

@InvokeArg
class TestPrinterArgs {
    var printerId: String? = null
}

@InvokeArg
class UsbProbeArgs {
    var deviceName: String? = null
}

@InvokeArg
class UsbQueryArgs {
    var deviceName: String? = null
    var requestBase64: String? = null
    var replyTimeoutMs: Int? = null
}

@InvokeArg
class BluetoothQueryArgs {
    var address: String? = null
    var requestBase64: String? = null
    var replyTimeoutMs: Int? = null
}

@InvokeArg
class DiscoverNetworkArgs {
    var timeoutSec: Int? = null
}

@InvokeArg
class UsbWriteArgs {
    var deviceName: String? = null
    var dataBase64: String? = null
}

@InvokeArg
class BluetoothProbeArgs {
    var address: String? = null
}

@InvokeArg
class BluetoothWriteArgs {
    var address: String? = null
    var dataBase64: String? = null
}

/**
 * Stateful-connection commands (one connect per print instead of one per
 * operation): `open*` mints a handle for an open device/socket, the
 * `*On` calls reuse it, and `close*` releases it. Handles idle past
 * [ConnectionHandles.DEFAULT_MAX_IDLE_MS] are reaped on the next open.
 */
@InvokeArg
class UsbOpenArgs {
    var deviceName: String? = null
}

@InvokeArg
class UsbQueryOnArgs {
    var handle: String? = null
    var requestBase64: String? = null
    var replyTimeoutMs: Int? = null
}

@InvokeArg
class UsbWriteOnArgs {
    var handle: String? = null
    var dataBase64: String? = null
    var dataPath: String? = null
}

@InvokeArg
class UsbCloseArgs {
    var handle: String? = null
}

@InvokeArg
class BluetoothOpenArgs {
    var address: String? = null
}

@InvokeArg
class BluetoothQueryOnArgs {
    var handle: String? = null
    var requestBase64: String? = null
    var replyTimeoutMs: Int? = null
}

@InvokeArg
class BluetoothWriteOnArgs {
    var handle: String? = null
    var dataBase64: String? = null
    var dataPath: String? = null
}

@InvokeArg
class BluetoothCloseArgs {
    var handle: String? = null
}

/** Rust reports the local API server's state so the pinned
 *  notification can show the live address (see PrintNinjaService). */
@InvokeArg
class ApiServerStateArgs {
    var running: Boolean = false
    var address: String? = null
}

@TauriPlugin
class AndroidPrintPlugin(private val activity: Activity) : Plugin(activity) {
    private val tag = "AndroidPrintPlugin"

    /** One render's deadline, in ms: a page that never finishes still gets an answer. */
    private val renderTimeoutMs = 60_000L

    /** One bulk-transfer / socket write's deadline, in ms. */
    private val ioTimeoutMs = 10_000

    /** Blocking I/O (USB, Bluetooth sockets) runs here, never on the main thread. */
    private val ioPool = Executors.newCachedThreadPool()

    /**
     * Connections held across the query+write of one print, so a job pays
     * one connect instead of one per operation. Handles are minted per
     * open and always closed by the matching close call; the idle sweep
     * on every open only reaps orphans from a caller that died mid-print.
     */
    /** An open USB device held across one print's query+write. */
    private data class UsbSession(val device: UsbDevice, val connection: UsbDeviceConnection)
    private val usbConnections = ConnectionHandles<UsbSession>()
    private val bluetoothSockets = ConnectionHandles<BluetoothSocket>()

    /** Settles an invoke back on the main thread, wherever the work ran. */
    private fun answer(invoke: Invoke, block: () -> Unit) {
        activity.runOnUiThread { block() }
    }

    /**
     * Renders HTML to a PDF file and resolves with its absolute path. The
     * caller deletes the file when done.
     *
     * Tauri runs this command **on the Android main thread**: Rust ships the
     * invoke through wry's main pipe, which the activity's own looper drains,
     * and `PluginManager.runCommand` reflects straight into this method. So
     * the method must return at once. It used to wait here (bounded, 60 s)
     * for the WebView — which deadlocked, because `onPageFinished` is
     * delivered on the very looper it was blocking, and a main thread that
     * does not answer input for 5 s is an ANR the system resolves by killing
     * the app. That froze the whole UI on every print and ended in a crash.
     *
     * The render is started here instead and finished by the callbacks below;
     * a watchdog on the same looper settles a page that never completes.
     */
    @Command
    fun htmlToPdf(invoke: Invoke) {
        val args = invoke.parseArgs(HtmlToPdfArgs::class.java)
        val html = args.html ?: return invoke.reject("html is required")
        var widthMm = args.pageWidthMm ?: 210.0
        var heightMm = args.pageHeightMm ?: 297.0
        if (args.orientation == "landscape") {
            val swap = widthMm
            widthMm = heightMm
            heightMm = swap
        }

        val tmp: File
        try {
            tmp = File.createTempFile("pn_render_", ".pdf", activity.cacheDir)
        } catch (e: Exception) {
            return invoke.reject("cannot create render file: ${e.message}")
        }

        // Exactly one of page-finished / failure / watchdog answers the
        // invoke: a callback that arrives after the deadline must not try to
        // resolve it a second time.
        val claimed = AtomicBoolean(false)

        activity.runOnUiThread {
            var view: WebView? = null
            try {
                val v = WebView(activity)
                view = v
                v.settings.javaScriptEnabled = false
                v.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        if (!claimed.compareAndSet(false, true)) return
                        if (view == null) {
                            invoke.reject("web view gone")
                            return
                        }
                        val error = printToPdf(view, tmp, widthMm, heightMm)
                        if (error == null) {
                            invoke.resolve(JSObject().put("path", tmp.absolutePath))
                        } else {
                            invoke.reject(error)
                        }
                    }
                }
                Handler(Looper.getMainLooper()).postDelayed(
                    {
                        if (claimed.compareAndSet(false, true)) {
                            v.destroy()
                            tmp.delete()
                            invoke.reject("render timed out after ${renderTimeoutMs / 1000}s")
                        }
                    },
                    renderTimeoutMs,
                )
                v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            } catch (e: Exception) {
                view?.destroy()
                tmp.delete()
                if (claimed.compareAndSet(false, true)) {
                    invoke.reject(e.message ?: "render failed")
                }
            }
        }
    }

    /**
     * Headless render without the print framework: the print
     * framework's adapter callbacks have package-private constructors,
     * so apps cannot drive PrintDocumentAdapter directly. Instead the
     * WebView is measured at the exact label size and drawn page by
     * page onto a PdfDocument — all public API, same @page dimensions
     * the desktop renderers honor. Runs on the UI thread from
     * `onPageFinished`, so it returns as soon as the pages are written.
     *
     * Returns `null` on success, or why the render failed. The view and the
     * document are released on both paths: a render that throws must not
     * leave a whole WebView (and its renderer process) behind.
     */
    private fun printToPdf(
        view: WebView,
        tmp: File,
        widthMm: Double,
        heightMm: Double,
    ): String? {
        val pdf = PdfDocument()
        try {
            val metrics = view.resources.displayMetrics
            val dotsPerMm = metrics.densityDpi / 25.4
            val widthPx = (widthMm * dotsPerMm).roundToInt().coerceAtLeast(1)
            val heightPx = (heightMm * dotsPerMm).roundToInt().coerceAtLeast(1)

            view.measure(
                View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            )
            val contentHeightPx = maxOf(view.measuredHeight, 1)
            view.layout(0, 0, widthPx, contentHeightPx)

            // PDF points stay device-independent: px * 72 / dpi.
            val widthPt = (widthPx * 72.0 / metrics.densityDpi).roundToInt()
            val heightPt = (heightPx * 72.0 / metrics.densityDpi).roundToInt()
            val contentHeightPt = (contentHeightPx * 72.0 / metrics.densityDpi).roundToInt()

            val pageCount = maxOf(1, ceil(contentHeightPt.toDouble() / heightPt).toInt())
            for (pageNo in 1..pageCount) {
                val info = PdfDocument.PageInfo.Builder(widthPt, heightPt, pageNo).create()
                val page = pdf.startPage(info)
                // Shift the canvas so each page shows its own slice.
                page.canvas.translate(0f, (-(pageNo - 1) * heightPx).toFloat())
                page.canvas.scale(
                    72f / metrics.densityDpi,
                    72f / metrics.densityDpi,
                )
                view.draw(page.canvas)
                pdf.finishPage(page)
            }
            FileOutputStream(tmp).use { pdf.writeTo(it) }
            return null
        } catch (e: Exception) {
            Log.e(tag, "print render failed", e)
            tmp.delete()
            return "print render failed: ${e.message}"
        } finally {
            // `close()` throws when a page was left unfinished — the case we
            // get here from the catch above — and that must not escape the
            // WebView callback it would then crash.
            runCatching { pdf.close() }
                .onFailure { Log.w(tag, "closing the pdf failed: ${it.message}") }
            view.destroy()
        }
    }

    @Command
    fun enumerateUsbPrinters(invoke: Invoke) {
        val usbManager = activity.getSystemService(Activity.USB_SERVICE) as UsbManager
        val result = org.json.JSONArray()
        for ((name, device) in usbManager.deviceList) {
            val obj = org.json.JSONObject()
            obj.put("id", device.deviceName)
            obj.put("name", name)
            obj.put("vendorId", device.vendorId)
            obj.put("productId", device.productId)
            result.put(obj)
        }
        invoke.resolve(JSObject().put("printers", result))
    }

    @Command
    fun testPrinter(invoke: Invoke) {
        invoke.parseArgs(TestPrinterArgs::class.java)
        // Reachability is probed by the transport before a job is sent;
        // the command only confirms the plugin round-trip works.
        invoke.resolve(JSObject().put("success", true))
    }

    /**
     * Single-shot LAN printer discovery: listens for mDNS advertisements
     * for `timeoutSec` (2–30, default 8) and resolves each one to an IP
     * and port. Both service types print without pairing or secrets —
     * IPP (`_ipp._tcp`) and JetDirect (`_pdl-datastream._tcp`).
     */
    @Command
    fun discoverNetworkPrinters(invoke: Invoke) {
        val timeoutSec =
            invoke.parseArgs(DiscoverNetworkArgs::class.java).timeoutSec ?: 8
        val timeoutMs = timeoutSec.coerceIn(2, 30) * 1000L
        ioPool.execute {
            val found = MdnsDiscovery(activity).discoverOnce(timeoutMs)
            answer(invoke) {
                val result = org.json.JSONArray()
                val seen = HashSet<String>()
                for (printer in found) {
                    if (!seen.add("${printer.host}:${printer.port}")) continue
                    val obj = org.json.JSONObject()
                    obj.put("name", printer.name)
                    obj.put("host", printer.host)
                    obj.put("port", printer.port)
                    obj.put("kind", printer.kind)
                    printer.resourcePath?.let { obj.put("resourcePath", it) }
                    result.put(obj)
                }
                invoke.resolve(JSObject().put("printers", result))
            }
        }
    }

    // ── USB printing ───────────────────────────────────────────────

    private fun usbManager(): UsbManager =
        activity.getSystemService(Context.USB_SERVICE) as UsbManager

    private fun findUsbDevice(deviceName: String): UsbDevice? =
        usbManager().deviceList.values.firstOrNull { it.deviceName == deviceName }

    /**
     * Blocks until the user answers the system USB dialog (call off the
     * main thread). Serialized: two concurrent sends take turns rather
     * than stacking two dialogs for the same device.
     */
    private val usbPermissionLock = Object()
    private val usbPermissionAction = "com.printninja.android_print.USB_PERMISSION"

    @Suppress("DEPRECATION")
    private fun ensureUsbPermission(device: UsbDevice): Boolean {
        val manager = usbManager()
        if (manager.hasPermission(device)) return true
        synchronized(usbPermissionLock) {
            if (manager.hasPermission(device)) return true
            val latch = CountDownLatch(1)
            var granted = false
            val receiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        if (intent.action != usbPermissionAction) return
                        if (
                            intent.getBooleanExtra(
                                UsbManager.EXTRA_PERMISSION_GRANTED,
                                false,
                            )
                        ) {
                            val dev: UsbDevice? =
                                intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                            if (dev?.deviceName == device.deviceName) granted = true
                        }
                        latch.countDown()
                    }
                }
            val filter = IntentFilter(usbPermissionAction)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                activity.registerReceiver(receiver, filter)
            }
            try {
                val flags =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        PendingIntent.FLAG_MUTABLE
                    } else {
                        0
                    }
                val intent =
                    Intent(usbPermissionAction).setPackage(activity.packageName)
                val pending =
                    PendingIntent.getBroadcast(
                        activity,
                        device.deviceId,
                        intent,
                        flags,
                    )
                manager.requestPermission(device, pending)
                latch.await(60, TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            } finally {
                runCatching { activity.unregisterReceiver(receiver) }
            }
            return granted
        }
    }

    private fun openUsb(device: UsbDevice): UsbDeviceConnection? =
        usbManager().openDevice(device)

    /**
     * The bulk endpoints a write or a status query needs: the first
     * bulk-OUT endpoint (interface order, then endpoint order) and, when
     * one exists, a bulk-IN endpoint — preferably on the same interface
     * so it is claimed once. Printers that only sink bytes simply have
     * no IN endpoint, and queries report that instead of failing.
     */
    private data class BulkEndpoints(
        val outIface: UsbInterface,
        val out: UsbEndpoint,
        val inIface: UsbInterface?,
        val `in`: UsbEndpoint?,
    )

    private fun bulkEndpoints(device: UsbDevice): BulkEndpoints? {
        var firstOut: Pair<UsbInterface, UsbEndpoint>? = null
        var firstIn: Pair<UsbInterface, UsbEndpoint>? = null
        var shared: Triple<UsbInterface, UsbEndpoint, UsbEndpoint>? = null
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            var ifaceOut: UsbEndpoint? = null
            var ifaceIn: UsbEndpoint? = null
            for (e in 0 until iface.endpointCount) {
                val endpoint = iface.getEndpoint(e)
                if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (endpoint.direction == UsbConstants.USB_DIR_OUT && ifaceOut == null) {
                    ifaceOut = endpoint
                }
                if (endpoint.direction == UsbConstants.USB_DIR_IN && ifaceIn == null) {
                    ifaceIn = endpoint
                }
            }
            if (ifaceOut != null && firstOut == null) firstOut = iface to ifaceOut
            if (ifaceIn != null && firstIn == null) firstIn = iface to ifaceIn
            if (ifaceOut != null && ifaceIn != null && shared == null) {
                shared = Triple(iface, ifaceOut, ifaceIn)
            }
        }
        val out = firstOut ?: return null
        // One interface with both directions is claimed once; otherwise the
        // first OUT interface and the first IN interface are claimed each.
        val inPair: Pair<UsbInterface, UsbEndpoint>? =
            shared?.let { it.first to it.third } ?: firstIn
        return BulkEndpoints(out.first, out.second, inPair?.first, inPair?.second)
    }

    /**
     * Writes the whole buffer to the device's first bulk-OUT endpoint.
     * Returns bytes written, or a negative value when the transfer failed.
     * Offset-based `bulkTransfer` (API 18+, minSdk 24): no per-chunk copy.
     */
    private fun bulkWriteOut(
        device: UsbDevice,
        connection: UsbDeviceConnection,
        data: ByteArray,
    ): Int {
        val endpoints = bulkEndpoints(device) ?: return -1
        if (!connection.claimInterface(endpoints.outIface, true)) return -1
        try {
            var written = 0
            while (written < data.size) {
                val n =
                    connection.bulkTransfer(
                        endpoints.out,
                        data,
                        written,
                        minOf(16384, data.size - written),
                        ioTimeoutMs,
                    )
                if (n < 0) return n
                written += n
            }
            return written
        } finally {
            connection.releaseInterface(endpoints.outIface)
        }
    }

    /**
     * Asks the device a status question and reads the reply: writes
     * `request` to bulk-OUT, then collects bulk-IN until a short read
     * (the reply arrived whole) or `deadlineMs` passes. Returns the
     * reply bytes — possibly empty when the device stays silent — and
     * throws when the transfer itself fails.
     */
    private fun bulkQuery(
        device: UsbDevice,
        connection: UsbDeviceConnection,
        request: ByteArray,
        deadlineMs: Long,
    ): ByteArray {
        val endpoints = bulkEndpoints(device)
            ?: throw IllegalStateException("USB device has no bulk endpoints")
        val inIface = endpoints.inIface
            ?: throw IllegalStateException("USB device has no bulk-IN endpoint to answer on")
        val inEp = endpoints.`in`
            ?: throw IllegalStateException("USB device has no bulk-IN endpoint to answer on")
        if (!connection.claimInterface(endpoints.outIface, true)) {
            throw IllegalStateException("could not claim the USB interface")
        }
        // A second interface is only claimed when it is a different one;
        // the shared case releases once below.
        val secondIface =
            if (inIface.id != endpoints.outIface.id) inIface else null
        if (secondIface != null && !connection.claimInterface(secondIface, true)) {
            connection.releaseInterface(endpoints.outIface)
            throw IllegalStateException("could not claim the USB interface")
        }
        try {
            try {
                var written = 0
                while (written < request.size) {
                    val n =
                        connection.bulkTransfer(
                            endpoints.out,
                            request,
                            written,
                            request.size - written,
                            ioTimeoutMs,
                        )
                    if (n < 0) throw IllegalStateException("USB status query was not accepted")
                    written += n
                }
                val reply = java.io.ByteArrayOutputStream()
                val buf = ByteArray(1024)
                val deadline = android.os.SystemClock.elapsedRealtime() + deadlineMs
                while (android.os.SystemClock.elapsedRealtime() < deadline) {
                    val left = deadline - android.os.SystemClock.elapsedRealtime()
                    val n =
                        connection.bulkTransfer(
                            inEp,
                            buf,
                            buf.size,
                            left.coerceAtMost(2000).toInt(),
                        )
                    if (n > 0) {
                        reply.write(buf, 0, n)
                        // A short read means the reply arrived whole;
                        // a full buffer may hide a second packet.
                        if (n < buf.size) break
                    } else if (reply.size() > 0) {
                        // The reply stopped mid-deadline: take what arrived.
                        break
                    }
                }
                return reply.toByteArray()
            } finally {
                secondIface?.let { connection.releaseInterface(it) }
            }
        } finally {
            connection.releaseInterface(endpoints.outIface)
        }
    }

    /** Open and close: proves the device is there without writing anything. */
    @Command
    fun probeUsb(invoke: Invoke) {
        val deviceName =
            invoke.parseArgs(UsbProbeArgs::class.java).deviceName
                ?: return invoke.reject("deviceName is required")
        ioPool.execute {
            val settle: (String?) -> Unit = { error ->
                answer(invoke) {
                    if (error == null) invoke.resolve(JSObject().put("opened", true))
                    else invoke.reject(error)
                }
            }
            val device = findUsbDevice(deviceName)
            if (device == null) {
                settle("USB device not found: $deviceName — check it is plugged in")
                return@execute
            }
            if (!ensureUsbPermission(device)) {
                settle(
                    "USB permission was not granted for $deviceName — allow access and try again",
                )
                return@execute
            }
            val connection = openUsb(device)
            if (connection == null) {
                settle("Could not open USB device $deviceName")
                return@execute
            }
            connection.close()
            settle(null)
        }
    }

    @Command
    fun writeUsb(invoke: Invoke) {
        val args = invoke.parseArgs(UsbWriteArgs::class.java)
        val deviceName = args.deviceName ?: return invoke.reject("deviceName is required")
        val encoded = args.dataBase64 ?: return invoke.reject("dataBase64 is required")
        ioPool.execute {
            val settle: (Int?, String?) -> Unit = { written, error ->
                answer(invoke) {
                    if (written != null) {
                        invoke.resolve(JSObject().put("bytesWritten", written))
                    } else {
                        invoke.reject(error ?: "USB write failed")
                    }
                }
            }
            val data =
                try {
                    Base64.decode(encoded, Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    settle(null, "request is not valid base64: ${e.message}")
                    return@execute
                }
            val device = findUsbDevice(deviceName)
            if (device == null) {
                settle(null, "USB device not found: $deviceName — check it is plugged in")
                return@execute
            }
            if (!ensureUsbPermission(device)) {
                settle(
                    null,
                    "USB permission was not granted for $deviceName — allow access and try again",
                )
                return@execute
            }
            val connection = openUsb(device)
            if (connection == null) {
                settle(null, "Could not open USB device $deviceName")
                return@execute
            }
            try {
                val written = bulkWriteOut(device, connection, data)
                if (written < 0) settle(null, "USB write to $deviceName failed")
                else settle(written, null)
            } catch (e: Exception) {
                settle(null, "USB write to $deviceName failed: ${e.message}")
            } finally {
                connection.close()
            }
        }
    }

    /**
     * Asks the device a status question (ESC/POS `DLE EOT`, Zebra `~HS`,
     * …) and returns the reply as base64. An empty reply means the device
     * stayed silent — the caller decides whether that is fine (a printer
     * that never answered anything may simply not speak the dialect).
     */
    @Command
    fun queryUsb(invoke: Invoke) {
        val args = invoke.parseArgs(UsbQueryArgs::class.java)
        val deviceName = args.deviceName ?: return invoke.reject("deviceName is required")
        val encoded = args.requestBase64 ?: return invoke.reject("requestBase64 is required")
        val replyTimeoutMs = (args.replyTimeoutMs ?: 3000).toLong().coerceIn(500, 10_000)
        ioPool.execute {
            val request =
                try {
                    Base64.decode(encoded, Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    answer(invoke) {
                        invoke.reject("request is not valid base64: ${e.message}")
                    }
                    return@execute
                }
            val device = findUsbDevice(deviceName)
            if (device == null) {
                answer(invoke) {
                    invoke.reject("USB device not found: $deviceName — check it is plugged in")
                }
                return@execute
            }
            if (!ensureUsbPermission(device)) {
                answer(invoke) {
                    invoke.reject(
                        "USB permission was not granted for $deviceName — allow access and try again",
                    )
                }
                return@execute
            }
            val connection = openUsb(device)
            if (connection == null) {
                answer(invoke) { invoke.reject("Could not open USB device $deviceName") }
                return@execute
            }
            try {
                val reply = bulkQuery(device, connection, request, replyTimeoutMs)
                answer(invoke) {
                    invoke.resolve(
                        JSObject().put(
                            "replyBase64",
                            Base64.encodeToString(reply, Base64.NO_WRAP),
                        ),
                    )
                }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("USB status query to $deviceName failed: ${e.message}")
                }
            } finally {
                connection.close()
            }
        }
    }

    /**
     * Opens the device and holds the connection under a minted handle for
     * the query+write of one print — one connect instead of one per
     * operation. Reaps idle-orphaned handles first. The caller must
     * [closeUsbConnection] on every path after this resolves.
     */
    @Command
    fun openUsbConnection(invoke: Invoke) {
        val deviceName =
            invoke.parseArgs(UsbOpenArgs::class.java).deviceName
                ?: return invoke.reject("deviceName is required")
        ioPool.execute {
            val settle: (String?, String?) -> Unit = { handle, error ->
                answer(invoke) {
                    if (handle != null) invoke.resolve(JSObject().put("handle", handle))
                    else invoke.reject(error ?: "USB open failed")
                }
            }
            val device = findUsbDevice(deviceName)
            if (device == null) {
                settle(null, "USB device not found: $deviceName — check it is plugged in")
                return@execute
            }
            if (!ensureUsbPermission(device)) {
                settle(
                    null,
                    "USB permission was not granted for $deviceName — allow access and try again",
                )
                return@execute
            }
            val connection = openUsb(device)
            if (connection == null) {
                settle(null, "Could not open USB device $deviceName")
                return@execute
            }
            for (orphan in usbConnections.sweepIdle()) {
                runCatching { orphan.connection.close() }
            }
            val handle = UUID.randomUUID().toString()
            val previous = usbConnections.put(handle, UsbSession(device, connection))
            if (previous != null) runCatching { previous.connection.close() }
            settle(handle, null)
        }
    }

    /** Status query on a held USB connection. The connection stays open. */
    @Command
    fun queryUsbOn(invoke: Invoke) {
        val args = invoke.parseArgs(UsbQueryOnArgs::class.java)
        val handle = args.handle ?: return invoke.reject("handle is required")
        val encoded = args.requestBase64 ?: return invoke.reject("requestBase64 is required")
        val replyTimeoutMs = (args.replyTimeoutMs ?: 3000).toLong().coerceIn(500, 10_000)
        ioPool.execute {
            val request =
                try {
                    Base64.decode(encoded, Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    answer(invoke) {
                        invoke.reject("request is not valid base64: ${e.message}")
                    }
                    return@execute
                }
            val session = usbConnections.get(handle)
            if (session == null) {
                answer(invoke) {
                    invoke.reject("unknown or expired USB connection — open a new one")
                }
                return@execute
            }
            try {
                val reply = bulkQuery(session.device, session.connection, request, replyTimeoutMs)
                answer(invoke) {
                    invoke.resolve(
                        JSObject().put(
                            "replyBase64",
                            Base64.encodeToString(reply, Base64.NO_WRAP),
                        ),
                    )
                }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("USB status query failed: ${e.message}")
                }
            }
        }
    }

    /** Write on a held USB connection. The connection stays open. */
    @Command
    fun writeUsbOn(invoke: Invoke) {
        val args = invoke.parseArgs(UsbWriteOnArgs::class.java)
        val handle = args.handle ?: return invoke.reject("handle is required")
        ioPool.execute {
            val settle: (Int?, String?) -> Unit = { written, error ->
                answer(invoke) {
                    if (written != null) {
                        invoke.resolve(JSObject().put("bytesWritten", written))
                    } else {
                        invoke.reject(error ?: "USB write failed")
                    }
                }
            }
            // File handoff for large payloads (A4): the Rust side stages
            // the bytes and deletes after the call; this deletes after
            // reading, so either side's cleanup suffices.
            val data: ByteArray =
                if (!args.dataPath.isNullOrEmpty()) {
                    try {
                        readHandoffFile(args.dataPath!!)
                    } catch (e: Exception) {
                        settle(null, "could not read handed-off payload: ${e.message}")
                        return@execute
                    }
                } else if (args.dataBase64 != null) {
                    try {
                        Base64.decode(args.dataBase64, Base64.DEFAULT)
                    } catch (e: IllegalArgumentException) {
                        settle(null, "request is not valid base64: ${e.message}")
                        return@execute
                    }
                } else {
                    answer(invoke) { invoke.reject("dataBase64 or dataPath is required") }
                    return@execute
                }
            val session = usbConnections.get(handle)
            if (session == null) {
                settle(null, "unknown or expired USB connection — open a new one")
                return@execute
            }
            try {
                val written = bulkWriteOut(session.device, session.connection, data)
                if (written < 0) settle(null, "USB write failed")
                else settle(written, null)
            } catch (e: Exception) {
                settle(null, "USB write failed: ${e.message}")
            }
        }
    }

    /**
     * Releases a held USB connection. Idempotent: an unknown handle
     * still resolves, so double-close races are harmless.
     */
    @Command
    fun closeUsbConnection(invoke: Invoke) {
        val handle =
            invoke.parseArgs(UsbCloseArgs::class.java).handle
                ?: return invoke.reject("handle is required")
        ioPool.execute {
            val session = usbConnections.remove(handle)
            if (session != null) runCatching { session.connection.close() }
            answer(invoke) { invoke.resolve(JSObject().put("closed", session != null)) }
        }
    }

    // ── Bluetooth printing ─────────────────────────────────────────

    /** Serial-port profile: what receipt/label printers speak over RFCOMM. */
    private val sppUuid: UUID =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    private fun bluetoothAdapter(): BluetoothAdapter? {
        val manager =
            activity.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return manager?.adapter
    }

    /**
     * Android 12+ needs BLUETOOTH_CONNECT at runtime for bonded-device
     * reads and sockets. The plugin cannot receive the grant callback, so
     * after asking it polls for the answer instead of failing at once:
     * the user grants "Nearby devices" in the system dialog and the
     * waiting operation carries on. Call off the main thread — it blocks
     * up to a minute while the dialog is open.
     */
    private fun awaitBluetoothConnect(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        if (grantedBluetoothConnect()) return true
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT),
            9751,
        )
        // Poll, don't fail: denial then reads as a timeout below, with a
        // message that names the fix instead of "try again".
        val deadline = android.os.SystemClock.elapsedRealtime() + 60_000
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            try {
                Thread.sleep(500)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return false
            }
            if (grantedBluetoothConnect()) return true
        }
        return false
    }

    private fun grantedBluetoothConnect(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return ContextCompat.checkSelfPermission(
            activity,
            Manifest.permission.BLUETOOTH_CONNECT,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun bluetoothDenied(): String =
        "Bluetooth permission was not granted — allow “Nearby devices” for PrintNinja in Settings and try again"

    /**
     * Reads a status reply off an open RFCOMM socket: until a short read
     * (the reply arrived whole) or `replyTimeoutMs` passes, with a
     * 250 ms-silence break. Shared by the one-shot and held-connection
     * queries so both agree on what "silent" means.
     */
    private fun readBluetoothReply(input: InputStream, replyTimeoutMs: Long): ByteArray {
        val reply = java.io.ByteArrayOutputStream()
        val buf = ByteArray(1024)
        val deadline = android.os.SystemClock.elapsedRealtime() + replyTimeoutMs
        var lastDataAt = -1L
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            val available =
                try {
                    input.available()
                } catch (_: Exception) {
                    0
                }
            if (available > 0) {
                val n = input.read(buf, 0, minOf(available, buf.size))
                if (n > 0) {
                    reply.write(buf, 0, n)
                    lastDataAt = android.os.SystemClock.elapsedRealtime()
                    // A short read means the reply arrived whole.
                    if (n < minOf(available, buf.size)) break
                }
            } else {
                if (reply.size() > 0 &&
                    android.os.SystemClock.elapsedRealtime() - lastDataAt > 250
                ) {
                    break
                }
                // Tight poll: the silence break above is only re-checked
                // here, so this bounds its overshoot at ~10 ms per query.
                // A Future-based blocking read was considered and rejected:
                // RFCOMM reads are not interruptible, so a timed-out get()
                // would leak the reader thread until the socket closes —
                // all for ≤50 ms per query.
                try {
                    Thread.sleep(10)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
        }
        return reply.toByteArray()
    }

    @Command
    fun listBluetoothDevices(invoke: Invoke) {
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            try {
                val adapter =
                    bluetoothAdapter()
                        ?: run {
                            answer(invoke) {
                                invoke.reject("this device has no Bluetooth adapter")
                            }
                            return@execute
                        }
                val result = org.json.JSONArray()
                for (device in adapter.bondedDevices.orEmpty()) {
                    val obj = org.json.JSONObject()
                    obj.put("id", device.address)
                    obj.put("name", device.name ?: device.address)
                    result.put(obj)
                }
                answer(invoke) { invoke.resolve(JSObject().put("devices", result)) }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("could not list Bluetooth devices: ${e.message}")
                }
            }
        }
    }

    private fun openBluetoothSocket(address: String): BluetoothSocket {
        val adapter =
            bluetoothAdapter()
                ?: throw IllegalStateException("this device has no Bluetooth adapter")
        val device: BluetoothDevice =
            try {
                adapter.getRemoteDevice(address)
            } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("not a Bluetooth address: $address")
            }
        runCatching { adapter.cancelDiscovery() }
        val socket = device.createRfcommSocketToServiceRecord(sppUuid)
        try {
            socket.connect()
        } catch (e: Exception) {
            runCatching { socket.close() }
            throw e
        }
        return socket
    }

    /** Connect and close: proves the printer answers without writing anything. */
    @Command
    fun probeBluetooth(invoke: Invoke) {
        val address =
            invoke.parseArgs(BluetoothProbeArgs::class.java).address
                ?: return invoke.reject("address is required")
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            try {
                openBluetoothSocket(address).close()
                answer(invoke) { invoke.resolve(JSObject().put("reachable", true)) }
            } catch (e: IllegalArgumentException) {
                answer(invoke) { invoke.reject(e.message ?: "bad Bluetooth address") }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("Could not reach Bluetooth printer $address: ${e.message}")
                }
            }
        }
    }

    @Command
    fun writeBluetooth(invoke: Invoke) {
        val args = invoke.parseArgs(BluetoothWriteArgs::class.java)
        val address = args.address ?: return invoke.reject("address is required")
        val encoded = args.dataBase64 ?: return invoke.reject("dataBase64 is required")
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            val data =
                try {
                    Base64.decode(encoded, Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    answer(invoke) {
                        invoke.reject("request is not valid base64: ${e.message}")
                    }
                    return@execute
                }
            try {
                val socket = openBluetoothSocket(address)
                try {
                    val out = socket.outputStream
                    out.write(data)
                    out.flush()
                } finally {
                    runCatching { socket.close() }
                }
                answer(invoke) {
                    invoke.resolve(JSObject().put("bytesWritten", data.size))
                }
            } catch (e: IllegalArgumentException) {
                answer(invoke) { invoke.reject(e.message ?: "bad Bluetooth address") }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject(
                        "Bluetooth write to $address failed: ${e.message}",
                    )
                }
            }
        }
    }

    /**
     * Asks the printer a status question over RFCOMM and returns the reply
     * as base64. An empty reply means the printer stayed silent; the
     * caller decides whether that is fine. Bounded by `replyTimeoutMs` —
     * a printer that never answers must not hold the job.
     */
    @Command
    fun queryBluetooth(invoke: Invoke) {
        val args = invoke.parseArgs(BluetoothQueryArgs::class.java)
        val address = args.address ?: return invoke.reject("address is required")
        val encoded = args.requestBase64 ?: return invoke.reject("requestBase64 is required")
        val replyTimeoutMs = (args.replyTimeoutMs ?: 3000).toLong().coerceIn(500, 10_000)
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            val request =
                try {
                    Base64.decode(encoded, Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    answer(invoke) {
                        invoke.reject("request is not valid base64: ${e.message}")
                    }
                    return@execute
                }
            try {
                val socket = openBluetoothSocket(address)
                try {
                    val out = socket.outputStream
                    out.write(request)
                    out.flush()
                    val reply = readBluetoothReply(socket.inputStream, replyTimeoutMs)
                    answer(invoke) {
                        invoke.resolve(
                            JSObject().put(
                                "replyBase64",
                                Base64.encodeToString(reply, Base64.NO_WRAP),
                            ),
                        )
                    }
                } finally {
                    runCatching { socket.close() }
                }
            } catch (e: IllegalArgumentException) {
                answer(invoke) { invoke.reject(e.message ?: "bad Bluetooth address") }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("Bluetooth status query to $address failed: ${e.message}")
                }
            }
        }
    }

    /**
     * Opens an RFCOMM socket and holds it under a minted handle for the
     * query+write of one print. Reaps idle-orphaned sockets first. The
     * caller must [closeBluetoothConnection] on every path after this
     * resolves.
     */
    @Command
    fun openBluetoothConnection(invoke: Invoke) {
        val address =
            invoke.parseArgs(BluetoothOpenArgs::class.java).address
                ?: return invoke.reject("address is required")
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            try {
                for (orphan in bluetoothSockets.sweepIdle()) {
                    runCatching { orphan.close() }
                }
                val socket = openBluetoothSocket(address)
                val handle = UUID.randomUUID().toString()
                val previous = bluetoothSockets.put(handle, socket)
                if (previous != null) runCatching { previous.close() }
                answer(invoke) { invoke.resolve(JSObject().put("handle", handle)) }
            } catch (e: IllegalArgumentException) {
                answer(invoke) { invoke.reject(e.message ?: "bad Bluetooth address") }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("Could not open Bluetooth printer $address: ${e.message}")
                }
            }
        }
    }

    /** Status query on a held RFCOMM socket. The socket stays open. */
    @Command
    fun queryBluetoothOn(invoke: Invoke) {
        val args = invoke.parseArgs(BluetoothQueryOnArgs::class.java)
        val handle = args.handle ?: return invoke.reject("handle is required")
        val encoded = args.requestBase64 ?: return invoke.reject("requestBase64 is required")
        val replyTimeoutMs = (args.replyTimeoutMs ?: 3000).toLong().coerceIn(500, 10_000)
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            val request =
                try {
                    Base64.decode(encoded, Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    answer(invoke) {
                        invoke.reject("request is not valid base64: ${e.message}")
                    }
                    return@execute
                }
            val socket = bluetoothSockets.get(handle)
            if (socket == null) {
                answer(invoke) {
                    invoke.reject("unknown or expired Bluetooth connection — open a new one")
                }
                return@execute
            }
            try {
                socket.outputStream.write(request)
                socket.outputStream.flush()
                val reply = readBluetoothReply(socket.inputStream, replyTimeoutMs)
                answer(invoke) {
                    invoke.resolve(
                        JSObject().put(
                            "replyBase64",
                            Base64.encodeToString(reply, Base64.NO_WRAP),
                        ),
                    )
                }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("Bluetooth status query failed: ${e.message}")
                }
            }
        }
    }

    /** Write on a held RFCOMM socket. The socket stays open. */
    @Command
    fun writeBluetoothOn(invoke: Invoke) {
        val args = invoke.parseArgs(BluetoothWriteOnArgs::class.java)
        val handle = args.handle ?: return invoke.reject("handle is required")
        ioPool.execute {
            if (!awaitBluetoothConnect()) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
                return@execute
            }
            // File handoff for large payloads (A4): see writeUsbOn.
            val data: ByteArray =
                if (!args.dataPath.isNullOrEmpty()) {
                    try {
                        readHandoffFile(args.dataPath!!)
                    } catch (e: Exception) {
                        answer(invoke) {
                            invoke.reject("could not read handed-off payload: ${e.message}")
                        }
                        return@execute
                    }
                } else if (args.dataBase64 != null) {
                    try {
                        Base64.decode(args.dataBase64, Base64.DEFAULT)
                    } catch (e: IllegalArgumentException) {
                        answer(invoke) {
                            invoke.reject("request is not valid base64: ${e.message}")
                        }
                        return@execute
                    }
                } else {
                    answer(invoke) { invoke.reject("dataBase64 or dataPath is required") }
                    return@execute
                }
            val socket = bluetoothSockets.get(handle)
            if (socket == null) {
                answer(invoke) {
                    invoke.reject("unknown or expired Bluetooth connection — open a new one")
                }
                return@execute
            }
            try {
                val out = socket.outputStream
                out.write(data)
                out.flush()
                answer(invoke) {
                    invoke.resolve(JSObject().put("bytesWritten", data.size))
                }
            } catch (e: SecurityException) {
                answer(invoke) { invoke.reject(bluetoothDenied()) }
            } catch (e: Exception) {
                answer(invoke) {
                    invoke.reject("Bluetooth write failed: ${e.message}")
                }
            }
        }
    }

    /**
     * Releases a held RFCOMM socket. Idempotent: an unknown handle still
     * resolves, so double-close races are harmless.
     */
    @Command
    fun closeBluetoothConnection(invoke: Invoke) {
        val handle =
            invoke.parseArgs(BluetoothCloseArgs::class.java).handle
                ?: return invoke.reject("handle is required")
        ioPool.execute {
            val socket = bluetoothSockets.remove(handle)
            if (socket != null) runCatching { socket.close() }
            answer(invoke) { invoke.resolve(JSObject().put("closed", socket != null)) }
        }
    }

    // ── Background service ─────────────────────────────────────────

    @Command
    fun startBackgroundService(invoke: Invoke) {
        PrintNinjaService.start(activity)
        invoke.resolve(JSObject().put("running", true))
    }

    @Command
    fun stopBackgroundService(invoke: Invoke) {
        PrintNinjaService.stop(activity)
        invoke.resolve()
    }

    @Command
    fun isBackgroundServiceRunning(invoke: Invoke) {
        invoke.resolve(JSObject().put("running", PrintNinjaService.isRunning))
    }

    /**
     * Mirrors the local API server's state into the foreground service:
     * the pinned notification then shows `host:port` while the server
     * runs and the print-queue wording after it stops. Rust calls this
     * from `launch_server` / `stop_api_server`.
     */
    @Command
    fun setApiServerState(invoke: Invoke) {
        val args = invoke.parseArgs(ApiServerStateArgs::class.java)
        PrintNinjaService.setApiServerState(activity, args.running, args.address)
        invoke.resolve()
        // Ask when the server starts, so the prompt has context. Off the
        // calling thread: it waits for the user's answer.
        if (args.running) ioPool.execute { ensureNotificationPermission() }
    }

    private fun grantedNotifications(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED

    /** Asked at most once per app process: a declined prompt is not repeated on every start. */
    @Volatile
    private var askedNotifications = false

    /**
     * Android 13+ hides a foreground service's notification until the
     * user allows notifications, so the pinned API address would never
     * show. Ask once, wait for the answer (the plugin cannot receive the
     * grant callback, so it polls like [awaitBluetoothConnect]), then
     * re-post the notification so it appears without restarting the server.
     */
    private fun ensureNotificationPermission() {
        if (!PrintNinjaService.needsNotificationPermission(
                Build.VERSION.SDK_INT,
                grantedNotifications(),
            ) || askedNotifications
        ) {
            return
        }
        askedNotifications = true
        activity.runOnUiThread {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                9752,
            )
        }
        val deadline = android.os.SystemClock.elapsedRealtime() + 60_000
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            try {
                Thread.sleep(500)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
            if (grantedNotifications()) {
                PrintNinjaService.repostNotification(activity)
                return
            }
        }
    }

    @Command
    fun requestBatteryExemption(invoke: Invoke) {
        val granted = BatteryExemption.request(activity)
        invoke.resolve(JSObject().put("granted", granted))
    }

    @Command
    fun isBatteryExemptionGranted(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", BatteryExemption.isGranted(activity)))
    }

    /**
     * Starts the foreground print service when the plugin loads at app
     * startup, so the queue survives before any command runs, and asks
     * for the notification permission so its notification is visible.
     * The app also starts it from the webview on launch; starting twice
     * is a no-op by Android contract.
     */
    override fun load(webView: WebView) {
        super.load(webView)
        PrintNinjaService.attachActivity(activity)
        try {
            PrintNinjaService.start(activity)
        } catch (e: Exception) {
            Log.w(tag, "could not start background service: ${e.message}")
        }
        // Android 13+ hides the service's notification until the user
        // allows notifications. Ask at launch, not only when the API
        // server starts, so the background notification is there by
        // default. Off the main thread: it waits for the user's answer.
        ioPool.execute { ensureNotificationPermission() }
    }
}
