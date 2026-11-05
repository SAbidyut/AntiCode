package com.sabidyut.agyterm

import android.content.Context

/**
 * The Google account Antigravity is signed in with, as its welcome header showed it
 * ("you@gmail.com (Google AI Pro)") — for the home screen's cards and the "sign in with
 * which account?" choice.
 */
object Accounts {
    private const val PREFS = "accounts"

    fun antigravity(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("agy", null)?.takeIf { it.isNotBlank() }

    fun setAntigravity(context: Context, email: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("agy", email.trim()).apply()
    }
}
