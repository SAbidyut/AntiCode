plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The terminal UI is a web app (../../web-terminal). Its production build is copied
// into the APK's assets under web/.
val webDist = rootProject.file("../web-terminal/dist")
val webAssetsDir = layout.buildDirectory.dir("generated/webassets")

val syncWebAssets by tasks.registering(Sync::class) {
    from(webDist)
    into(webAssetsDir.map { it.dir("web") })
    doFirst {
        check(webDist.resolve("index.html").exists()) {
            "web-terminal is not built. Run:  cd web-terminal && npm ci && npm run build"
        }
    }
}

android {
    namespace = "com.sabidyut.agyterm"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "com.sabidyut.agyterm"
        minSdk = 26
        // targetSdk 28 on purpose: Android 10+ forbids apps targeting API 29+ from
        // executing files they downloaded into their own data directory, which is
        // exactly what running Ubuntu (proot) needs. Termux does the same. The app
        // is installed directly (not from Play Store), so this is allowed.
        //noinspection ExpiredTargetSdkVersion
        targetSdk = 28
        versionCode = 72
        versionName = "0.18.10"

        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                cFlags += listOf("-std=c11", "-Wall", "-Wextra", "-Werror", "-Os")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets["main"].assets.srcDir(webAssetsDir)

    signingConfigs {
        // A fixed key committed to the repo, so every build (CI or local) is signed the
        // same way and a newer APK installs over the old one. Fine for a personal,
        // sideloaded app; use a private key (e.g. from CI secrets) before publishing widely.
        create("sideload") {
            storeFile = file("agyterm-sideload.jks")
            storePassword = "agyterminal"
            keyAlias = "agyterm"
            keyPassword = "agyterminal"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("sideload")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }

    packaging {
        // proot & friends must exist as real files in nativeLibraryDir to be executed.
        jniLibs.useLegacyPackaging = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        disable += listOf("ExpiredTargetSdkVersion", "OldTargetApi")
        checkReleaseBuilds = false
        abortOnError = false
    }
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("org.apache.commons:commons-compress:1.27.1")
}
