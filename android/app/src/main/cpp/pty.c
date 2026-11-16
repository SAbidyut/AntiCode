// Minimal pseudo-terminal support for the Kotlin side: start a process on a new PTY,
// resize it, wait for it, signal it.

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <jni.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static void throw_io(JNIEnv *env, const char *what) {
    char msg[256];
    snprintf(msg, sizeof msg, "%s: %s", what, strerror(errno));
    jclass cls = (*env)->FindClass(env, "java/io/IOException");
    if (cls) (*env)->ThrowNew(env, cls, msg);
}

/*
 * A Java string as real UTF-8 (GetStringUTFChars gives "modified UTF-8": a character outside
 * the basic plane — most emoji — comes out as two 3-byte halves no program reads right, so a
 * folder named "📁proj" couldn't be entered).
 */
static char *utf8_dup(JNIEnv *env, jstring s) {
    if (!s) return strdup("");
    jsize n = (*env)->GetStringLength(env, s);
    const jchar *u = (*env)->GetStringChars(env, s, NULL);
    if (!u) return strdup("");
    char *out = malloc((size_t)n * 3 + 1);
    size_t o = 0;
    if (out) {
        for (jsize i = 0; i < n; i++) {
            unsigned int c = u[i];
            if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (u[i + 1] - 0xDC00);
                i++;
            } else if (c >= 0xD800 && c <= 0xDFFF) {
                c = 0xFFFD; // a lone half
            }
            if (c < 0x80) {
                out[o++] = (char)c;
            } else if (c < 0x800) {
                out[o++] = (char)(0xC0 | (c >> 6));
                out[o++] = (char)(0x80 | (c & 0x3F));
            } else if (c < 0x10000) {
                out[o++] = (char)(0xE0 | (c >> 12));
                out[o++] = (char)(0x80 | ((c >> 6) & 0x3F));
                out[o++] = (char)(0x80 | (c & 0x3F));
            } else {
                out[o++] = (char)(0xF0 | (c >> 18));
                out[o++] = (char)(0x80 | ((c >> 12) & 0x3F));
                out[o++] = (char)(0x80 | ((c >> 6) & 0x3F));
                out[o++] = (char)(0x80 | (c & 0x3F));
            }
        }
        out[o] = 0;
    }
    (*env)->ReleaseStringChars(env, s, u);
    return out ? out : strdup("");
}

static char **to_cstrings(JNIEnv *env, jobjectArray arr) {
    if (!arr) return NULL;
    jsize n = (*env)->GetArrayLength(env, arr);
    char **out = calloc((size_t)n + 1, sizeof(char *));
    if (!out) return NULL;
    for (jsize i = 0; i < n; i++) {
        jstring s = (jstring)(*env)->GetObjectArrayElement(env, arr, i);
        out[i] = utf8_dup(env, s);
        (*env)->DeleteLocalRef(env, s);
    }
    return out;
}

static void free_cstrings(char **arr) {
    if (!arr) return;
    for (char **p = arr; *p; p++) free(*p);
    free(arr);
}

