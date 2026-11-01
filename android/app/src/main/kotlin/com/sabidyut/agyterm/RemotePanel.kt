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
    private val onClosed: () -> Unit,
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

    val isOpen get() = visibility == View.VISIBLE

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
        header.addView(iconButton(R.drawable.ic_panel_external, "Open in Chrome") {
            openInBrowser(web.url ?: startUrl)
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
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, true)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: ""
                if (scheme != "http" && scheme != "https") {
                    openInBrowser(url.toString()) // intent:, mailto: … → the system
                    return true
                }
                if (url.host == GOOGLE_SIGN_IN) {
                    // Google blocks its sign-in inside apps: continue this dashboard in Chrome.
                    prefs().edit().putBoolean(hostOf(startUrl), true).apply()
                    Toast.makeText(context, "Google sign-in opens in Chrome", Toast.LENGTH_SHORT).show()
                    openInBrowser(startUrl)
                    close()
                    return true
                }
                return false
            }

            override fun onPageFinished(view: WebView, url: String?) {
                CookieManager.getInstance().flush()
                subtitleView.text = Uri.parse(url ?: "").host ?: ""
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
                if (!title.isNullOrBlank() && !title.startsWith("http")) subtitleView.text = title
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
        addView(progress, LayoutParams(MATCH_PARENT, dp(2), Gravity.TOP))
        addView(web, LayoutParams(MATCH_PARENT, MATCH_PARENT))
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

    private fun prefs() = context.getSharedPreferences("remote", Context.MODE_PRIVATE)
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
    /** Status bar on top; navigation bar or keyboard at the bottom (pixels). */
    fun applyInsets(top: Int, bottom: Int) {
        insetTop = top
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
        if (prefs().getBoolean(hostOf(url), false)) return false
        titleView.text = title
        subtitleView.text = hostOf(url)
        if (url != startUrl || web.url == null) {
            startUrl = url
            web.loadUrl(url)
        }
        if (!isOpen) {
            visibility = View.VISIBLE
            translationX = width.toFloat().takeIf { it > 0 } ?: (resources.displayMetrics.widthPixels.toFloat())
            alpha = 0.6f
            animate().translationX(0f).alpha(1f).setDuration(240)
                .setInterpolator(DecelerateInterpolator(2f)).start()
        }
        web.onResume()
        return true
    }

    fun close() {
        if (!isOpen) return
        CookieManager.getInstance().flush()
        animate().translationX(width.toFloat()).alpha(0.6f).setDuration(200)
            .setInterpolator(DecelerateInterpolator()).withEndAction {
                visibility = View.GONE
                web.onPause()
                onClosed()
            }.start()
    }

    /** Back: inside the page first, then close the panel. */
    fun back(): Boolean {
        if (!isOpen) return false
        if (web.canGoBack()) web.goBack() else close()
        return true
    }

    fun destroy() {
        web.destroy()
    }

    companion object {
        private const val GOOGLE_SIGN_IN = "accounts.google.com"
    }
}
