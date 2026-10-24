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
        // La barre du lecteur de bureau (540 × 88), et les contours SAVAGE en pixels du bureau : taille de
        // l'image du cadre et place de la barre dedans (SAVAGE : le cadre est la barre ; SAVAGE ENHANCED (savage-meshy) déborde, comme
        // FRAME_SKINS dans main.js). Le cadre garde ses proportions : seuls ses rails droits s'allongent.
        private const val BAR_WIDTH = 540f
        private const val BAR_HEIGHT = 88f
        private class Skin(val width: Float, val height: Float, val barLeft: Float, val barTop: Float)
        private val SKINS = mapOf(
            "savage" to Skin(540f, 88f, 0f, 0f),
            "savage-meshy" to Skin(703f, 171f, 82f, 35f),
        )

        // L'image du cadre et ses rails (colonnes où le cadre n'est qu'un fil droit en haut et en bas : celles qu'on
        // peut allonger sans rien déformer), lus une fois par thème
        private class FrameImage(val bitmap: Bitmap, val rails: List<IntRange>)

        private val glassCache = mutableMapOf<Int, Pair<String, Bitmap>>()
        private val frameCache = mutableMapOf<Int, Pair<String, Bitmap>>()
        private val frameImages = mutableMapOf<String, FrameImage?>()

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

            // Taille du widget, en dp (portrait : largeur minimale, hauteur maximale ; paysage : l'inverse)
            val options = manager.getAppWidgetOptions(id)
            val density = context.resources.displayMetrics.density
            val landscape = context.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
            val w = max(200, options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH else AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 300)).toFloat()
            val h = max(50, options.getInt(if (landscape) AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT else AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 72)).toFloat()
            val scale = minOf(density, 2.5f) // pixels des images par dp : au-delà, elles pèseraient trop lourd pour un widget
            val width = (w * scale).roundToInt(); val height = (h * scale).roundToInt()

            val theme = state?.theme ?: "glass"
            // le contour (SAVAGE…) se pose par-dessus le thème, quel qu'il soit
            val frameName = state?.frame ?: "none"
            val skin = SKINS[frameName]
            val image = skin?.let { frameImages.getOrPut(frameName) { frameImage(context, frameName, it) } }
            // Place du cadre et de la barre, en dp : le cadre à la hauteur du widget, ses rails allongés s'il est plus
            // large ; réduit d'un bloc et centré s'il est plus étroit
            val bar = RectF(0f, 0f, w, h)
            val frameRect = RectF(0f, 0f, w, h)
            if (skin != null && image != null) {
                var s = h / skin.height
                if (skin.width * s > w || image.rails.isEmpty()) s = minOf(s, w / skin.width)
                val frameW = if (skin.width * s < w && image.rails.isNotEmpty()) w else skin.width * s
                val frameH = skin.height * s
                frameRect.set((w - frameW) / 2, (h - frameH) / 2, (w + frameW) / 2, (h + frameH) / 2)
                bar.set(frameRect.left + skin.barLeft * s, frameRect.top + skin.barTop * s,
                    frameRect.right - (skin.width - skin.barLeft - BAR_WIDTH) * s, frameRect.top + (skin.barTop + BAR_HEIGHT) * s)
            }
            layoutBar(views, bar, w, h, density)

            // le verre et le cadre ne changent qu'avec le morceau, le thème ou la taille : redessinés seulement alors
            val px = { r: RectF -> RectF(r.left * scale, r.top * scale, r.right * scale, r.bottom * scale) }
            val key = listOf(theme, frameName, width, height, state?.coverPath, state?.cover?.generationId, state?.color).joinToString("|")
            val background = glassCache[id]?.takeIf { it.first == key }?.second
                ?: glass(context, width, height, px(bar), state, theme, skin != null, scale).also { glassCache[id] = key to it }
            views.setImageViewBitmap(R.id.background, background)
            if (image != null) {
                val frameKey = "$frameName|$width|$height"
                val frame = frameCache[id]?.takeIf { it.first == frameKey }?.second
                    ?: frameBitmap(image, width, height, px(frameRect)).also { frameCache[id] = frameKey to it }
                views.setImageViewBitmap(R.id.frame, frame)
                views.setViewVisibility(R.id.frame, View.VISIBLE)
            } else {
                views.setViewVisibility(R.id.frame, View.GONE)
            }
            val coverDp = coverSize(bar.height())
            val cover = state?.cover?.let { rounded(it, (coverDp * density).roundToInt(), coverDp * 0.13f * density) }
            if (cover != null) views.setImageViewBitmap(R.id.cover, cover) else views.setImageViewResource(R.id.cover, R.mipmap.ic_launcher)
            return views
        }

        private fun coverSize(barHeight: Float) = (barHeight * 0.74f).coerceIn(32f, 112f)

        // Contenu de la barre à sa taille : marges du cadre, pochette, texte et boutons proportionnés à sa hauteur (comme
        // la barre du bureau : pochette 64 sur 88, boutons autour de la moitié de la hauteur), avec des minimums pour
        // rester lisible et touchable. Android 12 et plus seulement : avant, les tailles du layout restent.
        private fun layoutBar(views: RemoteViews, bar: RectF, w: Float, h: Float, density: Float) {
            val hb = bar.height()
            val padStart = (hb * 0.13f).coerceIn(6f, 16f)
            val padEnd = (hb * 0.08f).coerceIn(4f, 12f)
            fun px(dp: Float) = (dp * density).roundToInt()
            views.setViewPadding(R.id.bar, px(bar.left + padStart), px(bar.top), px(w - bar.right + padEnd), px(h - bar.bottom))
            if (android.os.Build.VERSION.SDK_INT < 31) return
            val dip = android.util.TypedValue.COMPLEX_UNIT_DIP
            val cover = coverSize(hb)
            views.setViewLayoutWidth(R.id.cover, cover, dip)
            views.setViewLayoutHeight(R.id.cover, cover, dip)
            views.setViewLayoutMargin(R.id.body, RemoteViews.MARGIN_START, (hb * 0.14f).coerceIn(8f, 16f), dip)
            val title = (hb * 0.2f).coerceIn(13f, 21f)
            views.setTextViewTextSize(R.id.title, dip, title)
            views.setTextViewTextSize(R.id.artist, dip, title * 0.84f)
            val play = (hb * 0.5f).coerceIn(34f, 60f)
            val side = play * 0.86f
            for (button in intArrayOf(R.id.prev, R.id.next)) {
                views.setViewLayoutWidth(button, side, dip)
                views.setViewLayoutHeight(button, side, dip)
                val pad = px(side * 0.24f)
                views.setViewPadding(button, pad, pad, pad, pad)
            }
            views.setViewLayoutWidth(R.id.play, play, dip)
            views.setViewLayoutHeight(R.id.play, play, dip)
            val pad = px(play * 0.26f)
            views.setViewPadding(R.id.play, pad, pad, pad, pad)
            views.setViewLayoutHeight(R.id.progress, if (hb >= 80) 4f else 3f, dip)
            views.setViewLayoutMargin(R.id.progress, RemoteViews.MARGIN_TOP, (hb * 0.07f).coerceIn(4f, 10f), dip)
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

        // Le cadre de chrome des contours SAVAGE (le même rendu que dans le lecteur, skins/<contour>-frame.png), et ses rails :
        // au-dessus et au-dessous de la barre, dans chaque moitié, la plus longue suite de colonnes où le chrome est le
        // plus mince (un fil en haut, un en bas ; la marge tient compte du relief du chrome texturé). Les pointes qui
        // dépassent sur les côtés ne comptent pas.
        private fun frameImage(context: Context, theme: String, skin: Skin): FrameImage? = try {
            context.assets.open("web/src/renderer/skins/$theme-frame.png").use { input ->
                val bitmap = BitmapFactory.decodeStream(input) ?: return null
                val counts = IntArray(bitmap.width)
                val column = IntArray(bitmap.height)
                for (x in 0 until bitmap.width) {
                    bitmap.getPixels(column, 0, 1, x, 0, 1, bitmap.height)
                    counts[x] = column.count { (it ushr 24) > 40 }
                }
                val k = bitmap.width / skin.width
                val lo = (skin.barLeft * k).roundToInt()
                val hi = ((skin.barLeft + BAR_WIDTH) * k).roundToInt() - 1
                val thinnest = (lo..hi).map { counts[it] }.filter { it > 0 }.minOrNull() ?: return FrameImage(bitmap, emptyList())
                val limit = (thinnest * 1.35f).roundToInt() + 2
                val plain = { x: Int -> counts[x] in 1..limit }
                fun longestRun(from: Int, to: Int): IntRange? {
                    var best: IntRange? = null
                    var start = -1
                    for (x in from..to) {
                        if (plain(x) && start < 0) start = x
                        if ((!plain(x) || x == to) && start >= 0) {
                            val end = if (plain(x)) x else x - 1
                            if (best == null || end - start > best.last - best.first) best = start..end
                            start = -1
                        }
                    }
                    // trop court : on ne l'allonge pas, le cadre est seulement réduit
                    return best?.takeIf { it.last - it.first >= bitmap.width / 40 }
                }
                val mid = (lo + hi) / 2
                FrameImage(bitmap, listOfNotNull(longestRun(lo, mid - 1), longestRun(mid, hi)))
            }
        } catch (_: Exception) {
            null
        }

        // Le cadre posé dans `rect` (pixels du widget) : à l'échelle de sa hauteur, les rails allongés à parts égales pour
        // atteindre la largeur voulue
        private fun frameBitmap(image: FrameImage, width: Int, height: Int, rect: RectF): Bitmap {
            val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(out)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            val src = image.bitmap
            val s = rect.height() / src.height
            val extra = (rect.width() - src.width * s).coerceAtLeast(0f) / max(1, image.rails.size)
            // colonnes du cadre : normales, puis un rail allongé, etc.
            val cuts = mutableListOf(0)
            for (r in image.rails) { cuts += r.first; cuts += r.last + 1 }
            cuts += src.width
            var x = rect.left
            for (i in 0 until cuts.size - 1) {
                val from = cuts[i]; val to = cuts[i + 1]
                if (to <= from) continue
                val stretched = i % 2 == 1 && extra > 0f
                val dw = (to - from) * s + if (stretched) extra else 0f
                // un demi-pixel de recouvrement : pas de fente entre deux morceaux
                canvas.drawBitmap(src, Rect(from, 0, to, src.height), RectF(x, rect.top, x + dw + 0.5f, rect.bottom), paint)
                x += dw
            }
            return out
        }
    }
}
