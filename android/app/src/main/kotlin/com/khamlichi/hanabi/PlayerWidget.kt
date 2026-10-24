package com.khamlichi.hanabi

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import kotlin.math.max
import kotlin.math.roundToInt

// Le lecteur flottant de l'ordinateur devient un widget de l'écran d'accueil. Android n'y permet pas d'animation :
// le verre est dessiné une fois par morceau, teinté par la pochette comme le fond flou du lecteur (sa palette
// étirée et floutée, la lumière de la basse qui monte du bas), avec le contour du thème choisi (chrome SAVAGE…).
class PlayerWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, views(context, manager, id))
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        manager.updateAppWidget(id, views(context, manager, id))
    }

    companion object {
        // Contours qui débordent du lecteur (comme FRAME_SKINS dans main.js) : position et taille de la barre dans
        // l'image du cadre, en fractions
        private class Skin(val left: Float, val top: Float, val right: Float, val bottom: Float)
        private val SKINS = mapOf(
            "savage" to Skin(0f, 0f, 0f, 0f),
            "savage-meshy" to Skin(82f / 703, 35f / 171, (703f - 622) / 703, (171f - 123) / 171),
        )

        private val glassCache = mutableMapOf<Int, Pair<String, Bitmap>>()
        private val frameCache = mutableMapOf<String, Bitmap?>()

        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, PlayerWidget::class.java))
            for (id in ids) manager.updateAppWidget(id, views(context, manager, id))
        }

        private fun pending(context: Context, cmd: String, code: Int) = PendingIntent.getForegroundService(context, code,
            PlayerService.commandIntent(context, cmd, foreground = true), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        private fun views(context: Context, manager: AppWidgetManager, id: Int): RemoteViews {
            val state = PlayerService.instance?.state
            val views = RemoteViews(context.packageName, R.layout.widget_player)
            val open = PendingIntent.getActivity(context, 20, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.cover, open)
            views.setOnClickPendingIntent(R.id.bar, open)
            views.setOnClickPendingIntent(R.id.play, pending(context, "play-pause", 21))
            views.setOnClickPendingIntent(R.id.next, pending(context, "next", 22))
            views.setOnClickPendingIntent(R.id.prev, pending(context, "prev", 23))

            views.setTextViewText(R.id.title, state?.title ?: "Hanabi Player")
            views.setTextViewText(R.id.artist, state?.artist?.ifEmpty { null } ?: if (state?.path == null) "Toucher pour ouvrir le lecteur" else "")
            val playing = state?.playing == true
            views.setImageViewResource(R.id.play, if (playing) R.drawable.ic_pause_dark else R.drawable.ic_play_dark)
            views.setContentDescription(R.id.play, if (playing) "Pause" else "Lecture")
            // avancement : celui du dernier état connu, prolongé tant que la musique joue
            val position = state?.let { s ->
                s.position + if (s.playing) (SystemClock.elapsedRealtime() - s.updatedAt) / 1000.0 * s.rate else 0.0
            } ?: 0.0
            val duration = state?.duration ?: 0.0
            views.setProgressBar(R.id.progress, 1000, if (duration > 0) (1000 * position / duration).roundToInt().coerceIn(0, 1000) else 0, false)

            // Taille du widget (portrait : largeur minimale, hauteur maximale), en pixels
            val options = manager.getAppWidgetOptions(id)
            val density = context.resources.displayMetrics.density
            val w = max(200, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 300))
            val h = max(50, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 72))
            val scale = minOf(density, 2.5f) // au-delà, l'image pèserait trop lourd pour un widget
            val width = (w * scale).roundToInt(); val height = (h * scale).roundToInt()

            val theme = state?.theme ?: "glass"
            val skin = SKINS[theme]
            val bar = RectF(0f, 0f, width.toFloat(), height.toFloat())
            if (skin != null) {
                bar.set(width * skin.left, height * skin.top, width * (1 - skin.right), height * (1 - skin.bottom))
                views.setViewPadding(R.id.bar, (bar.left / scale * density + 10 * density).roundToInt(), (bar.top / scale * density).roundToInt(),
                    ((width - bar.right) / scale * density + 6 * density).roundToInt(), ((height - bar.bottom) / scale * density).roundToInt())
            }
            // le verre et le cadre ne changent qu'avec le morceau, le thème ou la taille : redessinés seulement alors
            val key = listOf(theme, width, height, state?.coverPath, state?.cover?.generationId, state?.color).joinToString("|")
            val background = glassCache[id]?.takeIf { it.first == key }?.second
                ?: glass(context, width, height, bar, state, theme, skin != null, scale).also { glassCache[id] = key to it }
            views.setImageViewBitmap(R.id.background, background)
            val frame = skin?.let { frameCache.getOrPut("$theme|$width") { frameBitmap(context, theme, width) } }
            if (frame != null) {
                views.setImageViewBitmap(R.id.frame, frame)
                views.setViewVisibility(R.id.frame, View.VISIBLE)
            } else {
                views.setViewVisibility(R.id.frame, View.GONE)
            }
            val cover = state?.cover?.let { rounded(it, (48 * density).roundToInt(), 8 * density) }
            if (cover != null) views.setImageViewBitmap(R.id.cover, cover) else views.setImageViewResource(R.id.cover, R.mipmap.ic_launcher)
            return views
        }

        private fun rounded(source: Bitmap, size: Int, radius: Float): Bitmap {
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            canvas.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), radius, radius, paint)
            paint.blendMode = BlendMode.SRC_IN
            canvas.drawBitmap(source, null, Rect(0, 0, size, size), paint)
            return out
        }

        // Le verre : la palette de la pochette étirée et floutée (plafonnée en luminosité, comme FX_PALETTE_LIGHT),
        // la teinte sombre, un reflet en biais, la lumière de la basse du bas, et le liseré clair du bord
        private fun glass(context: Context, width: Int, height: Int, bar: RectF, state: PlayerService.NowPlaying?, theme: String, framed: Boolean, scale: Float): Bitmap {
            val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val radius = if (framed) 6 * scale else 18 * scale
            val clip = Path().apply { addRoundRect(bar, radius, radius, Path.Direction.CW) }
            canvas.save()
            canvas.clipPath(clip)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            canvas.drawColor(Color.argb(200, 16, 18, 28))
            val cover = state?.cover
            if (cover != null && theme != "mono") {
                // 24 × 6 pixels, agrandis avec lissage : le fond flou du lecteur
                val small = Bitmap.createScaledBitmap(Bitmap.createScaledBitmap(cover, 24, 6, true), 96, 24, true)
                var light = 0f
                for (x in 0 until 24) for (y in 0 until 6) {
                    val c = small.getPixel(x * 4, y * 4)
                    light += (0.2126f * Color.red(c) + 0.7152f * Color.green(c) + 0.0722f * Color.blue(c)) / 255
                }
                light /= 144
                val dim = if (light > 0.18f) 0.18f / light else 1f
                paint.alpha = (255 * 0.42f * minOf(1f, dim * 1.4f)).roundToInt()
                canvas.drawBitmap(small, null, bar, paint)
                paint.alpha = 255
            }
            canvas.drawColor(Color.argb(95, 16, 18, 28))
            // la basse, du bas du verre, à la couleur de la pochette
            val color = state?.color ?: Color.rgb(150, 180, 255)
            paint.shader = RadialGradient(bar.centerX(), bar.bottom + bar.height() * 0.2f, bar.width() * 0.55f,
                Color.argb(70, Color.red(color), Color.green(color), Color.blue(color)), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawRect(bar, paint)
            paint.shader = LinearGradient(bar.left, bar.top, bar.left + bar.width() * 0.6f, bar.bottom,
                intArrayOf(Color.argb(36, 255, 255, 255), Color.argb(5, 255, 255, 255), Color.TRANSPARENT), floatArrayOf(0f, 0.28f, 0.52f), Shader.TileMode.CLAMP)
            canvas.drawRect(bar, paint)
            paint.shader = null
            canvas.restore()
            if (!framed) {
                paint.style = Paint.Style.STROKE
                paint.strokeWidth = scale
                paint.shader = LinearGradient(bar.left, bar.top, bar.right, bar.bottom,
                    intArrayOf(Color.argb(82, 255, 255, 255), Color.argb(15, 255, 255, 255), Color.argb(40, 255, 255, 255)), null, Shader.TileMode.CLAMP)
                val half = scale / 2
                canvas.drawRoundRect(RectF(bar.left + half, bar.top + half, bar.right - half, bar.bottom - half), radius, radius, paint)
            }
            return out
        }

        // Le cadre de chrome des thèmes SAVAGE (le même rendu que dans le lecteur, skins/<thème>-frame.png)
        private fun frameBitmap(context: Context, theme: String, width: Int): Bitmap? = try {
            context.assets.open("web/src/renderer/skins/$theme-frame.png").use { input ->
                val bitmap = BitmapFactory.decodeStream(input) ?: return null
                if (bitmap.width > width * 1.5) Bitmap.createScaledBitmap(bitmap, width, (bitmap.height * width / bitmap.width.toFloat()).roundToInt(), true) else bitmap
            }
        } catch (_: Exception) {
            null
        }
    }
}
