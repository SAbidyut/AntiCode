package com.sabidyut.agyterm

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.net.Uri
import android.widget.Toast
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection

/**
 * Opens web pages (the Antigravity remote dashboard, login links) *inside* the app as a
 * Chrome Custom Tab instead of switching to a separate browser app.
 *
 * Why not a WebView: Google refuses to sign in to Google accounts from embedded WebViews
 * ("This browser or app may not be secure"). A Custom Tab runs the real browser engine
 * on top of our activity, so sign-in works and is remembered, while it still looks and
 * behaves like a screen of this app (our colours, ← returns to the terminal).
 */
class InAppBrowser(private val activity: Activity) {

    /** A browser package that supports Custom Tabs, preferring Chrome. */
    private val provider: String? by lazy {
        CustomTabsClient.getPackageName(activity, PREFERRED, /* ignoreDefault = */ true)
            ?: CustomTabsClient.getPackageName(activity, emptyList<String>())
    }

    private var connection: CustomTabsServiceConnection? = null

    /** Start the browser process early so the dashboard opens quickly. */
    fun warmup() {
        val pkg = provider ?: return
        val conn = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                client.warmup(0)
            }

            override fun onServiceDisconnected(name: ComponentName?) {}
        }
        if (CustomTabsClient.bindCustomTabsService(activity, pkg, conn)) connection = conn
    }

    fun release() {
        connection?.let {
            try {
                activity.unbindService(it)
            } catch (_: IllegalArgumentException) {
            }
        }
        connection = null
    }

    /** The app's theme (from the page): the tab's toolbar matches it. */
    var toolbarColor = Color.parseColor("#0B0D12")
    var darkTheme = true

    /**
     * A sign-in page, with the account the user chose for it (the page asked first):
     * [hint] an email — Google signs in with that account; [choose] — Google shows its list
     * of the accounts on the phone (and "Use another account"); [private] — a tab with no
     * saved sign-ins at all (Chrome's ephemeral Custom Tab), for an account the browser
     * isn't signed in to, on any site.
     */
    fun openSignIn(url: String, hint: String, choose: Boolean, private: Boolean) {
        var uri = Uri.parse(url)
        val host = uri.host ?: ""
        if (host == "accounts.google.com" && !uri.isOpaque) {
            if (hint.isNotEmpty()) uri = withParam(uri, "login_hint", hint)
            if (choose || private) {
                // (added to the prompt the page asked for, e.g. "consent select_account")
                // ("consent select_account" may come written with a "+", which Android reads as is)
                val prompt = (uri.getQueryParameter("prompt") ?: "").split(' ', '+').filter { it.isNotBlank() }.toMutableList()
                if ("select_account" !in prompt) prompt += "select_account"
                uri = withParam(uri, "prompt", prompt.joinToString(" "))
            }
        }
        open(uri.toString(), private)
    }

    /**
     * [uri] with [name] set to [value]; every other part of the query exactly as it was. (Not
     * decoded and encoded again: Android reads a "+" in a value as a plus, and writing it back
     * as %2B turned the page's "scope=a+b" into one scope Google refuses — invalid_scope.)
     */
    private fun withParam(uri: Uri, name: String, value: String): Uri {
        val kept = (uri.encodedQuery ?: "").split('&')
            .filter { it.isNotEmpty() && Uri.decode(it.substringBefore('=')) != name }
        val query = (kept + "${Uri.encode(name)}=${Uri.encode(value)}").joinToString("&")
        return uri.buildUpon().encodedQuery(query).build()
    }

    fun open(url: String, private: Boolean = false) {
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        if (scheme == null || scheme == "file") {
            // Android forbids handing file:// paths to other apps (it would crash the app)
            Toast.makeText(activity, "Can't open local files in a browser: $url", Toast.LENGTH_LONG).show()
            return
        }
        if (scheme != "https" && scheme != "http") {
            openExternal(uri)
            return
        }
        val pkg = provider
        if (pkg == null) {
            openExternal(uri) // no Custom Tabs browser installed
            return
        }
        // As close to a screen of the app as Chrome allows: our colours, no share /
        // bookmark / download buttons, the bar slides away while scrolling.
        val colors = CustomTabColorSchemeParams.Builder()
            .setToolbarColor(toolbarColor)
            .setNavigationBarColor(toolbarColor)
            .setSecondaryToolbarColor(toolbarColor)
            .build()
        val tab = CustomTabsIntent.Builder()
            .setDefaultColorSchemeParams(colors)
            .setColorScheme(if (darkTheme) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT)
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
            .setBookmarksButtonEnabled(false)
            .setDownloadButtonEnabled(false)
            .setCloseButtonIcon(backArrow())
            .setStartAnimations(activity, android.R.anim.slide_in_left, android.R.anim.fade_out)
            .setExitAnimations(activity, android.R.anim.fade_in, android.R.anim.slide_out_right)
            .build()
        // Pin the provider so a non-Custom-Tabs default browser doesn't take over.
        tab.intent.setPackage(pkg)
        // nothing remembered (no other account signed in, nothing kept after): Chrome 136+
        if (private) tab.intent.putExtra(EXTRA_EPHEMERAL, true)
        try {
            tab.launchUrl(activity, uri)
        } catch (_: Exception) {
            openExternal(uri)
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            if (uri.scheme.equals("intent", ignoreCase = true)) {
                // intent://…#Intent;package=…;end (links from web pages to apps): only as a
                // plain browsable link — never a specific component of some app
                val intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME).apply {
                    component = null
                    selector = null
                    addCategory(Intent.CATEGORY_BROWSABLE)
                }
                try {
                    activity.startActivity(intent)
                } catch (_: android.content.ActivityNotFoundException) {
                    val fallback = intent.getStringExtra("browser_fallback_url")
                    if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) open(fallback)
                    else throw IllegalStateException("no app")
                }
                return
            }
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            Toast.makeText(activity, "No app found to open the link", Toast.LENGTH_LONG).show()
        }
    }

    /** "←" icon for the tab's close button, so it reads as "back to the terminal". */
    private fun backArrow(): Bitmap {
        val d = activity.resources.displayMetrics.density
        val size = (24 * d).toInt()
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = if (darkTheme) Color.WHITE else Color.parseColor("#1F2128") // readable on a light bar
            style = Paint.Style.STROKE
            strokeWidth = 2.2f * d
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        val s = size / 24f
        val path = Path().apply {
            moveTo(19 * s, 12 * s); lineTo(5 * s, 12 * s)
            moveTo(11 * s, 6 * s); lineTo(5 * s, 12 * s); lineTo(11 * s, 18 * s)
        }
        Canvas(bmp).drawPath(path, paint)
        return bmp
    }

    companion object {
        /** CustomTabsIntent.EXTRA_ENABLE_EPHEMERAL_BROWSING (androidx.browser 1.9). */
        private const val EXTRA_EPHEMERAL = "androidx.browser.customtabs.extra.ENABLE_EPHEMERAL_BROWSING"
        private val PREFERRED = listOf(
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.google.android.apps.chrome",
        )
    }
}
