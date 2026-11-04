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

    /** ([profile]: one of the extra accounts — see UbuntuManager's profiles; "" the usual one) */
    fun antigravity(context: Context, profile: String = ""): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key(profile), null)?.takeIf { it.isNotBlank() }

    fun setAntigravity(context: Context, email: String, profile: String = "") {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key(profile), email.trim()).apply()
    }

    fun forgetAntigravity(context: Context, profile: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(key(profile)).apply()
    }

    private fun key(profile: String) = if (profile.isEmpty()) "agy" else "agy:$profile"

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
