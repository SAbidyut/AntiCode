package com.sabidyut.agyterm

import android.content.Context
import android.os.Build
import android.os.Environment
import java.io.File

/** Access to the phone's shared storage (/sdcard), the way Termux exposes it. */
object Storage {
    val root: File get() = Environment.getExternalStorageDirectory() // /storage/emulated/0

    fun hasAccess(@Suppress("UNUSED_PARAMETER") context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()) return true
        // Legacy storage (this app targets API 28): listing works once the permission is granted.
        return root.listFiles() != null
    }

    /** ~/storage/<name> → path inside Ubuntu (where /sdcard is the phone's storage). */
    val links = linkedMapOf(
        "shared" to "/sdcard",
        "downloads" to "/sdcard/Download",
        "dcim" to "/sdcard/DCIM",
        "pictures" to "/sdcard/Pictures",
        "music" to "/sdcard/Music",
        "movies" to "/sdcard/Movies",
        "documents" to "/sdcard/Documents",
    )
}
