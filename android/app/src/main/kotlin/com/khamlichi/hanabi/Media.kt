package com.khamlichi.hanabi

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaScannerConnection
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import kotlin.math.min
import kotlin.math.roundToInt

// Réécriture des fichiers sans réencoder l'audio (titre, artiste, pochette, découpe) et silences en début et en
// fin de piste : la même chose que writeTags, audibleRange et trimSilence dans main.js, avec le ffmpeg de
// youtubedl-android.
object Media {
    private const val TAG = "Hanabi"

    private fun ffmpeg(): File {
        Youtube.ensureInit()
        return File(HanabiApp.app.applicationInfo.nativeLibraryDir, "libffmpeg.so")
    }

    private fun packages() = File(HanabiApp.app.noBackupFilesDir, "youtubedl-android/packages")

    // → ce que ffmpeg écrit sur sa sortie d'erreur (ses informations), ou IOException avec sa dernière ligne
    fun runFfmpeg(args: List<String>): String {
        val builder = ProcessBuilder(listOf(ffmpeg().absolutePath) + args).redirectErrorStream(true)
        builder.environment()["LD_LIBRARY_PATH"] = listOf("python", "ffmpeg").joinToString(":") { File(packages(), "$it/usr/lib").absolutePath }
        builder.environment()["TMPDIR"] = HanabiApp.app.cacheDir.absolutePath
        val proc = builder.start()
        val log = proc.inputStream.bufferedReader().readText()
        if (proc.waitFor() != 0) throw IOException(log.trim().lines().lastOrNull() ?: "ffmpeg a échoué")
        return log
    }

