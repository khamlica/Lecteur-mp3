package com.khamlichi.hanabi

import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.util.Log
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLException
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID
import kotlin.math.abs

// YouTube → audio, comme convertYoutube dans main.js : yt-dlp (avec Python, QuickJS et ffmpeg, embarqués par
// youtubedl-android) aux mêmes réglages, puis le même nettoyage (intro et outro hors musique, silences) et la même
// recherche du vrai titre, de l'artiste et de la pochette.
object Youtube {
    private const val TAG = "Hanabi"
    private val prefs get() = HanabiApp.app.getSharedPreferences("youtube", Context.MODE_PRIVATE)

    @Volatile private var initialized = false

    // Python et ffmpeg sont décompressés au premier usage (quelques secondes)
    @Synchronized
    fun ensureInit() {
        if (initialized) return
        YoutubeDL.getInstance().init(HanabiApp.app)
        FFmpeg.getInstance().init(HanabiApp.app)
        initialized = true
    }

    private class Job { val id = UUID.randomUUID().toString(); @Volatile var cancelled = false }
    @Volatile private var job: Job? = null

    fun cancel() {
        val j = job ?: return
        j.cancelled = true
        YoutubeDL.getInstance().destroyProcessById(j.id)
    }

    private fun errorMessage(errors: String): String {
        val line = errors.lines().reversed().firstOrNull { it.startsWith("ERROR:") } ?: return "la conversion a échoué"
        return line.replace(Regex("^ERROR:\\s*(\\[[^\\]]+\\]\\s*[\\w-]+:\\s*)?"), "")
    }

