package com.khamlichi.hanabi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.view.KeyEvent

// Bouton du casque (ou de la voiture) quand le lecteur n'est plus lancé : il redémarre et joue
class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        @Suppress("DEPRECATION")
        val key = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return
        if (key.action != KeyEvent.ACTION_DOWN) return
        val cmd = when (key.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> "play-pause"
            KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "prev"
            KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP -> "pause"
            else -> return
        }
        val running = PlayerService.instance
        if (running != null) running.command(cmd)
        else if (cmd != "pause") context.startForegroundService(PlayerService.commandIntent(context, cmd, foreground = true))
    }
}
