package com.sabidyut.agyterm

import android.annotation.SuppressLint
import android.content.Context
import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView

/**
 * WebView with a "terminal keyboard" mode. In that mode the soft keyboard is opened
 * with TYPE_NULL (like Termux): no suggestions/autocorrect, every key arrives
 * immediately and is forwarded to the web UI, which turns it into terminal input.
 * When the compose box is focused, the normal WebView input (with Bangla IMEs) is used.
 */
@SuppressLint("ViewConstructor")
class TermWebView(context: Context, private val sink: KeySink) : WebView(context) {

    interface KeySink {
        fun onText(text: String)
        fun onKey(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean)
    }

    var terminalMode = false

    override fun onCheckIsTextEditor(): Boolean = terminalMode || super.onCheckIsTextEditor()

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        if (!terminalMode) return super.onCreateInputConnection(outAttrs)
        outAttrs.inputType = InputType.TYPE_NULL
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        return TerminalConnection()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!terminalMode) return super.dispatchKeyEvent(event)
        if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_MULTIPLE) {
            handleKey(event)
        }
        return true
    }

    private fun handleKey(event: KeyEvent) {
        if (event.action == KeyEvent.ACTION_MULTIPLE && event.keyCode == KeyEvent.KEYCODE_UNKNOWN) {
            event.characters?.let { sink.onText(it) }
            return
        }
        val ctrl = event.isCtrlPressed
        val alt = event.isAltPressed
        // Printable keys without Ctrl/Alt → plain text (respects Shift / keyboard layout).
        val uc = event.getUnicodeChar(event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv())
        if (uc >= 0x20 && !ctrl && !alt && (uc and KeyCharacterMap.COMBINING_ACCENT) == 0) {
            sink.onText(String(Character.toChars(uc)))
        } else {
            sink.onKey(event.keyCode, ctrl, alt, event.isShiftPressed)
        }
    }

    private inner class TerminalConnection : BaseInputConnection(this@TermWebView, false) {
        private var composing: CharSequence = ""

        override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
            composing = ""
            if (text.isNotEmpty()) sink.onText(text.toString().replace('\n', '\r'))
            return true
        }

        override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
            composing = text
            return true
        }

        override fun finishComposingText(): Boolean {
            if (composing.isNotEmpty()) sink.onText(composing.toString())
            composing = ""
            return true
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            repeat(beforeLength.coerceAtMost(64)) { sink.onKey(KeyEvent.KEYCODE_DEL, false, false, false) }
            repeat(afterLength.coerceAtMost(64)) { sink.onKey(KeyEvent.KEYCODE_FORWARD_DEL, false, false, false) }
            return true
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_MULTIPLE) handleKey(event)
            return true
        }

        override fun performEditorAction(actionCode: Int): Boolean {
            sink.onKey(KeyEvent.KEYCODE_ENTER, false, false, false)
            return true
        }
    }
}
