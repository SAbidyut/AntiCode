package com.sabidyut.agyterm

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File

/**
 * Which account the agents are signed in with, so their dashboards open with that
 * account instead of whichever Google account the browser picks first.
 *
 * - Antigravity: the web UI reads it from the CLI's welcome header ("you@gmail.com
 *   (Google AI Pro)") and stores it here (it can be edited in Settings).
 * - Claude Code: read from ~/.claude.json inside Ubuntu (oauthAccount.emailAddress).
 */
object Accounts {
    private const val PREFS = "accounts"

    fun antigravity(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("agy", null)?.takeIf { it.isNotBlank() }

    fun setAntigravity(context: Context, email: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("agy", email.trim()).apply()
    }

    fun claude(context: Context): String? = try {
        val f = File(context.filesDir, "ubuntu/root/.claude.json")
        if (!f.exists() || f.length() > 4_000_000) null
        else JSONObject(f.readText()).optJSONObject("oauthAccount")?.optString("emailAddress")?.takeIf { it.contains('@') }
    } catch (_: Exception) {
        null
    }

    /** The account for a URL: Google sites → the Antigravity account, claude.ai → Claude's. */
    fun forUrl(context: Context, url: Uri): String? {
        val host = url.host ?: return null
        return when {
            host == "claude.ai" || host.endsWith(".claude.ai") -> claude(context)
            host == "google.com" || host.endsWith(".google.com") -> antigravity(context)
            else -> null
        }
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
