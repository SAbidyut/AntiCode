package com.sabidyut.agyterm

import android.content.Context
import android.net.Uri

/**
 * The Google account the Antigravity CLI is signed in with, so Google dashboards open
 * with that account instead of whichever one the browser picks first. The web UI reads
 * it from the CLI's welcome header ("you@gmail.com (Google AI Pro)"); Settings can edit it.
 */
object Accounts {
    private const val PREFS = "accounts"

    fun antigravity(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("agy", null)?.takeIf { it.isNotBlank() }

    fun setAntigravity(context: Context, email: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("agy", email.trim()).apply()
    }

    /**
     * Pick the account on Google sites: `authuser=<email>` selects that signed-in account
     * (or asks to sign in with it); `login_hint` does the same on Google's sign-in pages.
     */
    fun withAccount(url: Uri, email: String?): Uri {
        if (email == null) return url
        val host = url.host ?: return url
        val param = when {
            host == "accounts.google.com" -> "login_hint"
            host.endsWith(".google.com") || host == "google.com" -> "authuser"
            else -> return url
        }
        if (url.getQueryParameter(param) != null || url.isOpaque) return url
        return url.buildUpon().appendQueryParameter(param, email).build()
    }
}
