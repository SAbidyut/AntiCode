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

    fun open(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme == null || uri.scheme == "file") {
            // Android forbids handing file:// paths to other apps (it would crash the app)
            Toast.makeText(activity, "Can't open local files in a browser: $url", Toast.LENGTH_LONG).show()
            return
        }
        if (uri.scheme != "https" && uri.scheme != "http") {
            openExternal(uri)
            return
        }
        val pkg = provider
        if (pkg == null) {
            openExternal(uri) // no Custom Tabs browser installed
            return
        }
        val colors = CustomTabColorSchemeParams.Builder()
            .setToolbarColor(Color.parseColor("#181b25"))
            .setNavigationBarColor(Color.parseColor("#181b25"))
            .build()
        val tab = CustomTabsIntent.Builder()
            .setDefaultColorSchemeParams(colors)
            .setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
            .setCloseButtonIcon(backArrow())
            .setStartAnimations(activity, android.R.anim.slide_in_left, android.R.anim.fade_out)
            .setExitAnimations(activity, android.R.anim.fade_in, android.R.anim.slide_out_right)
            .build()
        // Pin the provider so a non-Custom-Tabs default browser doesn't take over.
        tab.intent.setPackage(pkg)
        try {
            tab.launchUrl(activity, uri)
        } catch (_: Exception) {
            openExternal(uri)
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
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
            color = Color.WHITE
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
        private val PREFERRED = listOf(
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.google.android.apps.chrome",
        )
    }
}
