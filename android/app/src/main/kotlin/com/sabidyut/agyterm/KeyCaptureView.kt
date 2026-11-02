package com.sabidyut.agyterm

import android.annotation.SuppressLint
import android.content.Context
import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection

/**
 * An invisible view that owns the soft keyboard while the user types into the terminal
 * (the same approach Termux uses). When the terminal is tapped it takes focus, so the
 * keyboard connects to *this* view instead of the WebView, and every key is forwarded
 * straight to the terminal: no suggestions, no autocorrect, no waiting for a word to end.
 *
 * The compose box lives in the WebView; tapping it moves focus back to the WebView and
 * the normal keyboard (with Bangla layouts and suggestions) is used there.
 */
@SuppressLint("ViewConstructor")
class KeyCaptureView(context: Context, private val sink: Sink) : View(context) {

    interface Sink {
        fun onText(text: String)
        /** [char]: what the key types on this layout (with Shift, without Ctrl/Alt), or "". */
        fun onKey(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean, char: String)
    }

    /**
     * false: TYPE_NULL (raw keys, like Termux's default).
     * true: "visible password" text — for keyboards that misbehave with TYPE_NULL.
     */
    var compatMode = false

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = if (compatMode) {
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        } else {
            InputType.TYPE_NULL
        }
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        return Connection()
    }

    // Hardware keyboards (and IMEs that send key events) end up here.
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Back, volume, media, camera … keep their usual meaning
        if (keyCode == KeyEvent.KEYCODE_BACK || event.isSystem) return super.onKeyDown(keyCode, event)
        handleKey(event)
        return true
    }

    override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_UNKNOWN && event.characters != null) {
            sink.onText(event.characters)
            return true
        }
        repeat(repeatCount) { handleKey(event) }
        return true
    }

    private fun handleKey(event: KeyEvent) {
        val meta = event.metaState
        val ctrl = event.isCtrlPressed
        val alt = event.isAltPressed
        fun printable(c: Int) = c >= 0x20 && (c and KeyCharacterMap.COMBINING_ACCENT) == 0
        // AltGr (right Alt) types characters on many layouts (German AltGr+Q = @)
        if (alt && !ctrl && (meta and KeyEvent.META_ALT_LEFT_ON) == 0) {
            val g = event.getUnicodeChar(meta and KeyEvent.META_CTRL_MASK.inv())
            if (printable(g)) {
                sink.onText(String(Character.toChars(g)))
                return
            }
        }
        // Printable keys without Ctrl/Alt → text (respects Shift and the keyboard layout).
        val uc = event.getUnicodeChar(meta and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv())
        if (printable(uc) && !ctrl && !alt) {
            sink.onText(String(Character.toChars(uc)))
        } else {
            // Ctrl/Alt + a key: the page needs its character too (Alt+. , Ctrl+\ , Alt+Shift+F)
            val ch = if (printable(uc)) String(Character.toChars(uc)) else ""
            sink.onKey(event.keyCode, ctrl, alt, event.isShiftPressed, ch)
        }
    }

    /**
     * A full-editor connection whose Editable is emptied whenever text is committed.
     * (Keyboards that compose words even in raw mode deliver the word when it's committed.)
     */
    private inner class Connection : BaseInputConnection(this@KeyCaptureView, true) {

        private fun flushEditable() {
            val e = editable ?: return
            if (e.isEmpty()) return
            sink.onText(e.toString().replace('\n', '\r'))
            e.clear()
        }

        override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
            super.commitText(text, newCursorPosition)
            flushEditable()
            return true
        }

        override fun finishComposingText(): Boolean {
            super.finishComposingText()
            flushEditable()
            return true
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            // Our editor is always empty, so a delete means "backspace in the terminal".
            repeat(beforeLength.coerceIn(0, 64)) { sink.onKey(KeyEvent.KEYCODE_DEL, false, false, false, "") }
            repeat(afterLength.coerceIn(0, 64)) { sink.onKey(KeyEvent.KEYCODE_FORWARD_DEL, false, false, false, "") }
            return true
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.sendKeyEvent(event)
                handleKey(event)
            } else if (event.action == KeyEvent.ACTION_MULTIPLE && event.keyCode == KeyEvent.KEYCODE_UNKNOWN) {
                event.characters?.let { sink.onText(it) }
            }
            return true
        }

        override fun performEditorAction(actionCode: Int): Boolean {
            sink.onKey(KeyEvent.KEYCODE_ENTER, false, false, false, "")
            return true
        }
    }
}