    // Bloc PICTURE au format FLAC : c'est sous cette forme qu'un fichier Opus stocke sa pochette.
    private fun pictureBlock(data: ByteArray, format: String): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        val mime = format.toByteArray()
        val desc = "Cover (front)".toByteArray()
        // type 3 = couverture ; profondeur 24 bits ; 0 = pas de palette
        return ByteBuffer.allocate(32 + mime.size + desc.size + data.size)
            .putInt(3).putInt(mime.size).put(mime).putInt(desc.size).put(desc)
            .putInt(bounds.outWidth).putInt(bounds.outHeight).putInt(24).putInt(0).putInt(data.size).put(data)
            .array()
    }

    class Trim(val start: Double, val end: Double?)

    private fun fixed(seconds: Double) = String.format(java.util.Locale.ROOT, "%.3f", seconds)

    // Réécrit le fichier sans réencoder l'audio. Ce qui est null reste tel quel, comme tous les autres tags.
    // → null, ou le message d'erreur
    fun writeTags(file: String, title: String? = null, artist: String? = null, cover: ByteArray? = null, trim: Trim? = null): String? {
        val base = File(HanabiApp.app.cacheDir, "hanabi-tags-${System.nanoTime()}").absolutePath
        val tmp = "$file.tags.tmp"
        val ogg = Regex("\\.(opus|ogg)$", RegexOption.IGNORE_CASE).containsMatchIn(file)
        val mp3 = file.endsWith(".mp3", ignoreCase = true)
        // Dans un fichier Ogg, les tags sont portés par le flux audio ; ailleurs, par le fichier.
        val tagOption = if (ogg) "-metadata:s:a:0" else "-metadata"
        val tags = mutableListOf<String>()
        if (title != null) tags += listOf(tagOption, "title=$title")
        if (artist != null) tags += listOf(tagOption, "artist=$artist")
        // Découpe au paquet près, sans réencodage. En Ogg, elle n'est précise qu'en sortie ; ailleurs, elle se fait
        // en entrée pour ne pas perdre la pochette jointe. Pas de -ss quand le début est gardé : il retirerait le
        // premier paquet Opus (horodatage négatif). Sans fin, on garde jusqu'au bout.
        val cut = mutableListOf<String>()
        if (trim != null) {
            if (trim.start > 0) cut += listOf("-ss", fixed(trim.start))
            if (trim.end != null) cut += listOf("-to", fixed(trim.end))
        }
        val input = listOf("-y", "-v", "error") + (if (ogg) emptyList() else cut) + listOf("-i", file)
        try {
            if (ogg) {
                // Ogg n'accepte pas d'image jointe : la pochette est un tag texte, ajouté aux tags existants.
                runFfmpeg(input + listOf("-map_metadata", "0:s:a:0", "-f", "ffmetadata", "$base.txt"))
                val picture = cover?.let { it to "image/jpeg" } ?: Library.coverBytes(file)?.let { it to Library.imageType(it) }
                if (picture != null) {
                    val block = Base64.encodeToString(pictureBlock(picture.first, picture.second), Base64.NO_WRAP).replace("=", "\\=")
                    File("$base.txt").appendText("METADATA_BLOCK_PICTURE=$block\n")
                }
                runFfmpeg(input + listOf("-i", "$base.txt", "-map", "0:a", "-c", "copy",
                    "-map_metadata", "-1", "-map_metadata:s:a:0", "1:g") + tags + cut + listOf("-f", "ogg", tmp))
            } else {
                var streams = listOf("-map", "0") // pochette existante conservée telle quelle
                if (cover != null) {
                    File("$base.jpg").writeBytes(cover)
                    streams = listOf("-i", "$base.jpg", "-map", "0:a", "-map", "1:0",
                        "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)", "-disposition:v", "attached_pic")
                }
                runFfmpeg(input + streams + listOf("-c", "copy", "-map_metadata", "0") +
                    (if (mp3) listOf("-id3v2_version", "3") else emptyList()) + tags + listOf("-f", if (mp3) "mp3" else "ipod", tmp))
            }
            if (!File(tmp).renameTo(File(file))) throw IOException("remplacement du fichier impossible")
            MediaScannerConnection.scanFile(HanabiApp.app, arrayOf(file), null, null)
            return null
        } catch (e: Exception) {
            return "Modifications non enregistrées : ${e.message}"
        } finally {
            for (f in listOf("$base.jpg", "$base.txt", tmp)) File(f).delete()
        }
    }

    // ---------- Silences en début et fin de piste ----------

    private const val SILENCE_DB = -50    // en dessous de ce niveau, c'est du silence
    private const val SILENCE_MIN = 0.3   // durée minimale d'un silence pour être coupé (s)
    private const val SILENCE_KEEP = 0.2  // marge gardée avant le premier son et après le dernier (s)

    // Partie à garder, ou null s'il n'y a rien à couper.
    private fun audibleRange(file: String): Trim? {
        val log = runFfmpeg(listOf("-hide_banner", "-nostats", "-i", file,
            "-map", "0:a:0", "-af", "silencedetect=noise=${SILENCE_DB}dB:d=$SILENCE_MIN", "-f", "null", "-"))
        val d = Regex("Duration: (\\d+):(\\d+):([\\d.]+)").find(log) ?: return null
        val duration = d.groupValues[1].toDouble() * 3600 + d.groupValues[2].toDouble() * 60 + d.groupValues[3].toDouble()
        val starts = Regex("silence_start: (-?[\\d.]+)").findAll(log).map { it.groupValues[1].toDouble() }.toList()
        val ends = Regex("silence_end: ([\\d.]+)").findAll(log).map { it.groupValues[1].toDouble() }.toList()
        if (starts.isEmpty()) return null

        var start = 0.0
        var end = duration
        if (starts[0] <= 0.05 && ends.isNotEmpty()) start = maxOf(0.0, ends[0] - SILENCE_KEEP)
        // Un silence qui dure jusqu'à la fin du fichier (sa fin manque ou tombe sur la fin du fichier)
        val lastEnd = if (ends.size == starts.size) ends.last() else duration
        if (lastEnd >= duration - 0.05 && starts.last() > start) end = min(duration, starts.last() + SILENCE_KEEP)
        if (start < 0.1 && end > duration - 0.1) return null
        if (end - start < 1) return null // piste entièrement silencieuse : on n'y touche pas
        return Trim(start, end)
    }

    // Coupe les silences au début et à la fin, sans réencodage. En cas d'échec, le fichier reste intact.
    fun trimSilence(file: String) {
        try {
            audibleRange(file)?.let { writeTags(file, trim = it) }
        } catch (e: Exception) {
            Log.w(TAG, "Silences non coupés : ${e.message}")
        }
    }

    // ---------- Images ----------

    // Image (JPEG, PNG…) en JPEG, ou null si illisible
    fun toJpeg(data: ByteArray): ByteArray? {
        val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size) ?: return null
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    }

    // Image recadrée en carré centré et réduite à `size` au plus, en JPEG ; null si illisible ou déjà carrée
    fun squareJpeg(data: ByteArray, size: Int): ByteArray? {
        val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size) ?: return null
        val w = bitmap.width; val h = bitmap.height
        if (w == 0 || w == h) return null
        val side = min(w, h)
        val target = min(side, size)
        val square = Bitmap.createBitmap(bitmap, (w - side) / 2, (h - side) / 2, side, side)
        val scaled = Bitmap.createScaledBitmap(square, target, target, true)
        return ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
    }

    // Pochette réduite pour la notification et le widget
    fun thumbnail(data: ByteArray?, size: Int): Bitmap? {
        if (data == null) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= size && bounds.outHeight / (sample * 2) >= size) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val side = min(bitmap.width, bitmap.height)
        val square = Bitmap.createBitmap(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side)
        return if (side > size) Bitmap.createScaledBitmap(square, size, (size * square.height / square.width.toFloat()).roundToInt(), true) else square
    }
}
