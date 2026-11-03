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

    /** A hardware key moved the cursor or changed the line: the keyboard's copy is stale. */
    private fun forgetLine() {
        connection?.forget()
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
        if (KeyEvent.isModifierKey(keyCode)) return true // Shift / Ctrl on their own: nothing to send
        connection?.flush() // a word being composed goes first (not lost)
        handleKey(event)
        forgetLine()
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
     * A full editor that mirrors the line being typed, the way the keyboard expects a text
     * field to behave: it finishes a word and then replaces it (a Bangla suggestion for
     * "ami"), re-selects the last word, deletes inside it — always by positions in the whole
     * line, so the line stays here until Enter (or a key that moves the cursor). The
     * terminal gets the difference each time, in letter clusters (a letter with its vowel
     * signs, the way shells and Claude Code delete with ⌫): ⌫ for what was taken back,
     * then the new text. The part being composed is only shown by the page.
     */
    private inner class Connection : BaseInputConnection(this@KeyCaptureView, true) {

        /** Committed text of the line that the terminal already has. */
        private var sent = ""
        private var shown = ""

        private fun composingRange(e: android.text.Spannable): IntRange? {
            val a = getComposingSpanStart(e)
            val b = getComposingSpanEnd(e)
            return if (a in 0..b && b <= e.length && a < b) a until b else null
        }

        /** Bring the terminal and the page up to date with the editor. */
        fun sync() {
            val e = editable ?: return
            val text = e.toString()
            // the word being composed is held back (shown by the page at the cursor) only when
            // it is at the end of the line; re-composing a word further back (the cursor moved
            // there) counts as typed — the terminal follows by retyping from where it differs
            val comp = composingRange(e)?.takeIf { it.last + 1 == text.length }
            val committed = if (comp == null) text else text.removeRange(comp)
            val composing = if (comp == null) "" else text.substring(comp)
            if (committed != sent) {
                val old = clusters(sent)
                val now = clusters(committed)
                var k = 0
                while (k < old.size && k < now.size && old[k] == now[k]) k++
                repeat(old.size - k) { sink.onKey(KeyEvent.KEYCODE_DEL, false, false, false, "") }
                val add = now.subList(k, now.size).joinToString("")
                if (add.isNotEmpty()) sink.onText(add.replace('\n', '\r'))
                sent = committed
            }
            if (composing != shown) {
                shown = composing
                sink.onComposing(composing)
            }
            // raw keys (smart keyboard off): nothing is kept — text goes out as it comes and ⌫
            // is a plain DEL to the program, exactly what was pressed
            if (!smart && comp == null && e.isNotEmpty()) {
                e.clear()
                sent = ""
            }
            reportSelection()
        }

        // ---- telling the keyboard where things are ----
        // A text field must report its cursor and the word being composed after every change
        // (an EditText does it by itself). Without it the keyboard works from an old picture
        // of the field: tapping a suggestion did nothing, and the strip got stuck.
        private var batch = 0
        private val imm get() = context.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager

        override fun beginBatchEdit(): Boolean {
            batch++
            return true
        }

        override fun endBatchEdit(): Boolean {
            if (batch > 0) batch--
            if (batch == 0) reportSelection()
            return batch > 0
        }

        private fun reportSelection() {
            if (batch > 0) return // once, when the keyboard's batch of edits is done
            val e = editable ?: return
            imm.updateSelection(
                this@KeyCaptureView,
                android.text.Selection.getSelectionStart(e), android.text.Selection.getSelectionEnd(e),
                getComposingSpanStart(e), getComposingSpanEnd(e),
            )
        }

        override fun setSelection(start: Int, end: Int): Boolean {
            super.setSelection(start, end)
            sync() // (the cursor moved within the line: the word being composed may differ)
            return true
        }

        /** A new line (after Enter, a cursor key …): the keyboard starts from an empty field. */
        private fun reset() {
            editable?.clear()
            sent = ""
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                .restartInput(this@KeyCaptureView)
        }

        /** Everything typed so far goes to the terminal now. */
        private fun flushComposing() {
            super.finishComposingText()
            sync()
        }

        /** A hardware key comes next: what's being composed goes first. */
        fun flush() {
            if (shown.isNotEmpty()) flushComposing()
        }

        fun forget() {
            if (editable?.isNotEmpty() == true || sent.isNotEmpty()) reset()
        }

        /** The page sent the composing text itself (before a key-bar key): forget the line. */
        fun discard() {
            // nothing to forget (e.g. a held arrow key on the key bar): don't restart the keyboard
            val had = editable?.isNotEmpty() == true || sent.isNotEmpty() || shown.isNotEmpty()
            editable?.clear()
            sent = ""
            if (shown.isNotEmpty()) {
                shown = ""
                sink.onComposing("")
            }
            if (!had) return
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
            if (text.toString() == "\n") {
                // Enter typed as text: the line so far, then Enter, then a fresh line
                flushComposing()
                sink.onKey(KeyEvent.KEYCODE_ENTER, false, false, false, "")
                reset()
                return true
            }
            super.commitText(text, newCursorPosition)
            sync() // (several lines — a pasted clip — go as one piece, newlines as Enter)
            if (text.contains('\n')) reset() // the line has ended
            return true
        }

        override fun finishComposingText(): Boolean {
            super.finishComposingText()
            sync()
            return true
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            // text the keyboard can see (this line): it edits it, the terminal follows
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

        override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
            if (editable?.isNotEmpty() == true) {
                super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
                sync()
                return true
            }
            repeat(beforeLength.coerceIn(0, 64)) { sink.onKey(KeyEvent.KEYCODE_DEL, false, false, false, "") }
            repeat(afterLength.coerceIn(0, 64)) { sink.onKey(KeyEvent.KEYCODE_FORWARD_DEL, false, false, false, "") }
            return true
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.sendKeyEvent(event)
                // Shift / Ctrl pressed on their own (some keyboards send them before the key):
                // nothing to send, and the line mustn't be reset under the key that follows
                if (KeyEvent.isModifierKey(event.keyCode)) return true
                flushComposing() // a word being typed goes first
                val e = editable
                if (event.keyCode == KeyEvent.KEYCODE_DEL && !event.isCtrlPressed && !event.isAltPressed &&
                    e != null && e.isNotEmpty()
                ) {
                    // ⌫ inside this line: take the character before the cursor back here, the
                    // terminal follows
                    val sel = android.text.Selection.getSelectionStart(e)
                    val end = if (sel in 1..e.length) sel else e.length
                    val start = if (end >= 2 && Character.isLowSurrogate(e[end - 1])) end - 2 else end - 1
                    e.delete(start, end)
                    sync()
                    return true
                }
                // a letter or digit sent as a key (some keyboards do that for digits): typed
                // into this line like any text, so the line carries on
                if (smart && !event.isCtrlPressed && !event.isAltPressed) {
                    val uc = event.getUnicodeChar(event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK).inv())
                    if (uc >= 0x20 && (uc and KeyCharacterMap.COMBINING_ACCENT) == 0) {
                        commitText(String(Character.toChars(uc)), 1)
                        return true
                    }
                }
                // any other key (Enter, arrows, Tab …) changes the line in ways this editor
                // can't follow: send it and start afresh
                handleKey(event)
                if (e != null && e.isNotEmpty()) reset()
                else if (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) reset()
            } else if (event.action == KeyEvent.ACTION_MULTIPLE && event.keyCode == KeyEvent.KEYCODE_UNKNOWN) {
                event.characters?.let { commitText(it, 1) }
            }
            return true
        }

        override fun performEditorAction(actionCode: Int): Boolean {
            flushComposing()
            sink.onKey(KeyEvent.KEYCODE_ENTER, false, false, false, "")
            reset()
            return true
        }
    }

    companion object {
        /**
         * Splits text into letter clusters — what one ⌫ removes in Claude Code and (with the
         * app's binding) in the shell: a character with the marks that follow it (vowel
         * signs, virama, nukta, joiners), and conjuncts kept whole (consonant + virama +
         * consonant, Unicode's GB9c: "ক্ষ", "স্ত্রী").
         */
        fun clusters(s: String): List<String> {
            val base = graphemes(s)
            val out = ArrayList<String>()
            for (c in base) {
                val prev = out.lastOrNull()
                if (prev != null && endsWithLinker(prev) && isConsonant(c.codePointAt(0))) {
                    out[out.size - 1] = prev + c
                } else {
                    out += c
                }
            }
            return out
        }

        /** Bengali / Devanagari virama, possibly followed by a joiner. */
        private fun endsWithLinker(c: String): Boolean {
            val t = c.trimEnd('\u200D')
            return t.endsWith('\u09CD') || t.endsWith('\u094D')
        }

        private fun isConsonant(cp: Int) =
            cp in 0x0995..0x09B9 || cp == 0x09DC || cp == 0x09DD || cp == 0x09DF || cp == 0x09F0 || cp == 0x09F1 ||
                cp in 0x0915..0x0939 || cp in 0x0958..0x095F || cp in 0x0978..0x097F

        private val breaks: android.icu.text.BreakIterator by lazy {
            android.icu.text.BreakIterator.getCharacterInstance(java.util.Locale.ROOT)
        }

        /**
         * User-perceived characters (Unicode grapheme clusters): a letter with its vowel signs
         * and marks, a flag, an emoji with its skin tone or joined parts — what ⌫ removes.
         * (Called on the main thread only.)
         */
        private fun graphemes(s: String): List<String> {
            val out = ArrayList<String>()
            if (s.isEmpty()) return out
            val it = breaks
            it.setText(s)
            var start = it.first()
            var end = it.next()
            while (end != android.icu.text.BreakIterator.DONE) {
                out += s.substring(start, end)
                start = end
                end = it.next()
            }
            return out
        }
    }
}
