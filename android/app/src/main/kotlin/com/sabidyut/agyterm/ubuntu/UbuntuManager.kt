package com.sabidyut.agyterm.ubuntu

import android.content.Context
import android.os.Build
import android.system.Os
import android.util.Log
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/**
 * Installs and launches an Ubuntu userland (official "Ubuntu Base" tarball) inside the
 * app's private storage and runs it with proot — no root needed.
 */
class UbuntuManager(private val context: Context) {

    enum class State { NONE, INSTALLING, READY, ERROR }

    @Volatile var state: State = if (isInstalled()) State.READY else State.NONE
        private set
    @Volatile var progress = 0.0
        private set
    @Volatile var message = ""
        private set

    var onStateChanged: (() -> Unit)? = null

    val rootfs: File get() = File(context.filesDir, "ubuntu")
    private val tmpDir: File get() = File(context.filesDir, "tmp")
    private val fakeProc: File get() = File(context.filesDir, "fakeproc")
    private val marker: File get() = File(context.filesDir, "ubuntu.installed")
    private val nativeDir: String get() = context.applicationInfo.nativeLibraryDir

    fun isInstalled() = marker.exists() && File(rootfs, "bin/bash").exists()

    fun stateJson(): String = JSONObject()
        .put("host", "android")
        .put("ubuntu", state.name.lowercase())
        .put("progress", progress)
        .put("message", message)
        .toString()

    private fun update(s: State, p: Double, m: String) {
        state = s
        progress = p
        message = m
        onStateChanged?.invoke()
    }

    // ------------------------------------------------------------------ install

    @Synchronized
    fun install() {
        if (state == State.INSTALLING || isInstalled()) return
        update(State.INSTALLING, 0.0, "Ubuntu নামানো শুরু হচ্ছে…")
        Thread({
            try {
                doInstall()
                marker.writeText("ubuntu-base ${UBUNTU_VERSION}\n")
                update(State.READY, 1.0, "Ubuntu প্রস্তুত")
            } catch (t: Throwable) {
                Log.e(TAG, "install failed", t)
                update(State.ERROR, 0.0, "সেটআপ ব্যর্থ: ${t.message ?: t.javaClass.simpleName}। ইন্টারনেট দেখে আবার চেষ্টা করুন।")
            }
        }, "ubuntu-install").start()
    }

