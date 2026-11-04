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
class UbuntuManager private constructor(private val context: Context) {

    enum class State { NONE, INSTALLING, READY, ERROR }

    @Volatile var state: State = if (isInstalled()) State.READY else State.NONE
        private set
    @Volatile var progress = 0.0
        private set
    @Volatile var message = ""
        private set

    var onStateChanged: (() -> Unit)? = null
    /** The service: stays in the foreground (with a wake lock) while installing. */
    var onBusyChanged: (() -> Unit)? = null

    val rootfs: File get() = File(context.filesDir, "ubuntu")
    private val tmpDir: File get() = File(context.filesDir, "tmp")
    private val fakeProc: File get() = File(context.filesDir, "fakeproc")
    private val marker: File get() = File(context.filesDir, "ubuntu.installed")
    private val nativeDir: String get() = context.applicationInfo.nativeLibraryDir

    fun isInstalled() = marker.exists() && File(rootfs, "bin/bash").exists()

    /** Helper files and library links, ahead of the first launch (launch also calls it). */
    @Synchronized
    fun prepare() {
        if (!isInstalled()) return
        tmpDir.mkdirs()
        prepareLibs()
        syncGuestFiles()
    }

    /** Claude Code's own full-screen view (Settings → Advanced); off: its classic view. */
    var claudeFullscreen: Boolean
        get() = context.getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE).getBoolean("claudeFullscreen", false)
        set(v) = context.getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE).edit().putBoolean("claudeFullscreen", v).apply()

    /** The shell prompt's look (Settings → Prompt style): Ubuntu's ~/.config/agy-terminal/prompt. */
    var promptStyle: String
        get() = try {
            File(rootfs, "root/.config/agy-terminal/prompt").readText().trim()
        } catch (_: Exception) {
            ""
        }.takeIf { it in PROMPT_STYLES } ?: "powerline"
        set(v) {
            if (v !in PROMPT_STYLES) return
            try {
                val f = File(rootfs, "root/.config/agy-terminal/prompt")
                f.parentFile?.mkdirs()
                f.writeText("$v\n")
            } catch (_: Exception) { /* not installed yet */ }
        }

    /**
     * The account an agent is signed in with, partly hidden ("sh***@gmail.com"), or "" when
     * not known. Claude Code keeps it in ~/.claude.json. Antigravity shows it in its header
     * (the app remembers it from there); before that, its account and token files under
     * ~/.gemini are looked through for an email (a field, or the Google sign-in token's).
     * Read from the files only — nothing goes over the network.
     */
    fun accountEmail(kind: String): String {
        val home = File(rootfs, "root")
        val email = try {
            when (kind) {
                "claude" -> JSONObject(File(home, ".claude.json").readText())
                    .optJSONObject("oauthAccount")?.optString("emailAddress").orEmpty()
                // (the account its header showed, which the app remembers; else its files)
                "agy" -> com.sabidyut.agyterm.Accounts.antigravity(context)?.takeIf { "@" in it }
                    ?: agyEmail(File(home, ".gemini"))
                else -> ""
            }
        } catch (_: Exception) {
            ""
        }
        return maskEmail(email.trim())
    }

    private fun agyEmail(dir: File): String {
        if (!dir.isDirectory) return ""
        val skip = setOf("brain", "skills", "plugins", "sidecars", "artifacts", "workflows", "global_workflows", "tmp", "history", "cache", "logs")
        val names = Regex("account|oauth|cred|auth|token|user|login|session", RegexOption.IGNORE_CASE)
        val field = Regex(""""(?:email|emailAddress|user_email|userEmail|active)"\s*:\s*"([^"\s@]+@[^"\s@]+\.[^"\s@]+)"""")
        val jwt = Regex(""""id_token"\s*:\s*"([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.""")
        val files = dir.walkTopDown().maxDepth(3)
            .onEnter { it == dir || it.name !in skip }
            .filter { it.isFile && it.length() in 1..262_144 && names.containsMatchIn(it.name) }
            .take(40)
        for (f in files) {
            val text = try { f.readText() } catch (_: Exception) { continue }
            field.find(text)?.let { return it.groupValues[1] }
            jwt.find(text)?.let { m ->
                try {
                    val payload = String(android.util.Base64.decode(m.groupValues[2], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))
                    val e = JSONObject(payload).optString("email")
                    if ("@" in e) return e
                } catch (_: Exception) { /* not a sign-in token */ }
            }
        }
        return ""
    }

    fun stateJson(): String = JSONObject()
        .put("host", "android")
        .put("home", "/root")
        .put("ubuntu", state.name.lowercase())
        .put("progress", progress)
        .put("message", message)
        .put("storage", com.sabidyut.agyterm.Storage.hasAccess(context))
        // may run in the background without battery restrictions
        .put("background", (context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager).isIgnoringBatteryOptimizations(context.packageName))
        .toString()

    private fun update(s: State, p: Double, m: String) {
        val changed = s != state
        state = s
        progress = p
        message = m
        onStateChanged?.invoke()
        if (changed) onBusyChanged?.invoke()
    }

    // ------------------------------------------------------------------ install

    @Synchronized
    fun install() {
        if (state == State.INSTALLING || isInstalled()) return
        update(State.INSTALLING, 0.0, "Starting Ubuntu download…")
        Thread({
            try {
                doInstall()
                marker.writeText("ubuntu-base ${UBUNTU_VERSION}\n")
                update(State.READY, 1.0, "Ubuntu is ready")
            } catch (t: Throwable) {
                Log.e(TAG, "install failed", t)
                update(State.ERROR, 0.0, "Setup failed: ${t.message ?: t.javaClass.simpleName}. Check your internet connection and try again.")
            }
        }, "ubuntu-install").start()
    }

    private fun arch(): String {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        return when {
            abi.startsWith("arm64") -> "arm64"
            abi.startsWith("x86_64") -> "amd64"
            else -> throw IllegalStateException("This phone's processor ($abi) is not supported — a 64-bit ARM device is required")
        }
    }

    private fun doInstall() {
        val arch = arch()
        deleteTree(rootfs) // never through ~/storage/shared → /sdcard
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

        update(State.INSTALLING, 0.97, "Configuring Ubuntu…")
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
                        update(State.INSTALLING, 0.95 * read / total, "Downloading Ubuntu… $mb / $totalMb MB")
                    }
                }
                return n
            }
        }
        counting.use { extractTarGz(it) }
    }

    private fun extractTarGz(input: InputStream, root: File = rootfs) {
        val hardLinks = mutableListOf<Pair<File, File>>()
        val dirModes = mutableListOf<Pair<File, Int>>()
        TarArchiveInputStream(GZIPInputStream(input)).use { tar ->
            while (true) {
                val entry: TarArchiveEntry = tar.nextEntry ?: break
                val name = entry.name.removePrefix("./").trimEnd('/')
                if (name.isEmpty()) continue
                val dest = File(root, name)
                if (!dest.canonicalPath.startsWith(root.canonicalPath)) continue // path traversal guard
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
                        hardLinks += dest to File(root, entry.linkName.removePrefix("./"))
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

    /** ble.sh (bash autosuggestions) ships in the APK; unpack it when its version changes. */
    private fun syncBlesh() {
        val version = try {
            context.assets.open("blesh.version").bufferedReader().use { it.readText().trim() }
        } catch (_: Exception) {
            return // not bundled in this build
        }
        val dir = File(rootfs, "usr/share/blesh")
        val stamp = File(dir, ".agy-version")
        if (stamp.exists() && stamp.readText().trim() == version) return
        try {
            deleteTree(dir)
            dir.mkdirs()
            context.assets.open("blesh.pack").use { extractTarGz(it, dir) }
            stamp.writeText(version)
        } catch (e: Exception) {
            Log.w(TAG, "ble.sh unpack failed", e)
            deleteTree(dir)
        }
    }

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
        fun asset(name: String) = context.assets.open("guest/$name").bufferedReader().use { it.readText() }
        write("usr/local/bin/xdg-open", asset("xdg-open"), exec)
        write("usr/local/bin/setup-storage", asset("setup-storage"), exec)
        for (script in listOf("term-setup", "agy-setup", "agy-start", "claude-setup", "claude-start", "agy-autocomplete")) {
            write("usr/local/bin/$script", asset(script), exec)
        }
        write("usr/local/bin/agy-prompt", asset("agy-prompt"), exec)
        write("etc/profile.d/zz-agy-terminal.sh", asset("profile.sh"), 0x1a4)
        write("etc/agy-terminal.bashrc", asset("bashrc"), 0x1a4)
        syncBlesh()
        // Hook the prompt/aliases into root's .bashrc (after Ubuntu's own PS1).
        val bashrc = File(rootfs, "root/.bashrc")
        val hook = "[ -f /etc/agy-terminal.bashrc ] && . /etc/agy-terminal.bashrc"
        if (!bashrc.exists() || !bashrc.readText().contains(hook)) bashrc.appendText("\n$hook\n")
        // ~/storage/* → the phone's folders (like Termux), dangling until access is granted.
        val storageDir = File(rootfs, "root/storage").apply { mkdirs() }
        for ((name, target) in com.sabidyut.agyterm.Storage.links) {
            val link = File(storageDir, name)
            if (!isSymlink(link)) {
                link.delete()
                try {
                    Os.symlink(target, link.absolutePath)
                } catch (_: Exception) {
                }
            }
        }
        nameAndroidGroups()
        writeFakeProc() // (installs made by older versions get the new ones too)
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

    /**
     * `rm -rf` that never follows symbolic links. (Kotlin's deleteRecursively does: through
     * ~/storage/shared → /sdcard it would empty the phone's own storage.)
     */
    private fun deleteTree(f: File) {
        val st = try {
            Os.lstat(f.absolutePath)
        } catch (_: Exception) {
            return // already gone
        }
        if (android.system.OsConstants.S_ISDIR(st.st_mode)) {
            try {
                Os.chmod(f.absolutePath, (st.st_mode and 0x1ff) or 0x1c0) // read-only dirs in the rootfs
            } catch (_: Exception) {
            }
            f.listFiles()?.forEach { deleteTree(it) }
        }
        f.delete() // a link itself, not what it points to
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
            // no user namespaces for apps (see launch)
            "max_user_namespaces" to "0\n",
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
    @Synchronized
    private fun prepareLibs() {
        libDir.mkdirs()
        val link = File(libDir, "libtalloc.so.2")
        val target = "$nativeDir/libtalloc.so"
        // only when it changed: a launch running right now must not see it missing
        if (isSymlink(link) && (try { Os.readlink(link.absolutePath) } catch (_: Exception) { null }) == target) return
        link.delete()
        Os.symlink(target, link.absolutePath)
    }

    /**
     * kind = "ubuntu" (login shell), "agy" (Antigravity CLI, then a shell) or
     * "claude" (Claude Code, then a shell).
     */
    fun launch(kind: String, cwd: String = ""): Launch {
        prepare()
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
        // Android doesn't let apps create user namespaces (its security policy refuses them),
        // even where the kernel's limit says they're allowed. Programs that look at the limit
        // before sandboxing their commands — the Antigravity CLI's terminal sandbox — would
        // otherwise go ahead, and every command they run fails with "fork/exec …: operation
        // not permitted". With the truth here they run the commands normally.
        if (File(fakeProc, "max_user_namespaces").isFile) {
            args += listOf("-b", "${fakeProc.absolutePath}/max_user_namespaces:/proc/sys/user/max_user_namespaces")
        }
        // The phone's storage. Bound even before access is granted, so a grant later works
        // without restarting the session (the kernel checks permission on each access).
        val sdcard = com.sabidyut.agyterm.Storage.root
        if (sdcard.exists()) args += listOf("-b", "${sdcard.absolutePath}:/sdcard")
        if (File("/storage").exists()) args += listOf("-b", "/storage")
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
            // proves that an "open this link" request comes from our xdg-open (not from text
            // a program printed, e.g. `cat` of a downloaded file)
            "ANTICODE_LINK_TOKEN=$linkToken",
            timeZoneEnv(), // the phone's time, not UTC (the prompt's clock, `date`, logs)
        )
        // Claude Code's full-screen view keeps its own scrollback: every swipe is a wheel event
        // it answers by redrawing the whole screen — slow under proot on a phone. Its classic
        // view writes to the terminal's scrollback, which the app scrolls smoothly itself.
        if (!claudeFullscreen) args += "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"
        // the folder picked in the app: the login shell goes there first (profile.sh)
        if (cwd.isNotEmpty()) normalizeGuestPath(cwd)?.takeIf { it != "/root" }?.let { args += "ANTICODE_CWD=$it" }
        when (kind) {
            "agy" -> args += listOf("/bin/bash", "-l", "/usr/local/bin/agy-start")
            "claude" -> args += listOf("/bin/bash", "-l", "/usr/local/bin/claude-start")
            // used by the debug-only self test (see SessionService.runSelfTest)
            "selftest" -> args += listOf(
                "/bin/bash", "-lc",
                "head -2 /etc/os-release; echo PROOT_OK; " +
                    // started in the folder picked in the app (the self test picks /tmp)
                    "c=FAIL; [ \"\$PWD\" = /tmp ] && c=OK; echo SELFTEST_CWD_\$c; cd; " +
                    "agy-setup && agy --version && " +
                    "claude-setup --auto && claude --version && echo SELFTEST_OK; " +
                    // agy must see that the terminal sandbox (user namespaces) isn't available
                    // here, or every command its agent runs fails with "operation not permitted"
                    "echo USERNS=$(cat /proc/sys/user/max_user_namespaces 2>&1); " +
                    "r=FAIL; timeout 20 agy --mode auto --print hi </dev/null 2>&1 | head -3 | sed 's/^/AGYSBX| /' | " +
                    "tee /dev/stderr | grep -q 'terminal sandbox is not available' && r=OK; echo SELFTEST_SANDBOX_\$r; " +
                    // diagnostics: ble.sh (autosuggestions) unpacked and loading in an interactive shell
                    "ls -la /usr/share/blesh/ble.sh /usr/share/blesh/.agy-version 2>&1 | sed 's/^/BLESH| /'; " +
                    "printf 'echo BLEI=\$BLE_VERSION:\$-\nexit\n' | script -qec 'bash -i' /dev/null 2>&1 | grep -a 'BLEI=[^\$]' | sed 's/^/BLESH| /'; " +
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

    /**
     * The phone's time zone for Ubuntu: its name when Ubuntu has the zone files (tzdata),
     * otherwise a POSIX rule with the current offset (no files needed), e.g. "<+06>-6".
     */
    private fun timeZoneEnv(): String {
        val tz = java.util.TimeZone.getDefault()
        if (File(rootfs, "usr/share/zoneinfo/${tz.id}").isFile) return "TZ=${tz.id}"
        val minutes = tz.getOffset(System.currentTimeMillis()) / 60_000
        val a = kotlin.math.abs(minutes)
        val h = a / 60
        val m = a % 60
        val east = minutes >= 0
        // ASCII digits whatever the phone's language (Bengali would give "+০৬", which the
        // C library rejects — the shell then falls back to UTC)
        val two = { n: Int -> String.format(java.util.Locale.ROOT, "%02d", n) }
        val name = (if (east) "+" else "-") + two(h) + (if (m > 0) two(m) else "")
        // POSIX counts the other way round: UTC+6 is written "-6"
        val rule = (if (east) "-" else "+") + h.toString() + (if (m > 0) ":" + two(m) else "")
        return "TZ=<$name>$rule"
    }

    // ------------------------------------------------------------------ folders (the picker)

    /** "~/a", "/root/a/../b" → "/root/a", "/root/b" (links not followed); null if not a path. */
    fun normalizeGuestPath(path: String): String? {
        if (path.isEmpty() || path.length > 4096 || path.any { it == '\u0000' || it == '\n' || it == '\r' }) return null
        val p = when {
            path == "~" -> "/root"
            path.startsWith("~/") -> "/root/" + path.substring(2)
            path.startsWith("/") -> path
            else -> return null
        }
        val out = ArrayList<String>()
        for (part in p.split('/')) when (part) {
            "", "." -> {}
            ".." -> if (out.isNotEmpty()) out.removeAt(out.size - 1)
            else -> out += part
        }
        return "/" + out.joinToString("/")
    }

    /** Folders bound into Ubuntu from the phone (see launch). */
    private fun boundHost(guest: String): File? = when {
        guest == "/sdcard" || guest.startsWith("/sdcard/") -> File(com.sabidyut.agyterm.Storage.root, guest.removePrefix("/sdcard").removePrefix("/"))
        guest == "/storage" || guest.startsWith("/storage/") -> File(guest)
        else -> null
    }

    /** Where a path inside Ubuntu is on the phone (Ubuntu's own links followed, e.g. ~/storage/shared). */
    private fun hostPath(guest: String, depth: Int = 0): File? {
        if (depth > 16) return null
        val parts = guest.split('/').filter { it.isNotEmpty() }
        var cur = ""
        for ((i, part) in parts.withIndex()) {
            val next = "$cur/$part"
            if (boundHost(next) == null) {
                val f = File(rootfs, next.removePrefix("/"))
                if (isSymlink(f)) {
                    var t = try { Os.readlink(f.absolutePath) } catch (_: Exception) { return null }
                    // a hard link made inside Ubuntu: proot keeps it as a link to a file in
                    // Ubuntu's folder on the phone (an absolute phone path, not an Ubuntu one)
                    val root = rootfs.absolutePath
                    if (t == root || t.startsWith("$root/")) t = t.removePrefix(root).ifEmpty { "/" }
                    val target = if (t.startsWith("/")) t else "$cur/$t"
                    val rest = parts.drop(i + 1).joinToString("/")
                    val n = normalizeGuestPath(if (rest.isEmpty()) target else "$target/$rest") ?: return null
                    return hostPath(n, depth + 1)
                }
            }
            cur = next
        }
        return boundHost(cur) ?: File(rootfs, cur.removePrefix("/"))
    }

    private fun child(dir: String, name: String) = if (dir == "/") "/$name" else "$dir/$name"

    /** The phone's file for a path inside Ubuntu (a file name tapped in the terminal). */
    fun hostFile(guest: String): File? = normalizeGuestPath(guest)?.let { hostPath(it) }

    /** The folders in a folder inside Ubuntu, as JSON: {path, dirs} or {path, error: notfound|noaccess}. */
    fun listDir(path: String): String {
        val g = normalizeGuestPath(path) ?: return JSONObject().put("path", path).put("error", "notfound").toString()
        val json = JSONObject().put("path", g)
        val host = hostPath(g)
        val names = host?.list()
        if (host == null || names == null) {
            val storage = com.sabidyut.agyterm.Storage.root.absolutePath
            val onPhone = host != null && (host.absolutePath.startsWith(storage) || host.absolutePath.startsWith("/storage"))
            val noAccess = (onPhone && !com.sabidyut.agyterm.Storage.hasAccess(context)) || host?.isDirectory == true
            return json.put("error", if (noAccess) "noaccess" else "notfound").toString()
        }
        // (the folder is resolved once; only entries that are links are followed — DCIM/Camera
        // has thousands of pictures)
        val dirs = names.asSequence()
            .filter { !it.startsWith(".") }
            .filter {
                val f = File(host, it)
                if (isSymlink(f)) hostPath(child(g, it))?.isDirectory == true else f.isDirectory
            }
            .sortedWith(String.CASE_INSENSITIVE_ORDER)
            .take(2000)
            .toList()
        return json.put("dirs", org.json.JSONArray(dirs)).toString()
    }

    /** Makes a folder inside Ubuntu (or the phone's storage); "" when done, else why not. */
    fun makeDir(path: String): String {
        val g = normalizeGuestPath(path) ?: return "That isn't a folder path."
        val name = g.substringAfterLast('/')
        if (name.isEmpty() || name.length > 255) return "That isn't a folder name."
        val parent = hostPath(g.substringBeforeLast('/').ifEmpty { "/" }) ?: return "That place wasn't found."
        val dir = File(parent, name)
        if (dir.exists()) return if (dir.isDirectory) "" else "A file with that name is already there."
        return if (dir.mkdir()) "" else "The folder couldn't be made here."
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
        /** "shawon.2449@gmail.com" → "sh***@gmail.com" ("" stays ""). */
        fun maskEmail(email: String): String {
            val at = email.lastIndexOf('@')
            if (at <= 0 || at == email.length - 1) return ""
            val local = email.substring(0, at)
            val keep = if (local.length <= 3) 1 else 2
            return local.take(keep) + "***" + email.substring(at)
        }

        val PROMPT_STYLES = setOf("powerline", "pure", "rainbow", "lean", "capsule", "simple")
        private const val UI_PREFS = "anticode-ui"
        private const val TAG = "UbuntuManager"
        const val UBUNTU_VERSION = "24.04"
        // Newest first; the installer falls back if a point release isn't published.
        private val UBUNTU_POINT_RELEASES = listOf("24.04.5", "24.04.4", "24.04.3")

        @Volatile private var instance: UbuntuManager? = null

        /** Random per app process; see ANTICODE_LINK_TOKEN. */
        val linkToken: String = java.util.UUID.randomUUID().toString().replace("-", "")

        /**
         * One per process: an install keeps running when the service is recreated, and a
         * new service must see it (not start a second install over the first).
         */
        fun get(context: Context): UbuntuManager = instance ?: synchronized(this) {
            instance ?: UbuntuManager(context.applicationContext).also { instance = it }
        }
    }
}
