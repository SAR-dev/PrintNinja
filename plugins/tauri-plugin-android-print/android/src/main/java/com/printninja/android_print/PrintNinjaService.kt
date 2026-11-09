package com.printninja.android_print

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

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
 * The notification has two actions: **Open** brings the app to the
 * front and **Close** shuts everything down (service, activity and the
 * process, which takes the queue worker and API server with it). Tapping
 * the notification body also opens the app.
 *
 * Lifetime: started by default from the plugin's load() at app launch
 * (and again from the webview), so the queue survives before any command
 * runs. Stopped only from the notification's Close action or the
 * plugin's stopBackgroundService command.
 *
 * Process death: the queue worker (and the API server) live on the
 * Rust side, which only exists while the Tauri app is booted. If
 * Android kills the process and restarts this service, the new process
 * has the service but no app — [queueWorkerRunning] stays false and the
 * notification says the queue is paused instead of claiming it is
 * live. Reopening the app boots the worker and [setQueueWorkerState]
 * puts the live wording back.
 */
class PrintNinjaService : Service() {

    override fun onCreate() {
        super.onCreate()
        // The service can be restarted in a fresh process with no
        // Activity (and so no plugin load()): record crashes there too.
        CrashReporter.install(applicationContext)
        isRunning = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_CLOSE -> {
                closeApp()
                return START_NOT_STICKY
            }
        }
        startForegroundWithNotification()
        // If the system kills us (memory pressure), restart. Note the
        // restart is service-only: the Rust queue worker lives with the
        // Tauri app, which a service restart does not bring back, so
        // the queue stays paused (rows persist in SQLite) until the app
        // is reopened. The notification says that honestly.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        isRunning = false
        super.onDestroy()
    }

    /**
     * The notification's Close action: drop the notification, stop the
     * service, remove the activity from recents, then end the process.
     * The queue worker and API server live in this process (Tauri's Rust
     * side), so ending it is what actually "closes" PrintNinja. Queued
     * jobs persist in SQLite and resume on the next launch.
     */
    private fun closeApp() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        val activity = activityRef?.get()
        activity?.runOnUiThread {
            if (!activity.isFinishing) activity.finishAndRemoveTask()
        }
        // Short delay so the activity teardown and notification removal
        // go out before the process disappears.
        Handler(Looper.getMainLooper()).postDelayed(
            { Process.killProcess(Process.myPid()) },
            CLOSE_DELAY_MS,
        )
    }

    private fun startForegroundWithNotification() {
        try {
            ensureChannel(this)
            val notification = buildNotification(this)
            when {
                // Android 14+: specialUse has no timeout. dataSync is cut
                // off after ~6h on Android 15 and crashes the app if the
                // service does not stop in time.
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                    )
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
                    )
                else -> {
                    @Suppress("DEPRECATION")
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
        } catch (e: Exception) {
            // Background-start restrictions, a missing permission or a
            // revoked notification must degrade to "no background
            // service", never to a crash. The queue resumes next launch.
            android.util.Log.w("PrintNinjaService", "could not enter foreground: ${e.message}")
            isRunning = false
            stopSelf()
        }
    }

    /**
     * Safety net: if the system ever times this service out (Android 15+
     * dataSync/mediaProcessing), stop it ourselves. Not stopping within a
     * few seconds is what makes Android crash the whole app.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    companion object {
        const val CHANNEL_ID = "printninja-print-service"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.printninja.android_print.STOP_SERVICE"
        const val ACTION_CLOSE = "com.printninja.android_print.CLOSE_APP"
        private const val REQUEST_OPEN = 1
        private const val REQUEST_OPEN_ACTION = 3
        private const val REQUEST_CLOSE = 4
        private const val CLOSE_DELAY_MS = 300L

        /** The app's activity, so Close can finish it. Weak: never leaks it. */
        @Volatile
        private var activityRef: WeakReference<Activity>? = null

        /** Called by the plugin at load so the Close action can end the activity. */
        fun attachActivity(activity: Activity) {
            activityRef = WeakReference(activity)
        }

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

        /**
         * Whether the Rust queue worker is alive in this process. The
         * worker is spawned when the Tauri app boots (setup), and the
         * plugin's load() — which only runs with a live app — sets this
         * true. A service-restarted process never runs load(), so the
         * flag stays false and the notification must not claim the
         * queue is draining.
         */
        @Volatile
        var queueWorkerRunning: Boolean = false
            private set

        /** Idempotent: starting twice keeps one service. */
        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context.applicationContext, PrintNinjaService::class.java),
                )
            } catch (e: Exception) {
                // e.g. ForegroundServiceStartNotAllowedException when the
                // app is in the background on Android 12+.
                android.util.Log.w("PrintNinjaService", "could not start service: ${e.message}")
            }
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
         * Called by the plugin when the app boots (load): the Rust queue
         * worker exists from this moment on, so the notification may
         * claim the queue is live again. The flip rewrites the pinned
         * notification — which after a service restart shows the
         * paused wording until this runs.
         */
        fun setQueueWorkerState(context: Context, running: Boolean) {
            if (queueWorkerRunning == running) return
            queueWorkerRunning = running
            if (isRunning) refreshNotification(context)
        }

        /**
         * Title and body for the pinned notification: the live API
         * address while the server runs, the print-queue text while the
         * worker runs, and an honest "paused" text when Android
         * restarted the service without the app (worker down).
         * Split out so the contract test can pin the wording without an
         * Android [Context].
         */
        fun notificationText(
            workerRunning: Boolean,
            apiRunning: Boolean,
            address: String?,
        ): Pair<String, String> =
            if (!workerRunning) {
                "PrintNinja restarted" to
                    "The print queue is paused. Open the app to resume printing."
            } else if (apiRunning && address != null) {
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
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            fun openIntent(requestCode: Int): PendingIntent? = launch?.let {
                PendingIntent.getActivity(
                    context, requestCode, Intent(it),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            val close = PendingIntent.getService(
                context, REQUEST_CLOSE,
                Intent(context, PrintNinjaService::class.java).setAction(ACTION_CLOSE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val (title, text) =
                notificationText(queueWorkerRunning, apiServerRunning, apiServerAddress)
            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(context.applicationInfo.icon)
                .setContentIntent(openIntent(REQUEST_OPEN))
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            openIntent(REQUEST_OPEN_ACTION)?.let { builder.addAction(0, "Open", it) }
            builder.addAction(0, "Close", close)
            return builder.build()
        }
    }
}