    private fun arch(): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        return when {
            abi.startsWith("arm64") -> "arm64"
            abi.startsWith("x86_64") -> "amd64"
            else -> throw IllegalStateException("এই ফোনের প্রসেসর ($abi) সাপোর্টেড না — 64-bit ARM লাগবে")
        }
    }

    private fun doInstall() {
        val arch = arch()
        rootfs.deleteRecursively()
        rootfs.mkdirs()
        tmpDir.mkdirs()

        var lastError: Exception? = null
        for (version in UBUNTU_POINT_RELEASES) {
            val url = "https://cdimage.ubuntu.com/ubuntu-base/releases/$UBUNTU_VERSION/release/" +
                "ubuntu-base-$version-base-$arch.tar.gz"
            try {
                downloadAndExtract(url)
                lastError = null
                break
            } catch (e: java.io.FileNotFoundException) {
                lastError = e // this point release isn't on the server; try the next one
            }
        }
        lastError?.let { throw it }

        update(State.INSTALLING, 0.97, "Ubuntu সাজানো হচ্ছে…")
        configure()
    }

    private fun downloadAndExtract(url: String) {
        Log.i(TAG, "downloading $url")
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        if (conn.responseCode == 404) throw java.io.FileNotFoundException(url)
        if (conn.responseCode != 200) throw java.io.IOException("HTTP ${conn.responseCode}")
        val total = conn.contentLengthLong.coerceAtLeast(1)

        var read = 0L
        var lastReport = 0L
        val counting = object : FilterInputStream(BufferedInputStream(conn.inputStream, 64 * 1024)) {
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val n = super.read(b, off, len)
                if (n > 0) {
                    read += n
                    if (read - lastReport > 256 * 1024) {
                        lastReport = read
                        val mb = read / (1024 * 1024)
                        val totalMb = total / (1024 * 1024)
                        update(State.INSTALLING, 0.95 * read / total, "Ubuntu নামানো হচ্ছে… $mb / $totalMb MB")
                    }
                }
                return n
            }
        }
        counting.use { extractTarGz(it) }
    }

    private fun extractTarGz(input: InputStream) {
        val hardLinks = mutableListOf<Pair<File, File>>()
        val dirModes = mutableListOf<Pair<File, Int>>()
        TarArchiveInputStream(GZIPInputStream(input)).use { tar ->
            while (true) {
                val entry: TarArchiveEntry = tar.nextEntry ?: break
                val name = entry.name.removePrefix("./").trimEnd('/')
                if (name.isEmpty()) continue
                val dest = File(rootfs, name)
                if (!dest.canonicalPath.startsWith(rootfs.canonicalPath)) continue // path traversal guard
                when {
                    entry.isDirectory -> {
                        dest.mkdirs()
                        dirModes += dest to entry.mode
                    }
                    entry.isSymbolicLink -> {
                        dest.parentFile?.mkdirs()
                        dest.delete()
                        Os.symlink(entry.linkName, dest.absolutePath)
                    }
                    entry.isLink -> {
                        hardLinks += dest to File(rootfs, entry.linkName.removePrefix("./"))
                    }
                    entry.isFile -> {
                        dest.parentFile?.mkdirs()
                        dest.delete()
                        dest.outputStream().use { tar.copyTo(it, 64 * 1024) }
                        Os.chmod(dest.absolutePath, (entry.mode and 0x1ff) or 0x180) // keep rw for owner
                    }
                    else -> Unit // device nodes etc. can't be created (and aren't needed under proot)
                }
            }
        }
        // Android doesn't allow hard links in app storage: copy the file instead.
        for ((dest, target) in hardLinks) {
            if (!target.exists()) continue
            dest.parentFile?.mkdirs()
            dest.delete()
            target.copyTo(dest, overwrite = true)
            Os.chmod(dest.absolutePath, Os.stat(target.absolutePath).st_mode and 0xfff)
        }
        for ((dir, mode) in dirModes.asReversed()) {
            try {
                Os.chmod(dir.absolutePath, (mode and 0x1ff) or 0x1c0) // owner always rwx
            } catch (_: Exception) {
            }
        }
    }

    /** Writes the small files that make Ubuntu work nicely under proot on Android. */
    private fun configure() {
        fun write(path: String, text: String, mode: Int = 0x1a4 /* 0644 */) {
            val f = File(rootfs, path)
            f.parentFile?.mkdirs()
            if (f.exists() || isSymlink(f)) f.delete()
            f.writeText(text)
            Os.chmod(f.absolutePath, mode)
        }

        write("etc/resolv.conf", "nameserver 8.8.8.8\nnameserver 1.1.1.1\n")
        write("etc/hosts", "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n127.0.1.1 android\n")
        write("etc/hostname", "android\n")
        // apt drops privileges to "_apt", which proot's fake root can't do.
        write("etc/apt/apt.conf.d/99-agy-terminal", "APT::Sandbox::User \"root\";\nAcquire::Retries \"3\";\n")

        File(rootfs, "tmp").apply { mkdirs(); Os.chmod(absolutePath, 0x3ff /* 1777 */) }
        File(rootfs, "root").mkdirs()
        writeFakeProc()
        syncGuestFiles()
    }

    @Volatile private var guestFilesSynced = false

    /**
     * Files this app owns inside Ubuntu (helper scripts, group names). Rewritten once per
     * app start so fixes reach Ubuntu installs made by older versions of the app.
     */
    private fun syncGuestFiles() {
        if (guestFilesSynced) return
        fun write(path: String, text: String, mode: Int) {
            val f = File(rootfs, path)
            f.parentFile?.mkdirs()
            if (f.exists() || isSymlink(f)) f.delete()
            f.writeText(text)
            Os.chmod(f.absolutePath, mode)
        }
        val exec = 0x1ed // 0755
        write("usr/local/bin/xdg-open", ASSET_XDG_OPEN, exec)
        write("usr/local/bin/agy-setup", ASSET_FIRSTBOOT, exec)
        write("usr/local/bin/agy-start", ASSET_AGY_START, exec)
        write("etc/profile.d/zz-agy-terminal.sh", ASSET_PROFILE, 0x1a4)
        nameAndroidGroups()
        guestFilesSynced = true
    }

    /**
     * Android apps belong to several supplementary groups (e.g. 3003 inet, 9997 everybody,
     * 20xxx/50xxx per-app groups). Give each a name in /etc/group, otherwise every login
     * prints "groups: cannot find name for group ID …".
     */
    private fun nameAndroidGroups() {
        val groupFile = File(rootfs, "etc/group")
        if (!groupFile.exists()) return
        val gids = sortedSetOf(Os.getgid())
        try {
            File("/proc/self/status").readLines()
                .firstOrNull { it.startsWith("Groups:") }
                ?.removePrefix("Groups:")?.trim()?.split(Regex("\\s+"))
                ?.mapNotNullTo(gids) { it.toIntOrNull() }
        } catch (_: Exception) {
        }
        val known = groupFile.readLines().mapNotNull { it.split(':').getOrNull(2)?.toIntOrNull() }.toSet()
        val missing = gids.filter { it !in known }
        if (missing.isNotEmpty()) groupFile.appendText(missing.joinToString("") { "aid_$it:x:$it:\n" })
    }

    private fun isSymlink(f: File) = try {
        android.system.OsConstants.S_ISLNK(Os.lstat(f.absolutePath).st_mode)
    } catch (_: Exception) {
        false
    }

    /** Android hides some /proc files from apps; programs like `top` or Node expect them. */
    private fun writeFakeProc() {
        fakeProc.mkdirs()
        val files = mapOf(
            "loadavg" to "0.12 0.07 0.02 2/165 765\n",
            "stat" to "cpu  1957 0 2877 93280 262 342 254 87 0 0\n" +
                "cpu0 31 0 226 12027 82 10 4 9 0 0\nintr 0\nctxt 0\nbtime 0\nprocesses 0\n" +
                "procs_running 1\nprocs_blocked 0\nsoftirq 0\n",
            "uptime" to "124.08 932.80\n",
            "version" to "Linux version ${System.getProperty("os.version")} (proot) #1 SMP PREEMPT\n",
            "vmstat" to "nr_free_pages 136234\nnr_inactive_anon 0\nnr_active_anon 0\n",
        )
        for ((name, text) in files) File(fakeProc, name).writeText(text)
    }

    // ------------------------------------------------------------------ launch

    data class Launch(val command: String, val args: Array<String>, val env: Array<String>, val cwd: String)

    private val libDir: File get() = File(context.filesDir, "lib")

    /**
     * proot (an unmodified Termux build) links against "libtalloc.so.2", but Android only
     * ships files named lib*.so in the APK. Point that name at the bundled copy. The native
     * library dir changes on every app update, so this is refreshed before each launch.
     */
    private fun prepareLibs() {
        libDir.mkdirs()
        val link = File(libDir, "libtalloc.so.2")
        link.delete()
        Os.symlink("$nativeDir/libtalloc.so", link.absolutePath)
    }

    /** kind = "ubuntu" (login shell) or "agy" (Antigravity CLI, then a shell). */
    fun launch(kind: String): Launch {
        tmpDir.mkdirs()
        prepareLibs()
        syncGuestFiles()
        val proot = "$nativeDir/libproot.so"
        val args = mutableListOf(
            proot,
            "--kill-on-exit",
            "--link2symlink",
            "--sysvipc",
            "-0",
            "-r", rootfs.absolutePath,
            "-b", "/dev",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "/dev/urandom:/dev/random",
            "-b", "/proc/self/fd:/dev/fd",
            "-b", "/proc/self/fd/0:/dev/stdin",
            "-b", "/proc/self/fd/1:/dev/stdout",
            "-b", "/proc/self/fd/2:/dev/stderr",
            "-b", "${rootfs.absolutePath}/tmp:/dev/shm",
        )
        for (name in listOf("loadavg", "stat", "uptime", "version", "vmstat")) {
            if (!File("/proc/$name").canRead()) args += listOf("-b", "${fakeProc.absolutePath}/$name:/proc/$name")
        }
        val sdcard = File("/storage/emulated/0")
        if (sdcard.canRead()) args += listOf("-b", "${sdcard.absolutePath}:/sdcard")
        args += listOf("-w", "/root", "/usr/bin/env", "-i")
        args += listOf(
            "HOME=/root",
            "USER=root",
            "LOGNAME=root",
            "SHELL=/bin/bash",
            "TERM=xterm-256color",
            "COLORTERM=truecolor",
            "LANG=C.UTF-8",
            "PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TMPDIR=/tmp",
            "BROWSER=/usr/local/bin/xdg-open",
            "AGY_TERMINAL=1",
        )
        when (kind) {
            "agy" -> args += listOf("/bin/bash", "-l", "/usr/local/bin/agy-start")
            // used by the debug-only self test (see SessionService.runSelfTest)
            "selftest" -> args += listOf(
                "/bin/bash", "-lc",
                "head -2 /etc/os-release; echo PROOT_OK; agy-setup && agy --version && echo SELFTEST_OK; " +
                    // diagnostics: terminal settings, and agy's raw output on a PTY made inside Ubuntu
                    "echo STTY: $(stty -a | tr '\\n' ' '); " +
                    "(sleep 30) | timeout -s KILL 25 script -qfc agy /tmp/agy.ts >/dev/null 2>&1; " +
                    "echo AGYTS_BYTES=$(wc -c < /tmp/agy.ts); " +
                    "cat -v /tmp/agy.ts | tr -d '\\n' | fold -w 300 | head -8 | sed 's/^/AGYTS| /'; " +
                    "true",
            )
            else -> args += listOf("/bin/bash", "-l")
        }

        val env = arrayOf(
            "PATH=/system/bin:/system/xbin",
            "HOME=${context.filesDir.absolutePath}",
            "TMPDIR=${tmpDir.absolutePath}",
            "LD_LIBRARY_PATH=${libDir.absolutePath}:$nativeDir",
            "PROOT_TMP_DIR=${tmpDir.absolutePath}",
            "PROOT_LOADER=$nativeDir/libproot-loader.so",
            "PROOT_LOADER_32=$nativeDir/libproot-loader32.so",
            "ANDROID_DATA=/data",
            "ANDROID_ROOT=/system",
        )
        return Launch(proot, args.toTypedArray(), env, context.filesDir.absolutePath)
    }

    /** Plain Android shell (no Ubuntu) — handy for debugging. */
    fun launchAndroidShell(): Launch = Launch(
        "/system/bin/sh",
        arrayOf("/system/bin/sh", "-l"),
        arrayOf(
            "PATH=/system/bin:/system/xbin",
            "HOME=${context.filesDir.absolutePath}",
            "TMPDIR=${tmpDir.apply { mkdirs() }.absolutePath}",
            "TERM=xterm-256color",
            "LANG=C.UTF-8",
        ),
        context.filesDir.absolutePath,
    )

    companion object {
        private const val TAG = "UbuntuManager"
        const val UBUNTU_VERSION = "24.04"
        // Newest first; the installer falls back if a point release isn't published.
        private val UBUNTU_POINT_RELEASES = listOf("24.04.5", "24.04.4", "24.04.3")

        /** xdg-open / $BROWSER inside Ubuntu: asks the app (via an OSC escape) to open the URL on the phone. */
        private val ASSET_XDG_OPEN = """
            #!/bin/sh
            # Opens a URL in the phone's browser (handled by the Agy Terminal app).
            url="${'$'}1"
            [ -z "${'$'}url" ] && exit 1
            printf '\033]7770;open;%s\007' "${'$'}url" > /dev/tty 2>/dev/null || printf '\033]7770;open;%s\007' "${'$'}url"
            echo "ব্রাউজারে খোলা হচ্ছে: ${'$'}url" >&2
        """.trimIndent() + "\n"

        /** One-time setup inside Ubuntu: base tools + the official Antigravity CLI installer. */
        private val ASSET_FIRSTBOOT = """
            #!/bin/bash
            # Agy Terminal — first-time setup (run again any time with: agy-setup)
            set -o pipefail
            G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; N='\033[0m'
            echo -e "${'$'}{Y}✦ প্রথমবারের সেটআপ — কয়েক মিনিট লাগতে পারে, অ্যাপ খোলা রাখুন${'$'}{N}"
            export DEBIAN_FRONTEND=noninteractive
            step() { echo -e "\n${'$'}{G}▸ ${'$'}*${'$'}{N}"; }
            step "প্যাকেজ তালিকা আপডেট (apt update)"
            apt-get update || { echo -e "${'$'}{R}apt update ব্যর্থ — ইন্টারনেট দেখে 'agy-setup' চালান${'$'}{N}"; exit 1; }
            step "দরকারি টুল ইনস্টল (curl, git, nano …)"
            apt-get install -y --no-install-recommends ca-certificates curl git nano less procps unzip xz-utils openssh-client \
              || { echo -e "${'$'}{R}ইনস্টল ব্যর্থ — আবার চেষ্টা করতে 'agy-setup' চালান${'$'}{N}"; exit 1; }
            if [ ! -x "${'$'}HOME/.local/bin/agy" ]; then
              step "Antigravity CLI ইনস্টল (Google এর অফিসিয়াল ইনস্টলার)"
              curl -fsSL https://antigravity.google/cli/install.sh | bash \
                || { echo -e "${'$'}{R}agy ইনস্টল ব্যর্থ — আবার চেষ্টা করতে 'agy-setup' চালান${'$'}{N}"; exit 1; }
            fi
            grep -q '.local/bin' "${'$'}HOME/.bashrc" 2>/dev/null || echo 'export PATH="${'$'}HOME/.local/bin:${'$'}PATH"' >> "${'$'}HOME/.bashrc"
            touch "${'$'}HOME/.agy-terminal-setup-done"
            echo -e "\n${'$'}{G}✓ সেটআপ শেষ! 'agy' লিখে Antigravity চালান।${'$'}{N}\n"
        """.trimIndent() + "\n"

        /** Started by the "Antigravity" button: setup if needed, run agy, then stay in a shell. */
        private val ASSET_AGY_START = """
            #!/bin/bash
            [ -f "${'$'}HOME/.agy-terminal-setup-done" ] || /usr/local/bin/agy-setup
            export PATH="${'$'}HOME/.local/bin:${'$'}PATH"
            if command -v agy >/dev/null 2>&1; then
              agy
            else
              echo "agy পাওয়া যায়নি — 'agy-setup' চালিয়ে আবার চেষ্টা করুন।"
            fi
            exec bash -l
        """.trimIndent() + "\n"

        /** Runs for every login shell: first-time setup + a friendly prompt. */
        private val ASSET_PROFILE = """
            # Agy Terminal
            export PATH="${'$'}HOME/.local/bin:${'$'}PATH"
            if [ -n "${'$'}PS1" ] && [ -z "${'$'}AGY_SETUP_RUNNING" ] && [ ! -f "${'$'}HOME/.agy-terminal-setup-done" ] && [ "${'$'}0" != "/usr/local/bin/agy-start" ]; then
              AGY_SETUP_RUNNING=1 /usr/local/bin/agy-setup
            fi
            PS1='\[\e[1;32m\]ubuntu\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '
        """.trimIndent() + "\n"
    }
}
