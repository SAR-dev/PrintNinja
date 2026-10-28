package com.printninja.android_print

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

class MdnsDiscovery(private val context: Context) {
    private val TAG = "MdnsDiscovery"
    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val listeners = mutableMapOf<String, NsdManager.DiscoveryListener>()

    fun startDiscovery(serviceType: String = "_ipp._tcp.", onFound: (String, String, Int) -> Unit) {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                Log.d(TAG, "Discovery started: $serviceType")
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "Service found: ${serviceInfo.serviceName}")
                resolveService(serviceInfo, onFound)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "Service lost: ${serviceInfo.serviceName}")
            }

            override fun onDiscoveryStopped(serviceType: String) {
                Log.d(TAG, "Discovery stopped: $serviceType")
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Start discovery failed: $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Stop discovery failed: $errorCode")
            }
        }

        listeners[serviceType] = listener
        nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    fun stopDiscovery(serviceType: String = "_ipp._tcp.") {
        listeners[serviceType]?.let { nsdManager.stopServiceDiscovery(it) }
        listeners.remove(serviceType)
    }

    /** One resolved printer on the LAN. */
    data class FoundPrinter(
        val name: String,
        val host: String,
        val port: Int,
        val kind: String,
        /** `rp` from the TXT record, no leading slash; null when absent. */
        val resourcePath: String? = null,
    )

    /** A service found by discovery, waiting its turn to be resolved. */
    private data class Pending(val info: NsdServiceInfo, val kind: String)

    /**
     * Single-shot discovery across the printer service types, blocking
     * until `timeoutMs` elapses (call off the main thread). Resolutions
     * land on the main thread while this waits, so the callbacks are
     * never starved. Returns each reachable printer once.
     */
    fun discoverOnce(timeoutMs: Long): List<FoundPrinter> {
        val found = java.util.concurrent.ConcurrentHashMap<String, FoundPrinter>()
        val types = listOf("_ipp._tcp." to "ipp", "_pdl-datastream._tcp." to "raw_tcp")
        val active = mutableListOf<Pair<String, NsdManager.DiscoveryListener>>()
        // NsdManager before Android 14 allows one resolve at a time, so
        // found services wait here and resolve one by one, across both
        // service types (the limit is per app, not per type).
        val queue =
            ResolveQueue<Pending> { pending, done ->
                nsdManager.resolveService(
                    pending.info,
                    object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                            Log.d(TAG, "Resolve failed for ${pending.info.serviceName}: $errorCode")
                            done()
                        }

                        override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                            try {
                                val rawHost = serviceInfo.host?.hostAddress
                                if (rawHost != null) {
                                    val host = PrinterAddress.formatHost(rawHost)
                                    found.putIfAbsent(
                                        "$host:${serviceInfo.port}",
                                        FoundPrinter(
                                            serviceInfo.serviceName,
                                            host,
                                            serviceInfo.port,
                                            pending.kind,
                                            PrinterAddress.resourcePath(
                                                serviceInfo.attributes?.get("rp"),
                                            ),
                                        ),
                                    )
                                }
                            } finally {
                                done()
                            }
                        }
                    },
                )
            }
        for ((serviceType, kind) in types) {
            val listener =
                object : NsdManager.DiscoveryListener {
                    override fun onDiscoveryStarted(serviceType: String) {}

                    override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                        queue.add(Pending(serviceInfo, kind))
                    }

                    override fun onServiceLost(serviceInfo: NsdServiceInfo) {}

                    override fun onDiscoveryStopped(serviceType: String) {}

                    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                        Log.e(TAG, "Start discovery failed: $serviceType $errorCode")
                    }

                    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
                }
            active += serviceType to listener
            try {
                nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
            } catch (e: Exception) {
                Log.e(TAG, "discoverServices failed: ${e.message}")
            }
        }
        try {
            Thread.sleep(timeoutMs)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        queue.close()
        for ((_, listener) in active) {
            runCatching { nsdManager.stopServiceDiscovery(listener) }
        }
        return found.values.sortedBy { it.name }.toList()
    }

    private fun resolveService(serviceInfo: NsdServiceInfo, onFound: (String, String, Int) -> Unit) {
        nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Resolve failed: $errorCode")
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val host = PrinterAddress.formatHost(serviceInfo.host?.hostAddress ?: return)
                val port = serviceInfo.port
                val name = serviceInfo.serviceName
                onFound(name, host, port)
            }
        })
    }
}
