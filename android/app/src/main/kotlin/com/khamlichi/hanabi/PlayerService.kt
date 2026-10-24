package com.khamlichi.hanabi

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.MutableContextWrapper
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.Icon
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

// Le lecteur lui-même : la page de l'interface (effets, son, liste de lecture…) vit ici et non dans l'écran de l'app,
// pour que la musique continue écran éteint ou app fermée, et que le widget, la notification et les boutons du casque
// la pilotent. L'écran de l'app (MainActivity) ne fait qu'afficher cette page quand il est ouvert.
class PlayerService : Service() {
    companion object {
        private const val TAG = "Hanabi"
        @Volatile var instance: PlayerService? = null
            private set
        const val ACTION_COMMAND = "com.khamlichi.hanabi.COMMAND"
        const val EXTRA_CMD = "cmd"
        const val EXTRA_FOREGROUND = "foreground"
        private const val NOTIFICATION_ID = 1
        private const val WIDGET_TICK = 2000L
        private const val PAUSED_FOREGROUND = 10 * 60 * 1000L // en pause, le lecteur quitte le premier plan après 10 min
        private const val SYNC_INTERVAL = 5 * 60 * 1000L
        private const val UPDATE_RECHECK = 15 * 60 * 1000L

        // `foreground` : lancé depuis l'arrière-plan (widget, bouton du casque) : le service doit passer au premier
        // plan aussitôt (Android l'exige dans les 5 s)
        fun commandIntent(context: Context, cmd: String, foreground: Boolean = false): Intent =
            Intent(context, PlayerService::class.java).setAction(ACTION_COMMAND).putExtra(EXTRA_CMD, cmd).putExtra(EXTRA_FOREGROUND, foreground)
    }

    inner class LocalBinder : Binder() {
        val service get() = this@PlayerService
    }

    // Morceau en cours, tel que la page le décrit (voir Bridge.playback)
    class NowPlaying {
        var path: String? = null
        var title = "Hanabi Player"
        var artist = ""
        var playing = false
        var position = 0.0 // s
        var duration = 0.0 // s
        var rate = 1.0
        var color: Int? = null // couleur des effets (dominante de la pochette)
        var theme = "glass"
        var frame = "none" // contour posé par-dessus le thème (le cadre du widget)
        var cover: Bitmap? = null
        var coverPath: String? = null
        var updatedAt = 0L
    }

    val state = NowPlaying()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wrapper: MutableContextWrapper
    lateinit var web: WebView
        private set
    var activity: MainActivity? = null
        private set
    private var pageReady = false
    private val pending = mutableListOf<String>()
    private lateinit var session: MediaSession
    private lateinit var audio: AudioManager
    private var foreground = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioDevice: String? = null
    private lateinit var clipboard: ClipboardManager
    private val settingsFile by lazy { File(filesDir, "settings.json") }

    override fun onBind(intent: Intent?): IBinder = LocalBinder()

