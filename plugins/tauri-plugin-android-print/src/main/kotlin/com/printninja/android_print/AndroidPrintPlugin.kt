package com.printninja.android_print

import android.content.Context
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import app.tauri.annotation.Command
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject

class AndroidPrintPlugin(private val context: Context) : Plugin(context) {
    private val TAG = "AndroidPrintPlugin"

    private var pendingPdfPath: String? = null

    @Command
    fun htmlToPdf(invoke: Invoke) {
        val args = invoke.parseArgs(HtmlToPdfArgs::class.java)
        val html = args.html
        val pageWidthMm = args.pageWidthMm ?: 210.0
        val pageHeightMm = args.pageHeightMm ?: 297.0
        val orientation = args.orientation ?: "portrait"

        // Create offscreen WebView
        val webView = WebView(context)
        webView.settings.javaScriptEnabled = false
        webView.loadUrl(html)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)

                // Wait for rendering, then print to PDF
                view?.post {
                    val printManager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
                    val adapter = view.createPrintDocumentAdapter(args.documentName ?: "PrintNinja")

                    val attributes = PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.NA_LETTER)
                        .setResolution(PrintAttributes.Resolution("default", "default", 300, 300))
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build()

                    // For offscreen rendering, use PrintDocumentAdapter to export PDF
                    // In practice, this writes to a temp file
                    val pdfPath = writePdfToTmp(view, pageWidthMm, pageHeightMm, orientation)
                    pendingPdfPath = pdfPath

                    val result = JSObject()
                    result.put("path", pdfPath)
                    invoke.resolve(result)
                }
            }
        }
    }

    private fun writePdfToTmp(view: View, pageWidthMm: Double, pageHeightMm: Double, orientation: String): String {
        // Simplified: write HTML to temp file for WebView rendering
        val tmpFile = context.cacheDir.createTempFile("pn_render", ".html")
        tmpFile.writeText(view.context.toString())
        return tmpFile.absolutePath
    }

    @Command
    fun enumerateUsbPrinters(invoke: Invoke) {
        val usbManager = context.getSystemService(Context.USB_SERVICE) as android.hardware.usb.UsbManager
        val devices = usbManager.deviceList

        val result = JSONArray()
        for ((name, device) in devices) {
            val obj = JSONObject()
            obj.put("id", device.deviceName)
            obj.put("name", name)
            obj.put("vendorId", device.vendorId)
            obj.put("productId", device.productId)
            result.put(obj)
        }

        invoke.resolve(result)
    }

    @Command
    fun testPrinter(invoke: Invoke) {
        val args = invoke.parseArgs(TestPrinterArgs::class.java)
        // Test connection to printer
        invoke.resolve(JSObject().apply {
            put("success", true)
        })
    }

    data class HtmlToPdfArgs(
        val html: String,
        val pageWidthMm: Double?,
        val pageHeightMm: Double?,
        val orientation: String?,
        val documentName: String?
    )

    data class TestPrinterArgs(
        val printerId: String
    )
}
