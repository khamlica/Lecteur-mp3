import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

// Même numéro de version que l'app de bureau (package.json) : une étiquette vX.Y.Z publie les deux.
val desktopVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val versionParts = desktopVersion.split(".").map { it.toInt() }

// Clé de signature des versions publiées : keystore.properties (en local) ou variables d'environnement
// (GitHub Actions). Sans elle, la version « release » est signée avec la clé de débogage.
val signing = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
fun signingValue(key: String, env: String): String? = signing.getProperty(key) ?: System.getenv(env)

android {
    namespace = "com.khamlichi.hanabi"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.khamlichi.hanabi"
        minSdk = 26
        targetSdk = 36
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = desktopVersion
    }

    signingConfigs {
        val store = signingValue("storeFile", "ANDROID_KEYSTORE_FILE")
        if (store != null) {
            create("release") {
                storeFile = rootProject.file(store)
                storePassword = signingValue("storePassword", "ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingValue("keyAlias", "ANDROID_KEY_ALIAS") ?: "hanabi"
                keyPassword = signingValue("keyPassword", "ANDROID_KEY_PASSWORD") ?: storePassword
            }
        }
    }

    buildTypes {
        debug {
            // l'émulateur (x86_64) en plus des téléphones
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            // les téléphones actuels : python, yt-dlp et ffmpeg pèsent ~50 Mo par architecture
            ndk { abiFilters += listOf("arm64-v8a") }
        }
    }

    packaging {
        // youtubedl-android lance python et ffmpeg depuis le dossier des bibliothèques : elles doivent y être
        // extraites à l'installation
        jniLibs { useLegacyPackaging = true }
    }
}

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.core:core:1.18.0")
    // scanner de QR code de Google Play : sans autorisation d'appareil photo ni écran à faire (synchronisation sans Wi‑Fi)
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // le scanner tire une vieille version de fragment, qui casserait registerForActivityResult (MainActivity)
    implementation("androidx.fragment:fragment:1.8.9")
}

// ---------- Interface : celle de l'app de bureau (src/renderer), adaptée au téléphone ----------

// Copie l'interface du lecteur de bureau et celle propre au téléphone (src/web) dans les ressources de l'APK :
//   web/src/renderer/…  l'interface de bureau, telle quelle (effets, thèmes, fenêtres de réglages)
//   web/assets/…        les images partagées (pochette par défaut)
//   web/src/renderer/player.html  la page du lecteur pour téléphone, à côté de celle du bureau
//   web/src/renderer/android/…  sa mise en page et le pont vers Android
// Les fenêtres de bureau (menu, effets, édition) s'ouvrent ici dans un panneau : on leur ajoute le pont.
abstract class CopyWebTask : DefaultTask() {
    @get:InputDirectory abstract val renderer: DirectoryProperty
    @get:InputDirectory abstract val shared: DirectoryProperty
    @get:InputDirectory abstract val mobile: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val out = outputDir.get().asFile.resolve("web")
        out.deleteRecursively()
        val dest = out.resolve("src/renderer")
        renderer.get().asFile.copyRecursively(dest)
        shared.get().asFile.resolve("cover.svg").copyTo(out.resolve("assets/cover.svg"))
        mobile.get().asFile.copyRecursively(dest.resolve("android"))
        // la page du lecteur à côté de celle du bureau (index.html) : mêmes adresses relatives (Worker des effets…)
        dest.resolve("android/player.html").renameTo(dest.resolve("player.html"))
        for (page in listOf("menu.html", "fx-panel.html", "editor.html", "sync.html", "lyrics.html")) {
            val file = dest.resolve(page)
            val html = file.readText()
            require("</title>" in html && "</head>" in html) { "$page : balises </title> et </head> introuvables" }
            file.writeText(html
                .replaceFirst("</title>", "</title>\n  <script src=\"android/child.js\"></script>")
                .replaceFirst("</head>", "  <link rel=\"stylesheet\" href=\"android/child.css\">\n</head>"))
        }
    }
}

val copyWeb = tasks.register<CopyWebTask>("copyWeb") {
    renderer.set(rootProject.file("../src/renderer"))
    shared.set(rootProject.file("../assets"))
    mobile.set(file("src/web"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyWeb, CopyWebTask::outputDir)
    }
}
