package com.sabidyut.agyterm

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.webkit.WebView

/**
 * The app's WebView. While the terminal owns the keyboard ([holdFocusAway]), touching
 * the page — scrolling the terminal, pressing an extra key — must not move Android focus
 * back to the WebView: that silently disconnected the keyboard from the terminal
 * ("typing stops working until I tap the terminal again").
 */
@SuppressLint("ViewConstructor")
class TermWebView(context: Context) : WebView(context) {

    var holdFocusAway = false

    override fun requestFocus(direction: Int, previouslyFocusedRect: Rect?): Boolean =
        if (holdFocusAway) false else super.requestFocus(direction, previouslyFocusedRect)
}
