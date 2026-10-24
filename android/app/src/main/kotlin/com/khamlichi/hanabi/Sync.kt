package com.khamlichi.hanabi

import android.content.pm.ApplicationInfo
import android.os.Build
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.Inflater
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

// Synchronisation avec l'ordinateur (le protocole est décrit dans src/sync.js) : le téléphone trouve l'ordinateur sur
// le réseau, va chercher les morceaux qui lui manquent et y dépose les siens. Rien n'est jamais supprimé ni remplacé,
// et un morceau que le téléphone a déjà eu (supprimé depuis) ne lui est plus renvoyé.
object Sync {
    private const val TAG = "Hanabi"
    private const val DISCOVERY_PORT = 47810
    private val file get() = File(HanabiApp.app.filesDir, "sync.json")
    private val random = SecureRandom()

    // { phoneId, pcs: [{ id, name, token, address, port, lastSync, summary, error }], known: { dossier: [id…] } }
    private val store: JSONObject by lazy {
        (try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }).apply {
            if (!has("phoneId")) put("phoneId", UUID.randomUUID().toString())
            if (!has("pcs")) put("pcs", JSONArray())
            if (!has("known")) put("known", JSONObject())
        }
    }

    // Association en cours, comme l'affiche la fenêtre « Synchronisation » (src/renderer/sync.js)
    private class Pairing {
        var step = "searching"   // searching | found | connecting | code | done | failed
        var found = JSONArray()
        var peer: String? = null
        var code: String? = null
        var accepted = false
        var message: String? = null
        // pour la suite de l'échange
        var address = ""
        var port = 0
        var pin: String? = null
        var session: String? = null
    }

    private var pairing: Pairing? = null
    private var activity: JSONObject? = null // { peer, step, received, sent }

    // Sans réseau commun : la liste scannée sur l'ordinateur (QR code, voir qrCodes dans src/sync.js), et les vidéos
    // qui manquent ici, retéléchargées depuis YouTube
    private class QrTrack(val id: String, val title: String, val artist: String)
    private class Offline {
        var step = "confirm"     // confirm | downloading | done | failed
        var tracks = listOf<QrTrack>()
        @Volatile var message: String? = null
        @Volatile var cancelled = false
        val fetches: MutableSet<Youtube.Fetch> = ConcurrentHashMap.newKeySet()
    }
    private var offline: Offline? = null
    // ouvre le scanner de QR code (PlayerService) → le texte lu, ou null (annulé : sans erreur)
    var scanner: (((String?, String?) -> Unit) -> Unit)? = null
    // le morceau en cours d'écoute (PlayerService) : pas remplacé pendant qu'on l'écoute
    var playingPath: () -> String? = { null }
    private val running = AtomicBoolean(false)

    // La page et Android sont prévenus de chaque changement (PlayerService) : état → page, dossier → liste du lecteur
    var onState: ((JSONObject) -> Unit)? = null
    var onLibraryChanged: ((String) -> Unit)? = null
    // le dossier de musique retenu par la page (réglage « folder »)
    var folderSetting: () -> String? = { null }

    val paired get() = synchronized(this) { store.getJSONArray("pcs").length() > 0 }

    private fun save() {
        try {
            val tmp = File(file.path + ".tmp")
            tmp.writeText(store.toString())
            tmp.renameTo(file)
        } catch (e: Exception) {
            Log.e(TAG, "Synchronisation : enregistrement impossible", e)
        }
    }

    private fun pcs(): List<JSONObject> = store.getJSONArray("pcs").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    @Synchronized
    fun state(): JSONObject {
        val devices = JSONArray()
        for (pc in pcs()) {
            devices.put(JSONObject().put("id", pc.getString("id")).put("name", pc.getString("name"))
                .put("lastSync", pc.opt("lastSync") ?: JSONObject.NULL)
                .put("summary", pc.opt("summary") ?: JSONObject.NULL)
                .put("error", pc.opt("error") ?: JSONObject.NULL))
        }
        val p = pairing
        return JSONObject()
            .put("role", "phone")
            .put("devices", devices)
            .put("pairing", if (p == null) JSONObject.NULL else JSONObject()
                .put("step", p.step).put("found", p.found).put("peer", p.peer ?: JSONObject.NULL)
                .put("code", p.code ?: JSONObject.NULL).put("accepted", p.accepted).put("message", p.message ?: JSONObject.NULL))
            .put("activity", activity ?: JSONObject.NULL)
            .put("offline", offline?.let { o ->
                JSONObject().put("step", o.step).put("count", o.tracks.size).put("message", o.message ?: JSONObject.NULL)
            } ?: JSONObject.NULL)
    }

    private fun changed() = onState?.invoke(state())

    // Depuis la page : → l'état, tout de suite ; la suite arrive par onState
    fun action(name: String, arg: String?): JSONObject {
        when (name) {
            "pair-search" -> search()
            "pair-choose" -> arg?.let { choose(it) }
            "pair-confirm" -> confirm()
            "pair-cancel" -> cancel()
            "forget" -> arg?.let { forget(it) }
            "sync-now" -> HanabiApp.work.execute { syncAll() }
            "qr-scan" -> scanQr()
            "qr-download" -> downloadQr()
            "qr-cancel" -> cancelQr()
            "qr-text" -> if (debug) scanned(arg, null) // essais sur l'émulateur, sans appareil photo
        }
        return state()
    }

    // ---------- Réseau ----------

    private fun sha256(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data)
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun nonce() = hex(ByteArray(32).also { random.nextBytes(it) })

    private val debug get() = HanabiApp.app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    private fun deviceName(): String =
        Settings.Global.getString(HanabiApp.app.contentResolver, "device_name")?.takeIf { it.isNotBlank() } ?: Build.MODEL

    // Les ordinateurs qui répondent sur le réseau : diffusion sur chaque réseau du téléphone (Wi‑Fi, partage de
    // connexion…) ; l'émulateur, lui, ne joint que l'ordinateur qui le fait tourner (10.0.2.2). Si personne ne répond
    // à la diffusion (Android ne l'envoie pas toujours sur le réseau du partage de connexion), chaque adresse des
    // petits réseaux du téléphone est interrogée une à une.
    private fun discover(): List<JSONObject> {
        val targets = mutableSetOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        val sweep = mutableSetOf<InetAddress>()
        try {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (a in iface.interfaceAddresses) {
                    val own = a.address as? Inet4Address ?: continue
                    a.broadcast?.let { targets += it }
                    val prefix = a.networkPrefixLength.toInt()
                    if (prefix !in 24..30) continue
                    val ip = ByteBuffer.wrap(own.address).int
                    val net = ip and (-1 shl (32 - prefix))
                    for (host in 1 until (1 shl (32 - prefix)) - 1) {
                        if (net or host != ip) sweep += InetAddress.getByAddress(ByteBuffer.allocate(4).putInt(net or host).array())
                    }
                }
            }
        } catch (_: Exception) {}
        if (debug) targets += InetAddress.getByName("10.0.2.2")
        val found = linkedMapOf<String, JSONObject>()
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val message = "HANABI-DISCOVER 1".toByteArray()
            val buffer = ByteArray(2048)
            repeat(3) { round ->
                for (target in if (round > 0 && found.isEmpty()) targets + sweep else targets) {
                    try { socket.send(DatagramPacket(message, message.size, target, DISCOVERY_PORT)) } catch (_: IOException) {}
                }
                val until = System.currentTimeMillis() + 500
                while (System.currentTimeMillis() < until) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    try { socket.receive(packet) } catch (_: SocketTimeoutException) { continue }
                    try {
                        val reply = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                        if (reply.optString("app") != "hanabi" || reply.optInt("v") != 1) continue
                        val id = reply.getString("id")
                        if (!Regex("[0-9a-f]{64}").matches(id)) continue
                        found[id] = JSONObject().put("id", id).put("name", reply.optString("name", "Ordinateur").take(60))
                            .put("address", packet.address.hostAddress).put("port", reply.getInt("port"))
                            .put("pairing", reply.optBoolean("pairing"))
                    } catch (_: Exception) {}
                }
            }
        }
        return found.values.toList()
    }

    class HttpError(val status: Int, message: String) : IOException(message)

    // HTTPS vers l'ordinateur, dont la clé publique doit avoir l'empreinte `pin` (null : la première fois, pendant
    // l'association ; l'empreinte vue est rendue par `seen`, et c'est le code comparé à l'écran qui la confirme)
    private class Pinned(val pin: String?) : X509TrustManager {
        @Volatile var seen: String? = null
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            val fp = MessageDigest.getInstance("SHA-256").digest(chain[0].publicKey.encoded).joinToString("") { "%02x".format(it) }
            if (pin != null && fp != pin) throw CertificateException("ce n'est pas l'ordinateur associé")
            seen = fp
        }
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException()
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }

    private fun open(address: String, port: Int, path: String, pin: String?, token: String?, timeoutMs: Int): Pair<HttpsURLConnection, Pinned> {
        val trust = Pinned(pin)
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), random) }
        val conn = URL("https://$address:$port$path").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = tls.socketFactory
        conn.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true } // l'adresse change, la clé est épinglée
        conn.connectTimeout = 4000
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("User-Agent", "HanabiPlayer")
        if (token != null) {
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("X-Hanabi-Name", deviceName())
        }
        return conn to trust
    }

    private fun check(conn: HttpsURLConnection) {
        val status = conn.responseCode
        if (status in 200..299) return
        val error = try { JSONObject(conn.errorStream?.use { String(it.readBytes()) } ?: "{}").optString("error") } catch (_: Exception) { "" }
        throw HttpError(status, error.ifEmpty { "erreur $status" })
    }

    // → la réponse JSON, et l'empreinte de l'ordinateur vue
    private fun request(address: String, port: Int, method: String, path: String, body: JSONObject?, pin: String?,
                        token: String? = null, timeoutMs: Int = 10000): Pair<JSONObject, String?> {
        val (conn, trust) = open(address, port, path, pin, token, timeoutMs)
        try {
            conn.requestMethod = method
            if (body != null) {
                val data = body.toString().toByteArray()
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setFixedLengthStreamingMode(data.size)
                conn.outputStream.use { it.write(data) }
            }
            check(conn)
            val text = conn.inputStream.use { String(it.readBytes(), Charsets.UTF_8) }
            return JSONObject(text.ifEmpty { "{}" }) to trust.seen
        } finally {
            conn.disconnect()
        }
    }

    // ---------- Association ----------

    private fun search() {
        val p = Pairing()
        synchronized(this) { pairing = p }
        HanabiApp.work.execute {
            val found = try { discover() } catch (e: Exception) { Log.w(TAG, "Recherche impossible", e); emptyList() }
            synchronized(this) {
                if (pairing !== p) return@execute
                val known = pcs().map { it.getString("id") }.toSet()
                p.found = JSONArray(found.map { it.put("paired", it.getString("id") in known) })
                p.step = "found"
            }
            changed()
        }
    }

    private fun choose(id: String) {
        val p = synchronized(this) { pairing } ?: return
        val peer = (0 until p.found.length()).map { p.found.getJSONObject(it) }.firstOrNull { it.getString("id") == id } ?: return
        synchronized(this) {
            p.step = "connecting"
            p.peer = peer.getString("name")
            p.address = peer.getString("address")
            p.port = peer.getInt("port")
        }
        HanabiApp.work.execute {
            try {
                // le téléphone s'engage sur son nonce avant de connaître celui de l'ordinateur (voir src/sync.js)
                val phoneId = synchronized(this) { store.getString("phoneId") }
                val mine = nonce()
                val commit = hex(sha256(mine.toByteArray()))
                val (started, fp) = request(p.address, p.port, "POST", "/pair/start",
                    JSONObject().put("phoneId", phoneId).put("name", deviceName()).put("commit", commit), null)
                // l'ordinateur qui répond doit être celui qu'on a choisi
                if (fp != id) throw IOException("un autre appareil a répondu")
                val session = started.getString("session")
                request(p.address, p.port, "POST", "/pair/reveal", JSONObject().put("session", session).put("nonce", mine), fp)
                val h = sha256("hanabi-pair-1|$fp|$phoneId|$mine|${started.getString("nonce")}".toByteArray())
                val code = (((h[0].toLong() and 0xff) shl 24) or ((h[1].toLong() and 0xff) shl 16) or ((h[2].toLong() and 0xff) shl 8) or (h[3].toLong() and 0xff)) % 1000000
                synchronized(this) {
                    if (pairing !== p) return@execute
                    p.pin = fp
                    p.session = session
                    p.code = code.toString().padStart(6, '0')
                    p.step = "code"
                }
            } catch (e: Exception) {
                Log.w(TAG, "Association impossible", e)
                fail(p, if (e is HttpError) e.message ?: "refusé" else "Ordinateur injoignable : ${e.message}")
            }
            changed()
        }
    }

    private fun confirm() {
        val p = synchronized(this) { pairing } ?: return
        val pin = p.pin ?: return
        val session = p.session ?: return
        synchronized(this) { p.accepted = true }
        HanabiApp.work.execute {
            try {
                // attend la confirmation sur l'ordinateur (l'ordinateur abandonne au bout de 2 min)
                val (reply, _) = request(p.address, p.port, "POST", "/pair/confirm", JSONObject().put("session", session), pin, timeoutMs = 150000)
                synchronized(this) {
                    val kept = JSONArray()
                    for (pc in pcs()) if (pc.getString("id") != pin) kept.put(pc)
                    kept.put(JSONObject().put("id", pin).put("name", reply.optString("name", p.peer ?: "Ordinateur"))
                        .put("token", reply.getString("token")).put("address", p.address).put("port", p.port))
                    store.put("pcs", kept)
                    save()
                    p.step = "done"
                    p.message = "Associé à « ${reply.optString("name", p.peer ?: "l'ordinateur")} »"
                }
                changed()
                syncAll()
            } catch (e: Exception) {
                Log.w(TAG, "Association non confirmée", e)
                fail(p, if (e is HttpError) e.message ?: "refusé" else "Ordinateur injoignable : ${e.message}")
                changed()
            }
        }
    }

    private fun fail(p: Pairing, message: String) = synchronized(this) {
        if (pairing !== p) return@synchronized
        p.step = "failed"
        p.message = message.replaceFirstChar { it.uppercase() }
        p.code = null
    }

    private fun cancel() {
        val p = synchronized(this) { pairing.also { pairing = null } } ?: return
        val session = p.session ?: return
        HanabiApp.work.execute {
            try { request(p.address, p.port, "POST", "/pair/cancel", JSONObject().put("session", session), p.pin) } catch (_: Exception) {}
        }
    }

    @Synchronized
    private fun forget(id: String) {
        val kept = JSONArray()
        for (pc in pcs()) if (pc.getString("id") != id) kept.put(pc)
        store.put("pcs", kept)
        save()
    }

    // ---------- Sans Wi‑Fi : QR code de la liste ----------

    // « HANABI2|page/pages|données » (voir qrCodes dans src/sync.js) ; « HANABI1|…|ids » : versions 1.4.0
    private val qrFormat = Regex("^HANABI([12])\\|(\\d+)/(\\d+)\\|([\\w-]*)$")

    private fun scanQr() {
        scanner?.invoke(::scanned)
    }

    // Les morceaux d'un QR code : identifiant de la vidéo, titre et artiste sur l'ordinateur
    private fun qrTracks(version: String, data: String): List<QrTrack> {
        if (version == "1") return data.chunked(11).map { QrTrack(it, "", "") }
        val inflater = Inflater(true)
        inflater.setInput(android.util.Base64.decode(data, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (!inflater.finished()) {
            val n = inflater.inflate(buffer)
            if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
            out.write(buffer, 0, n)
        }
        inflater.end()
        return out.toString("UTF-8").split('\n').mapNotNull { line ->
            val f = line.split('\t')
            if (!Regex("[\\w-]{11}").matches(f[0])) null else QrTrack(f[0], f.getOrElse(1) { "" }, f.getOrElse(2) { "" })
        }
    }

    private fun scanned(text: String?, error: String?) {
        if (text == null && error == null) return // scanner fermé
        HanabiApp.work.execute {
            val o = Offline()
            val m = text?.let { qrFormat.find(it.trim()) }
            val tracks = try { m?.let { qrTracks(it.groupValues[1], it.groupValues[4]) } } catch (e: Exception) { null }
            if (m == null || tracks == null) {
                o.step = "failed"
                o.message = if (text == null) "Scan impossible : $error" else "Ce n'est pas un QR code de Hanabi Player"
            } else {
                // ce que le téléphone a déjà eu ne revient pas, même supprimé depuis
                val folder = Youtube.downloadFolder(folderSetting())
                val here = Library.scan(folder).let { a -> (0 until a.length()).map { Library.trackId(File(a.getJSONObject(it).getString("path"))) } }
                remember(folder, here)
                val known = known(folder)
                o.tracks = tracks.filter { "yt:${it.id}" !in known }.distinctBy { it.id }
                val (page, pages) = m.groupValues[2] to m.groupValues[3]
                if (pages != "1") o.message = "Code $page sur $pages : scannez aussi les autres ensuite."
            }
            synchronized(this) { offline = o }
            changed()
        }
    }

    // Plusieurs morceaux à la fois : le plus long est d'attendre YouTube et le nettoyage, pas le réseau
    private const val QR_PARALLEL = 3

    private fun downloadQr() {
        val o = synchronized(this) { offline?.takeIf { it.step == "confirm" && it.tracks.isNotEmpty() } } ?: return
        o.step = "downloading"
        HanabiApp.work.execute {
            val folder = Youtube.downloadFolder(folderSetting())
            val total = o.tracks.size
            val queue = ConcurrentLinkedQueue(o.tracks)
            val done = AtomicInteger()
            val failed = AtomicInteger()
            fun report(title: String?) {
                o.message = "Téléchargement ${done.get() + failed.get()}/$total" + (title?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "")
                changed()
            }
            try {
                Youtube.prepare { p -> o.message = p.optString("status"); changed() }
                report(null)
                val workers = (1..minOf(QR_PARALLEL, total)).map {
                    HanabiApp.work.submit {
                        while (!o.cancelled) {
                            val t = queue.poll() ?: break
                            val fetch = Youtube.Fetch()
                            o.fetches += fetch
                            report(t.title.ifBlank { null })
                            val path = try {
                                Youtube.fetch(fetch, t.id, t.title, t.artist, folder)
                            } catch (e: Exception) {
                                Log.w(TAG, "${t.id} non téléchargé", e)
                                null
                            }
                            o.fetches -= fetch
                            if (path != null) {
                                remember(folder, listOf("yt:${t.id}"))
                                done.incrementAndGet()
                            } else if (!o.cancelled) failed.incrementAndGet()
                            report(null)
                        }
                    }
                }
                workers.forEach { it.get() }
            } catch (e: Exception) {
                Log.w(TAG, "Téléchargement de la liste impossible", e)
            }
            val n = done.get()
            val f = failed.get()
            o.step = "done"
            o.message = listOfNotNull(
                if (n > 1) "$n morceaux téléchargés" else "$n morceau téléchargé",
                if (f > 0) "$f indisponible${if (f > 1) "s" else ""} sur YouTube" else null,
                if (o.cancelled) "arrêté" else null,
            ).joinToString(", ")
            changed()
            if (n > 0) onLibraryChanged?.invoke(folder)
        }
    }

    private fun cancelQr() {
        val o = synchronized(this) { offline } ?: return
        if (o.step == "downloading") {
            o.cancelled = true
            o.fetches.forEach { Youtube.cancel(it) }
        } else synchronized(this) { offline = null }
    }

    // ---------- Synchronisation ----------

    // Morceaux déjà eus dans ce dossier (présents ou supprimés depuis)
    private fun known(folder: String): MutableSet<String> = synchronized(this) {
        val a = store.getJSONObject("known").optJSONArray(folder.lowercase()) ?: JSONArray()
        (0 until a.length()).mapTo(mutableSetOf()) { a.getString(it) }
    }

    private fun remember(folder: String, ids: Collection<String>) = synchronized(this) {
        val set = known(folder)
        if (set.addAll(ids)) {
            store.getJSONObject("known").put(folder.lowercase(), JSONArray(set.toList()))
            save()
        }
    }

    // Empreinte du contenu (comme fileHash dans src/sync.js) : un titre, un artiste ou une pochette modifiés la changent
    private class Hashed(val size: Long, val modified: Long, val hash: String)
    private val hashes = ConcurrentHashMap<String, Hashed>()

    private fun fileHash(file: File): String {
        hashes[file.path]?.let { if (it.size == file.length() && it.modified == file.lastModified()) return it.hash }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return hex(digest.digest()).also { hashes[file.path] = Hashed(file.length(), file.lastModified(), it) }
    }

    private fun progress(step: String?) = synchronized(this) { activity?.put("step", step ?: JSONObject.NULL) }.also { changed() }

    // Chemin relatif venu de l'ordinateur → fichier dans le dossier, ou null s'il en sortirait
    private fun inside(folder: File, rel: String): File? {
        if (!Library.AUDIO.containsMatchIn(rel)) return null
        val parts = rel.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." || '\u0000' in it }) return null
        val file = File(folder, parts.joinToString("/"))
        return file.takeIf { it.canonicalPath.startsWith(folder.canonicalPath + "/") }
    }

    fun syncAll() {
        if (!running.compareAndSet(false, true)) return
        try {
            for (pc in synchronized(this) { pcs() }) {
                try {
                    syncWith(pc)
                } catch (e: Exception) {
                    Log.w(TAG, "Synchronisation avec ${pc.optString("name")} impossible", e)
                    synchronized(this) {
                        pc.put("error", if (e is HttpError && e.status == 401) "L'ordinateur ne reconnaît plus ce téléphone : associez-le à nouveau"
                            else "Synchronisation interrompue : ${e.message}")
                        save()
                    }
                }
            }
        } finally {
            synchronized(this) { activity = null }
            running.set(false)
            changed()
        }
    }

    private fun syncWith(pc: JSONObject) {
        val id = pc.getString("id")
        val token = pc.getString("token")
        val name = pc.getString("name")
        synchronized(this) { activity = JSONObject().put("peer", name).put("received", 0).put("sent", 0) }
        progress("Recherche de $name")

        // l'ordinateur, à sa dernière adresse, sinon cherché sur le réseau (il a pu en changer)
        var address = pc.getString("address")
        var port = pc.getInt("port")
        val library = try {
            request(address, port, "GET", "/sync/library", null, id, token, 20000).first
        } catch (e: IOException) {
            if (e is HttpError) throw e
            val found = discover().firstOrNull { it.getString("id") == id }
            if (found == null) {
                synchronized(this) { pc.put("error", "Pas sur ce réseau"); save() }
                return
            }
            address = found.getString("address")
            port = found.getInt("port")
            synchronized(this) { pc.put("address", address).put("port", port); save() }
            request(address, port, "GET", "/sync/library", null, id, token, 20000).first
        }

        val folder = File(Youtube.downloadFolder(folderSetting()))
        val local = Library.scan(folder.absolutePath).let { a -> (0 until a.length()).map { File(a.getJSONObject(it).getString("path")) } }
        val localIds = local.associateBy { Library.trackId(it) }
        remember(folder.absolutePath, localIds.keys)
        val known = known(folder.absolutePath)
        val remoteKnown = library.getJSONArray("known").let { a -> (0 until a.length()).mapTo(mutableSetOf()) { a.getString(it) } }
        val remote = library.getJSONArray("tracks").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
        val remoteById = remote.associateBy { it.getString("id") }
        // empreinte de chaque morceau quand les deux copies étaient identiques, à la dernière synchronisation
        val base = synchronized(this) { pc.optJSONObject("base") ?: JSONObject().also { pc.put("base", it) } }

        val toGet = remote.filter { it.getString("id") !in known }.mapNotNull { t -> inside(folder, t.getString("path"))?.takeIf { !it.exists() }?.let { t to it } }
        val toSend = localIds.filterKeys { it !in remoteKnown }

        // Morceaux présents des deux côtés mais différents (titre, artiste, pochette… modifiés) : la copie modifiée
        // depuis la dernière synchronisation remplace l'autre. Si on ne peut pas savoir (jamais synchronisés, ou modifiés
        // des deux côtés), celle de l'ordinateur l'emporte.
        val toUpdateHere = mutableListOf<Pair<JSONObject, File>>()
        val toUpdateThere = mutableListOf<Pair<JSONObject, File>>()
        for ((trackId, file) in localIds) {
            val r = remoteById[trackId] ?: continue
            val remoteHash = r.optString("hash").ifEmpty { null } ?: continue
            val localHash = try { fileHash(file) } catch (_: IOException) { continue }
            if (localHash == remoteHash) {
                synchronized(this) { base.put(trackId, localHash) }
                continue
            }
            if (base.optString(trackId) == remoteHash) toUpdateThere += r to file else toUpdateHere += r to file
        }

        var received = 0
        var sent = 0
        val playing = playingPath()

        // Fichier de l'ordinateur → `dest` (remplacé s'il existe : on passe par un fichier .part)
        fun receive(track: JSONObject, dest: File) {
            val (conn, _) = open(address, port, "/sync/file?path=" + URLEncoder.encode(track.getString("path"), "UTF-8"), id, token, 30000)
            try {
                check(conn)
                dest.parentFile?.mkdirs()
                val part = File(dest.path + ".part")
                conn.inputStream.use { input -> part.outputStream().use { input.copyTo(it) } }
                val expected = conn.contentLengthLong
                if ((expected >= 0 && part.length() != expected) || !part.renameTo(dest)) {
                    part.delete()
                    throw IOException("fichier incomplet")
                }
            } finally {
                conn.disconnect()
            }
            val trackId = track.getString("id")
            remember(folder.absolutePath, listOf(trackId))
            track.optString("hash").ifEmpty { null }?.let { synchronized(this) { base.put(trackId, it) } }
            received++
            synchronized(this) { activity?.put("received", received) }
        }

        // `source` → l'ordinateur, sous `rel` ; `replace` : l'empreinte de la copie de l'ordinateur à remplacer
        fun send(trackId: String, source: File, rel: String, replace: String?) {
            val query = "/sync/file?path=" + URLEncoder.encode(rel, "UTF-8") + "&id=" + URLEncoder.encode(trackId, "UTF-8") +
                (replace?.let { "&replace=$it" } ?: "")
            val (conn, _) = open(address, port, query, id, token, 60000)
            try {
                conn.requestMethod = "PUT"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/octet-stream")
                conn.setFixedLengthStreamingMode(source.length())
                source.inputStream().use { input -> conn.outputStream.use { input.copyTo(it) } }
                if (conn.responseCode == 409) return // ouvert dans le lecteur de l'ordinateur : la prochaine fois
                check(conn)
                val reply = JSONObject(conn.inputStream.use { String(it.readBytes()) })
                if (reply.optBoolean("skipped")) return
                sent++
                synchronized(this) { base.put(trackId, fileHash(source)) }
            } finally {
                conn.disconnect()
            }
            synchronized(this) { activity?.put("sent", sent) }
        }

        for ((i, pair) in toGet.withIndex()) {
            progress("Réception ${i + 1}/${toGet.size} : ${pair.second.nameWithoutExtension}")
            receive(pair.first, pair.second)
        }
        for ((i, pair) in toUpdateHere.withIndex()) {
            val (track, file) = pair
            if (file.path == playing) continue // en cours d'écoute : remplacé la fois suivante
            progress("Mise à jour ${i + 1}/${toUpdateHere.size} : ${file.nameWithoutExtension}")
            receive(track, file)
        }
        for ((i, entry) in toSend.entries.withIndex()) {
            val (trackId, source) = entry
            progress("Envoi ${i + 1}/${toSend.size} : ${source.nameWithoutExtension}")
            send(trackId, source, source.relativeTo(folder).invariantSeparatorsPath, null)
        }
        for ((i, pair) in toUpdateThere.withIndex()) {
            val (track, file) = pair
            progress("Envoi des modifications ${i + 1}/${toUpdateThere.size} : ${file.nameWithoutExtension}")
            send(track.getString("id"), file, track.getString("path"), track.getString("hash"))
        }
        request(address, port, "POST", "/sync/done", JSONObject().put("received", received).put("sent", sent), id, token)
        synchronized(this) {
            pc.put("lastSync", System.currentTimeMillis()).put("summary", JSONObject().put("received", received).put("sent", sent))
            pc.remove("error")
            save()
        }
        if (received > 0) onLibraryChanged?.invoke(folder.absolutePath)
    }
}
