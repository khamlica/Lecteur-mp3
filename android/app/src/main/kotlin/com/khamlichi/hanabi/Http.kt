package com.khamlichi.hanabi

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

object Http {
    class Response(val status: Int, val body: ByteArray) {
        val ok get() = status in 200..299
        val text get() = body.toString(Charsets.UTF_8)
    }

    fun get(url: String, timeoutMs: Int = 5000, headers: Map<String, String> = emptyMap()): Response {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "HanabiPlayer")
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            return Response(status, stream?.use { it.readBytes() } ?: ByteArray(0))
        } finally {
            conn.disconnect()
        }
    }

    // Téléchargement d'un gros fichier (mise à jour) ; GitHub renvoie vers un autre domaine, suivi à la main pour
    // ne pas y envoyer le jeton
    fun download(url: String, headers: Map<String, String>, dest: File) {
        var conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.setRequestProperty("User-Agent", "HanabiPlayer")
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        if (conn.responseCode in 300..399) {
            val location = conn.getHeaderField("Location")
            conn.disconnect()
            conn = URL(location).openConnection() as HttpURLConnection
            conn.connectTimeout = 15000
            conn.readTimeout = 30000
        }
        try {
            if (conn.responseCode !in 200..299) throw IOException("HTTP ${conn.responseCode}")
            val part = File(dest.path + ".part")
            conn.inputStream.use { input -> part.outputStream().use { input.copyTo(it) } }
            if (!part.renameTo(dest)) throw IOException("enregistrement impossible")
        } finally {
            conn.disconnect()
        }
    }

    fun online(): Boolean {
        val cm = HanabiApp.app.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
