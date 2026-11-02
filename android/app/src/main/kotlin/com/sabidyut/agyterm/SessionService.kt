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
import android.os.Handler
import android.os.Looper
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
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
    private val mainHandler = Handler(Looper.getMainLooper())
    val sessions = ConcurrentHashMap<String, TermSession>()
    lateinit var ubuntu: UbuntuManager
        private set
    private var wakeLock: PowerManager.WakeLock? = null

    /** Called (on a background thread) when a session's process exits. */
    var onSessionExit: ((TermSession) -> Unit)? = null

    // ---- "task finished" notifications ----
    /** The app is on screen, showing this session: no need to notify about it. */
    @Volatile var uiVisible = false
    @Volatile var activeSessionId: String? = null
    var notifyWhenDone: Boolean
        get() = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_NOTIFY, true)
        set(v) = getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_NOTIFY, v).apply()

    private val watcher = object : Runnable {
        override fun run() {
            checkFinished()
            if (sessions.values.any { it.alive }) mainHandler.postDelayed(this, WATCH_MS)
            else watching = false
        }
    }
    private var watching = false

    private fun startWatching() {
        if (watching) return
        watching = true
        mainHandler.postDelayed(watcher, WATCH_MS)
    }

    /**
     * An agent's answer (or a long command) is done when, after the user pressed Enter, the
     * program wrote for a while and then went quiet — or it rang the bell / sent a
     * notification escape itself.
     */
    private fun checkFinished() {
        val now = System.currentTimeMillis()
        for (s in sessions.values) {
            val explicit = s.alert
            if (explicit != null) s.alert = null
            val armed = s.enterAt > 0
            val longRun = armed && now - s.enterAt > MIN_WORK_MS
            // A shell says when a command is done (its prompt came back); an agent's answer
            // is done when it wrote for a while after the input and then went quiet.
            val shellDone = armed && s.promptAt > s.enterAt
            val agentDone = armed && s.outSinceEnter > 200 && s.lastOutputAt - s.enterAt > MIN_WORK_MS &&
                now - s.lastOutputAt > QUIET_MS && s.promptAt <= s.enterAt &&
                (s.kind == "claude" || s.kind == "agy")
            // A program's own "done" signal (OSC 9 / 777) counts only after the user asked for
            // something — Claude Code also sends one when it has been idle for a minute
            // ("waiting for your input"), which is not news.
            val done = (explicit != null && explicit != "bell" && armed) ||
                (explicit == "bell" && longRun) ||
                (shellDone && s.promptAt - s.enterAt > MIN_WORK_MS) ||
                agentDone
            if (shellDone && !done) s.enterAt = 0 // a quick command: nothing to report
            // the same for an agent's quick answer: written and quiet again within moments
            // (else its idle "waiting for your input" a minute later would count as a reply)
            val agentQuick = armed && !done && explicit == null && (s.kind == "claude" || s.kind == "agy") &&
                s.outSinceEnter > 0 && now - s.lastOutputAt > QUIET_MS && s.lastOutputAt - s.enterAt <= MIN_WORK_MS
            if (agentQuick) s.enterAt = 0
            if (!done) continue
            s.enterAt = 0
            val watched = uiVisible && activeSessionId == s.id
            if (!watched && notifyWhenDone) notifyFinished(s, explicit?.takeIf { it != "bell" })
        }
    }

    private fun notifyFinished(s: TermSession, message: String?) {
        val who = when (s.kind) {
            "claude" -> "Claude Code"
            "agy" -> "Antigravity"
            else -> "Command"
        }
        val title = if (s.kind == "claude" || s.kind == "agy") "$who replied" else "$who finished"
        val text = message?.takeIf { it.isNotBlank() } ?: s.label.ifBlank { "Tap to see the result" }
        val open = PendingIntent.getActivity(
            this, s.id.hashCode(),
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_OPEN_SESSION, s.id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, DONE_CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        val n = builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(open)
            .setCategory(Notification.CATEGORY_MESSAGE)
            // the text may show what you're working on: keep it off the lock screen
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(
                (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, DONE_CHANNEL_ID)
                else @Suppress("DEPRECATION") Notification.Builder(this))
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .build(),
            )
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(DONE_NOTIFICATION_BASE + (s.id.hashCode() and 0xffff), n)
    }

    /** The user opened that session: its "finished" notification is old news. */
    fun clearFinished(id: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(DONE_NOTIFICATION_BASE + (id.hashCode() and 0xffff))
    }

    override fun onCreate() {
        super.onCreate()
        ubuntu = UbuntuManager.get(applicationContext)
        // a fresh process with sessions still written down: they were killed with the old one
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val live = prefs.getString(PREF_LIVE, "[]") ?: "[]"
        if (sessions.isEmpty() && live != "[]") prefs.edit().putString(PREF_LOST, live).putString(PREF_LIVE, "[]").apply()
        ubuntu.onBusyChanged = { mainHandler.post { updateForeground() } }
        createChannel()
        // after the UI had its start: unpack the helper files once, ahead of the first launch
        mainHandler.postDelayed({ Thread({ ubuntu.prepare() }, "ubuntu-prepare").start() }, 1500)
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val all = sessions.values.toList()
            sessions.clear()
            saveLive() // stopped on purpose: nothing to report later
            // the page is told now: once they're out of the list, their ends aren't reported
            // (the tabs would look alive and swallow typing)
            for (s in all) {
                s.kill()
                onSessionExit?.invoke(s)
            }
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RESHOW) {
            mainHandler.post { updateForeground() } // the notification was swiped away
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    private fun sessionEnded(s: TermSession) {
        // also when no UI is attached: drop the wake lock once nothing runs
        mainHandler.post { updateForeground() }
        saveLive()
        if (sessions.containsKey(s.id)) onSessionExit?.invoke(s)
    }

    fun createSession(kind: String, cols: Int, rows: Int): TermSession {
        val launch = when (kind) {
            "ubuntu", "agy", "claude", "selftest" -> ubuntu.launch(kind)
            else -> ubuntu.launchAndroidShell()
        }
        val id = UUID.randomUUID().toString().substring(0, 8)
        val title = when (kind) {
            "agy" -> "Antigravity"
            "claude" -> "Claude Code"
            "ubuntu" -> "Ubuntu"
            else -> "Android"
        }
        val session = TermSession(
            id, kind, title, launch.command, launch.args, launch.env, launch.cwd, rows, cols,
        ) { s -> sessionEnded(s) }
        sessions[id] = session
        saveLive()
        updateForeground()
        mainHandler.post { startWatching() }
        return session
    }

    fun closeSession(id: String) {
        clearFinished(id)
        sessions.remove(id)?.kill()
        saveLive()
        updateForeground()
    }

    // ---- sessions Android stopped ----
    // The running sessions are written down as they come and go. If the app is killed (the
    // phone ran low on memory, or a battery saver / "clean up" closed everything), the list
    // is still there when it starts again: the page tells the user and offers to reopen them.

    /** Writes down the running sessions (kind + what the UI calls them). */
    @Synchronized
    fun saveLive() {
        val arr = org.json.JSONArray()
        for (s in sessions.values.sortedBy { it.createdAt }) {
            if (s.alive && s.kind != "selftest") arr.put(org.json.JSONObject().put("kind", s.kind).put("label", s.label))
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_LIVE, arr.toString()).apply()
    }

    /** Sessions that were running when the app was last killed ("[]" if none). */
    fun lostSessions(): String = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_LOST, "[]") ?: "[]"

    fun forgetLostSessions() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(PREF_LOST).apply()
    }

    /**
     * Debug builds only: installs Ubuntu, then runs first-time setup, `agy --version` and `claude --version`
     * inside it, logging everything to logcat (tag AgySelfTest). Used by CI on an emulator:
     *   adb shell am start -n com.sabidyut.agyterm/.MainActivity --ez selftest true
     */
    fun runSelfTest(onDone: (Boolean) -> Unit = {}) {
        Thread({
            Log.i(SELFTEST, "start")
            if (!ubuntu.isInstalled()) {
                ubuntu.install()
                var last = ""
                while (ubuntu.state == UbuntuManager.State.INSTALLING) {
                    if (ubuntu.message != last) {
                        last = ubuntu.message
                        Log.i(SELFTEST, "install: $last")
                    }
                    Thread.sleep(2000)
                }
                if (ubuntu.state != UbuntuManager.State.READY) {
                    Log.e(SELFTEST, "SELFTEST_FAIL install: ${ubuntu.message}")
                    return@Thread
                }
            }
            Log.i(SELFTEST, "ubuntu installed, starting session")
            val s = createSession("selftest", 100, 30)
            val line = StringBuilder()
            s.attach(object : TermSession.OutputListener {
                override fun onOutput(session: TermSession, data: ByteArray, len: Int) {
                    for (ch in String(data, 0, len, Charsets.UTF_8)) {
                        if (ch == '\n') {
                            Log.i(SELFTEST, "out: " + line.toString().replace(Regex("\u001b\\[[0-9;?]*[A-Za-z]"), "").trimEnd('\r'))
                            line.setLength(0)
                        } else if (line.length < 400) line.append(ch)
                    }
                }
            })
            while (s.alive) Thread.sleep(1000)
            Log.i(SELFTEST, "out: $line")
            Log.i(SELFTEST, "session exited with code ${s.exitCode}")
            closeSession(s.id)
            onDone(s.exitCode == 0)
        }, "selftest").start()
    }

    /**
     * Foreground while anything runs (or Ubuntu is being installed); otherwise let the
     * system stop us when unbound. Called from the main and the JS-bridge threads.
     */
    @Synchronized
    fun updateForeground() {
        val running = sessions.values.count { it.alive }
        val installing = ubuntu.state == UbuntuManager.State.INSTALLING
        if (sessions.isEmpty() && !installing) {
            releaseWakeLock()
            stopForegroundCompat()
            stopSelf()
            return
        }
        // The notification stays as long as any session is open (finished ones too, until
        // their tabs are closed); the phone is kept awake only while something runs.
        startService(Intent(this, SessionService::class.java))
        startForeground(NOTIFICATION_ID, buildNotification(running, sessions.size, installing))
        if (running > 0 || installing) acquireWakeLock() else releaseWakeLock()
    }

    private fun buildNotification(running: Int, open: Int, installing: Boolean): Notification {
        val tap = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Android 14+ lets the user swipe even a foreground service's notification away:
        // put it straight back while sessions are open
        val swiped = PendingIntent.getService(
            this, 2, Intent(this, SessionService::class.java).setAction(ACTION_RESHOW),
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
            .setContentTitle("AntiCode")
            .setContentText(
                when {
                    installing && open == 0 -> "Installing Ubuntu…"
                    running == 0 -> if (open == 1) "1 session open — tap to open" else "$open sessions open — tap to open"
                    running == 1 -> "1 session running — tap to open"
                    else -> "$running sessions running — tap to open"
                },
            )
            .setOngoing(true)
            .setDeleteIntent(swiped)
            .setContentIntent(tap)
            .addAction(Notification.Action.Builder(null, "Stop all", stop).build())
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(CHANNEL_ID, "Running sessions", NotificationManager.IMPORTANCE_LOW)
        ch.description = "Keeps terminal sessions running in the background"
        nm.createNotificationChannel(ch)
        val done = NotificationChannel(DONE_CHANNEL_ID, "Task finished", NotificationManager.IMPORTANCE_HIGH)
        done.description = "When an agent has answered or a long command is done"
        nm.createNotificationChannel(done)
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
        ubuntu.onBusyChanged = null
        for (s in sessions.values) s.kill()
        sessions.clear()
        releaseWakeLock()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "sessions"
        private const val DONE_CHANNEL_ID = "done"
        private const val NOTIFICATION_ID = 1
        private const val DONE_NOTIFICATION_BASE = 1000
        private const val PREFS = "service"
        private const val PREF_NOTIFY = "notifyWhenDone"
        private const val PREF_LIVE = "liveSessions"
        private const val PREF_LOST = "lostSessions"
        const val EXTRA_OPEN_SESSION = "openSession"
        /** Quiet this long after output = the answer is done. */
        private const val QUIET_MS = 4000L
        /** Only for runs that took a while (not `ls`). */
        private const val MIN_WORK_MS = 5000L
        private const val WATCH_MS = 1500L
        private const val SELFTEST = "AgySelfTest"
        const val ACTION_STOP = "com.sabidyut.agyterm.STOP"
        const val ACTION_RESHOW = "com.sabidyut.agyterm.RESHOW"
    }
}
