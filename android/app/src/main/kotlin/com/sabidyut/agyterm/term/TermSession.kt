package com.sabidyut.agyterm.term

import android.os.ParcelFileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Executors

/**
 * One running program on a pseudo-terminal. Output is kept in a ring buffer so the UI
 * can re-attach (e.g. after the activity was destroyed while the service kept running).
 */
class TermSession(
    val id: String,
    val kind: String,
    var title: String,
    command: String,
    args: Array<String>,
    env: Array<String>,
    cwd: String,
    rows: Int,
    cols: Int,
    private val onExit: (TermSession) -> Unit,
) {
    /** The folder it was started in, inside Ubuntu (file names tapped in it are looked for there). */
    var startDir = ""
    /** The account (profile) an agent session signs in with; "" the usual one. */
    var profile = ""

    interface OutputListener {
        fun onOutput(session: TermSession, data: ByteArray, len: Int)
        /** A password is being asked for (or no longer). */
        fun onHiddenInput(session: TermSession, on: Boolean) {}
    }

    /** The program reads a password now: the keyboard and the screen hide what's typed. */
    @Volatile var hiddenInput = false
        private set

    private val fd: Int
    // Kept as a field: a garbage-collected ParcelFileDescriptor would close the PTY.
    private val pfd: ParcelFileDescriptor
    val pid: Int
    @Volatile var alive = true
        private set
    val createdAt = System.nanoTime()
    @Volatile var exitCode = 0
        private set

    private val lock = Object()
    private val ring = ByteArray(RING_SIZE)
    private var ringStart = 0
    private var ringLen = 0
    private var listener: OutputListener? = null

    /** Current window size (for re-attaching UIs). */
    @Volatile var cols = cols
        private set
    @Volatile var rows = rows
        private set

    // ---- "is the answer done?" (see SessionService's task notifications) ----
    /** What the UI calls this session (its task), for notifications. */
    @Volatile var label: String = ""
    /** When the user last pressed Enter; 0 once that run was reported (or more was typed). */
    @Volatile var enterAt = 0L
    /** Output bytes since that Enter, and when the last ones arrived. */
    @Volatile var outSinceEnter = 0L
    @Volatile var lastOutputAt = 0L
    /** A notification the program asked for (OSC 9 / OSC 777), or "bell". */
    @Volatile var alert: String? = null
    /** The shell printed its prompt again (OSC 7770;done from the guest bashrc). */
    @Volatile var promptAt = 0L
    private var oscState = 0
    private val osc = java.io.ByteArrayOutputStream()

    private val out: FileOutputStream
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "pty-writer-$id") }

    init {
        val pidOut = IntArray(1)
        fd = Pty.createSubprocess(command, cwd, args, env, pidOut, rows, cols)
        pid = pidOut[0]
        pfd = ParcelFileDescriptor.adoptFd(fd)
        val input = FileInputStream(pfd.fileDescriptor)
        out = FileOutputStream(pfd.fileDescriptor)

        val reader = Thread({
            val buf = ByteArray(16 * 1024)
            try {
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    val shown = synchronized(lock) {
                        append(buf, n)
                        listener?.onOutput(this, buf, n)
                        listener != null
                    }
                    lastOutputAt = System.currentTimeMillis()
                    outSinceEnter += n
                    scanForAlerts(buf, n)
                    val hide = synchronized(fdLock) { fdOpen && Pty.hiddenInput(fd) }
                    if (hide != hiddenInput) {
                        hiddenInput = hide
                        synchronized(lock) { listener?.onHiddenInput(this, hide) }
                    }
                    if (shown) waitForRoom(n)
                }
            } catch (_: IOException) {
                // EIO when the child side closes — normal end of session
            }
            closePty()
        }, "pty-reader-$id")
        reader.start()

        Thread({
            exitCode = Pty.waitFor(pid)
            // let the reader drain the last output first, so "exited" comes after it
            // (bounded: a background child may keep the terminal open)
            try {
                reader.join(500)
            } catch (_: InterruptedException) {
            }
            alive = false
            onExit(this)
        }, "pty-waiter-$id").start()
    }

    private fun append(b: ByteArray, n: Int) {
        var off = 0
        var len = n
        if (len >= RING_SIZE) {
            off = len - RING_SIZE
            len = RING_SIZE
        }
        // (in at most two block copies, not byte by byte: this runs for every read)
        val end = (ringStart + ringLen) % RING_SIZE
        val first = minOf(len, RING_SIZE - end)
        System.arraycopy(b, off, ring, end, first)
        if (len > first) System.arraycopy(b, off + first, ring, 0, len - first)
        val total = ringLen + len
        if (total > RING_SIZE) {
            ringStart = (ringStart + total - RING_SIZE) % RING_SIZE
            ringLen = RING_SIZE
        } else ringLen = total
    }

    /**
     * Sets the output listener. [withSnapshot] receives everything printed so far; it runs
     * under the same lock as output delivery, so nothing is lost or duplicated in between.
     */
    fun attach(l: OutputListener?, withSnapshot: ((ByteArray) -> Unit)? = null) = synchronized(lock) {
        listener = l
        synchronized(ackLock) { // (a new page starts counting afresh)
            unacked = 0
            ackLock.notifyAll()
        }
        if (withSnapshot != null) {
            val snap = ByteArray(ringLen)
            val first = minOf(ringLen, RING_SIZE - ringStart)
            System.arraycopy(ring, ringStart, snap, 0, first)
            if (ringLen > first) System.arraycopy(ring, 0, snap, first, ringLen - first)
            withSnapshot(snap)
        }
    }

    /**
     * Finds BEL and the desktop-notification escapes programs send when they finish:
     * OSC 9 ; text (iTerm2, Claude Code), OSC 777 ; notify ; title ; body (urxvt, Ghostty).
     */
    private fun scanForAlerts(b: ByteArray, n: Int) {
        for (i in 0 until n) {
            val c = b[i].toInt() and 0xff
            when (oscState) {
                0 -> if (c == 0x1b) oscState = 1 else if (c == 0x07) alert = "bell"
                1 -> oscState = when (c) {
                    ']'.code -> { osc.reset(); 2 }
                    0x1b -> 1
                    else -> 0
                }
                2 -> when (c) {
                    0x07 -> { finishOsc(); oscState = 0 }
                    0x1b -> oscState = 3
                    else -> if (osc.size() < 400) osc.write(c)
                }
                3 -> if (c == '\\'.code) { finishOsc(); oscState = 0 } else { oscState = 2 }
            }
        }
    }

    private val DONE = "7770;done;${com.sabidyut.agyterm.ubuntu.UbuntuManager.linkToken}"

    private fun finishOsc() {
        val s = osc.toString("UTF-8")
        when {
            // ConEmu-style OSC 9 ; <number> ; … (9;4 progress bar, 9;9 working directory from
            // prompts) are not notifications
            s.startsWith("9;") && !OSC9_SUBCOMMAND.containsMatchIn(s) -> alert = s.substring(2)
            s.startsWith("777;notify;") -> alert = s.substring(11).split(';').filter { it.isNotBlank() }.joinToString(" — ")
            // (signed by the guest bashrc with the app's token, like every 7770 message: the
            // same text printed by a program doesn't count as the prompt coming back)
            s == DONE -> promptAt = System.currentTimeMillis()
        }
    }

    // ---- flow control ----
    // The page says how much output it has taken in (ack). A program printing faster than the
    // screen can follow (yes, cat of a huge log) then waits for it, as on any terminal — the
    // output used to pile up by the megabyte in the page until it dropped some or froze.
    private val ackLock = Object()
    private var unacked = 0L

    fun ack(n: Int) = synchronized(ackLock) {
        unacked = maxOf(0L, unacked - n)
        ackLock.notifyAll()
    }

    private fun waitForRoom(n: Int) = synchronized(ackLock) {
        unacked += n
        // (the app out of sight: its page may be slowed down by the system — an agent working
        // in the background isn't held back by it)
        if (!paceOutput) return@synchronized
        val until = android.os.SystemClock.uptimeMillis() + ACK_GIVE_UP_MS
        while (unacked > HIGH_WATER && alive && paceOutput) {
            val left = until - android.os.SystemClock.uptimeMillis()
            if (left <= 0) {
                unacked = 0 // the page isn't answering (reloading, gone): don't hold the program
                break
            }
            ackLock.wait(minOf(left, 200L))
        }
    }

    fun write(data: ByteArray) {
        if (!alive) return
        // Enter arms the "answer finished" check — so does a digit in an agent (answering
        // "1 / 2 / 3" to its question starts more work). Typing a prompt doesn't: in a shell
        // it disarms (the user is here), in an agent it changes nothing. Terminal replies
        // (starting with ESC) don't count.
        val agent = kind in com.sabidyut.agyterm.ubuntu.UbuntuManager.AGENTS
        val choice = agent && data.size == 1 && data[0] in '1'.code.toByte()..'9'.code.toByte()
        if (data.contains('\r'.code.toByte()) || choice) {
            enterAt = System.currentTimeMillis()
            outSinceEnter = 0
            promptAt = 0
        } else if (!agent && data.isNotEmpty() && data[0] != 0x1b.toByte()) {
            enterAt = 0
        }
        try {
            writer.execute {
                try {
                    out.write(data)
                    out.flush()
                } catch (_: IOException) {
                }
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // closed meanwhile (a key typed as the tab closed)
        }
    }

    private val fdLock = Object()
    private var fdOpen = true

    /** Closes the PTY master once (the fd number may be reused right after). */
    private fun closePty() = synchronized(fdLock) {
        if (!fdOpen) return@synchronized
        fdOpen = false
        try {
            pfd.close()
        } catch (_: IOException) {
        }
    }

    fun resize(rows: Int, cols: Int) {
        this.rows = rows
        this.cols = cols
        synchronized(fdLock) { if (fdOpen) Pty.setWindowSize(fd, rows, cols) }
    }

    fun kill() {
        val wasAlive = alive
        if (wasAlive) {
            // SIGHUP, like closing a terminal window: to the program in front (bash saves its
            // history) and to the whole session
            synchronized(fdLock) { if (fdOpen) Pty.hangUp(fd) }
            Pty.sendSignal(pid, 1)
        }
        Thread {
            if (wasAlive) {
                Thread.sleep(1500)
                if (alive) Pty.sendSignal(pid, 9)
                Thread.sleep(300)
            }
            // a background job may still hold the terminal open: let the reader (and its
            // output buffer) go
            closePty()
        }.start()
        writer.shutdown()
    }

    companion object {
        const val RING_SIZE = 512 * 1024
        /** Output the page may be behind by before the program has to wait. */
        private const val HIGH_WATER = 1024 * 1024L
        private const val ACK_GIVE_UP_MS = 4000L
        /** The app is on screen: output keeps pace with its page (set by the activity). */
        @Volatile var paceOutput = true
        private val OSC9_SUBCOMMAND = Regex("^9;\\d+(;|$)")
    }
}