JNIEXPORT jint JNICALL
Java_com_sabidyut_agyterm_term_Pty_createSubprocess(JNIEnv *env, jclass clazz, jstring jcmd, jstring jcwd,
                                                   jobjectArray jargs, jobjectArray jenv, jintArray jpid,
                                                   jint rows, jint cols) {
    (void)clazz;
    int ptm = open("/dev/ptmx", O_RDWR | O_CLOEXEC);
    if (ptm < 0) {
        throw_io(env, "open /dev/ptmx");
        return -1;
    }
    char devname[64];
    if (grantpt(ptm) || unlockpt(ptm) || ptsname_r(ptm, devname, sizeof devname)) {
        throw_io(env, "pty setup");
        close(ptm);
        return -1;
    }

    // UTF-8 input processing, no XON/XOFF (Ctrl+S / Ctrl+Q must reach programs).
    struct termios tios;
    if (tcgetattr(ptm, &tios) == 0) { // (never set from settings that weren't read)
        tios.c_iflag |= IUTF8;
        tios.c_iflag &= ~(IXON | IXOFF);
        tcsetattr(ptm, TCSANOW, &tios);
    }
    struct winsize sz = {.ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols};
    ioctl(ptm, TIOCSWINSZ, &sz);

    char *cmd = utf8_dup(env, jcmd);
    char *cwd = utf8_dup(env, jcwd);
    char **argv = to_cstrings(env, jargs);
    char **envp = to_cstrings(env, jenv);

    pid_t pid = fork();
    if (pid < 0) {
        throw_io(env, "fork");
        free(cmd);
        free(cwd);
        free_cstrings(argv);
        free_cstrings(envp);
        close(ptm);
        return -1;
    }

    if (pid == 0) {
        // ---- child ----
        sigset_t all;
        sigfillset(&all);
        sigprocmask(SIG_UNBLOCK, &all, NULL);
        for (int s = 1; s < 32; s++) signal(s, SIG_DFL);

        close(ptm);
        setsid();
        int pts = open(devname, O_RDWR);
        if (pts < 0) _exit(127);
        ioctl(pts, TIOCSCTTY, 0);
        dup2(pts, 0);
        dup2(pts, 1);
        dup2(pts, 2);

        // Close every other inherited descriptor.
        DIR *d = opendir("/proc/self/fd");
        if (d) {
            int dfd = dirfd(d);
            struct dirent *e;
            while ((e = readdir(d))) {
                int fd = atoi(e->d_name);
                if (fd > 2 && fd != dfd) close(fd);
            }
            closedir(d);
        }

        clearenv();
        if (envp)
            for (char **p = envp; *p; p++) putenv(*p);
        if (chdir(cwd) != 0 && chdir("/") != 0) _exit(126);
        execvp(cmd, argv);
        dprintf(1, "\r\n[exec %s failed: %s]\r\n", cmd, strerror(errno));
        _exit(127);
    }

    // ---- parent ----
    free(cmd);
    free(cwd);
    free_cstrings(argv);
    free_cstrings(envp);
    jint p = (jint)pid;
    (*env)->SetIntArrayRegion(env, jpid, 0, 1, &p);
    return ptm;
}

JNIEXPORT void JNICALL
Java_com_sabidyut_agyterm_term_Pty_setWindowSize(JNIEnv *env, jclass clazz, jint fd, jint rows, jint cols) {
    (void)env;
    (void)clazz;
    struct winsize sz = {.ws_row = (unsigned short)rows, .ws_col = (unsigned short)cols};
    ioctl(fd, TIOCSWINSZ, &sz);
}

/** Blocks until the process exits. Returns the exit code, or -signal if it was killed. */
JNIEXPORT jint JNICALL
Java_com_sabidyut_agyterm_term_Pty_waitFor(JNIEnv *env, jclass clazz, jint pid) {
    (void)env;
    (void)clazz;
    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return -1;
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return -WTERMSIG(status);
    return 0;
}

JNIEXPORT void JNICALL
Java_com_sabidyut_agyterm_term_Pty_sendSignal(JNIEnv *env, jclass clazz, jint pid, jint sig) {
    (void)env;
    (void)clazz;
    // the child called setsid(), so -pid addresses its whole process group
    if (kill(-pid, sig) != 0) kill(pid, sig);
}

/*
 * Hangs up the program in front on the terminal (an interactive bash puts itself in a
 * process group of its own, which the signal to proot's group doesn't reach — proot also
 * ignores SIGHUP): it can save its history and clean up, as when a terminal window closes.
 */
JNIEXPORT void JNICALL
Java_com_sabidyut_agyterm_term_Pty_hangUp(JNIEnv *env, jclass clazz, jint fd) {
    (void)env;
    (void)clazz;
    pid_t pg = tcgetpgrp(fd);
    if (pg > 0) {
        kill(-pg, SIGHUP);
        kill(-pg, SIGCONT); // (a stopped job gets it too)
    }
}

/*
 * The program reads a hidden answer (a password: sudo, ssh, read -s): lines typed with echo
 * off. (Line editors — bash, Claude Code — turn echo off too, but read keys one by one.)
 */
JNIEXPORT jboolean JNICALL
Java_com_sabidyut_agyterm_term_Pty_hiddenInput(JNIEnv *env, jclass clazz, jint fd) {
    (void)env;
    (void)clazz;
    struct termios t;
    if (tcgetattr(fd, &t) != 0) return JNI_FALSE;
    return (!(t.c_lflag & ECHO) && (t.c_lflag & ICANON)) ? JNI_TRUE : JNI_FALSE;
}
