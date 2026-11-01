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
    interface OutputListener {
        fun onOutput(session: TermSession, data: ByteArray, len: Int)
    }

    private val fd: Int
    // Kept as a field: a garbage-collected ParcelFileDescriptor would close the PTY.
    private val pfd: ParcelFileDescriptor
    val pid: Int
    @Volatile var alive = true
        private set
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
                    synchronized(lock) {
                        append(buf, n)
                        listener?.onOutput(this, buf, n)
                    }
                }
            } catch (_: IOException) {
                // EIO when the child side closes — normal end of session
            }
            try {
                pfd.close()
            } catch (_: IOException) {
            }
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
        for (i in 0 until len) {
            ring[(ringStart + ringLen) % RING_SIZE] = b[off + i]
            if (ringLen < RING_SIZE) ringLen++ else ringStart = (ringStart + 1) % RING_SIZE
        }
    }

    /**
     * Sets the output listener. [withSnapshot] receives everything printed so far; it runs
     * under the same lock as output delivery, so nothing is lost or duplicated in between.
     */
    fun attach(l: OutputListener?, withSnapshot: ((ByteArray) -> Unit)? = null) = synchronized(lock) {
        listener = l
        if (withSnapshot != null) {
            val snap = ByteArray(ringLen)
            for (i in 0 until ringLen) snap[i] = ring[(ringStart + i) % RING_SIZE]
            withSnapshot(snap)
        }
    }

    fun write(data: ByteArray) {
        if (!alive) return
        writer.execute {
            try {
                out.write(data)
                out.flush()
            } catch (_: IOException) {
            }
        }
    }

    fun resize(rows: Int, cols: Int) {
        this.rows = rows
        this.cols = cols
        if (alive) Pty.setWindowSize(fd, rows, cols)
    }

    fun kill() {
        if (alive) {
            Pty.sendSignal(pid, 1) // SIGHUP, like closing a terminal window
            Thread {
                Thread.sleep(1500)
                if (alive) Pty.sendSignal(pid, 9)
            }.start()
        }
        writer.shutdown()
    }

    companion object {
        const val RING_SIZE = 512 * 1024
    }
}
