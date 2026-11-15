package io.foxwarm.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder

class NodeService : Service() {
    companion object {
        const val STOP = "io.foxwarm.android.STOP"
        @Volatile var isRunning = false; private set
        @Volatile var connectionStatus = "Stopped"; private set
    }
    private var client: NodeClient? = null
    private val main = Handler(android.os.Looper.getMainLooper())
    private val preferences by lazy { NodePreferences(this) }
    private val notifications by lazy { getSystemService(NotificationManager::class.java) }

    override fun onCreate() {
        super.onCreate()
        notifications.createNotificationChannel(NotificationChannel("connection", "Node connection", NotificationManager.IMPORTANCE_LOW))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP || intent == null && !preferences.running) {
            preferences.running = false
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = notification("Connecting")
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, notification)
        val pairing = preferences.load()
        if (pairing == null) {
            preferences.running = false
            stopSelf()
            return START_NOT_STICKY
        }
        if (client != null) return START_STICKY
        preferences.running = true
        isRunning = true
        connectionStatus = "Connecting"
        val connectedClient = NodeClient(pairing, { tool, args ->
            val service = DeviceAccessibilityService.current ?: error("Enable Foxwarm Node in Android Accessibility settings.")
            service.execute(tool, args)
        }, { state ->
            main.post {
                if (client != null) {
                    connectionStatus = state
                    notifications.notify(1, notification(state))
                }
            }
        })
        client = connectedClient
        connectedClient.start()
        return START_STICKY
    }

    private fun notification(status: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, NodeService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "connection")
            .setSmallIcon(R.drawable.ic_node).setContentTitle("Foxwarm Node")
            .setContentText(status).setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build()).build()
    }

    override fun onDestroy() {
        client?.close()
        client = null
        isRunning = false
        connectionStatus = "Stopped"
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
