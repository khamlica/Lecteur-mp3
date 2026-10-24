package com.khamlichi.hanabi

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream

// Ce que sert la page du lecteur, sous une adresse https locale (les Worker, Web Audio et fetch exigent une
// vraie origine) :
//   /app/…    l'interface, dans les ressources de l'APK (web/, copiée depuis l'app de bureau, voir build.gradle.kts)
//   /music/…  les fichiers de musique du téléphone (l'élément audio y avance par requêtes partielles)
object WebContent {
    const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"
    const val PAGE = "$ORIGIN/app/src/renderer/player.html"
    private const val MUSIC = "/music"

    fun musicUrl(path: String): String = ORIGIN + MUSIC + path.split('/').joinToString("/") { Uri.encode(it) }

    private val TYPES = mapOf(
        "html" to "text/html", "js" to "text/javascript", "css" to "text/css", "svg" to "image/svg+xml",
        "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "json" to "application/json",
        "mp3" to "audio/mpeg", "opus" to "audio/ogg", "ogg" to "audio/ogg", "m4a" to "audio/mp4",
        "woff2" to "font/woff2",
    )

    private fun typeOf(name: String) = TYPES[name.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"

    fun serve(context: Context, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != HOST) return null
        val path = url.path ?: return notFound()
        return when {
            path.startsWith("/app/") -> asset(context, path.removePrefix("/app/"))
            path.startsWith("$MUSIC/") -> try { music(Uri.decode(url.encodedPath!!.removePrefix(MUSIC)), request.requestHeaders["Range"] ?: request.requestHeaders["range"]) } catch (e: Exception) {
                android.util.Log.w("HanabiWeb", "lecture impossible", e); notFound()
            }
            else -> notFound()
        }
    }

    // no-store : le cache du navigateur garderait des morceaux de fichier qu'il ne sait pas revalider (ni ETag ni date),
    // et les requêtes partielles suivantes échoueraient
    private fun headers(vararg extra: Pair<String, String>) = mutableMapOf("Cache-Control" to "no-store", *extra)

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers(), "".byteInputStream())

    private fun asset(context: Context, path: String): WebResourceResponse {
        if (path.contains("..")) return notFound()
        return try {
            val stream = context.assets.open("web/$path")
            WebResourceResponse(typeOf(path), if (typeOf(path).startsWith("text/")) "utf-8" else null, 200, "OK", headers(), stream)
        } catch (_: Exception) {
            notFound()
        }
    }

    // La WebView applique elle-même la plage demandée (Range) au flux rendu : elle saute jusqu'au début de la plage, et
    // lit jusqu'au bout. On lui rend donc toujours le fichier entier, mais avec le statut et la plage d'une réponse
    // partielle : sans eux, l'élément audio prendrait le morceau pour un direct, de durée inconnue.
    private fun music(path: String, range: String?): WebResourceResponse {
        val file = File(path)
        if (!Library.AUDIO.containsMatchIn(file.name) || !file.isFile) return notFound()
        val total = file.length()
        val start = range?.let { Regex("bytes=([0-9]+)-").find(it) }?.groupValues?.get(1)?.toLongOrNull()
        if (start == null || start >= total) {
            return WebResourceResponse(typeOf(file.name), null, 200, "OK", headers("Accept-Ranges" to "bytes"), FileInputStream(file))
        }
        return WebResourceResponse(typeOf(file.name), null, 206, "Partial Content",
            headers("Accept-Ranges" to "bytes", "Content-Range" to "bytes $start-${total - 1}/$total"), FileInputStream(file))
    }
}
