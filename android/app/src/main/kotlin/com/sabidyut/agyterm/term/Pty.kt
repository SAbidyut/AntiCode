package com.sabidyut.agyterm.term

/** JNI glue to src/main/cpp/pty.c. */
object Pty {
    init {
        System.loadLibrary("agypty")
    }

    /** Starts [cmd] on a new pseudo-terminal. Returns the master fd; the pid is written to pidOut[0]. */
    @JvmStatic
    external fun createSubprocess(
        cmd: String,
        cwd: String,
        args: Array<String>,
        env: Array<String>,
        pidOut: IntArray,
        rows: Int,
        cols: Int,
    ): Int

    @JvmStatic external fun setWindowSize(fd: Int, rows: Int, cols: Int)

    /** Blocks until [pid] exits; returns the exit code or -signal. */
    @JvmStatic external fun waitFor(pid: Int): Int

    @JvmStatic external fun close(fd: Int)

    @JvmStatic external fun sendSignal(pid: Int, signal: Int)
}
