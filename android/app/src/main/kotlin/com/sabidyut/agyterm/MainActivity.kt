package com.sabidyut.agyterm

import android.annotation.SuppressLint
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
import android.webkit.JavascriptInterface
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
        window.statusBarColor = Color.parseColor("#181b25")
        window.navigationBarColor = Color.parseColor("#181b25")
        imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        browser = InAppBrowser(this).apply { warmup() }

        web = TermWebView(this, object : TermWebView.KeySink {
            override fun onText(text: String) = js("__native.onImeText(${JSONObject.quote(text)})")
            override fun onKey(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean) =
                js("__native.onImeKey($keyCode, $ctrl, $alt, $shift)")
        })
        web.setBackgroundColor(Color.parseColor("#0f1117"))
        setContentView(web)

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

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == ASSET_HOST) return false
                browser.open(request.url.toString())
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

    // ---------------------------------------------------------------- self test (debug builds)
    private fun selftestEnabled() =
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 &&
            intent?.getBooleanExtra("selftest", false) == true

    /**
     * Phase 2 of the emulator self test: open the Antigravity CLI through the real web UI
     * (same path as the "Antigravity" button) and log what the screen shows, so CI catches
     * a blank/frozen terminal — the bug users actually hit.
     */
    private fun selftestAgyInUi() {
        Log.i(SELFTEST, "phase 2: starting agy in the real UI")
        web.evaluateJavascript("window.__selftest ? (__selftest.open('agy'), 'started') : 'no hook'") {
            Log.i(SELFTEST, "ui: $it")
        }
        val checks = listOf(15_000L, 30_000L, 50_000L)
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
                    if (ok) Log.i(SELFTEST, "SELFTEST_AGY_OK")
                    else if (i == checks.lastIndex) Log.e(SELFTEST, "SELFTEST_AGY_FAIL screen blank or JS errors")
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
            main.post { Toast.makeText(this@MainActivity, "সেশন শুরু হয়নি: ${e.message}", Toast.LENGTH_LONG).show() }
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

        @JavascriptInterface
        fun setTerminalKeyboard(on: Boolean) {
            main.post {
                if (web.terminalMode != on) {
                    web.terminalMode = on
                    imm.restartInput(web)
                }
            }
        }

        @JavascriptInterface
        fun showKeyboard() {
            main.post {
                web.requestFocus()
                imm.showSoftInput(web, 0)
            }
        }

        @JavascriptInterface
        fun hideKeyboard() {
            main.post { imm.hideSoftInputFromWindow(web.windowToken, 0) }
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
        private const val SELFTEST = "AgySelfTest"
    }
}