    override fun onCreate() {
        super.onCreate()
        instance = this
        wrapper = MutableContextWrapper(this)
        audio = getSystemService(AudioManager::class.java)
        clipboard = getSystemService(ClipboardManager::class.java)
        readSettingsForNative()
        createWebView()
        createSession()
        registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
        audio.registerAudioDeviceCallback(deviceCallback, main)
        main.post(updateCheck)
        setupSync()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.getBooleanExtra(EXTRA_FOREGROUND, false) == true) goForeground(true)
        intent?.getStringExtra(EXTRA_CMD)?.let { command(it) }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        instance = null
        main.removeCallbacksAndMessages(null)
        try { unregisterReceiver(noisy) } catch (_: Exception) {}
        audio.unregisterAudioDeviceCallback(deviceCallback)
        try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) } catch (_: Exception) {}
        wakeLock?.takeIf { it.isHeld }?.release()
        session.release()
        web.destroy()
        super.onDestroy()
    }

    // L'app est balayée des apps récentes : la musique continue si elle joue, sinon le lecteur s'arrête
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!state.playing) stopSelf()
    }

    // ---------- Page du lecteur ----------

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        pageReady = false
        web = WebView(wrapper).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.textZoom = 100
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = WebView.OVER_SCROLL_NEVER
            addJavascriptInterface(Bridge(), "HanabiNative")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    WebContent.serve(applicationContext, request)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == WebContent.HOST) return false
                    // un lien extérieur s'ouvre dans le navigateur
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
                    return true
                }

                // Le moteur de la page a planté (mémoire…) : on recrée la page, qui reprend le morceau où il en était
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    Log.w(TAG, "Page du lecteur perdue (plantage : ${detail.didCrash()}) : rechargement")
                    val container = view.parent as? ViewGroup
                    container?.removeView(view)
                    view.destroy()
                    createWebView()
                    container?.addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    Log.d(TAG, "page: ${message.message()} (${message.sourceId().substringAfterLast('/')}:${message.lineNumber()})")
                    return true
                }

                // Choix d'une image pour la pochette (fenêtre d'édition)
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    val shown = activity ?: return false.also { callback.onReceiveValue(null) }
                    shown.chooseFile(callback, params)
                    return true
                }
            }
            loadUrl(WebContent.PAGE)
        }
    }

    fun attach(activity: MainActivity, container: ViewGroup) {
        this.activity = activity
        wrapper.baseContext = activity // listes déroulantes, choix de couleur… s'ouvrent sur l'écran de l'app
        (web.parent as? ViewGroup)?.removeView(web)
        container.addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        event("visible", "true")
    }

    fun detach(activity: MainActivity) {
        if (this.activity !== activity) return
        (web.parent as? ViewGroup)?.removeView(web)
        wrapper.baseContext = this
        this.activity = null
        event("visible", "false")
    }

    // Exécute du JavaScript dans la page, une fois celle-ci prête
    fun js(code: String) {
        main.post {
            if (pageReady) web.evaluateJavascript(code, null) else pending += code
        }
    }

    fun event(name: String, json: String = "null") = js("hanabiHost._event(${JSONObject.quote(name)}, $json)")

    // Commande du lecteur : play-pause, play, pause, next, prev, choose-folder, youtube…
    fun command(cmd: String, arg: String = "null") = js("hanabiHost._command(${JSONObject.quote(cmd)}, $arg)")

    // ---------- Pont avec la page (window.HanabiNative) ----------

    private inner class Bridge {
        @JavascriptInterface
        fun ready() = main.post {
            pageReady = true
            pending.forEach { web.evaluateJavascript(it, null) }
            pending.clear()
            audioDeviceChanged(force = true)
            Updater.ready?.let { event("update-ready", JSONObject.quote(it)) }
        }

        @JavascriptInterface
        fun loadSettings(): String = try { settingsFile.readText() } catch (_: Exception) { "" }

        @JavascriptInterface
        fun saveSettings(json: String) {
            try {
                val tmp = File(settingsFile.path + ".tmp")
                tmp.writeText(json)
                tmp.renameTo(settingsFile)
                readSettingsForNative(json)
            } catch (e: Exception) {
                Log.e(TAG, "Impossible d'enregistrer les réglages", e)
            }
        }

        @JavascriptInterface
        fun readClipboard(): String = try {
            clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this@PlayerService)?.toString() ?: ""
        } catch (_: Exception) {
            ""
        }

        @JavascriptInterface
        fun playback(json: String) {
            val info = JSONObject(json)
            main.post { onPlayback(info) }
        }

        @JavascriptInterface
        fun hasStorageAccess(): Boolean = storageAccess()

        @JavascriptInterface
        fun requestStorageAccess() {
            main.post { activity?.requestStorageAccess() }
        }

        @JavascriptInterface
        fun moveToBack() {
            main.post { activity?.moveTaskToBack(true) }
        }

        @JavascriptInterface
        fun setTransparent(flag: Boolean) {
            main.post { activity?.applyTransparency(flag) }
        }

        @JavascriptInterface
        fun cancelYoutube() = Youtube.cancel()

        @JavascriptInterface
        fun installUpdate() {
            if (Updater.ready != null) main.post { startActivity(Updater.installIntent(this@PlayerService)) }
        }

        @JavascriptInterface
        fun version(): String = BuildConfigInfo.version(this@PlayerService)

        @JavascriptInterface
        fun checkUpdate() {
            main.post { checkUpdates(manual = true) }
        }

        @JavascriptInterface
        fun musicFolder(): String = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC).absolutePath

        // Travaux longs : le résultat revient à la page par hanabiHost._done(id, résultat)
        @JavascriptInterface
        fun call(id: Int, method: String, argsJson: String) {
            val args = JSONArray(argsJson)
            HanabiApp.work.execute {
                val result: Any? = try {
                    when (method) {
                        "scan" -> Library.scan(args.getString(0))
                        "listDir" -> Library.listDir(if (args.isNull(0)) null else args.getString(0))
                        "mkdir" -> Library.makeDir(args.getString(0), args.getString(1))
                        "metadata" -> Library.metadata(args.getString(0))
                        "youtube" -> Youtube.convert(args.getString(0), if (args.isNull(1)) null else args.getString(1)) { progress ->
                            event("yt-progress", progress.toString())
                        }
                        "writeTags" -> writeTags(args.getString(0), args.getJSONObject(1))
                        "lookup" -> args.getJSONObject(1).let { Youtube.lookupForEditor(args.getString(0), it.optString("title"), it.optString("artist")) }
                        "sync" -> Sync.action(args.getString(0), if (args.length() > 1 && !args.isNull(1)) args.getString(1) else null)
                        else -> throw IllegalArgumentException("méthode inconnue : $method")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "$method a échoué", e)
                    js("hanabiHost._fail($id, ${JSONObject.quote(e.message ?: e.toString())})")
                    return@execute
                }
                js("hanabiHost._done($id, ${result ?: "null"})")
            }
        }
    }

    private fun writeTags(file: String, changes: JSONObject): JSONObject {
        val trim = changes.optJSONObject("trim")?.let { Media.Trim(it.getDouble("start"), if (it.isNull("end")) null else it.optDouble("end")) }
        val cover = if (changes.has("cover") && !changes.isNull("cover")) Base64.decode(changes.getString("cover"), Base64.DEFAULT) else null
        val title = if (changes.has("title") && !changes.isNull("title")) changes.getString("title") else null
        val artist = if (changes.has("artist") && !changes.isNull("artist")) changes.getString("artist") else null
        val error = Media.writeTags(file, title, artist, cover, trim)
        if (file == state.path) state.coverPath = null // pochette peut-être changée : relue pour la notification
        return if (error != null) JSONObject().put("error", error) else JSONObject()
    }

    fun storageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED

    // Réglages dont le natif a besoin (thème du widget, fond de l'écran de l'app)
    var transparent = true
        private set
    @Volatile private var folderSetting: String? = null

    // Les thèmes SAVAGE portent leur cadre (sur le widget aussi), sauf si un autre contour est choisi
    private fun widgetFrame(theme: String, frame: String) = when {
        frame != "none" -> frame
        theme == "savage-cells" -> "savage"
        theme == "savage-enhanced" -> "savage-meshy"
        else -> frame
    }

    private fun readSettingsForNative(json: String? = null) {
        try {
            val s = JSONObject(json ?: settingsFile.readText())
            transparent = s.optBoolean("transparent", true)
            folderSetting = if (s.isNull("folder")) null else s.optString("folder").ifEmpty { null }
            var theme = s.optString("fxTheme", "glass")
            var frame = s.optString("fxFrame", "none")
            // les contours SAVAGE étaient des thèmes (jusqu'à la 1.4), voir host.js
            if (theme == "savage" || theme == "savage-meshy") { frame = theme; theme = "glass" }
            frame = widgetFrame(theme, frame)
            if (theme != state.theme || frame != state.frame) {
                state.theme = theme
                state.frame = frame
                main.post { PlayerWidget.updateAll(this) }
            }
        } catch (_: Exception) {
        }
    }

    // ---------- Lecture : session média, notification, widget ----------

    private fun createSession() {
        session = MediaSession(this, "Hanabi Player").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = command("play")
                override fun onPause() = command("pause")
                override fun onSkipToNext() = command("next")
                override fun onSkipToPrevious() = command("prev")
                override fun onStop() = command("pause")
                override fun onSeekTo(pos: Long) = command("seek", (pos / 1000.0).toString())
            })
            setMediaButtonReceiver(PendingIntent.getBroadcast(this@PlayerService, 0,
                Intent(this@PlayerService, MediaButtonReceiver::class.java), PendingIntent.FLAG_IMMUTABLE))
            isActive = true
        }
    }

    private fun onPlayback(info: JSONObject) {
        val wasPlaying = state.playing
        if (info.has("playing")) state.playing = info.getBoolean("playing")
        if (info.has("path")) state.path = if (info.isNull("path")) null else info.getString("path")
        if (info.has("title")) state.title = info.getString("title").ifEmpty { "Hanabi Player" }
        if (info.has("artist")) state.artist = info.getString("artist")
        if (info.has("position")) state.position = info.getDouble("position")
        if (info.has("duration")) state.duration = info.optDouble("duration", 0.0).takeIf { it.isFinite() } ?: 0.0
        if (info.has("rate")) state.rate = info.getDouble("rate")
        if (info.has("theme")) state.theme = info.getString("theme")
        if (info.has("frame")) state.frame = widgetFrame(state.theme, info.getString("frame"))
        info.optJSONArray("color")?.let { state.color = Color.rgb(it.getInt(0), it.getInt(1), it.getInt(2)) }
        state.updatedAt = android.os.SystemClock.elapsedRealtime()

        if (state.playing && !wasPlaying) {
            if (wakeLock == null) wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Hanabi:lecture")
            wakeLock?.takeIf { !it.isHeld }?.acquire(6 * 3600 * 1000L)
        } else if (!state.playing && wasPlaying) {
            wakeLock?.takeIf { it.isHeld }?.release()
        }

        main.removeCallbacks(widgetTick)
        if (state.playing) main.postDelayed(widgetTick, WIDGET_TICK)
        if (state.path != state.coverPath) loadCover() else publish()
    }

    // L'avancement du widget suit la lecture (écran allumé seulement)
    private val widgetTick = object : Runnable {
        override fun run() {
            if (!state.playing) return
            if (getSystemService(PowerManager::class.java).isInteractive) PlayerWidget.updateAll(this@PlayerService)
            main.postDelayed(this, WIDGET_TICK)
        }
    }

    // Pochette du morceau, lue dans le fichier, pour la notification, l'écran verrouillé et le widget
    private fun loadCover() {
        val path = state.path
        state.coverPath = path
        HanabiApp.work.execute {
            val bitmap = path?.let { Media.thumbnail(Library.coverBytes(it), 512) }
            main.post {
                if (state.path == path) {
                    state.cover = bitmap
                    publish()
                }
            }
        }
    }

    private fun publish() {
        val playbackState = PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP)
            .setState(if (state.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                (state.position * 1000).toLong(), if (state.playing) state.rate.toFloat() else 0f, state.updatedAt)
            .build()
        session.setPlaybackState(playbackState)
        session.setMetadata(MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, state.title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, state.artist)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, (state.duration * 1000).toLong())
            .apply { state.cover?.let { putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) } }
            .build())

        val manager = getSystemService(NotificationManager::class.java)
        if (state.path == null) {
            if (foreground) { stopForeground(STOP_FOREGROUND_REMOVE); foreground = false }
            manager.cancel(NOTIFICATION_ID)
        } else if (state.playing) {
            main.removeCallbacks(leaveForeground)
            goForeground(false)
        } else if (foreground) {
            // En pause, le lecteur reste un moment au premier plan : Android ne le laisserait pas y revenir depuis
            // l'arrière-plan pour reprendre (morceau suivant après un téléchargement, bouton du casque…)
            notifySafely(manager, notification())
            main.removeCallbacks(leaveForeground)
            main.postDelayed(leaveForeground, PAUSED_FOREGROUND)
        } else {
            notifySafely(manager, notification())
        }
        PlayerWidget.updateAll(this)
    }

    private val leaveForeground = Runnable {
        if (!state.playing && foreground) {
            stopForeground(STOP_FOREGROUND_DETACH)
            foreground = false
        }
    }

    private fun notifySafely(manager: NotificationManager, n: Notification) {
        try { manager.notify(NOTIFICATION_ID, n) } catch (_: SecurityException) {}
    }

    private fun goForeground(early: Boolean) {
        try {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            foreground = true
        } catch (e: Exception) {
            // Android refuse parfois le premier plan depuis l'arrière-plan : la notification reste, sans plus
            Log.w(TAG, "Premier plan refusé : ${e.message}")
            if (!early) notifySafely(getSystemService(NotificationManager::class.java), notification())
        }
    }

    private fun servicePending(cmd: String, code: Int) =
        PendingIntent.getService(this, code, commandIntent(this, cmd), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE)
        fun action(icon: Int, label: String, cmd: String, code: Int) =
            Notification.Action.Builder(Icon.createWithResource(this, icon), label, servicePending(cmd, code)).build()
        return Notification.Builder(this, HanabiApp.CHANNEL_PLAYBACK)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(state.title)
            .setContentText(state.artist)
            .setLargeIcon(state.cover)
            .setContentIntent(open)
            .setOngoing(state.playing)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .apply { state.color?.let { setColor(it) } }
            .addAction(action(R.drawable.ic_prev, "Précédent", "prev", 11))
            .addAction(if (state.playing) action(R.drawable.ic_pause, "Pause", "play-pause", 12) else action(R.drawable.ic_play, "Lecture", "play-pause", 12))
            .addAction(action(R.drawable.ic_next, "Suivant", "next", 13))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    // ---------- Casque débranché, sortie audio ----------

    // (Le focus audio, lui, est géré par la WebView : pause pendant un appel ou quand une autre app joue, reprise
    // après une interruption brève. Le demander ici en plus la mettrait en pause aussitôt.)

    // Casque débranché, enceinte Bluetooth déconnectée : pause, comme toute app de musique
    private val noisy = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (state.playing) command("pause")
        }
    }

    // Sortie audio en cours (casque Bluetooth, haut-parleur…) : chacune garde son réglage de synchronisation des effets
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) = audioDeviceChanged()
        override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) = audioDeviceChanged()
    }

    private fun audioDeviceChanged(force: Boolean = false) {
        val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val bluetooth = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER)
        val wired = setOf(AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET)
        val name = outputs.firstOrNull { it.type in bluetooth }?.let { it.productName?.toString()?.ifBlank { null } ?: "Bluetooth" }
            ?: outputs.firstOrNull { it.type in wired }?.let { "Casque filaire" }
            ?: "Haut-parleur du téléphone"
        if (name == audioDevice && !force) return
        audioDevice = name
        event("audio-device", JSONObject.quote(name))
    }

    // ---------- Mises à jour ----------

    // Au démarrage du lecteur, toutes les 6 h, et à chaque retour sur l'app (au plus tous les quarts d'heure) : le
    // lecteur vit en arrière-plan et ne redémarre pas quand on rouvre l'app, une version publiée entre-temps
    // attendrait sinon jusqu'à 6 h
    private var lastUpdateCheck = 0L
    private val updateCheck = object : Runnable {
        override fun run() {
            checkUpdates()
            main.postDelayed(this, Updater.CHECK_INTERVAL)
        }
    }

    // `manual` : demandé depuis le menu ✨, la réponse s'affiche (à jour, mise à jour prête, ou vérification impossible)
    fun checkUpdates(manual: Boolean = false) {
        val now = android.os.SystemClock.elapsedRealtime()
        if (!manual && lastUpdateCheck != 0L && now - lastUpdateCheck < UPDATE_RECHECK) return
        lastUpdateCheck = now
        HanabiApp.work.execute {
            val ready = Updater.check(this)
            ready?.let { event("update-ready", JSONObject.quote(it)) }
            if (!manual) return@execute
            val text = when {
                ready != null -> "Version $ready prête : « Installer la version $ready » dans le menu ✨"
                Updater.failed -> "Impossible de vérifier les mises à jour (pas de connexion ?)"
                else -> "Hanabi Player est à jour (version ${BuildConfigInfo.version(this)})"
            }
            main.post { android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_LONG).show() }
        }
    }

    // ---------- Synchronisation avec l'ordinateur (Sync.kt) ----------

    private fun setupSync() {
        Sync.folderSetting = { folderSetting }
        Sync.playingPath = { state.path }
        Sync.onState = { event("sync-state", it.toString()) }
        // morceaux reçus : la liste du lecteur suit (et le dossier, s'il vient d'être créé)
        Sync.onLibraryChanged = { folder ->
            event("library-changed", JSONObject().put("folder", folder).put("tracks", Library.scan(folder)).toString())
        }
        // sans Wi‑Fi : le scanner de QR code de Google Play, ouvert sur l'écran de l'app
        Sync.scanner = { done ->
            main.post {
                val shown = activity
                if (shown == null) done(null, "ouvrez l'app")
                else GmsBarcodeScanning.getClient(shown, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
                    .startScan()
                    .addOnSuccessListener { done(it.rawValue ?: "", null) }
                    .addOnCanceledListener { done(null, null) }
                    .addOnFailureListener { done(null, it.message ?: it.toString()) }
            }
        }
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        main.postDelayed(syncTick, 5000)
    }

    // Toutes les 5 minutes, au retour sur l'app et à chaque nouveau réseau, tant que le lecteur tourne
    private val syncTick = object : Runnable {
        override fun run() {
            main.removeCallbacks(this)
            if (Sync.paired && storageAccess()) HanabiApp.work.execute { Sync.syncAll() }
            main.postDelayed(this, SYNC_INTERVAL)
        }
    }

    fun syncSoon(delayMs: Long = 1500) {
        main.removeCallbacks(syncTick)
        main.postDelayed(syncTick, delayMs)
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post { syncSoon(4000) }
        }
    }

    fun openStorageSettings(context: Context) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        context.startActivity(intent)
    }
}
