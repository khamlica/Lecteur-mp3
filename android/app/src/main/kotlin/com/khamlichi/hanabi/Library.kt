package com.khamlichi.hanabi

import android.media.MediaMetadataRetriever
import android.os.Environment
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.Collator
import java.util.Locale

// Les dossiers de musique, comme scanFolder et readMetadata dans main.js
object Library {
    val AUDIO = Regex("\\.(mp3|opus|m4a)$", RegexOption.IGNORE_CASE)

    // Ordre « naturel » à la française, comme localeCompare(…, 'fr', { numeric: true, sensitivity: 'base' }) :
    // sans tenir compte des accents ni de la casse, « piste 2 » avant « piste 10 »
    private val collator = Collator.getInstance(Locale.FRENCH).apply { strength = Collator.PRIMARY }
    private val chunk = Regex("\\d+|\\D+")
    val natural = Comparator<String> { a, b ->
        val x = chunk.findAll(a).map { it.value }.toList()
        val y = chunk.findAll(b).map { it.value }.toList()
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]; val q = y[i]
            val c = if (p[0].isDigit() && q[0].isDigit()) {
                p.trimStart('0').length.compareTo(q.trimStart('0').length).takeIf { it != 0 } ?: p.trimStart('0').compareTo(q.trimStart('0'))
            } else collator.compare(p, q)
            if (c != 0) return@Comparator c
        }
        x.size.compareTo(y.size)
    }

    // Les dossiers propres aux apps (Android/data…) sont illisibles et sans musique
    private fun skipped(dir: File) = dir.name.startsWith(".") || (dir.name == "Android" && dir.parentFile?.let { isRoot(it) } == true)

    fun roots(): List<Pair<String, File>> {
        val list = mutableListOf("Mémoire interne" to Environment.getExternalStorageDirectory())
        // cartes SD : /storage/XXXX-XXXX
        File("/storage").listFiles()?.filter { it.isDirectory && it.canRead() && Regex("[0-9A-F]{4}-[0-9A-F]{4}").matches(it.name) }
            ?.forEach { list += "Carte SD (${it.name})" to it }
        return list
    }

    private fun isRoot(dir: File) = roots().any { it.second.absolutePath == dir.absolutePath }

    fun scan(dir: String): JSONArray {
        val files = mutableListOf<File>()
        fun walk(current: File) {
            val entries = current.listFiles() ?: return // dossier illisible : on l'ignore
            for (entry in entries) {
                if (entry.isDirectory) { if (!skipped(entry)) walk(entry) }
                else if (entry.isFile && AUDIO.containsMatchIn(entry.name)) files += entry
            }
        }
        walk(File(dir))
        files.sortWith(compareBy(natural) { it.absolutePath })
        return JSONArray().apply { files.forEach { put(track(it)) } }
    }

    fun track(file: File) = JSONObject()
        .put("path", file.absolutePath)
        .put("url", WebContent.musicUrl(file.absolutePath))
        .put("name", file.nameWithoutExtension)

    // Contenu d'un dossier, pour choisir un dossier ou une piste dans le lecteur (le choix de fichiers d'Android
    // ne donne pas de chemin) ; sans chemin : les emplacements de stockage
    fun listDir(path: String?): JSONObject {
        if (path == null) {
            return JSONObject().put("path", JSONObject.NULL).put("parent", JSONObject.NULL)
                .put("dirs", JSONArray(roots().map { JSONObject().put("name", it.first).put("path", it.second.absolutePath) }))
                .put("files", JSONArray())
        }
        val dir = File(path)
        val entries = dir.listFiles()?.toList() ?: emptyList()
        val dirs = entries.filter { it.isDirectory && !skipped(it) }.sortedWith(compareBy(natural) { it.name })
        val files = entries.filter { it.isFile && AUDIO.containsMatchIn(it.name) }.sortedWith(compareBy(natural) { it.name })
        val label = roots().firstOrNull { it.second.absolutePath == dir.absolutePath }?.first
        return JSONObject()
            .put("path", dir.absolutePath)
            .put("name", label ?: dir.name)
            .put("parent", if (isRoot(dir)) "" else dir.parent ?: "")
            .put("dirs", JSONArray(dirs.map { JSONObject().put("name", it.name).put("path", it.absolutePath) }))
            .put("files", JSONArray(files.map { JSONObject().put("name", it.name).put("path", it.absolutePath) }))
    }

    private inline fun <T> retriever(path: String, block: (MediaMetadataRetriever) -> T): T? = try {
        MediaMetadataRetriever().let { r ->
            try { r.setDataSource(path); block(r) } finally { r.release() }
        }
    } catch (_: Exception) {
        null
    }

    fun coverBytes(path: String): ByteArray? = retriever(path) { it.embeddedPicture } ?: oggPicture(path)

    private fun ByteBuffer.skipField() { val n = int; position(position() + n) }
    private fun ByteBuffer.field(): ByteArray { val n = int; require(n in 0..remaining()); return ByteArray(n).also { get(it) } }

    // Commentaires d'un fichier Opus ou Ogg (TITLE=…, PURL=…), le premier pour lequel `pick` rend autre chose que null.
    // Android ne lit pas les grands (la miniature d'une vidéo, posée par yt-dlp), répartis sur plusieurs pages Ogg.
    private fun <T> oggComment(path: String, pick: (String) -> T?): T? {
        if (!Regex("\\.(opus|ogg)$", RegexOption.IGNORE_CASE).containsMatchIn(path)) return null
        return try {
            java.io.RandomAccessFile(path, "r").use { f ->
                // les deux premiers paquets du flux : l'en-tête, puis les commentaires (OpusTags / vorbis)
                val packets = mutableListOf<java.io.ByteArrayOutputStream>(java.io.ByteArrayOutputStream())
                val header = ByteArray(27)
                while (packets.size <= 2 && f.filePointer < f.length()) {
                    f.readFully(header)
                    if (String(header, 0, 4) != "OggS") return null
                    val segments = ByteArray(header[26].toInt() and 0xff).also { f.readFully(it) }
                    for (lace in segments) {
                        val n = lace.toInt() and 0xff
                        val data = ByteArray(n).also { f.readFully(it) }
                        packets.last().write(data)
                        if (n < 255) packets += java.io.ByteArrayOutputStream() // fin du paquet
                    }
                }
                val tags = ByteBuffer.wrap(packets.getOrNull(1)?.toByteArray() ?: return null).order(ByteOrder.LITTLE_ENDIAN)
                tags.position(if (tags.get(0) == 3.toByte()) 7 else 8) // « \u0003vorbis » ou « OpusTags »
                tags.skipField() // fournisseur
                repeat(tags.int) {
                    pick(String(tags.field(), Charsets.UTF_8))?.let { return it }
                }
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    // Pochette d'un fichier Opus ou Ogg (tag METADATA_BLOCK_PICTURE)
    private fun oggPicture(path: String): ByteArray? = oggComment(path) { comment ->
        if (!comment.startsWith("METADATA_BLOCK_PICTURE=", ignoreCase = true)) return@oggComment null
        val block = ByteBuffer.wrap(Base64.decode(comment.substringAfter('='), Base64.DEFAULT))
        block.int // type
        block.skipField() // type MIME
        block.skipField() // description
        block.position(block.position() + 16) // largeur, hauteur, profondeur, palette
        block.field()
    }

    // Identifiant d'un morceau pour la synchronisation, le même que trackId dans src/sync.js : la vidéo YouTube
    // d'origine si le fichier la mentionne (yt-dlp l'écrit dans les commentaires des .opus), sinon le nom du fichier
    private val youtubeId = Regex("(?:[?&]v=|youtu\\.be/|/shorts/)([\\w-]{11})")
    private class CachedId(val size: Long, val modified: Long, val id: String)
    private val ids = java.util.concurrent.ConcurrentHashMap<String, CachedId>()

    fun trackId(file: File): String {
        val cached = ids[file.path]
        if (cached != null && cached.size == file.length() && cached.modified == file.lastModified()) return cached.id
        val id = oggComment(file.path) { comment ->
            val key = comment.substringBefore('=').lowercase(Locale.ROOT)
            if (key == "purl" || key == "comment") youtubeId.find(comment.substringAfter('='))?.let { "yt:${it.groupValues[1]}" } else null
        } ?: nameId(file.name)
        ids[file.path] = CachedId(file.length(), file.lastModified(), id)
        return id
    }

    fun nameId(name: String) = "name:" + java.text.Normalizer.normalize(name, java.text.Normalizer.Form.NFC).lowercase(Locale.ROOT)

    fun imageType(data: ByteArray) = if (data.size > 4 && data[0] == 0x89.toByte() && data[1] == 'P'.code.toByte()) "image/png" else "image/jpeg"

    fun metadata(path: String): JSONObject = retriever(path) { r ->
        val pic = r.embeddedPicture ?: oggPicture(path)
        JSONObject()
            .put("title", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("artist", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("album", r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)?.takeIf { it.isNotBlank() } ?: JSONObject.NULL)
            .put("cover", pic?.let { "data:${imageType(it)};base64," + Base64.encodeToString(it, Base64.NO_WRAP) } ?: JSONObject.NULL)
    } ?: JSONObject()

    // Durée en secondes, ou null
    fun duration(path: String): Double? = retriever(path) {
        it.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()?.div(1000)
    }
}
