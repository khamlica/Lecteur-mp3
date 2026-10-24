package com.khamlichi.hanabi

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import java.util.concurrent.Executors

class HanabiApp : Application() {
    override fun onCreate() {
        super.onCreate()
        app = this
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_PLAYBACK, "Lecture", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Le morceau en cours et ses commandes"
            setShowBadge(false)
        })
        manager.createNotificationChannel(NotificationChannel(CHANNEL_UPDATES, "Mises à jour", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Une nouvelle version est prête à installer"
        })
    }

    companion object {
        lateinit var app: HanabiApp
            private set
        const val CHANNEL_PLAYBACK = "playback"
        const val CHANNEL_UPDATES = "updates"

        // Travaux longs (dossiers, tags, téléchargements, recherches en ligne), hors du fil de l'interface
        val work = Executors.newCachedThreadPool()
    }
}
