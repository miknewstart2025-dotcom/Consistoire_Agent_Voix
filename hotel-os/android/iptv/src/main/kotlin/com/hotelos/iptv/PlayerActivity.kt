package com.hotelos.iptv

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Color
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.hotelos.dpc.IHotelDevice
import com.hotelos.iptv.core.Channel
import com.hotelos.iptv.core.EpgIndex
import com.hotelos.iptv.core.EpgWindow
import com.hotelos.iptv.core.Favourites
import com.hotelos.iptv.core.IptvJson
import com.hotelos.iptv.core.Lineup
import com.hotelos.iptv.core.NumberEntry
import com.hotelos.iptv.core.StreamRetry
import com.hotelos.iptv.core.Zapper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.time.Instant

/**
 * HOTEL IPTV player. Lineup/EPG come from the HOTEL OS API (normalised server-side) using the
 * controller's delegated token; both are cached for offline use. [HW-REQUIRED] stream playback
 * (HLS/DASH/UDP multicast) must be validated on each certified box and hotel network.
 */
class PlayerActivity : ComponentActivity() {
    private lateinit var player: ExoPlayer
    private lateinit var osd: TextView
    private lateinit var numberView: TextView
    private var zapper = Zapper(emptyList())
    private var epg: EpgIndex? = null
    private val numbers = NumberEntry()
    private var numberJob: Job? = null
    private var osdJob: Job? = null
    private var retryJob: Job? = null
    private var attempt = 0
    private var device: IHotelDevice? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private val http = OkHttpClient()
    private val cacheLineup by lazy { File(filesDir, "lineup.json") }
    private val cacheEpg by lazy { File(filesDir, "epg.json") }

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(n: ComponentName?, b: IBinder?) { device = IHotelDevice.Stub.asInterface(b); refreshData() }
        override fun onServiceDisconnected(n: ComponentName?) { device = null }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        player = ExoPlayer.Builder(this).build()
        val view = PlayerView(this).apply { player = this@PlayerActivity.player; useController = false; setBackgroundColor(Color.BLACK) }
        osd = TextView(this).apply { setTextColor(Color.WHITE); textSize = 22f; setBackgroundColor(0xAA000000.toInt()); setPadding(32, 20, 32, 20) }
        numberView = TextView(this).apply { setTextColor(Color.WHITE); textSize = 48f; setPadding(32, 32, 32, 32) }
        setContentView(FrameLayout(this).apply {
            addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(osd, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            addView(numberView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END))
        })
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) = onStreamError(error)
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_READY) attempt = 0 }
        })
        multicastLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).createMulticastLock("hotelos-iptv").apply { setReferenceCounted(false); acquire() }
        loadCache()
        bindService(Intent("com.hotelos.dpc.BIND").setPackage("com.hotelos.dpc"), conn, Context.BIND_AUTO_CREATE)
        SessionResetReceiver.onReset = { favourites.clear(); getSharedPreferences("session", MODE_PRIVATE).edit().clear().apply() }
    }

    private fun loadCache() {
        runCatching { setLineup(IptvJson.decodeFromString(Lineup.serializer(), cacheLineup.readText())) }
        runCatching { epg = EpgIndex(IptvJson.decodeFromString(EpgWindow.serializer(), cacheEpg.readText())) }
    }

    private fun setLineup(l: Lineup) {
        val currentId = zapper.current?.id
        zapper = Zapper(l.channels)
        val last = currentId ?: getSharedPreferences("session", MODE_PRIVATE).getString("lastChannel", null)
        last?.let { zapper.select(it) }
        if (player.currentMediaItem == null) zapper.current?.let { play(it) }
    }

    private fun refreshData() = lifecycleScope.launch {
        val d = device ?: return@launch
        val base = runCatching { d.apiBaseUrl }.getOrNull() ?: return@launch
        val token = runCatching { d.delegatedToken }.getOrNull() ?: return@launch
        suspend fun get(path: String): String? = withContext(Dispatchers.IO) {
            runCatching {
                http.newCall(Request.Builder().url(base.trimEnd('/') + path).header("Authorization", "Bearer $token").build()).execute().use { r ->
                    if (r.isSuccessful) r.body?.string() else null
                }
            }.getOrNull()
        }
        get("/device/v1/iptv/lineup")?.let { json -> runCatching { setLineup(IptvJson.decodeFromString(Lineup.serializer(), json)); cacheLineup.writeText(json) } }
        get("/device/v1/iptv/epg?hours=24")?.let { json -> runCatching { epg = EpgIndex(IptvJson.decodeFromString(EpgWindow.serializer(), json)); cacheEpg.writeText(json) } }
        if (zapper.channels.isEmpty()) showOsd("Aucune chaîne disponible / No channels available")
    }

    private fun play(c: Channel) {
        retryJob?.cancel()
        player.setMediaItem(MediaItem.fromUri(Uri.parse(c.streamUrl)))
        player.prepare()
        player.playWhenReady = true
        getSharedPreferences("session", MODE_PRIVATE).edit().putString("lastChannel", c.id).apply()
        showOsd(osdText(c))
    }

    private fun osdText(c: Channel): String {
        val (now, next) = epg?.nowNext(c.epgId, Instant.now()) ?: (null to null)
        val fav = if (favourites.contains(c.id)) " ★" else ""
        return buildString {
            append("${c.number}  ${c.name}$fav")
            now?.let { append("\n▶ ${it.title}") }
            next?.let { append("\n⏭ ${it.title}") }
        }
    }

    private fun showOsd(text: String) {
        osd.text = text; osd.visibility = android.view.View.VISIBLE
        osdJob?.cancel()
        osdJob = lifecycleScope.launch { delay(5000); osd.visibility = android.view.View.GONE }
    }

    private fun onStreamError(e: PlaybackException) {
        val c = zapper.current ?: return
        val wait = StreamRetry.delayMs(attempt++)
        if (wait == null) { showOsd("${c.number} ${c.name}\nChaîne indisponible / Channel unavailable"); return }
        retryJob = lifecycleScope.launch { delay(wait); if (zapper.current?.id == c.id) { player.prepare(); player.playWhenReady = true } }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP -> { zapper.next()?.let { attempt = 0; play(it) }; return true }
            KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> { zapper.previous()?.let { attempt = 0; play(it) }; return true }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_INFO -> { zapper.current?.let { showOsd(osdText(it)) }; return true }
            KeyEvent.KEYCODE_PROG_YELLOW, KeyEvent.KEYCODE_BOOKMARK -> { zapper.current?.let { favourites.toggle(it.id); showOsd(osdText(it)) }; return true }
        }
        if (keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
            numberView.text = numbers.digit(keyCode - KeyEvent.KEYCODE_0)
            numberJob?.cancel()
            numberJob = lifecycleScope.launch {
                delay(1500)
                numberView.text = ""
                numbers.commit()?.let { n -> zapper.tune(n)?.let { attempt = 0; play(it) } }
            }
            return true
        }
        return super.onKeyDown(keyCode, event) // BACK leaves to HOTEL LAUNCHER
    }

    override fun onStop() { super.onStop(); player.pause() }
    override fun onStart() { super.onStart(); if (player.currentMediaItem != null) player.play() }
    override fun onDestroy() {
        runCatching { unbindService(conn) }
        multicastLock?.release()
        player.release()
        SessionResetReceiver.onReset = null
        super.onDestroy()
    }

    companion object { val favourites = Favourites() }
}

class SessionResetReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        PlayerActivity.favourites.clear()
        context.getSharedPreferences("session", Context.MODE_PRIVATE).edit().clear().apply()
        onReset?.invoke()
    }
    companion object { @Volatile var onReset: (() -> Unit)? = null }
}
