package com.khamlichi.hanabi

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File

// Mises à jour automatiques, comme celles de l'app de bureau : les versions sont publiées dans les Releases du dépôt
// GitHub (privé) par .github/workflows/release.yml, avec l'APK. Pour les lire, l'app utilise le jeton en lecture
// seule que GitHub Actions ajoute à l'APK : une build faite en local n'en a pas et ne se met pas à jour.
// L'APK est téléchargé en arrière-plan ; Android demande ensuite d'accepter l'installation.
object Updater {
    private const val TAG = "Hanabi"
    private const val LATEST = "https://api.github.com/repos/khamlica/Lecteur-mp3/releases/latest"
    const val CHECK_INTERVAL = 6 * 3600 * 1000L
    private const val NOTIFICATION_ID = 2

    @Volatile var ready: String? = null // version téléchargée, prête à installer
        private set

    private fun token(context: Context): String? = try {
        JSONObject(context.assets.open("update-token.json").bufferedReader().readText()).getString("token")
    } catch (_: Exception) {
        null
    }

    private fun apk(context: Context) = File(context.cacheDir, "updates/Hanabi-Player.apk")

    private fun newer(a: String, b: String): Boolean {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = (x.getOrNull(i) ?: 0) - (y.getOrNull(i) ?: 0)
            if (d != 0) return d > 0
        }
        return false
    }

    // → la version prête à installer, ou null
    fun check(context: Context): String? {
        val token = token(context) ?: return null
        try {
            val auth = mapOf("Authorization" to "Bearer $token", "Accept" to "application/vnd.github+json")
            val res = Http.get(LATEST, 10000, auth)
            if (!res.ok) return null
            val release = JSONObject(res.text)
            val version = release.getString("tag_name").removePrefix("v")
            if (!newer(version, BuildConfigInfo.version(context))) return null
            val assets = release.getJSONArray("assets")
            val asset = (0 until assets.length()).map { assets.getJSONObject(it) }.firstOrNull { it.getString("name").endsWith(".apk") } ?: return null
            val dest = apk(context)
            val marker = File(dest.path + ".version")
            if (!(dest.exists() && marker.exists() && marker.readText() == version)) {
                dest.parentFile?.mkdirs()
                Http.download(asset.getString("url"), mapOf("Authorization" to "Bearer $token", "Accept" to "application/octet-stream"), dest)
                marker.writeText(version)
            }
            ready = version
            notifyReady(context, version)
            return version
        } catch (e: Exception) {
            Log.w(TAG, "Mise à jour impossible : ${e.message}")
            return null
        }
    }

    fun installIntent(context: Context): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk(context))
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun notifyReady(context: Context, version: String) {
        val pending = PendingIntent.getActivity(context, 3, installIntent(context), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(context, HanabiApp.CHANNEL_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Hanabi Player $version est prête")
            .setContentText("Toucher pour installer la mise à jour")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // notifications refusées : le menu ✨ propose quand même l'installation
        }
    }
}

object BuildConfigInfo {
    fun version(context: Context): String = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0"
}
