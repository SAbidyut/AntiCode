package com.sabidyut.agyterm

import android.annotation.SuppressLint
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import android.Manifest
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebViewAssetLoader
import com.sabidyut.agyterm.term.TermSession
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

class MainActivity : ComponentActivity() {

    private lateinit var web: TermWebView
    private lateinit var keys: KeyCaptureView
    private var service: SessionService? = null
    private val main = Handler(Looper.getMainLooper())
    private lateinit var imm: InputMethodManager
    private lateinit var browser: InAppBrowser

    // ---------------------------------------------------------------- output pump
    // PTY output arrives on reader threads; batch it and hand it to the web UI ~60×/s.
    private val pendingLock = Any()
    private val pending = LinkedHashMap<String, ByteArrayOutputStream>()
    private var flushScheduled = false

    private val outputListener = object : TermSession.OutputListener {
        override fun onOutput(session: TermSession, data: ByteArray, len: Int) = queue(session.id, data, len)
    }

    private fun queue(id: String, data: ByteArray, len: Int) {
        synchronized(pendingLock) {
            pending.getOrPut(id) { ByteArrayOutputStream() }.write(data, 0, len)
            if (!flushScheduled) {
                flushScheduled = true
                main.postDelayed(::flush, 8)
            }
        }
    }

    private fun flush() {
        val batch: List<Pair<String, ByteArray>>
        synchronized(pendingLock) {
            batch = pending.map { (id, buf) -> id to buf.toByteArray() }
            pending.clear()
            flushScheduled = false
        }
        for ((id, bytes) in batch) {
            var off = 0
            while (off < bytes.size) {
                val n = minOf(CHUNK, bytes.size - off)
                val b64 = Base64.encodeToString(bytes, off, n, Base64.NO_WRAP)
                js("__native.onOutput('$id','$b64')")
                off += n
            }
        }
    }

