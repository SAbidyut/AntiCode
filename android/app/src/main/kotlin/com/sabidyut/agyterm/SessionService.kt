package com.sabidyut.agyterm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.sabidyut.agyterm.term.TermSession
import com.sabidyut.agyterm.ubuntu.UbuntuManager
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Owns the terminal sessions, so Antigravity keeps running while the app is in the
 * background (shown as an ongoing notification, like Termux).
 */
class SessionService : Service() {

    inner class LocalBinder : Binder() {
        val service: SessionService get() = this@SessionService
    }

    private val binder = LocalBinder()
    val sessions = ConcurrentHashMap<String, TermSession>()
    lateinit var ubuntu: UbuntuManager
        private set
    private var wakeLock: PowerManager.WakeLock? = null

    /** Called (on a background thread) when a session's process exits. */
    var onSessionExit: ((TermSession) -> Unit)? = null

    override fun onCreate() {
        super.onCreate()
        ubuntu = UbuntuManager(applicationContext)
        createChannel()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            for (s in sessions.values) s.kill()
            sessions.clear()
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    fun createSession(kind: String, cols: Int, rows: Int): TermSession {
        val launch = when (kind) {
            "ubuntu", "agy" -> ubuntu.launch(kind)
            else -> ubuntu.launchAndroidShell()
        }
        val id = UUID.randomUUID().toString().substring(0, 8)
        val title = when (kind) {
            "agy" -> "Antigravity"
            "ubuntu" -> "Ubuntu"
            else -> "Android"
        }
        val session = TermSession(
            id, kind, title, launch.command, launch.args, launch.env, launch.cwd, rows, cols,
        ) { s -> onSessionExit?.invoke(s) }
        sessions[id] = session
        updateForeground()
        return session
    }

    fun closeSession(id: String) {
        sessions.remove(id)?.kill()
        updateForeground()
    }

    /** Foreground while anything runs; otherwise let the system stop us when unbound. */
    fun updateForeground() {
        val running = sessions.values.count { it.alive }
        if (sessions.isEmpty()) {
            releaseWakeLock()
            stopForegroundCompat()
            stopSelf()
            return
        }
        startService(Intent(this, SessionService::class.java))
        startForeground(NOTIFICATION_ID, buildNotification(running))
        acquireWakeLock()
    }

    private fun buildNotification(running: Int): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, SessionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        return builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Agy টার্মিনাল")
            .setContentText("${running}টি সেশন চলছে — চাপ দিয়ে খুলুন")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "সব বন্ধ করুন", stop).build())
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(CHANNEL_ID, "চলমান সেশন", NotificationManager.IMPORTANCE_LOW)
        ch.description = "টার্মিনাল সেশন ব্যাকগ্রাউন্ডে চালু রাখে"
        nm.createNotificationChannel(ch)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgyTerminal:sessions").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
    }

    override fun onDestroy() {
        for (s in sessions.values) s.kill()
        sessions.clear()
        releaseWakeLock()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "sessions"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.sabidyut.agyterm.STOP"
    }
}
