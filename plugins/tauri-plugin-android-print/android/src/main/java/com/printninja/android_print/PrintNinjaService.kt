package com.printninja.android_print

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that keeps the print queue and the local API
 * server alive after the app is swiped away. Android kills background
 * work aggressively (Doze, app standby); a foreground service with a
 * persistent notification is the sanctioned way to stay alive, and the
 * user stops it explicitly from the notification itself.
 *
 * The pinned notification doubles as the API server's status display:
 * Rust calls [setApiServerState] when the server starts or stops (see
 * `src-tauri/src/commands/api.rs::launch_server`), and the text shows
 * the live address while it runs.
 *
 * Lifetime: started from MainActivity.onCreate (see
 * scripts/patch-android-service.mjs) and from the plugin's load(), so
 * the queue survives before any command runs. Stopped only from the
 * notification action or the plugin's stopBackgroundService command.
 */
class PrintNinjaService : Service() {

    override fun onCreate() {
        super.onCreate()
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithNotification()
        // If the system kills us (memory pressure), restart: the queue
        // rows persist in SQLite, so printing resumes where it stopped.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        ensureChannel(this)
        val notification = buildNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val CHANNEL_ID = "printninja-print-service"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.printninja.android_print.STOP_SERVICE"
        private const val REQUEST_OPEN = 1
        private const val REQUEST_STOP = 2

        @Volatile
        var isRunning: Boolean = false
            private set

        /** Whether the local API server is up, mirrored from Rust. */
        @Volatile
        var apiServerRunning: Boolean = false
            private set

        /** Bound `host:port` while [apiServerRunning], else null. */
        @Volatile
        var apiServerAddress: String? = null
            private set

        /** Idempotent: starting twice keeps one service. */
        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context.applicationContext, PrintNinjaService::class.java),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context.applicationContext, PrintNinjaService::class.java))
        }

        /**
         * Called from Rust when the local API server starts or stops.
         * Starting keeps the process resident (Android would otherwise
         * freeze or kill it) and rewrites the pinned notification with
         * the live address; stopping leaves the service up for the print
         * queue and drops the text back to the print-only wording.
         *
         * The statics are written first and read at every build, so a
         * notification rebuilt after either side changed in the meantime
         * always shows the current truth.
         */
        fun setApiServerState(context: Context, running: Boolean, address: String?) {
            apiServerRunning = running
            apiServerAddress = if (running) address else null
            if (running) {
                // Starts the service if needed; a repeated start intent
                // re-runs onStartCommand, which rewrites the notification.
                start(context)
            } else if (isRunning) {
                refreshNotification(context)
            }
        }

        /**
         * Title and body for the pinned notification: the live API
         * address while the server runs, the print-queue text otherwise.
         * Split out so the contract test can pin the wording without an
         * Android [Context].
         */
        fun notificationText(running: Boolean, address: String?): Pair<String, String> =
            if (running && address != null) {
                "PrintNinja is running" to "API server listening on $address"
            } else {
                "PrintNinja print service is running" to
                    "The print queue stays available in the background."
            }

        /**
         * Whether the runtime notification permission still has to be
         * asked for: Android 13 (API 33) introduced it, and without it the
         * foreground service runs but its notification stays hidden.
         * Pure so the contract test can pin it without a [Context].
         */
        fun needsNotificationPermission(sdkInt: Int, granted: Boolean): Boolean =
            sdkInt >= 33 && !granted

        /**
         * Re-posts the pinned notification once the user has granted the
         * notification permission. The service kept running while it was
         * denied, so only the notification needs to be shown again.
         */
        fun repostNotification(context: Context) = refreshNotification(context)

        /** Re-posts the pinned notification with the current API state. */
        private fun refreshNotification(context: Context) {
            if (!isRunning) return
            ensureChannel(context)
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            // Same id: re-posting rewrites the notification in place.
            manager.notify(NOTIFICATION_ID, buildNotification(context))
        }

        private fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        "Print queue",
                        NotificationManager.IMPORTANCE_LOW,
                    ).apply {
                        description = "Keeps the print queue running in the background."
                        setShowBadge(false)
                    },
                )
            }
        }

        private fun buildNotification(context: Context): Notification {
            val openApp = context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?.let {
                    PendingIntent.getActivity(
                        context, REQUEST_OPEN, it,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                }
            val stop = PendingIntent.getService(
                context, REQUEST_STOP,
                Intent(context, PrintNinjaService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val (title, text) = notificationText(apiServerRunning, apiServerAddress)
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(context.applicationInfo.icon)
                .setContentIntent(openApp)
                .addAction(0, "Stop", stop)
                .setOngoing(true)
                .setSilent(true)
                .build()
        }
    }
}