    private fun js(code: String) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            web.evaluateJavascript("window.__native && ($code)", null)
        } else {
            main.post { web.evaluateJavascript("window.__native && ($code)", null) }
        }
    }

    // ---------------------------------------------------------------- service
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as SessionService.LocalBinder).service
            service = svc
            svc.onSessionExit = { s ->
                main.post {
                    js("__native.onExit('${s.id}', ${s.exitCode})")
                    svc.updateForeground()
                }
            }
            svc.ubuntu.onStateChanged = {
                js("__native.onState(${JSONObject.quote(svc.ubuntu.stateJson())})")
            }
            // Only now load the UI: every bridge call needs the service.
            if (web.url == null) web.loadUrl(if (selftestEnabled()) "$START_URL?selftest=1" else START_URL)
            if (selftestEnabled()) svc.runSelfTest { ok -> if (ok) main.post { selftestAgyInUi() } }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    // ---------------------------------------------------------------- lifecycle
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // edge-to-edge: the page paints behind the bars and pads itself (see followInsets)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        browser = InAppBrowser(this).apply { warmup() }

        web = TermWebView(this)
        web.setBackgroundColor(Color.parseColor(BG))
        // Owns the keyboard while typing into the terminal (see KeyCaptureView).
        keys = KeyCaptureView(this, object : KeyCaptureView.Sink {
            override fun onText(text: String) = js("__native.onImeText(${JSONObject.quote(text)})")
            override fun onKey(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean) =
                js("__native.onImeKey($keyCode, $ctrl, $alt, $shift)")
        })
        keys.compatMode = getPreferences(Context.MODE_PRIVATE).getBoolean(PREF_KEYBOARD_COMPAT, false)
        val root = FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(keys, FrameLayout.LayoutParams(1, 1))
        }
        setContentView(root)
        followInsets(root)

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            textZoom = 100 // the terminal grid must not follow the system font scale
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String?) {
                // the page missed the insets sent while it was loading
                lastInsets = ""
                ViewCompat.requestApplyInsets(view)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == ASSET_HOST) return false
                browser.open(request.url.toString())
                return true
            }
        }
        // Page console → logcat (tag AgyWeb), for debugging and the CI self test.
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.println(
                    if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.ERROR else Log.INFO,
                    "AgyWeb",
                    "${m.message()} (${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()})",
                )
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.__native ? __native.onBack() : false") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        val intent = Intent(this, SessionService::class.java)
        startService(intent)
        bindService(intent, connection, Context.BIND_AUTO_CREATE)
    }

    override fun onDestroy() {
        service?.let { svc ->
            for (s in svc.sessions.values) s.attach(null)
            svc.onSessionExit = null
            svc.ubuntu.onStateChanged = null
            svc.updateForeground()
        }
        unbindService(connection)
        browser.release()
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- insets / keyboard animation
    private var imeAnimating = false
    private var lastInsets = ""

    /**
     * Draw edge-to-edge and hand the status bar / navigation bar / keyboard heights to the
     * page as they change — on every frame while the keyboard slides — so the terminal
     * moves with the keyboard instead of jumping when the window is resized.
     */
    private fun followInsets(root: View) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            if (!imeAnimating) sendInsets(insets, settled = true)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.setWindowInsetsAnimationCallback(
            root,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) imeAnimating = true
                }

                override fun onProgress(
                    insets: WindowInsetsCompat,
                    running: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    sendInsets(insets, settled = false)
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() == 0) return
                    imeAnimating = false
                    ViewCompat.getRootWindowInsets(root)?.let { sendInsets(it, settled = true) }
                }
            },
        )
    }

    private fun sendInsets(insets: WindowInsetsCompat, settled: Boolean) {
        val d = resources.displayMetrics.density
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val top = bars.top / d
        val bottom = maxOf(bars.bottom, ime.bottom) / d
        val keyboard = ime.bottom > bars.bottom
        val key = "%.1f,%.1f,%b,%b".format(top, bottom, keyboard, settled)
        if (key == lastInsets) return
        lastInsets = key
        js("__native.onInsets($top, $bottom, $keyboard, $settled)")
    }

    // ---------------------------------------------------------------- keyboard focus
    private fun focusTerminalKeys() {
        web.holdFocusAway = true
        if (!keys.hasFocus()) keys.requestFocus()
    }

    /** A text field in the page (compose box, settings) was tapped: give the keyboard to it. */
    private fun releaseToWebView() {
        if (!web.holdFocusAway && web.hasFocus()) return
        web.holdFocusAway = false
        web.requestFocus()
        // only if the page really has a text field focused (not e.g. when going home)
        main.postDelayed({ if (web.hasFocus() && web.onCheckIsTextEditor()) imm.showSoftInput(web, 0) }, 80)
    }

    // ---------------------------------------------------------------- phone storage
    private val storagePermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { onStorageResult() }

    /** Like Termux's termux-setup-storage: ask for access to the phone's shared storage. */
    private fun requestStorageAccess() {
        if (Storage.hasAccess(this)) {
            onStorageResult()
            return
        }
        storagePermissions.launch(
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE),
        )
    }

    private fun onStorageResult() {
        if (!Storage.hasAccess(this) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Some Android 11+ devices also want "All files access" for full /sdcard access.
            try {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")),
                )
                Toast.makeText(this, "Turn on \"Allow access to manage all files\", then come back", Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
        }
        pushState()
    }

    override fun onResume() {
        super.onResume()
        pushState() // storage access may have been granted in Settings
    }

    private fun pushState() {
        val svc = service ?: return
        js("__native.onState(${JSONObject.quote(svc.ubuntu.stateJson())})")
    }

    // ---------------------------------------------------------------- self test (debug builds)
    private fun selftestEnabled() =
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 &&
            intent?.getBooleanExtra("selftest", false) == true

    /**
     * Phase 2 of the emulator self test: open the Antigravity CLI through the real web UI
     * (same path as the "Antigravity" button) and log what the screen shows, so CI catches
     * a blank/frozen terminal — the bug users actually hit.
     */
    private fun selftestAgyInUi(attempt: Int = 0) {
        Log.i(SELFTEST, "phase 2: starting agy in the real UI (attempt ${attempt + 1})")
        web.evaluateJavascript("window.__selftest ? (__selftest.open('agy'), 'started') : 'no hook'") {
            Log.i(SELFTEST, "ui: $it")
            if (it != "\"started\"") {
                if (attempt < 10) main.postDelayed({ selftestAgyInUi(attempt + 1) }, 3000)
                else Log.e(SELFTEST, "SELFTEST_AGY_FAIL web UI never became ready (url=${web.url})")
                return@evaluateJavascript
            }
            scheduleScreenChecks()
        }
    }

    private var typingTestStarted = false

    private fun selftestScreen(cb: (String) -> Unit) {
        web.evaluateJavascript("__selftest.screen()") { raw ->
            cb(try { JSONObject("{\"v\":$raw}").getString("v") } catch (_: Exception) { "" })
        }
    }

    /**
     * Phase 3: type into an Ubuntu shell through the native key view (the CI script injects
     * key presses with `adb shell input text` once SELFTEST_TYPE_READY is logged), then check
     * that the phone's storage is visible under /sdcard.
     */
    private fun selftestTyping() {
        Log.i(SELFTEST, "phase 3: typing through the native key view")
        web.evaluateJavascript("__selftest.open('ubuntu')", null)
        main.postDelayed({
            web.evaluateJavascript("__selftest.focusKeys()", null)
            main.postDelayed({
                Log.i(SELFTEST, "SELFTEST_TYPE_READY keyViewFocused=${keys.hasFocus()}")
                pollTyping(0)
            }, 1500)
        }, 5000)
    }

    /** Wait until the shell printed [expect] on a line of its own. */
    private fun pollLine(expect: String, tries: Int, onOk: () -> Unit, failTag: String) {
        selftestScreen { screen ->
            when {
                screen.lines().any { it.trim() == expect } -> onOk()
                tries > 0 -> main.postDelayed({ pollLine(expect, tries - 1, onOk, failTag) }, 3000)
                else -> {
                    for (line in screen.lines()) if (line.isNotBlank()) Log.i(SELFTEST, "ui| $line")
                    Log.e(SELFTEST, "$failTag keyViewFocused=${keys.hasFocus()}")
                }
            }
        }
    }

    private fun pollTyping(@Suppress("UNUSED_PARAMETER") n: Int) {
        pollLine("42", 20, {
            Log.i(SELFTEST, "SELFTEST_TYPE_OK")
            // Scrolling the terminal used to steal the keyboard: swipe, then type again.
            Log.i(SELFTEST, "SELFTEST_SWIPE_READY")
            pollLine("55", 20, {
                Log.i(SELFTEST, "SELFTEST_TYPE_AFTER_SWIPE_OK keyViewFocused=${keys.hasFocus()}")
                web.evaluateJavascript("__selftest.send('ls /sdcard/ >/dev/null && ls -d ~/storage/downloads/ && echo SD\$((1+1))OK')", null)
                main.postDelayed({ pollStorage(0) }, 2000)
            }, "SELFTEST_TYPE_FAIL typing stopped working after scrolling")
        }, "SELFTEST_TYPE_FAIL typed text never reached the shell")
    }

    private fun pollStorage(n: Int) {
        selftestScreen { screen ->
            if (screen.contains("SD2OK")) {
                Log.i(SELFTEST, "SELFTEST_STORAGE_OK")
                selftestClaudeInUi()
            } else if (n < 10) {
                main.postDelayed({ pollStorage(n + 1) }, 2000)
            } else {
                for (line in screen.lines()) if (line.isNotBlank()) Log.i(SELFTEST, "ui| $line")
                Log.e(SELFTEST, "SELFTEST_STORAGE_FAIL /sdcard not readable inside Ubuntu")
            }
        }
    }

    /** Phase 4: open Claude Code through the real web UI and check that it draws its screen. */
    private fun selftestClaudeInUi() {
        Log.i(SELFTEST, "phase 4: starting Claude Code in the real UI")
        web.evaluateJavascript("__selftest.open('claude')", null)
        pollClaude(0)
    }

    private fun pollClaude(n: Int) {
        main.postDelayed({
            web.evaluateJavascript("JSON.stringify({s: __selftest.screen(), e: __selftest.errors()})") { raw ->
                val obj = try {
                    JSONObject(JSONObject("{\"v\":$raw}").getString("v"))
                } catch (_: Exception) {
                    JSONObject().put("s", "").put("e", "unreadable: $raw")
                }
                val screen = obj.optString("s")
                val errors = obj.optString("e")
                val ok = errors.isBlank() && Regex("Welcome to Claude|Claude Code v|text style|Select login").containsMatchIn(screen)
                if (ok) {
                    for (line in screen.lines()) if (line.isNotBlank()) Log.i(SELFTEST, "claude| $line")
                    Log.i(SELFTEST, "SELFTEST_CLAUDE_OK")
                } else if (n < 12) {
                    pollClaude(n + 1)
                } else {
                    for (line in screen.lines()) if (line.isNotBlank()) Log.i(SELFTEST, "claude| $line")
                    if (errors.isNotBlank()) Log.e(SELFTEST, "ui js errors: $errors")
                    Log.e(SELFTEST, "SELFTEST_CLAUDE_FAIL Claude Code screen never appeared")
                }
            }
        }, 5000)
    }

    private fun scheduleScreenChecks() {
        val checks = listOf(15_000L, 30_000L, 60_000L, 90_000L)
        for ((i, delay) in checks.withIndex()) {
            main.postDelayed({
                web.evaluateJavascript("JSON.stringify({s: __selftest.screen(), e: __selftest.errors()})") { raw ->
                    val obj = try {
                        JSONObject(JSONObject("{\"v\":$raw}").getString("v"))
                    } catch (_: Exception) {
                        JSONObject().put("s", "").put("e", "unreadable: $raw")
                    }
                    val screen = obj.optString("s")
                    val errors = obj.optString("e")
                    Log.i(SELFTEST, "ui screen after ${delay / 1000}s:")
                    for (line in screen.lines()) if (line.isNotBlank()) Log.i(SELFTEST, "ui| $line")
                    if (errors.isNotBlank()) Log.e(SELFTEST, "ui js errors: $errors")
                    val ok = errors.isBlank() && Regex("Antigravity|sign|Sign|login|Login").containsMatchIn(screen)
                    if (ok) {
                        if (!typingTestStarted) {
                            typingTestStarted = true
                            Log.i(SELFTEST, "SELFTEST_AGY_OK")
                            selftestTyping()
                        }
                    } else if (i == checks.lastIndex && !typingTestStarted) {
                        // Log the raw terminal output so the cause is visible in CI.
                        web.evaluateJavascript("__selftest.dump()") { dump ->
                            val text = try {
                                JSONObject("{\"v\":$dump}").getString("v")
                            } catch (_: Exception) {
                                "$dump"
                            }
                            for (chunk in text.chunked(900)) Log.i(SELFTEST, "dump| $chunk")
                            Log.e(SELFTEST, "SELFTEST_AGY_FAIL screen blank or JS errors")
                        }
                    }
                }
            }, delay)
        }
    }

    /** Methods callable from JavaScript as window.AndroidBridge.* (they run on a binder thread). */
    inner class Bridge {
        private fun svc() = service ?: throw IllegalStateException("service not bound")

        @JavascriptInterface
        fun createSession(kind: String, cols: Int, rows: Int): String = try {
            val s = svc().createSession(kind, cols.coerceIn(10, 500), rows.coerceIn(4, 300))
            s.attach(outputListener)
            s.id
        } catch (e: Exception) {
            main.post { Toast.makeText(this@MainActivity, "Could not start the session: ${e.message}", Toast.LENGTH_LONG).show() }
            ""
        }

        @JavascriptInterface
        fun write(id: String, data: String) {
            svc().sessions[id]?.write(data.toByteArray(Charsets.UTF_8))
        }

        @JavascriptInterface
        fun resize(id: String, cols: Int, rows: Int) {
            svc().sessions[id]?.resize(rows.coerceIn(4, 300), cols.coerceIn(10, 500))
        }

        @JavascriptInterface
        fun closeSession(id: String) {
            main.post { service?.closeSession(id) }
        }

        @JavascriptInterface
        fun attach(id: String) {
            val s = svc().sessions[id] ?: return
            s.attach(outputListener) { snap -> if (snap.isNotEmpty()) queue(id, snap, snap.size) }
            if (!s.alive) main.post { js("__native.onExit('$id', ${s.exitCode})") }
        }

        @JavascriptInterface
        fun listSessions(): String {
            val arr = JSONArray()
            for (s in svc().sessions.values) {
                arr.put(JSONObject().put("id", s.id).put("kind", s.kind).put("title", s.title).put("alive", s.alive))
            }
            return arr.toString()
        }

        @JavascriptInterface
        fun getState(): String = svc().ubuntu.stateJson()

        @JavascriptInterface
        fun installUbuntu() = svc().ubuntu.install()

        @JavascriptInterface
        fun openUrl(url: String) {
            main.post { browser.open(url) }
        }

        @JavascriptInterface
        fun openRemote(url: String) {
            main.post { browser.open(url) }
        }

        @JavascriptInterface
        fun copyText(text: String) {
            main.post {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("terminal", text))
            }
        }

        @JavascriptInterface
        fun readClipboard(): String {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
        }

        /** on: the terminal gets the keyboard (raw keys). off: the WebView does (compose box, inputs). */
        @JavascriptInterface
        fun setTerminalKeyboard(on: Boolean) {
            main.post { if (on) focusTerminalKeys() else releaseToWebView() }
        }

        @JavascriptInterface
        fun showKeyboard() {
            main.post {
                focusTerminalKeys()
                imm.restartInput(keys)
                imm.showSoftInput(keys, InputMethodManager.SHOW_IMPLICIT)
            }
        }

        @JavascriptInterface
        fun hideKeyboard() {
            main.post {
                imm.hideSoftInputFromWindow(web.windowToken, 0)
                web.holdFocusAway = false
            }
        }

        /** Keyboard compatibility mode for keyboards that misbehave in raw mode. */
        @JavascriptInterface
        fun setKeyboardCompat(on: Boolean) {
            main.post {
                keys.compatMode = on
                getPreferences(Context.MODE_PRIVATE).edit().putBoolean(PREF_KEYBOARD_COMPAT, on).apply()
                if (keys.hasFocus()) imm.restartInput(keys)
            }
        }

        @JavascriptInterface
        fun requestStorage() {
            main.post { requestStorageAccess() }
        }

        @JavascriptInterface
        fun exitApp() {
            main.post { moveTaskToBack(true) }
        }
    }

    companion object {
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_HOST/assets/web/index.html"
        private const val CHUNK = 192 * 1024
        private const val BG = "#0b0d12"
        private const val PREF_KEYBOARD_COMPAT = "keyboard_compat"
        private const val SELFTEST = "AgySelfTest"
    }
}
