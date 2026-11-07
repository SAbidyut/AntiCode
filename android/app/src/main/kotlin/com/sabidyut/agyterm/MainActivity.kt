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
import android.os.SystemClock
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
import android.content.ComponentCallbacks2
import android.util.Base64
import android.util.Log
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
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
    private lateinit var panel: RemotePanel
    private var fileCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        fileCallback = null
    }

    // ---------------------------------------------------------------- output pump
    // PTY output arrives on reader threads; batch it and hand it to the web UI ~60×/s.
    private val pendingLock = Any()
    private val pending = LinkedHashMap<String, ByteArrayOutputStream>()
    private var flushScheduled = false

    private val outputListener = object : TermSession.OutputListener {
        override fun onOutput(session: TermSession, data: ByteArray, len: Int) = queue(session.id, data, len)
        override fun onHiddenInput(session: TermSession, on: Boolean) {
            main.post {
                flush() // (the question first)
                js("__native.onHiddenInput && __native.onHiddenInput('${session.id}', $on)")
                if (session.id == shownSessionId) keys.setHidden(on)
            }
        }
    }

    private fun queue(id: String, data: ByteArray, len: Int) {
        synchronized(pendingLock) {
            // the page was let go: what's printed now is in the session's saved output, which
            // the page gets when it's loaded again
            if (dropOutput) return
            val buf = pending.getOrPut(id) { ByteArrayOutputStream() }
            buf.write(data, 0, len)
            if (outOfSight) {
                if (buf.size() > HOLD_MAX) {
                    // a lot printed while away: no point handing all of it over — the page
                    // starts afresh with the saved output instead
                    dropOutput = true
                    pending.clear()
                    main.post { releasePage() }
                    return
                }
                // a question for the terminal (where is the cursor, what are you): the program
                // may wait for the answer — that goes to the page now
                if (!flushScheduled && asksTerminal(data, len)) {
                    flushScheduled = true
                    main.post(::flush)
                }
                return
            }
            if (!flushScheduled) {
                flushScheduled = true
                // the echo of a key (nothing sent for a frame): right away; a stream of output
                // still goes in batches
                val idle = SystemClock.uptimeMillis() - lastFlush > 16
                if (idle) main.post(::flush) else main.postDelayed(::flush, 8)
            }
        }
    }

    @Volatile private var lastFlush = 0L

    // ---------------------------------------------------------------- out of sight
    // In the background the page draws nothing and the system slows its timers down to about
    // once a second, so output handed to it then piled up in the page (megabytes while an
    // agent worked away) faster than it could take it in — memory the rest of the phone was
    // short of. Now the output waits here and the page gets it in one go when the app is
    // back (drawn once, not flickering through what was missed — see onCatchUp). Only when a
    // lot printed meanwhile, or Android is about to stop the app for memory, is the page let go
    // altogether (its memory goes back to the phone) and loaded again when the app is back,
    // replaying each session's saved output; a cover in the app's colour hides that until the
    // page says it's ready.
    /** The app is in the background (between onStop and onStart). */
    @Volatile private var outOfSight = false
    /** The page was let go (or is being): output isn't kept for it. (under pendingLock) */
    private var dropOutput = false
    /** The page is about:blank now: load it again when the app is back. */
    private var pageReleased = false
    /** Hides the page while it loads again, until it says it is ready (see pageReady). */
    private lateinit var cover: View
    private val hideCoverLater = Runnable { hideCover() }
    /** The held output goes to the page next: it draws it once when it's all in (under pendingLock). */
    private var catchUp = false

    private fun showCover() {
        cover.animate().cancel()
        cover.alpha = 1f
        cover.visibility = View.VISIBLE
    }

    private fun hideCover() {
        main.removeCallbacks(hideCoverLater)
        if (cover.visibility != View.VISIBLE) return
        cover.animate().alpha(0f).setDuration(180).withEndAction { cover.visibility = View.GONE }.start()
    }

    /**
     * A query the terminal answers (CSI … n / c / t, CSI > q, CSI ? u, CSI … $ p, OSC …;?,
     * DCS): device status, cursor position, attributes, colours, modes.
     */
    private fun asksTerminal(b: ByteArray, n: Int): Boolean {
        var i = 0
        while (i < n - 1) {
            if (b[i] != 0x1b.toByte()) { i++; continue }
            when (b[i + 1].toInt().toChar()) {
                'P' -> return true
                ']' -> {
                    var j = i + 2
                    while (j < n - 1 && j < i + 40 && b[j] != 0x07.toByte() && b[j] != 0x1b.toByte()) {
                        if (b[j] == ';'.code.toByte() && b[j + 1] == '?'.code.toByte()) return true
                        j++
                    }
                }
                '[' -> {
                    var j = i + 2
                    val first = if (j < n) b[j].toInt().toChar() else ' '
                    while (j < n && j < i + 24 && b[j] in 0x20..0x3f) j++
                    if (j < n) {
                        val prev = b[j - 1].toInt().toChar()
                        when (b[j].toInt().toChar()) {
                            'n', 'c', 't' -> return true
                            'q' -> if (first == '>') return true
                            'u' -> if (first == '?') return true
                            'p' -> if (prev == '$') return true
                        }
                    }
                }
            }
            i++
        }
        return false
    }

    /** Lets the page go (the app out of sight): its memory goes back to the phone. */
    private fun releasePage() {
        if (pageReleased || rebuilding || web.url == null) {
            synchronized(pendingLock) { if (!pageReleased) dropOutput = false }
            return
        }
        Log.i("AgyWeb", "releasing the page while out of sight")
        // (the sessions keep their output; the new page asks for it)
        service?.let { svc -> for (s in svc.sessions.values) s.attach(null) }
        synchronized(pendingLock) {
            dropOutput = true
            pending.clear()
        }
        pageReleased = true
        showCover()
        if (outOfSight) web.loadUrl("about:blank") else reloadPage()
    }

    /** Back in sight after the page was let go: the UI starts again (sessions re-attach). */
    private fun reloadPage() {
        pageReleased = false
        synchronized(pendingLock) {
            dropOutput = false
            pending.clear()
        }
        lastInsets = ""
        showCover()
        // (if the page never says it's ready: not hidden for good)
        main.removeCallbacks(hideCoverLater)
        main.postDelayed(hideCoverLater, 5000)
        web.loadUrl(START_URL)
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // Android is about to stop the app for memory (it's in the middle or at the end of the
        // list of processes to go): give the page's back — better than losing every session.
        // (Not for the milder levels: it only costs the page a restart and the screen a flash.)
        @Suppress("DEPRECATION")
        val critical = level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE
        if (outOfSight && critical) main.post { if (outOfSight) releasePage() }
    }

    private fun flush() {
        lastFlush = SystemClock.uptimeMillis()
        val batch: List<Pair<String, ByteArray>>
        val catching: Boolean
        synchronized(pendingLock) {
            batch = pending.map { (id, buf) -> id to buf.toByteArray() }
            pending.clear()
            flushScheduled = false
            catching = catchUp
            catchUp = false
        }
        // what piled up while the app was away: the page draws it once, when it's all in
        if (catching && batch.isNotEmpty()) js("__native.onCatchUp && __native.onCatchUp(true)")
        for ((id, bytes) in batch) {
            var off = 0
            while (off < bytes.size) {
                val n = minOf(CHUNK, bytes.size - off)
                val b64 = Base64.encodeToString(bytes, off, n, Base64.NO_WRAP)
                js("__native.onOutput('$id','$b64')")
                off += n
            }
        }
        if (catching && batch.isNotEmpty()) js("__native.onCatchUp && __native.onCatchUp(false)")
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
            svc.uiVisible = lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)
            svc.onSessionExit = { s ->
                main.post {
                    flush() // the session's last output first, then "exited"
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
        // (no Custom Tabs warm-up: it started the whole browser in the background on every
        // launch — a hundred MB or more — for a page that's rarely opened; it opens without)
        browser = InAppBrowser(this)

        web = TermWebView(this)
        web.setBackgroundColor(Color.parseColor(BG))
        // Owns the keyboard while typing into the terminal (see KeyCaptureView).
        keys = KeyCaptureView(this, object : KeyCaptureView.Sink {
            override fun onText(text: String) = js("__native.onImeText(${JSONObject.quote(text)})")
            override fun onComposing(text: String) = js("__native.onImeComposing(${JSONObject.quote(text)})")
            override fun onKey(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean, char: String) =
                js("__native.onImeKey($keyCode, $ctrl, $alt, $shift, ${JSONObject.quote(char)})")
        })
        keys.compatMode = getPreferences(Context.MODE_PRIVATE).getBoolean(PREF_KEYBOARD_COMPAT, false)
        keys.smart = getPreferences(Context.MODE_PRIVATE).getBoolean(PREF_KEYBOARD_SMART, true)
        cover = View(this).apply {
            setBackgroundColor(Color.parseColor(BG))
            visibility = View.GONE
            isClickable = true // (touches don't reach the page while it loads)
        }
        val root = FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(keys, FrameLayout.LayoutParams(1, 1))
            addView(cover, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        panel = RemotePanel(
            this,
            openInBrowser = { browser.open(it) },
            chooseFiles = { cb ->
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                pickFiles.launch("*/*")
            },
            // while the panel covers the terminal, no session is "being watched"
            onOpened = { service?.activeSessionId = null },
            onClosed = { service?.activeSessionId = shownSessionId },
            onRendererGone = {
                Log.e("AgyWeb", "dashboard renderer gone, recreating")
                rebuildUi()
            },
        )
        panel.openFileElsewhere = { openFileElsewhere(it) }
        root.addView(panel, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
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
                deliverOpenSession()
            }

            // The page's renderer died (out of memory, killed): rebuild the UI instead of
            // letting Android take the whole app down — sessions keep running in the
            // service and are re-attached by the new page.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e("AgyWeb", "WebView renderer gone (crash=${detail.didCrash()}), recreating")
                rebuildUi()
                return true
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
                if (panel.back()) return
                web.evaluateJavascript("window.__native ? __native.onBack() : false") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        val serviceIntent = Intent(this, SessionService::class.java)
        // (rebuilt in the background — the WebView's renderer was killed while the app was out of
        // sight — Android refuses startService; binding still creates the service)
        try {
            startService(serviceIntent)
        } catch (_: IllegalStateException) {
        } catch (_: SecurityException) {
        }
        bindService(serviceIntent, connection, Context.BIND_AUTO_CREATE)
        takeOpenSession(intent)
    }

    private var rebuilding = false

    /** A dead WebView renderer: new WebViews (sessions keep running in the service). */
    private fun rebuildUi() {
        if (rebuilding) return // both WebViews report the same renderer
        rebuilding = true
        main.post { recreate() }
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
        panel.destroy()
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
                    // only the keyboard's slide is "moving" (it has an end that settles it);
                    // the bars animating on their own are passed on as they are
                    sendInsets(insets, settled = !imeAnimating)
                    return insets
                }

                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) imeAnimating = false
                    if (imeAnimating) return
                    ViewCompat.getRootWindowInsets(root)?.let { sendInsets(it, settled = true) }
                }
            },
        )
    }

    private var lastFloating = false

    /** Pages, pictures and text open in the app's panel; PDFs and the rest in the app for them. */
    private fun openTappedFile(f: java.io.File, guest: String) {
        val ext = f.name.substringAfterLast('.', "").lowercase()
        if (ext in IN_APP_FILES || ext in RemotePanel.TEXT_FILES) {
            if (keys.hasFocus()) {
                imm.hideSoftInputFromWindow(keys.windowToken, 0)
                web.holdFocusAway = false
                keys.clearFocus()
                js("__native.onKeyboardReleased()")
            }
            panel.openLocal(f, f.name, guest.replaceFirst(Regex("^/root(?=/|$)"), "~"))
        } else {
            openFileElsewhere(f)
        }
    }

    private fun openFileElsewhere(f: java.io.File) {
        val ext = f.name.substringAfterLast('.', "").lowercase()
        val uri = try {
            androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", f)
        } catch (e: IllegalArgumentException) {
            Toast.makeText(this, "This file can't be handed to another app", Toast.LENGTH_SHORT).show()
            return
        }
        val type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(view)
        } catch (_: android.content.ActivityNotFoundException) {
            Toast.makeText(this, "No app on this phone opens .$ext files", Toast.LENGTH_LONG).show()
        }
    }

    private fun sendInsets(insets: WindowInsetsCompat, settled: Boolean) {
        val d = resources.displayMetrics.density
        // the bars and a camera cutout; in landscape the navigation bar may be at a side
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        panel.applyInsets(bars.top, maxOf(bars.bottom, ime.bottom), bars.left, bars.right)
        val top = bars.top / d
        val bottom = maxOf(bars.bottom, ime.bottom) / d
        val left = bars.left / d
        val right = bars.right / d
        val keyboard = ime.bottom > bars.bottom
        // A floating keyboard is shown but takes no room at the bottom (Android 11+ tells
        // whether the keyboard is visible): the page keeps the input line in its upper half.
        // (decided once things settle: mid-slide, a docked keyboard is "visible" while still
        // lower than the navigation bar, which would flash the floating layout)
        val floating = if (!settled) lastFloating else (!keyboard && Build.VERSION.SDK_INT >= 30 &&
            insets.isVisible(WindowInsetsCompat.Type.ime()) && keys.hasFocus()).also { lastFloating = it }
        val key = "$top,$bottom,$keyboard,$settled,$left,$right,$floating"
        if (key == lastInsets) return
        lastInsets = key
        js("__native.onInsets($top, $bottom, $keyboard, $settled, $left, $right, $floating)")
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

    override fun onStart() {
        super.onStart()
        TermSession.paceOutput = true
        service?.uiVisible = true
        synchronized(pendingLock) {
            outOfSight = false
            // what was printed while away, in one go
            if (!dropOutput && pending.isNotEmpty()) {
                catchUp = true
                if (!flushScheduled) {
                    flushScheduled = true
                    main.post(::flush)
                }
            }
        }
        if (pageReleased) reloadPage()
    }

    // ---------------------------------------------------------------- "task finished" taps
    private var openSessionId: String? = null
    /** The session the page shows (set from JS). */
    @Volatile private var shownSessionId: String? = null

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeOpenSession(intent)
    }

    private fun takeOpenSession(intent: Intent?) {
        val id = intent?.getStringExtra(SessionService.EXTRA_OPEN_SESSION) ?: return
        intent.removeExtra(SessionService.EXTRA_OPEN_SESSION)
        if (::panel.isInitialized) panel.close() // the session must not open under the panel
        openSessionId = id
        deliverOpenSession()
    }

    /** Show the session whose notification was tapped (the page keeps it if still starting). */
    private fun deliverOpenSession() {
        val id = openSessionId ?: return
        if (web.url == null || pageReleased) return // delivered from onPageFinished
        openSessionId = null
        service?.clearFinished(id)
        js("__native.onOpenSession(${JSONObject.quote(id)})")
    }

    override fun onStop() {
        super.onStop()
        TermSession.paceOutput = false
        service?.uiVisible = false
        outOfSight = true
        // Opening the app again must not pop the keyboard up by itself: let go of the
        // terminal's keyboard focus (a tap on the terminal brings it back).
        if (keys.hasFocus()) {
            imm.hideSoftInputFromWindow(keys.windowToken, 0)
            web.holdFocusAway = false
            keys.clearFocus()
            js("__native.onKeyboardReleased && __native.onKeyboardReleased()")
        }
    }

    @android.annotation.SuppressLint("BatteryLife")
    private fun requestBackgroundRun() {
        val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        try {
            startActivity(
                Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:$packageName")),
            )
        } catch (_: Exception) {
            try {
                startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
                Toast.makeText(this, "Open Settings → Apps → AntiCode → Battery → Unrestricted", Toast.LENGTH_LONG).show()
            }
        }
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
                selftestBlesh()
            }, "SELFTEST_TYPE_FAIL typing stopped working after scrolling")
        }, "SELFTEST_TYPE_FAIL typed text never reached the shell")
    }

    /**
     * The shell's autosuggestions (ble.sh) are attached. The CI script then types the
     * start of an earlier command (SELFTEST_SUGGEST_READY) and screenshots the suggestion.
     */
    private fun selftestBlesh() {
        val expected = try {
            assets.open("blesh.version").bufferedReader().use { it.readText().trim() }
        } catch (_: Exception) {
            "none"
        }
        web.evaluateJavascript("__selftest.send('v=\${BLE_VERSION:-none}; echo BLE=\${v%%+*}.')", null)
        pollLine("BLE=$expected.", 10, {
            Log.i(SELFTEST, "SELFTEST_BLE_OK")
            Log.i(SELFTEST, "SELFTEST_SUGGEST_READY")
            // drop whatever the CI script left on the command line: close a completion
            // menu (Esc), then end-of-line + kill-to-start (^E ^U), then ^C for good measure
            main.postDelayed({ web.evaluateJavascript("__selftest.keys('\\u001b')", null) }, 18_000)
            main.postDelayed({ web.evaluateJavascript("__selftest.keys('\\u0005\\u0015')", null) }, 18_800)
            main.postDelayed({ web.evaluateJavascript("__selftest.keys('\\u0003')", null) }, 19_600)
            main.postDelayed({
                web.evaluateJavascript("__selftest.send('ls /sdcard/ >/dev/null && ls -d ~/storage/downloads/ && echo SD\$((1+1))OK')", null)
                main.postDelayed({ pollStorage(0) }, 2000)
            }, 21_000) // after the CI script's typing (it polls every 5 s and takes ~10 s)
        }, "SELFTEST_BLE_FAIL ble.sh is not attached in the Ubuntu shell")
    }

    private fun pollStorage(n: Int) {
        selftestScreen { screen ->
            if (screen.contains("SD2OK")) {
                Log.i(SELFTEST, "SELFTEST_STORAGE_OK")
                // the folder picker sees home, and the phone's folders through ~/storage links
                val ub = service?.ubuntu
                val home = ub?.listDir("~") ?: "no service"
                val shared = ub?.listDir("~/storage/shared") ?: "no service"
                Log.i(SELFTEST, "folders| ~ → ${home.take(300)}")
                Log.i(SELFTEST, "folders| ~/storage/shared → ${shared.take(300)}")
                if (home.contains("\"storage\"") && shared.contains("\"Download\"")) Log.i(SELFTEST, "SELFTEST_FOLDERS_OK")
                else Log.e(SELFTEST, "SELFTEST_FOLDERS_FAIL")
                // a tapped file name: found inside Ubuntu and on the phone, handed out by the
                // FileProvider; the shell's folder reaches the page (OSC 7 from the prompt)
                val filesOk = try {
                    val inUbuntu = ub?.hostFile("~/.bashrc")
                    val onPhone = ub?.hostFile("~/storage/downloads/report.pdf")
                    inUbuntu != null && inUbuntu.isFile && onPhone != null &&
                        androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", inUbuntu) != null &&
                        androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", onPhone) != null
                } catch (e: Exception) {
                    Log.e(SELFTEST, "files| ${e.message}")
                    false
                }
                web.evaluateJavascript("__selftest.session()?.cwd ?? ''") { cwd ->
                    Log.i(SELFTEST, "files| provider=$filesOk shell folder=$cwd")
                    if (filesOk && cwd.trim('"') == "/root") Log.i(SELFTEST, "SELFTEST_FILES_OK")
                    else Log.e(SELFTEST, "SELFTEST_FILES_FAIL")
                }
                // Phase 3b: a program's notification escape (OSC 9) while nobody looks at
                // the session → a "task finished" notification (the CI script checks it)
                web.evaluateJavascript("__selftest.home(); __selftest.send(\"printf '\\\\033]9;SELFTEST-NOTIFY\\\\007'\")", null)
                Log.i(SELFTEST, "SELFTEST_NOTIFY_SENT")
                main.postDelayed({ selftestZoom() }, 9000)
            } else if (n < 10) {
                main.postDelayed({ pollStorage(n + 1) }, 2000)
            } else {
                for (line in screen.lines()) if (line.isNotBlank()) Log.i(SELFTEST, "ui| $line")
                Log.e(SELFTEST, "SELFTEST_STORAGE_FAIL /sdcard not readable inside Ubuntu")
            }
        }
    }

    /**
     * Phase 3c: zooming (text size → terminal width → the shell redraws its prompt) must not
     * leave blank lines or copies of the prompt bar behind (ble.sh redraw after resize).
     */
    private fun selftestZoom() {
        Log.i(SELFTEST, "phase 3c: zooming a shell")
        web.evaluateJavascript("__selftest.open('ubuntu')", null)
        main.postDelayed({ web.evaluateJavascript("__selftest.send('clear')", null) }, 6000)
        main.postDelayed({ web.evaluateJavascript("__selftest.send('echo ZOOM-A1')", null) }, 8000)
        val sizes = listOf(20, 10, 17, 14)
        for ((i, px) in sizes.withIndex()) {
            main.postDelayed({ web.evaluateJavascript("__selftest.zoom($px)", null) }, 10_000L + i * 2500L)
        }
        main.postDelayed({
          // the prompt clocks (drawn by the app) must sit on prompt lines only
          web.evaluateJavascript(
            "[...document.querySelectorAll('.session:not([hidden]) .term-row')].filter(r => r.querySelector('.rlabel') && !r.textContent.includes('root')).length",
          ) { strayClocks ->
            selftestScreen { screen ->
                val lines = screen.lines().dropLastWhile { it.isBlank() }
                val bars = lines.count { it.contains("root") }
                for (line in lines) Log.i(SELFTEST, "zoom| $line")
                Log.i(SELFTEST, "zoom stray clocks: $strayClocks")
                // bar, ❯ echo ZOOM-A1, ZOOM-A1, gap, bar, ❯
                if (bars == 2 && lines.size == 6 && lines.any { it.trim() == "ZOOM-A1" } && strayClocks == "0") {
                    Log.i(SELFTEST, "SELFTEST_ZOOM_OK")
                } else {
                    Log.e(SELFTEST, "SELFTEST_ZOOM_FAIL bars=$bars lines=${lines.size} strayClocks=$strayClocks")
                }
                selftestImeWords()
            }
          }
        }, 10_000L + sizes.size * 2500L + 2500L)
    }

    /**
     * Phase 3d: the smart keyboard, driven like Gboard does it: a word composed in Latin,
     * finished, then replaced by its Bangla suggestion (by re-selecting it, and by deleting
     * it). The terminal must end up with only the Bangla words.
     */
    private fun selftestImeWords() {
        Log.i(SELFTEST, "phase 3d: smart keyboard words")
        web.evaluateJavascript("__selftest.send('clear')", null)
        main.postDelayed({
            focusTerminalKeys()
            val ic = keys.onCreateInputConnection(android.view.inputmethod.EditorInfo())
            ic.commitText("echo ", 1)
            for (w in listOf("a", "am", "ami")) ic.setComposingText(w, 1)
            ic.finishComposingText()
            ic.setComposingRegion(5, 8) // re-select "ami" (positions in the whole line) …
            ic.commitText("আমি ", 1) // … and replace it
            for (w in listOf("s", "se")) ic.setComposingText(w, 1)
            ic.finishComposingText()
            ic.setComposingRegion(9, 11) // the next word the same way
            ic.commitText("সেখানে ", 1)
            for (w in listOf("v", "va", "val", "valo")) ic.setComposingText(w, 1)
            if (Build.VERSION.SDK_INT >= 34) {
                // Android 14 keyboards pick a suggestion in one step: the word being typed is
                // replaced where it stands (Gboard: "tuki" → tumi)
                val n = ic.getTextBeforeCursor(1000, 0)?.length ?: 0
                ic.replaceText(n - 4, n, "ভালো", 1, null)
                Log.i(SELFTEST, "ime| suggestion picked with replaceText")
            } else {
                ic.finishComposingText()
                ic.deleteSurroundingText(4, 0) // or delete it …
                ic.commitText("ভালো", 1) // … and type the suggestion
            }
            ic.deleteSurroundingText(1, 0) // ⌫ takes the vowel sign "ো" back …
            ic.commitText("ো", 1) // … and it's typed again
            ic.commitText(" ক্ষমা", 1) // a conjunct: ⌫ ⌫ ⌫ down to "ক্", then typed again
            ic.deleteSurroundingText(2, 0)
            ic.deleteSurroundingText(1, 0)
            ic.commitText("ষমা", 1)
            ic.performEditorAction(android.view.inputmethod.EditorInfo.IME_ACTION_NONE)
            main.postDelayed({
                selftestScreen { screen ->
                    val lines = screen.lines().map { it.trim() }.filter { it.isNotEmpty() }
                    for (line in lines.takeLast(4)) Log.i(SELFTEST, "ime| $line")
                    if (lines.any { it == "আমি সেখানে ভালো ক্ষমা" } &&
                        lines.none { it.contains("ami") || it.contains("valo") || it.contains("seস") }
                    ) {
                        Log.i(SELFTEST, "SELFTEST_IME_OK")
                    } else {
                        Log.e(SELFTEST, "SELFTEST_IME_FAIL")
                    }
                    selftestKeyboardCycle()
                }
            }, 3000)
        }, 2000)
    }

    /**
     * Phase 3e: opening and closing the keyboard must not change the terminal's size (that
     * makes the shell redraw and the screen jump).
     */
    private fun selftestKeyboardCycle() {
        Log.i(SELFTEST, "phase 3e: keyboard open / close")
        web.evaluateJavascript(
            "(() => { const s = __selftest.session(); window.__rz = []; const o = s.bridge.resize.bind(s.bridge);" +
                " s.bridge.resize = (...a) => { window.__rz.push(a.slice(1).join('x')); return o(...a); };" +
                " __selftest.focusKeys(); return s.term.cols + 'x' + s.term.rows; })()",
        ) { before ->
            main.postDelayed({
                web.evaluateJavascript("__selftest.hideKeys()", null)
                main.postDelayed({
                    web.evaluateJavascript(
                        "(() => { const s = __selftest.session(); return window.__rz.join(',') + '|' + s.term.cols + 'x' + s.term.rows; })()",
                    ) { after ->
                        val (resizes, size) = after.trim('"').split('|').let { (it.getOrNull(0) ?: "?") to (it.getOrNull(1) ?: "?") }
                        Log.i(SELFTEST, "kbcycle| before=$before after=$size resizes=[$resizes]")
                        if (resizes.isEmpty() && size == before.trim('"')) Log.i(SELFTEST, "SELFTEST_KBCYCLE_OK")
                        else Log.e(SELFTEST, "SELFTEST_KBCYCLE_FAIL")
                        selftestConjuncts()
                    }
                }, 3000)
            }, 3000)
        }
    }

    /** Phase 4: open Claude Code through the real web UI and check that it draws its screen. */
    /**
     * Phase 3f: conjunct widths. A command's output counts a conjunct by its letters (as the
     * shell and Claude Code do); while `agy` runs — its marker, sent by the shell's `agy` —
     * one cell, as the Antigravity CLI counts it (its tables line up).
     */
    private fun selftestConjuncts() {
        Log.i(SELFTEST, "phase 3f: conjunct widths for commands and for agy")
        web.evaluateJavascript("__selftest.send(\"clear; printf 'CL:x\\u0995\\u09cd\\u09b7y\\u0985\\u09cd\\u09af\\u09bez\\\\n'; " +
            "printf '\\\\e]7770;widths;%s;joined\\\\a' \\\"\$ANTICODE_LINK_TOKEN\\\"; printf 'CJ:x\\u0995\\u09cd\\u09b7y\\u0985\\u09cd\\u09af\\u09bez\\\\n'\")", null)
        main.postDelayed({
            web.evaluateJavascript(
                "(() => { const b = __selftest.session().term.buffer.active;" +
                    " let r = ''; for (const p of ['CL:x', 'CJ:x']) { for (let i = 0; i < b.length; i++) {" +
                    " const l = b.getLine(i); if (!l.translateToString(true).startsWith(p)) continue;" +
                    " r += p.slice(0, 2); for (let x = 0; x < 14; x++) { const c = l.getCell(x).getChars(); if (c === 'y' || c === 'z') r += c + '@' + x; } break; } } return r; })()",
            ) { r ->
                Log.i(SELFTEST, "conjunct| $r")
                // C L : x ক ্ ষ y অ্ যা z → by letters y in cell 6, z in 9; joined (agy) ক্ষ is one
                // cell: y in 5, z in 8 (অ্যা starts with a vowel: two characters, not a conjunct)
                if (r.trim('"') == "CLy@6z@9CJy@5z@8") Log.i(SELFTEST, "SELFTEST_CONJUNCT_OK") else Log.e(SELFTEST, "SELFTEST_CONJUNCT_FAIL")
                selftestClaudeInUi()
            }
        }, 2500)
    }

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
                    selftestPanel()
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

    /** Phase 5: a remote dashboard opens in the app's own panel. */
    private fun selftestPanel() {
        main.postDelayed({
            panel.open("https://example.com/", "Remote test")
            Log.i(SELFTEST, "SELFTEST_PANEL_READY")
            main.postDelayed({
                if (panel.isOpen) Log.i(SELFTEST, "SELFTEST_PANEL_OK")
                else Log.e(SELFTEST, "SELFTEST_PANEL_FAIL panel did not open")
            }, 8000)
        }, 12_000) // the CI script screenshots Claude Code first
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
        fun createSession(kind: String, cols: Int, rows: Int, cwd: String, profile: String): String = try {
            val s = svc().createSession(kind, cols.coerceIn(10, 500), rows.coerceIn(4, 300), cwd, profile)
            // anything printed before we got here (a quick prompt) is in the ring: send it too
            s.attach(outputListener) { snap -> if (snap.isNotEmpty()) queue(s.id, snap, snap.size) }
            s.id
        } catch (e: Exception) {
            main.post { Toast.makeText(this@MainActivity, "Could not start the session: ${e.message}", Toast.LENGTH_LONG).show() }
            ""
        }

        /** The folder picker: the folders in a folder inside Ubuntu (JSON). */
        @JavascriptInterface
        fun listDir(path: String): String = try {
            svc().ubuntu.listDir(path)
        } catch (e: Exception) {
            org.json.JSONObject().put("path", path).put("error", "notfound").toString()
        }

        /** A folder's folders and files (the folder sheet). */
        @JavascriptInterface
        fun listFolder(path: String): String = try {
            svc().ubuntu.listFolder(path)
        } catch (e: Exception) {
            org.json.JSONObject().put("path", path).put("error", "notfound").toString()
        }

        /** A word tapped in the terminal that names a folder: where it is ("" if it isn't one). */
        @JavascriptInterface
        fun findDir(candidates: String): String = try {
            val list = JSONArray(candidates)
            svc().ubuntu.findDir((0 until list.length()).map { list.optString(it) })
        } catch (_: Exception) {
            ""
        }

        /** The folder picker's "New folder": "" when made, else why not. */
        @JavascriptInterface
        fun makeDir(path: String): String = try {
            svc().ubuntu.makeDir(path)
        } catch (e: Exception) {
            e.message ?: "The folder couldn't be made."
        }

        /** The page has taken in [n] more bytes of a session's output (flow control). */
        @JavascriptInterface
        fun ack(id: String, n: Int) {
            service?.sessions?.get(id)?.ack(n)
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
            main.post {
                flush() // the history first, then what depends on it (modes, exit banner)
                js("__native.onReplayed('$id')")
                // (a password asked for while the page was gone: the new page hides it too)
                if (s.hiddenInput) js("__native.onHiddenInput && __native.onHiddenInput('$id', true)")
                if (!s.alive) js("__native.onExit('$id', ${s.exitCode})")
            }
        }

        @JavascriptInterface
        fun listSessions(): String {
            val arr = JSONArray()
            // in the order they were opened (the map itself has none)
            for (s in svc().sessions.values.sortedBy { it.createdAt }) {
                arr.put(
                    JSONObject().put("id", s.id).put("kind", s.kind).put("title", s.title).put("alive", s.alive)
                        .put("cols", s.cols).put("rows", s.rows).put("dir", s.startDir).put("profile", s.profile),
                )
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

        /** A sign-in page with the account chosen for it (see InAppBrowser.openSignIn). */
        @JavascriptInterface
        fun openSignIn(url: String, hint: String, choose: Boolean, private: Boolean) {
            main.post { browser.openSignIn(url, hint, choose, private) }
        }

        /** What our xdg-open puts in front of a link (the page trusts only those). */
        @JavascriptInterface
        fun linkToken(): String = com.sabidyut.agyterm.ubuntu.UbuntuManager.linkToken

        /**
         * A file name tapped in the terminal: [candidates] are where it may be inside Ubuntu (a
         * JSON list — the name next to the shell's folder, the session's folder, home). The
         * first that exists opens; "" when one did, else "notfound".
         */
        @JavascriptInterface
        fun openFile(candidates: String): String {
            val list = try {
                JSONArray(candidates)
            } catch (_: Exception) {
                return "notfound"
            }
            val ub = svc().ubuntu
            for (i in 0 until minOf(list.length(), 8)) {
                val guest = ub.normalizeGuestPath(list.optString(i)) ?: continue
                val f = ub.hostFile(guest) ?: continue
                if (f.isFile) {
                    main.post { openTappedFile(f, guest) }
                    return ""
                }
            }
            return "notfound"
        }

        /** A remote dashboard in the app's own panel (Chrome tab for Google-only sites). */
        @JavascriptInterface
        fun openRemote(url: String, title: String) {
            main.post {
                if (keys.hasFocus()) {
                    imm.hideSoftInputFromWindow(keys.windowToken, 0)
                    web.holdFocusAway = false
                    keys.clearFocus()
                    js("__native.onKeyboardReleased()")
                }
                val host = Uri.parse(url).host ?: ""
                // Google sites only work signed in, and Google blocks its sign-in inside apps:
                // straight to the Chrome tab for those.
                val googleOnly = host == "google.com" || host.endsWith(".google.com")
                if (googleOnly || !panel.open(url, title.ifBlank { host.ifEmpty { url } })) browser.open(url)
            }
        }

        /** The app's theme: the remote panel and the status bar icons follow it. */
        @JavascriptInterface
        fun setThemeColors(bg: String, text: String, muted: String, accent: String) {
            main.post {
                try {
                    val b = Color.parseColor(bg)
                    panel.setColors(b, Color.parseColor(text), Color.parseColor(muted), Color.parseColor(accent))
                    val light = (Color.red(b) * 299 + Color.green(b) * 587 + Color.blue(b) * 114) / 1000 > 150
                    browser.toolbarColor = b
                    browser.darkTheme = !light
                    androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
                        isAppearanceLightStatusBars = light
                        isAppearanceLightNavigationBars = light
                    }
                } catch (_: RuntimeException) { // (a colour the page didn't have: "")
                }
            }
        }

        @JavascriptInterface
        fun copyText(text: String) {
            main.post {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                // (a clip over ~1 MB can't be handed to the system: it would throw here, on
                // the main thread, and take every session down — e.g. OSC 52 from any program)
                val clip = if (text.length > MAX_CLIP) text.substring(text.length - MAX_CLIP) else text
                try {
                    cm.setPrimaryClip(ClipData.newPlainText("terminal", clip))
                    if (clip.length < text.length) Toast.makeText(this@MainActivity, "Copied the last ${MAX_CLIP / 1000}k characters", Toast.LENGTH_SHORT).show()
                } catch (_: RuntimeException) {
                    Toast.makeText(this@MainActivity, "Too much text to copy", Toast.LENGTH_SHORT).show()
                }
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
                // already the terminal's: a restart would reset the keyboard on every tap (the
                // suggestions blink, the symbols page goes back to letters, a word half typed
                // is cut off) — only shown again if it was put away
                val had = keys.hasFocus()
                focusTerminalKeys()
                if (!had) imm.restartInput(keys)
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

        /** The session on screen (no "finished" notification for what you're looking at). */
        @JavascriptInterface
        fun setActiveSession(id: String) {
            shownSessionId = id.ifEmpty { null }
            val hidden = id.isNotEmpty() && service?.sessions?.get(id)?.hiddenInput == true
            main.post { keys.setHidden(hidden) }
            service?.let {
                if (!panel.isOpen) it.activeSessionId = shownSessionId
                if (id.isNotEmpty()) it.clearFinished(id)
            }
        }

        /** What the UI calls a session — the text of its notifications. */
        @JavascriptInterface
        fun setSessionLabel(id: String, label: String) {
            svc().sessions[id]?.label = label.take(120)
            svc().saveLive()
        }

        /** Sessions Android stopped while the app was gone (JSON [{kind, label}]). */
        @JavascriptInterface
        fun getLostSessions(): String = svc().lostSessions()

        @JavascriptInterface
        fun forgetLostSessions() = svc().forgetLostSessions()

        /** Ask to be left out of battery optimisation (the system's own dialog). */
        @JavascriptInterface
        fun allowBackground() {
            main.post { requestBackgroundRun() }
        }

        /** The Antigravity account (seen in the CLI's header, or typed in Settings). */
        @JavascriptInterface
        fun setAntigravityAccount(email: String, profile: String) =
            Accounts.setAntigravity(this@MainActivity, email, profile.takeIf { com.sabidyut.agyterm.ubuntu.UbuntuManager.validProfile(it) } ?: "")

        @JavascriptInterface
        fun getAccounts(): String = JSONObject()
            .put("agy", Accounts.antigravity(this@MainActivity) ?: "")
            .toString()

        /** Forget "this dashboard opens in Chrome" (after a Google sign-in). */
        @JavascriptInterface
        fun resetDashboardChoices() {
            getSharedPreferences(RemotePanel.PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }

        @JavascriptInterface
        fun setNotifyWhenDone(on: Boolean) {
            service?.notifyWhenDone = on
        }

        @JavascriptInterface
        fun getNotifyWhenDone(): Boolean = service?.notifyWhenDone ?: true

        /** Claude Code's full-screen view for new sessions (off: its classic, smoothly scrolled view). */
        @JavascriptInterface
        fun setClaudeFullscreen(on: Boolean) {
            svc().ubuntu.claudeFullscreen = on
        }

        @JavascriptInterface
        fun getClaudeFullscreen(): Boolean = service?.ubuntu?.claudeFullscreen ?: false

        /** Antigravity approves every tool without asking (its --dangerously-skip-permissions). */
        @JavascriptInterface
        fun setAgyApproveAll(on: Boolean) {
            svc().ubuntu.agyApproveAll = on
        }

        @JavascriptInterface
        fun getAgyApproveAll(): Boolean = service?.ubuntu?.agyApproveAll ?: false

        /** The page has restored its sessions and drawn them: the cover (after a release) goes. */
        @JavascriptInterface
        fun pageReady() {
            main.post { hideCover() }
        }

        /** OpenCode's compact view (opencode mini) instead of its full screen. */
        @JavascriptInterface
        fun setOpencodeMini(on: Boolean) {
            svc().ubuntu.opencodeMini = on
        }

        @JavascriptInterface
        fun getOpencodeMini(): Boolean = service?.ubuntu?.opencodeMini ?: false

        /** The shell prompt's look (Settings → Prompt style). */
        @JavascriptInterface
        fun setPromptStyle(style: String) {
            svc().ubuntu.promptStyle = style
        }

        @JavascriptInterface
        fun getPromptStyle(): String = service?.ubuntu?.promptStyle ?: "powerline"

        /** The account (email) an agent ("claude" / "agy") is signed in with; "" if unknown. */
        @JavascriptInterface
        fun accountEmail(kind: String, profile: String): String = service?.ubuntu?.accountEmail(kind, profile) ?: ""

        /** An agent's extra accounts (JSON [{name, email}]). */
        @JavascriptInterface
        fun listProfiles(kind: String): String = service?.ubuntu?.listProfiles(kind) ?: "[]"

        /** A new account for an agent: "" when made, else why not. */
        @JavascriptInterface
        fun createProfile(kind: String, name: String): String = try {
            svc().ubuntu.createProfile(kind, name)
        } catch (e: Exception) {
            e.message ?: "The account couldn't be made"
        }

        /** Sign an account out (it signs in afresh next time). */
        @JavascriptInterface
        fun signOut(kind: String, profile: String): Boolean = try {
            svc().ubuntu.signOut(kind, profile)
        } catch (_: Exception) {
            false
        }

        /** Forget an account (its sign-in goes with it). */
        @JavascriptInterface
        fun deleteProfile(kind: String, name: String): Boolean = try {
            svc().ubuntu.deleteProfile(kind, name)
        } catch (_: Exception) {
            false
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

        /** Smart keyboard (suggestions, Bangla) or raw keys. */
        @JavascriptInterface
        fun setKeyboardSmart(on: Boolean) {
            main.post {
                if (keys.smart == on) return@post
                keys.smart = on
                getPreferences(Context.MODE_PRIVATE).edit().putBoolean(PREF_KEYBOARD_SMART, on).apply()
                if (keys.hasFocus()) imm.restartInput(keys)
            }
        }

        /** The page sent the word being composed itself (before a key-bar key): drop it here. */
        @JavascriptInterface
        fun discardComposing() {
            main.post { keys.discardComposing() }
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
        /** Shown in the app's panel as they are (pages and pictures). */
        private val IN_APP_FILES = setOf("html", "htm", "xhtml", "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif")
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_HOST/assets/web/index.html"
        private const val CHUNK = 192 * 1024
        /** Output kept for the page per session while away (more: the page starts afresh). */
        private const val HOLD_MAX = 4 * 1024 * 1024
        /** The most the clipboard is given at once (the system refuses ~1 MB and more). */
        private const val MAX_CLIP = 300_000
        private const val BG = "#0b0d12"
        private const val PREF_KEYBOARD_COMPAT = "keyboard_compat"
        private const val PREF_KEYBOARD_SMART = "keyboard_smart"
        private const val SELFTEST = "AgySelfTest"
    }
}
