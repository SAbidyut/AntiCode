package com.sabidyut.agyterm

import android.content.Context

/**
 * The Google account each Antigravity account (profile) is signed in with, as its welcome
 * header showed it ("you@gmail.com (Google AI Pro)") — for the home screen's cards and the
 * "sign in with which account?" choice.
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
}
