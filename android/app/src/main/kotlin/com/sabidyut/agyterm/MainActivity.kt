package com.sabidyut.agyterm

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
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
            if (web.url == null) web.loadUrl(START_URL)
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
                openExternal(request.url.toString(), customTab = true)
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
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- helpers
    private fun openExternal(url: String, customTab: Boolean) {
        val uri = Uri.parse(url)
        try {
            if (customTab && (uri.scheme == "https" || uri.scheme == "http")) {
                val colors = CustomTabColorSchemeParams.Builder()
                    .setToolbarColor(Color.parseColor("#181b25"))
                    .build()
                CustomTabsIntent.Builder()
                    .setDefaultColorSchemeParams(colors)
                    .setShowTitle(true)
                    .build()
                    .launchUrl(this, uri)
            } else {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "লিংক খোলার মতো কোনো ব্রাউজার নেই", Toast.LENGTH_LONG).show()
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
            main.post { openExternal(url, customTab = true) }
        }

        @JavascriptInterface
        fun openRemote(url: String) {
            main.post { openExternal(url, customTab = true) }
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
    }
}
