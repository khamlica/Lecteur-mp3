package com.khamlichi.hanabi

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import android.net.Uri

// L'écran de l'app : il affiche la page du lecteur, qui vit dans PlayerService (la musique continue sans lui)
class MainActivity : ComponentActivity() {
    private lateinit var container: FrameLayout
    private var service: PlayerService? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var insets = JSONObject().put("top", 0).put("bottom", 0).put("left", 0).put("right", 0)

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        service?.event("storage")
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val s = (binder as PlayerService.LocalBinder).service
            service = s
            s.attach(this@MainActivity, container)
            refreshTransparency()
            s.event("insets", insets.toString())
            handleIntent(intent)
        }

        override fun onServiceDisconnected(name: ComponentName) {
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // la page s'étend sous les barres du système ; elle reçoit leurs marges (insets) pour y placer ses boutons
        window.setDecorFitsSystemWindows(false)
        container = FrameLayout(this)
        setContentView(container)
        container.setOnApplyWindowInsetsListener { _, windowInsets ->
            val bars = windowInsets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
            val ime = windowInsets.getInsets(android.view.WindowInsets.Type.ime())
            val d = resources.displayMetrics.density
            insets = JSONObject().put("top", bars.top / d).put("bottom", maxOf(bars.bottom, ime.bottom) / d)
                .put("left", bars.left / d).put("right", bars.right / d)
            service?.event("insets", insets.toString())
            windowInsets
        }

        val intent = Intent(this, PlayerService::class.java)
        startService(intent)
        bindService(intent, connection, Context.BIND_AUTO_CREATE)

        // Retour : ferme le panneau ouvert (menu, réglages…), sinon revient à l'écran d'accueil sans arrêter la musique
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val s = service ?: return finish()
                s.web.evaluateJavascript("window.hanabiHost ? hanabiHost.back() : false") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    // Un lien YouTube partagé depuis une autre app : l'audio est téléchargé
    private fun handleIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        val url = Regex("https?://\\S*(youtube\\.com|youtu\\.be)/\\S+", RegexOption.IGNORE_CASE).find(text)?.value ?: return
        service?.command("youtube-url", JSONObject.quote(url))
        intent.action = null // pas de nouveau téléchargement en revenant sur l'app
    }

    // rotation, fenêtre redimensionnée : même fantôme qu'au lancement derrière le fond de verre
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        refreshTransparency()
    }

    override fun onResume() {
        super.onResume()
        service?.event("resume")
    }

    override fun onDestroy() {
        service?.detach(this)
        try { unbindService(connection) } catch (_: Exception) {}
        super.onDestroy()
    }

    // Fond de verre (réglage « Transparence ») : le fond d'écran du téléphone, flouté quand Android le permet, sous
    // la teinte sombre du lecteur ; sinon un fond sombre plein, comme le lecteur de bureau
    fun applyTransparency(flag: Boolean) {
        val blur = Build.VERSION.SDK_INT >= 31 && windowManager.isCrossWindowBlurEnabled
        if (flag) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER)
            window.setBackgroundDrawable(ColorDrawable(if (blur) 0x5510121C else 0xB010121C.toInt()))
            if (Build.VERSION.SDK_INT >= 31) window.setBackgroundBlurRadius(if (blur) (48 * resources.displayMetrics.density).toInt() else 0)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER)
            window.setBackgroundDrawable(ColorDrawable(0xFF161821.toInt()))
            if (Build.VERSION.SDK_INT >= 31) window.setBackgroundBlurRadius(0)
        }
    }

    // Au lancement (et après une rotation), le flou du fond de verre garde derrière l'app une image fantôme d'elle-même :
    // le fond est reposé une fois la page affichée, en passant un instant par le fond plein, qui efface ce fantôme
    private fun refreshTransparency() {
        container.postDelayed({
            val s = service ?: return@postDelayed
            if (!s.transparent) return@postDelayed applyTransparency(false)
            applyTransparency(false)
            container.postDelayed({ service?.let { applyTransparency(it.transparent) } }, 100)
        }, 600)
    }

    fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) service?.openStorageSettings(this)
        else askPermissions.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE))
    }

    fun chooseFile(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams) {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        try {
            pickFile.launch(params.createIntent())
        } catch (_: Exception) {
            fileCallback = null
            callback.onReceiveValue(null)
        }
    }
}
