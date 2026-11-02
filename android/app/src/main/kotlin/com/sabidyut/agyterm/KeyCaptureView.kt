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
        /** Smart keyboard: the word being typed (not sent yet), "" when there's none. */
        fun onComposing(text: String)
        /** [char]: what the key types on this layout (with Shift, without Ctrl/Alt), or "". */
        fun onKey(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean, char: String)
    }

    /**
     * Smart keyboard (default): an ordinary text field to the keyboard, so it shows its
     * suggestions and Bangla transliteration (amon → এমন) like in a chat app — no number row,
     * no autocorrect, no capitals. The word being typed is shown at the cursor by the page and
     * reaches the terminal when the keyboard commits it (space, a suggestion, Enter).
     */
    var smart = true

    /**
     * Not smart — false: TYPE_NULL (raw keys, like Termux's default).
     * true: "visible password" text — for keyboards that misbehave with TYPE_NULL.
     */
    var compatMode = false

    private var connection: Connection? = null

    /** Drop the word being composed (the page already sent it, e.g. before a key-bar key). */
    fun discardComposing() {
        connection?.discard()
    }

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = when {
            // plain text: suggestions on; no AUTO_CORRECT / CAP_* flags → no autocorrect, no capitals
            smart -> InputType.TYPE_CLASS_TEXT
            compatMode -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            else -> InputType.TYPE_NULL
        }
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or EditorInfo.IME_ACTION_NONE
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        return Connection().also { connection = it }
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
    /**
     * A full editor that mirrors the word being typed, the way the keyboard expects a text
     * field to behave: it may finish a word and then replace it (a Bangla suggestion for
     * "ami"), re-select it, or delete parts of it — so the text stays here until the word
     * is over. The terminal always gets the difference: what was committed since the last
     * sync (and ⌫ for what was taken back); the composing part is only shown by the page.
     */
    private inner class Connection : BaseInputConnection(this@KeyCaptureView, true) {

        /** Committed text of the current word that the terminal already has. */
        private var sent = ""
        private var shown = ""

        private fun composingRange(e: CharSequence): IntRange? {
            val a = getComposingSpanStart(e as android.text.Spannable)
            val b = getComposingSpanEnd(e)
            return if (a in 0..b && b <= e.length && a < b) a until b else null
        }

        /** Bring the terminal and the page up to date with the editor. */
        fun sync() {
            val e = editable ?: return
            val text = e.toString()
            val comp = composingRange(e)
            val committed = if (comp == null) text else text.removeRange(comp)
            val composing = if (comp == null) "" else text.substring(comp)
            if (committed != sent) {
                var p = 0
                while (p < sent.length && p < committed.length && sent[p] == committed[p]) p++
                if (p > 0 && p < sent.length && Character.isLowSurrogate(sent[p])) p-- // whole characters
                repeat(sent.codePointCount(p, sent.length)) { sink.onKey(KeyEvent.KEYCODE_DEL, false, false, false, "") }
                val add = committed.substring(p)
                if (add.isNotEmpty()) sink.onText(add.replace('\n', '\r'))
                sent = committed
            }
            if (composing != shown) {
                shown = composing
                sink.onComposing(composing)
            }
            // a finished word (ends with a space / newline, nothing composing): start afresh,
            // so ⌫ from here on is a plain terminal backspace
            if (composing.isEmpty() && committed.isNotEmpty() && committed.last().isWhitespace()) reset()
        }

        private fun reset() {
            editable?.clear()
            sent = ""
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                .updateSelection(this@KeyCaptureView, 0, 0, -1, -1)
        }

        /** Everything typed so far goes to the terminal now (before Enter, a key …). */
        private fun flushAll() {
            super.finishComposingText()
            sync()
            if (editable?.isNotEmpty() == true) reset()
        }

        /** The page sent the composing text itself (before a key-bar key): forget it here. */
        fun discard() {
            editable?.clear()
            sent = ""
            if (shown.isNotEmpty()) {
                shown = ""
                sink.onComposing("")
            }
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                .restartInput(this@KeyCaptureView)
        }

        override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
            super.setComposingText(text, newCursorPosition)
            sync()
            return true
        }

        override fun setComposingRegion(start: Int, end: Int): Boolean {
            super.setComposingRegion(start, end)
            sync()
            return true
        }

        override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
            super.commitText(text, newCursorPosition)
            sync()
            return true
        }

        override fun finishComposingText(): Boolean {
            super.finishComposingText()
            sync()
            return true
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            // text the keyboard can see (the current word): it edits it, the terminal follows
            if (editable?.isNotEmpty() == true) {
                super.deleteSurroundingText(beforeLength, afterLength)
                sync()
                return true
            }
            // Our editor is otherwise empty, so a delete means "backspace in the terminal".
            repeat(beforeLength.coerceIn(0, 64)) { sink.onKey(KeyEvent.KEYCODE_DEL, false, false, false, "") }
            repeat(afterLength.coerceIn(0, 64)) { sink.onKey(KeyEvent.KEYCODE_FORWARD_DEL, false, false, false, "") }
            return true
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.sendKeyEvent(event)
                flushAll() // a word being typed goes first (then Enter, ⌫ …)
                handleKey(event)
            } else if (event.action == KeyEvent.ACTION_MULTIPLE && event.keyCode == KeyEvent.KEYCODE_UNKNOWN) {
                flushAll()
                event.characters?.let { sink.onText(it) }
            }
            return true
        }

        override fun performEditorAction(actionCode: Int): Boolean {
            flushAll()
            sink.onKey(KeyEvent.KEYCODE_ENTER, false, false, false, "")
            return true
        }
    }
}
