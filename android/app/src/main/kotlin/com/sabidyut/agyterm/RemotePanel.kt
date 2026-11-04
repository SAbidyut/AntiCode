package com.sabidyut.agyterm

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.animation.DecelerateInterpolator
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * A remote dashboard (claude.ai/code, Antigravity) shown inside the app: our own slim
 * header — back, title, reload, open in Chrome — over the page. No URL bar, no browser
 * chrome, slides in like a screen of the app.
 *
 * Google does not allow signing in to a Google account inside an app's embedded browser,
 * so when a page sends the user to accounts.google.com the dashboard continues in a
 * Chrome tab instead (remembered for that site).
 */
@SuppressLint("ViewConstructor", "SetJavaScriptEnabled")
class RemotePanel(
    context: Context,
    private val openInBrowser: (String) -> Unit,
    private val chooseFiles: (ValueCallback<Array<Uri>>) -> Unit,
    private val onOpened: () -> Unit,
    private val onClosed: () -> Unit,
    /** The pages' renderer died: the activity rebuilds its WebViews. */
    private val onRendererGone: () -> Unit,
) : FrameLayout(context) {

    private val d = resources.displayMetrics.density
    private fun dp(v: Int) = (v * d).toInt()

    private val header = LinearLayout(context)
    private val titleView = TextView(context)
    private val subtitleView = TextView(context)
    private val progress = View(context)
    private val web = WebView(context)
    private val buttons = mutableListOf<ImageButton>()
    private var startUrl = ""
    private var bg = Color.parseColor("#0B0D12")
    private var fg = Color.parseColor("#E6E9EF")
    private var muted = Color.parseColor("#8A90A2")

    /** Shown (or sliding in), not on its way out. */
    var isOpen = false
        private set
    /** Showing a file from inside the app (see openLocal), not a web page. */
    private var localFile: java.io.File? = null
    /** "Open with another app" for a local file. */
    var openFileElsewhere: ((java.io.File) -> Unit)? = null
    /**
     * A new page replaced what was shown (a file after a dashboard, or the other way round):
     * its history starts with it — Back must not step into the other kind of page (a file
     * with file access off, or a web page while the panel still thinks it's showing a file).
     */
    private var freshHistory = false
    /** Unload the page a while after closing, so it doesn't poll in the background. */
    private val unload = Runnable {
        if (!isOpen) {
            web.loadUrl("about:blank")
            startUrl = ""
            leaveLocal()
        }
    }

    init {
        visibility = View.GONE
        isClickable = true // don't let touches fall through to the terminal

        header.orientation = LinearLayout.HORIZONTAL
        header.gravity = Gravity.CENTER_VERTICAL
        header.setPadding(dp(4), 0, dp(4), 0)
        header.addView(iconButton(R.drawable.ic_panel_back, "Back") { close() })
        val titles = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            addView(titleView)
            addView(subtitleView)
        }
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16.5f)
        titleView.paint.isFakeBoldText = true
        subtitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        for (t in listOf(titleView, subtitleView)) {
            t.isSingleLine = true
            t.ellipsize = TextUtils.TruncateAt.END
        }
        header.addView(titles, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        header.addView(iconButton(R.drawable.ic_panel_refresh, "Reload") { web.reload() })
        header.addView(iconButton(R.drawable.ic_panel_external, "Open in another app") {
            val f = localFile
            if (f != null) openFileElsewhere?.invoke(f) else openInBrowser(web.url ?: startUrl)
        })

        progress.pivotX = 0f
        progress.scaleX = 0f

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            // two fingers zoom pictures, text files and pages (a page that forbids it stays
            // as it is); no +/− buttons over the content
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme?.lowercase() ?: ""
                if (localFile != null) {
                    // a local page: its links to files next to it open here, web links in the
                    // browser (a web page doesn't load with file access switched on)
                    if (scheme == "file") return false
                    if (request.hasGesture()) openInBrowser(url.toString())
                    return true
                }
                if (scheme != "http" && scheme != "https") {
                    // intent:, mailto: … → another app, but only for a link the user tapped
                    // (not a page redirecting there by itself)
                    if (request.hasGesture()) openInBrowser(url.toString())
                    return true
                }
                if (url.host == GOOGLE_SIGN_IN) {
                    // Google blocks its sign-in inside apps: this dashboard continues in Chrome,
                    // where the session will live — so it opens there directly from now on
                    // (Settings → "Open dashboards in the app again" undoes it). The browser
                    // adds the agent's account (authuser) so the right Google account is used.
                    prefs().edit().putLong(hostOf(startUrl), System.currentTimeMillis()).apply()
                    Toast.makeText(context, "Google sign-in continues in Chrome", Toast.LENGTH_SHORT).show()
                    openInBrowser(startUrl)
                    close()
                    return true
                }
                return false
            }

            // All of the app's WebViews share one renderer: if it dies (out of memory) and any
            // of them doesn't handle that, Android kills the whole app with every session.
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                onRendererGone()
                return true
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (freshHistory && url != null && url != "about:blank") {
                    freshHistory = false
                    view.clearHistory()
                }
            }

            override fun onPageFinished(view: WebView, url: String?) {
                CookieManager.getInstance().flush()
                if (localFile == null) subtitleView.text = Uri.parse(url ?: "").host ?: ""
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.animate().cancel()
                if (newProgress >= 100) {
                    progress.animate().scaleX(1f).setDuration(120).withEndAction {
                        progress.animate().alpha(0f).setDuration(200).start()
                    }.start()
                } else {
                    progress.alpha = 1f
                    progress.animate().scaleX(newProgress / 100f).setDuration(160).start()
                }
            }

            override fun onReceivedTitle(view: WebView, title: String?) {
                // keep our own title; the page's goes in the second line if it says more
                if (localFile == null && !title.isNullOrBlank() && !title.startsWith("http")) subtitleView.text = title
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                chooseFiles(callback) // attach a photo or file to a message
                return true
            }
        }

        addView(header, LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.TOP))
        addView(web, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        addView(progress, LayoutParams(MATCH_PARENT, dp(2), Gravity.TOP)) // over the page
        applyTheme()
        applyInsets(0, 0)
    }

    private fun iconButton(icon: Int, label: String, onClick: () -> Unit) = ImageButton(context).apply {
        setImageResource(icon)
        contentDescription = label
        background = null
        setPadding(dp(12), dp(12), dp(12), dp(12))
        setOnClickListener { onClick() }
        buttons += this
        layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
    }

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun hostOf(url: String) = Uri.parse(url).host ?: url

    /** The app's theme colours (the page's own colours stay as they are). */
    fun setColors(background: Int, text: Int, mutedText: Int, accent: Int) {
        bg = background
        fg = text
        muted = mutedText
        progress.background = GradientDrawable().apply { setColor(accent) }
        applyTheme()
    }

    private fun applyTheme() {
        setBackgroundColor(bg)
        header.setBackgroundColor(bg)
        web.setBackgroundColor(bg)
        titleView.setTextColor(fg)
        subtitleView.setTextColor(muted)
        for (b in buttons) b.setColorFilter(fg)
        if (progress.background == null) progress.setBackgroundColor(Color.parseColor("#F38BA8"))
    }

    private var insetTop = 0
    /** Status bar on top; navigation bar or keyboard at the bottom; a side nav bar (pixels). */
    fun applyInsets(top: Int, bottom: Int, left: Int = 0, right: Int = 0) {
        insetTop = top
        setPadding(left, 0, right, 0)
        header.setPadding(dp(4), top, dp(4), 0)
        header.layoutParams = (header.layoutParams as LayoutParams).apply { height = top + dp(56) }
        (progress.layoutParams as LayoutParams).topMargin = top + dp(56)
        progress.requestLayout()
        web.layoutParams = (web.layoutParams as LayoutParams).apply {
            topMargin = top + dp(56)
            bottomMargin = bottom
        }
    }

    /** Opens [url]; false if this site only works in Chrome (Google sign-in). */
    fun open(url: String, title: String): Boolean {
        val chromeSince = try {
            prefs().getLong(hostOf(url), 0L)
        } catch (_: ClassCastException) {
            0L
        }
        if (System.currentTimeMillis() - chromeSince < CHROME_FOR_MS) return false
        removeCallbacks(unload)
        if (localFile != null) {
            leaveLocal()
            startUrl = "" // (load it afresh, without file access)
        }
        titleView.text = title
        subtitleView.text = hostOf(url)
        if (url != startUrl || web.url == null) {
            startUrl = url
            freshHistory = true
            web.loadUrl(url)
        }
        show()
        return true
    }

    /**
     * A file from inside the app — a page or picture an agent made, a text file — shown here.
     * Pages may load the files next to them (their CSS, images); file access is switched off
     * again before any web page loads.
     */
    fun openLocal(file: java.io.File, title: String, subtitle: String) {
        removeCallbacks(unload)
        localFile = file
        web.settings.allowFileAccess = true
        titleView.text = title
        subtitleView.text = subtitle
        val ext = file.name.substringAfterLast('.', "").lowercase()
        startUrl = Uri.fromFile(file).toString()
        freshHistory = true
        if (ext in TEXT_FILES) {
            // plain text in the app's colours, wrapped, at a readable size
            val text = try {
                file.inputStream().use { inp ->
                    val buf = ByteArray(minOf(file.length(), MAX_TEXT.toLong()).toInt())
                    var n = 0
                    while (n < buf.size) {
                        val r = inp.read(buf, n, buf.size - n)
                        if (r < 0) break
                        n += r
                    }
                    String(buf, 0, n, Charsets.UTF_8)
                }
            } catch (e: Exception) {
                e.message ?: "Couldn't read it"
            }
            val esc = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            val hex = { c: Int -> String.format(java.util.Locale.ROOT, "#%06X", c and 0xFFFFFF) }
            web.loadDataWithBaseURL(
                startUrl,
                "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>" +
                    "<body style='margin:0;background:${hex(bg)};color:${hex(fg)}'>" +
                    "<pre style='margin:0;padding:14px 16px 40px;white-space:pre-wrap;overflow-wrap:anywhere;" +
                    "font:13px/1.55 monospace'>$esc</pre>",
                "text/html", "utf-8", null,
            )
        } else if (ext in IMAGE_FILES) {
            // a picture on its own page, fitted to the screen: pinch to zoom in (up to 10×),
            // and it starts fitted again on the next file
            val src = startUrl.replace("&", "&amp;").replace("'", "&#39;").replace("<", "&lt;")
            val hex = String.format(java.util.Locale.ROOT, "#%06X", bg and 0xFFFFFF)
            web.loadDataWithBaseURL(
                startUrl,
                "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1," +
                    "minimum-scale=1,maximum-scale=10,user-scalable=yes'>" +
                    "<style>html,body{margin:0;height:100%;background:$hex}" +
                    "body{display:flex;align-items:center;justify-content:center}" +
                    "img{display:block;max-width:100%;max-height:100%;object-fit:contain}" +
                    "img.v{width:100%;height:auto}" +
                    // (a transparent picture on a soft checkerboard, as image viewers show it)
                    "img{background:repeating-conic-gradient(#ffffff10 0% 25%,transparent 0% 50%) 0 0/16px 16px}</style>" +
                    "<img src='$src' alt=''" + (if (ext == "svg") " class=v" else "") + ">",
                "text/html", "utf-8", null,
            )
        } else {
            web.loadUrl(startUrl)
        }
        show()
    }

    private fun leaveLocal() {
        localFile = null
        web.settings.allowFileAccess = false
    }

    private fun show() {
        if (!isOpen) {
            isOpen = true
            animate().cancel() // maybe still sliding out
            if (visibility != View.VISIBLE) {
                visibility = View.VISIBLE
                translationX = width.toFloat().takeIf { it > 0 } ?: resources.displayMetrics.widthPixels.toFloat()
                alpha = 0.6f
            }
            animate().translationX(0f).alpha(1f).setDuration(240)
                .setInterpolator(DecelerateInterpolator(2f)).start()
            onOpened()
        }
        web.onResume()
    }

    fun close() {
        if (!isOpen) return
        isOpen = false
        CookieManager.getInstance().flush()
        onClosed()
        animate().translationX(width.toFloat()).alpha(0.6f).setDuration(200)
            .setInterpolator(DecelerateInterpolator()).withEndAction {
                if (isOpen) return@withEndAction // reopened meanwhile
                visibility = View.GONE
                web.onPause()
                postDelayed(unload, UNLOAD_AFTER_MS)
            }.start()
    }

    /** Back: inside the page first, then close the panel. */
    fun back(): Boolean {
        if (!isOpen) return false
        val list = web.copyBackForwardList()
        val prev = if (list.currentIndex > 0) list.getItemAtIndex(list.currentIndex - 1)?.url else null
        if (web.canGoBack() && prev != null && prev != "about:blank") web.goBack() else close()
        return true
    }

    fun destroy() {
        web.destroy()
    }

    companion object {
        /** Shown as plain text (not as a page). */
        /** Pictures: shown on their own page, fitted, to pinch-zoom. */
        val IMAGE_FILES = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif")
        val TEXT_FILES = setOf("txt", "md", "markdown", "csv", "json", "log", "xml", "yaml", "yml", "py", "js", "ts", "sh", "c", "cpp", "java", "kt", "go", "rs", "css")
        private const val MAX_TEXT = 2 * 1024 * 1024
        private const val GOOGLE_SIGN_IN = "accounts.google.com"
        const val PREFS = "remote"
        private const val CHROME_FOR_MS = 7L * 24 * 3600 * 1000
        private const val UNLOAD_AFTER_MS = 60_000L
    }
}