    // Dossier de destination : le dossier de musique, ou Musique/YouTube s'il n'y en a pas encore (aussi celui des
    // morceaux reçus par la synchronisation).
    fun downloadFolder(folder: String?): String {
        if (folder != null && File(folder).isDirectory) return folder
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "YouTube")
        dir.mkdirs()
        return dir.absolutePath
    }

    // yt-dlp évolue sans cesse avec YouTube : mis à jour une fois par jour au plus, avant un téléchargement
    private fun updateYtDlp(force: Boolean, progress: (JSONObject) -> Unit) {
        val last = prefs.getLong("updated", 0)
        if (!force && System.currentTimeMillis() - last < 24 * 3600 * 1000L) return
        progress(JSONObject().put("status", "Mise à jour de yt-dlp…"))
        try {
            YoutubeDL.getInstance().updateYoutubeDL(HanabiApp.app, YoutubeDL.UpdateChannel.STABLE)
            prefs.edit().putLong("updated", System.currentTimeMillis()).apply()
        } catch (e: Exception) {
            Log.w(TAG, "Mise à jour de yt-dlp impossible : ${e.message}")
        }
    }

    // → { folder, tracks, file } | { error } | { cancelled: true }
    fun convert(url: String, folderSetting: String?, progress: (JSONObject) -> Unit): JSONObject {
        if (job != null) return JSONObject().put("error", "Une conversion est déjà en cours")
        val current = Job()
        job = current
        val temp = File(HanabiApp.app.cacheDir, "hanabi-player-youtube")
        try {
            if (!File(HanabiApp.app.noBackupFilesDir, "youtubedl-android/packages/python").exists()) {
                progress(JSONObject().put("status", "Installation de yt-dlp…")) // décompressé au premier usage
            }
            ensureInit()
            updateYtDlp(false, progress)
            if (current.cancelled) return JSONObject().put("cancelled", true)
            val folder = downloadFolder(folderSetting)
            val files = mutableListOf<JSONObject>()
            fun request() = YoutubeDLRequest(url).apply {
                addOption("--no-playlist")
                // Meilleure piste audio disponible, gardée telle quelle (Opus le plus souvent, sinon AAC) : aucun
                // réencodage, donc aucune perte, et environ deux fois plus léger qu'un MP3 équivalent.
                addOption("-f", "bestaudio/best")
                addOption("-x")
                addOption("--embed-metadata"); addOption("--embed-thumbnail"); addOption("--convert-thumbnails", "jpg")
                // les mêmes noms de fichiers que sur l'ordinateur (et lisibles sur une carte SD)
                addOption("--windows-filenames")
                addOption("-P", folder); addOption("-P", "temp:${temp.absolutePath}")
                addOption("-o", "%(title)s.%(ext)s")
                // (les avertissements restent : ils vont au journal d'Android, voir run)
                addOption("--quiet"); addOption("--progress"); addOption("--newline")
                addOption("--progress-template", "download:P %(progress._percent_str)s")
                addOption("--print", "before_dl:T %(title)s")
                // Infos du fichier obtenu, pour le nettoyer et retrouver le morceau (track et artist ne sont connus
                // que si YouTube a identifié la musique)
                addOption("--print", "after_move:F %(.{id,filepath,title,track,artist,channel,thumbnail})j")
            }
            val onLine = { line: String ->
                val value = line.drop(2).trim()
                when {
                    line.startsWith("T ") -> progress(JSONObject().put("title", value).put("status", "Téléchargement…"))
                    line.startsWith("P ") -> value.removeSuffix("%").trim().toDoubleOrNull()?.let { pct ->
                        progress(JSONObject().put("status", if (pct >= 100) "Finalisation…" else "Téléchargement… ${pct.toInt()} %"))
                    }
                    line.startsWith("F ") -> try {
                        files += JSONObject(value)
                    } catch (_: Exception) {
                        // ligne illisible : le fichier est quand même dans le dossier, seulement pas nettoyé
                    }
                }
                Unit
            }
            fun run(): String? = try {
                val res = YoutubeDL.getInstance().execute(request(), current.id) { _, _, line -> onLine(line) }
                if (res.err.isNotBlank()) Log.w(TAG, "yt-dlp : ${res.err.take(4000)}")
                null
            } catch (e: YoutubeDL.CanceledException) {
                "cancelled"
            } catch (e: YoutubeDLException) {
                e.message ?: ""
            }

            var errors = run()
            if (errors != null && !current.cancelled) {
                // Souvent dû à un changement côté YouTube : on met yt-dlp à jour et on réessaie une fois.
                updateYtDlp(true, progress)
                if (!current.cancelled) { files.clear(); errors = run() }
            }
            if (current.cancelled) return JSONObject().put("cancelled", true)
            if (errors != null || files.isEmpty()) return JSONObject().put("error", "Échec : ${errorMessage(errors ?: "")}")

            progress(JSONObject().put("status", "Nettoyage du début et de la fin…"))
            for (file in files) {
                trimNonMusic(file.getString("filepath"), file.optString("id"))
                Media.trimSilence(file.getString("filepath"))
            }
            progress(JSONObject().put("status", "Recherche du titre et de la pochette…"))
            for (file in files) tagDownload(file)
            MediaScannerConnection.scanFile(HanabiApp.app, files.map { it.getString("filepath") }.toTypedArray(), null, null)

            val tracks = Library.scan(folder)
            val wanted = File(files[0].getString("filepath")).absolutePath
            var found: String? = null
            for (i in 0 until tracks.length()) {
                val p = tracks.getJSONObject(i).getString("path")
                if (p.equals(wanted, ignoreCase = true)) found = p
            }
            return JSONObject().put("folder", folder).put("tracks", tracks).put("file", found ?: JSONObject.NULL)
        } catch (e: Exception) {
            Log.w(TAG, "Conversion impossible", e)
            return JSONObject().put("error", "Échec : ${e.message}")
        } finally {
            job = null
            temp.deleteRecursively()
        }
    }

    // ---------- Passages hors musique (intro et outro des clips) ----------

    // SponsorBlock repère notamment les passages hors musique des clips (« music_offtopic »). Comme yt-dlp, on
    // n'envoie que le début de l'empreinte de l'identifiant : le serveur renvoie toutes les vidéos qui la partagent.
    private const val SPONSORBLOCK_API = "https://sponsor.ajay.app/api/skipSegments/"
    private const val EDGE_TOLERANCE = 1.0 // un passage à moins d'1 s du début ou de la fin est une intro / une outro
    private const val MIN_MUSIC = 10.0     // en dessous, les données sont sûrement fausses : on ne coupe pas

    private class Segment(val start: Double, val end: Double, val duration: Double)

    private fun nonMusicSegments(videoId: String): List<Segment> {
        val prefix = MessageDigest.getInstance("SHA-256").digest(videoId.toByteArray()).joinToString("") { "%02x".format(it) }.take(4)
        val categories = URLEncoder.encode("[\"music_offtopic\"]", "UTF-8")
        val res = Http.get("$SPONSORBLOCK_API$prefix?categories=$categories")
        if (!res.ok) return emptyList() // 404 : aucun passage connu
        val videos = JSONArray(res.text)
        for (i in 0 until videos.length()) {
            val v = videos.getJSONObject(i)
            if (v.optString("videoID") != videoId) continue
            val segs = v.getJSONArray("segments")
            return (0 until segs.length()).map {
                val s = segs.getJSONObject(it)
                val seg = s.getJSONArray("segment")
                Segment(seg.getDouble(0), seg.getDouble(1), s.optDouble("videoDuration", 0.0).takeIf { d -> !d.isNaN() } ?: 0.0)
            }
        }
        return emptyList()
    }

    // Partie à garder sans l'intro ni l'outro hors musique, ou null s'il n'y en a pas.
    private fun musicRange(videoId: String): Media.Trim? {
        val segments = nonMusicSegments(videoId).sortedBy { it.start }
        if (segments.isEmpty()) return null
        var start = 0.0
        for (s in segments) if (s.start <= start + EDGE_TOLERANCE) start = maxOf(start, s.end)
        // Sans durée connue, on ne peut pas savoir si un passage touche la fin
        val duration = segments.maxOf { it.duration }
        var end: Double? = duration.takeIf { it > 0 }
        if (end != null) for (s in segments.reversed()) if (s.end >= end!! - EDGE_TOLERANCE) end = minOf(end!!, s.start)
        val cutsEnd = end != null && end < duration - EDGE_TOLERANCE
        if (start < 0.1 && !cutsEnd) return null
        if (end != null && end - start < MIN_MUSIC) return null
        return Media.Trim(start, if (cutsEnd) end else null)
    }

    private fun trimNonMusic(file: String, videoId: String) {
        if (videoId.isEmpty()) return
        try {
            musicRange(videoId)?.let { Media.writeTags(file, trim = it) }
        } catch (e: Exception) {
            Log.w(TAG, "Passages hors musique non coupés : ${e.message}")
        }
    }

    // ---------- Titre, artiste et pochette du morceau ----------

    // Le catalogue iTunes est interrogeable sans compte ni clé et fournit des pochettes carrées. Tout ce qui suit est
    // facultatif : sans Internet, ou si rien de sûr n'est trouvé, le fichier garde les infos de la vidéo, nettoyées.
    private const val ITUNES_API = "https://itunes.apple.com/search"
    private const val COVER_SIZE = 600 // comme les pochettes choisies à la main (cover.js)
    // Écart de durée accepté entre le fichier et le morceau trouvé (s) : un clip est souvent plus long que le morceau
    private const val SHORTER_TOLERANCE = 6.0
    private const val LONGER_TOLERANCE = 45.0
    private const val CLOSE_DURATION = 8.0 // en dessous, c'est sûrement la même version

    private val CI = setOf(RegexOption.IGNORE_CASE)
    // Mentions qui ne font pas partie du nom du morceau
    private val NOISE = Regex("\\b(official|officiel(le)?|music\\s+video|lyric\\s+video|video|vidéo|clip|mv|m/v|audio|lyrics?|paroles|visuali[sz]er|hd|hq|4k|full\\s+ver(sion)?)\\b", CI)
    private val TRAILING_NOISE = Regex("[\\s\\-–—|:]*\\b(official|officiel(le)?)?\\s*(music\\s+video|lyric\\s+video|video|vidéo|clip|mv|m/v|audio|lyrics|visuali[sz]er|hd|4k)\\s*$", CI)
    // Versions différentes du morceau original : on ne les retient que si la vidéo les mentionne aussi.
    private val VARIANTS = Regex("\\b(live|remix|mix|acoustic|instrumental|inst|karaoke|cover|piano|music box|sped up|slowed|nightcore|8d|lofi|demo|orchestra)\\b", CI)

    // Minuscules, sans accents ni ponctuation, entouré d'espaces pour chercher des mots entiers.
    private fun words(s: String?) = " " + Normalizer.normalize(s ?: "", Normalizer.Form.NFKD).replace(Regex("\\p{M}"), "").lowercase()
        .replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim() + " "
    private fun mentions(text: String, name: String) = words(name).isNotBlank() && text.contains(words(name))

    private fun stripBrackets(s: String) = s.replace(Regex("\\s*(\\([^)]*\\)|\\[[^\\]]*\\]|【[^】]*】)"), "").trim()

    // Nom de chaîne qui désigne clairement l'artiste (« ArtisteVEVO », « Artiste - Topic »), ou null.
    private fun channelArtist(channel: String?): String? {
        val name = (channel ?: "").replace(Regex("\\s*-\\s*topic$|vevo$|\\s+official$", CI), "").trim()
        return if (name.isNotEmpty() && name != channel) name else null
    }

    class Guess(val artist: String?, val title: String, val sure: Boolean)

    // Devine l'artiste et le titre à partir du titre d'une vidéo. `sure` : ils étaient clairement séparés.
    fun guessFromTitle(raw: String, channel: String?): Guess {
        var t = raw
            .replace(Regex("\\s*(\\[[^\\]]*\\]|【[^】]*】)\\s*"), " ")
            // Parenthèses de mentions (« (Official Video) ») ou de traduction (« IU(아이유) ») ; celles qui comptent,
            // comme « (feat. …) » ou « (Remix) », restent.
            .replace(Regex("\\s*\\(([^)]*)\\)")) { m -> if (NOISE.containsMatchIn(m.groupValues[1]) || !Regex("\\p{IsLatin}").containsMatchIn(m.groupValues[1])) "" else m.value }
            .replace(Regex("\\s+"), " ").trim()
        while (TRAILING_NOISE.containsMatchIn(t)) t = t.replace(TRAILING_NOISE, "").trim()

        Regex("^(.+?)\\s*['‘’\"“”「『](.+?)['‘’\"“”」』]\\s*(.*)$").find(t)?.let { q ->
            return Guess(q.groupValues[1].trim(), "${q.groupValues[2]} ${q.groupValues[3]}".trim(), true)
        }
        val parts = t.split(Regex("\\s[-–—_|]\\s"))
        if (parts.size >= 2) return Guess(parts[0].trim(), parts.drop(1).joinToString(" - ").trim(), true)
        return Guess(channelArtist(channel), t.ifEmpty { raw }, false)
    }

    private fun searchItunes(term: String): JSONArray {
        val q = "term=${URLEncoder.encode(term, "UTF-8")}&media=music&entity=song&limit=15"
        val res = Http.get("$ITUNES_API?$q")
        if (!res.ok) return JSONArray()
        return JSONObject(res.text).optJSONArray("results") ?: JSONArray()
    }

    // Résultat qui correspond vraiment au morceau : son artiste et son titre apparaissent dans `text`, ce n'est pas
    // une autre version, et la durée concorde.
    private fun bestMatch(results: JSONArray, text: String, duration: Double?): JSONObject? {
        val matches = (0 until results.length()).map { results.getJSONObject(it) }.filter { r ->
            val trackName = r.optString("trackName"); val artistName = r.optString("artistName")
            if (r.optString("kind") != "song" || trackName.isEmpty() || artistName.isEmpty()) return@filter false
            val title = stripBrackets(trackName.replace(Regex("\\s+-\\s+.*$"), ""))
            if (!mentions(text, title)) return@filter false
            if (artistName.split(Regex("\\s*(?:,|&|\\band\\b|\\bx\\b|\\bfeat\\.?|\\bft\\.?|\\bwith\\b)\\s*", CI)).none { mentions(text, it) }) return@filter false
            if (VARIANTS.findAll(trackName).any { !mentions(text, it.value) }) return@filter false
            val ms = r.optDouble("trackTimeMillis", 0.0)
            if (duration == null || ms.isNaN() || ms <= 0) return@filter true
            val diff = duration - ms / 1000
            diff >= -SHORTER_TOLERANCE && diff <= LONGER_TOLERANCE
        }
        // Dans l'ordre de pertinence d'iTunes, en préférant une durée presque identique
        val close = { r: JSONObject -> val ms = r.optDouble("trackTimeMillis", 0.0); duration != null && ms > 0 && abs(duration - ms / 1000) <= CLOSE_DURATION }
        return matches.firstOrNull(close) ?: matches.firstOrNull()
    }

    private fun fetchCover(url: String): ByteArray? = try {
        val res = Http.get(url)
        if (res.ok) Media.toJpeg(res.body) else null
    } catch (_: Exception) {
        null
    }

    class Found(val title: String, val artist: String, val cover: ByteArray?)

    // Cherche le morceau en ligne, ou null si rien de sûr n'a été trouvé, si le service ne répond pas ou s'il n'y a
    // pas de connexion. Ne lève jamais d'erreur.
    fun lookupTrack(text: String, artist: String?, title: String?, duration: Double?): Found? {
        if (!Http.online() || title.isNullOrBlank()) return null
        val terms = listOfNotNull(artist?.let { "${stripBrackets(it)} ${stripBrackets(title)}" }, stripBrackets(title))
            .filter { it.isNotBlank() }.distinct()
        for (term in terms) {
            try {
                val found = bestMatch(searchItunes(term), words(text), duration) ?: continue
                val art = found.optString("artworkUrl100")
                val cover = if (art.isNotEmpty()) fetchCover(art.replace(Regex("/\\d+x\\d+bb\\."), "/${COVER_SIZE}x${COVER_SIZE}bb.")) else null
                return Found(found.getString("trackName"), found.getString("artistName"), cover)
            } catch (e: Exception) {
                Log.w(TAG, "Recherche du morceau impossible : ${e.message}")
                return null // hors délai ou réponse illisible : inutile d'insister
            }
        }
        return null
    }

    // Miniature de la vidéo recadrée en carré centré, comme une pochette, ou null si inutile.
    private fun squareThumbnail(file: String): ByteArray? = Library.coverBytes(file)?.let { Media.squareJpeg(it, COVER_SIZE) }

    // Après un téléchargement : vrai titre, artiste et pochette si le morceau est trouvé, sinon titre de la vidéo
    // débarrassé de ses mentions et miniature recadrée. En cas d'échec, le fichier reste tel quel.
    private fun tagDownload(file: JSONObject) {
        try {
            val path = file.getString("filepath")
            val videoTitle = file.optString("title").takeIf { file.has("title") && !file.isNull("title") } ?: ""
            val track = file.optString("track").takeIf { file.has("track") && !file.isNull("track") && it.isNotEmpty() }
            val fileArtist = file.optString("artist").takeIf { file.has("artist") && !file.isNull("artist") && it.isNotEmpty() }
            val channel = file.optString("channel").takeIf { file.has("channel") && !file.isNull("channel") }
            val guess = if (track != null) Guess(fileArtist, track, true) else guessFromTitle(videoTitle, channel)
            val found = lookupTrack(
                listOf(videoTitle, channel, track, fileArtist).joinToString(" ") { it ?: "" },
                guess.artist, guess.title, Library.duration(path))
            var title: String? = null; var artist: String? = null; var cover: ByteArray? = null
            if (found != null) {
                title = found.title; artist = found.artist; cover = found.cover
            } else if (track == null) {
                // YouTube n'a rien fourni : yt-dlp a mis le titre de la vidéo et le nom de la chaîne.
                if (guess.title != videoTitle) title = guess.title
                if (guess.artist != null && (guess.sure || fileArtist == null)) artist = guess.artist
            }
            if (cover == null) cover = squareThumbnail(path)
            // miniature non intégrée par yt-dlp : on la télécharge
            if (cover == null && Library.coverBytes(path) == null && file.optString("thumbnail").startsWith("http")) {
                cover = try {
                    Http.get(file.getString("thumbnail"), 10000).takeIf { it.ok }?.body?.let { Media.squareJpeg(it, COVER_SIZE) ?: Media.toJpeg(it) }
                } catch (_: Exception) {
                    null
                }
            }
            if (title != null || artist != null || cover != null) Media.writeTags(path, title, artist, cover)
        } catch (e: Exception) {
            Log.w(TAG, "Infos du morceau non complétées : ${e.message}")
        }
    }

    // Recherche lancée depuis la fenêtre d'édition, à partir de ce qui y est saisi → { title, artist, cover } | { error }
    fun lookupForEditor(file: String, title: String, artist: String): JSONObject {
        val name = File(file).nameWithoutExtension
        val guess = if (title.isNotEmpty() && artist.isNotEmpty()) Guess(artist, title, true) else guessFromTitle(title.ifEmpty { name }, null)
        val guessArtist = guess.artist ?: artist.ifEmpty { null }
        if (!Http.online()) return JSONObject().put("error", "Pas de connexion Internet")
        val found = lookupTrack(listOf(title, artist, name).joinToString(" "), guessArtist, guess.title, Library.duration(file))
            ?: return JSONObject().put("error", "Morceau introuvable")
        return JSONObject().put("title", found.title).put("artist", found.artist)
            .put("cover", found.cover?.let { android.util.Base64.encodeToString(it, android.util.Base64.NO_WRAP) } ?: JSONObject.NULL)
    }
}
