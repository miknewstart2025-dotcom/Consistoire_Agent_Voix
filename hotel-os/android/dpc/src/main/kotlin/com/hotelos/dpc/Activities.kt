package com.hotelos.dpc

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.widget.LinearLayout
import android.widget.TextView
import androidx.lifecycle.lifecycleScope
import com.hotelos.dpc.core.AppDesiredState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private fun Activity.text(size: Float, bold: Boolean = false) = TextView(this).apply {
    textSize = size; setTextColor(Color.WHITE); gravity = Gravity.CENTER
    if (bold) typeface = Typeface.DEFAULT_BOLD
}

/**
 * Pairing screen shown until the box is assigned to a room. The technician types the code in the
 * HOTEL OS technician app (or scans the QR – QR rendering added with the PWA, see PROGRESS.md).
 */
class PairingActivity : androidx.activity.ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val c = Controller.get(this)
        val code = text(72f, bold = true)
        val status = text(20f)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setBackgroundColor(Color.rgb(17, 24, 39))
            addView(text(28f).apply { setText("HOTEL OS – appairage / pairing") })
            addView(code)
            addView(status)
        })
        lifecycleScope.launch {
            while (true) {
                if (c.policy?.launcher?.roomNumber != null) { finish(); c.platform.goHome(); return@launch }
                val current = c.prefs.pairingCode ?: c.renewPairingCode()
                code.text = current ?: "…"
                status.text = if (c.prefs.isEnrolled) "Device ${c.prefs.deviceId?.take(8)} – en attente d'affectation à une chambre" else "En attente d'enrôlement (station de provisioning)"
                delay(10_000)
                c.syncNow()
            }
        }
    }
}

/** Minimal built-in HOME used only if HOTEL LAUNCHER is missing or crash-looping. */
class RecoveryHomeActivity : androidx.activity.ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val c = Controller.get(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setBackgroundColor(Color.BLACK) }
        val p = c.policy
        root.addView(text(36f, bold = true).apply { text = p?.launcher?.branding?.hotelName ?: "HOTEL OS" })
        root.addView(text(18f).apply { text = "Service temporairement limité – Temporarily limited service" })
        p?.apps?.filter { it.state == AppDesiredState.ALLOWED && it.visibleInLauncher }?.forEach { app ->
            root.addView(text(24f).apply {
                text = app.label ?: app.packageName
                isFocusable = true
                setPadding(24, 16, 24, 16)
                setOnFocusChangeListener { v, f -> v.setBackgroundColor(if (f) Color.DKGRAY else Color.TRANSPARENT) }
                setOnClickListener {
                    val i = packageManager.getLeanbackLaunchIntentForPackage(app.packageName) ?: packageManager.getLaunchIntentForPackage(app.packageName)
                    if (i != null) startActivity(i)
                }
            })
        }
        setContentView(root)
    }
    @Deprecated("TV back key must not leave HOME")
    override fun onBackPressed() {}
}

/** Message from reception / admin. HIGH priority cannot be dismissed before its duration. */
class MessageActivity : Activity() {
    private var dismissible = true
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val duration = intent.getIntExtra("duration", 30)
        dismissible = !intent.getBooleanExtra("high", false)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(48, 48, 48, 48); setBackgroundColor(Color.rgb(31, 41, 55))
            intent.getStringExtra("title")?.let { t -> addView(text(30f, bold = true).apply { text = t }) }
            addView(text(24f).apply { text = intent.getStringExtra("text") })
        })
        Handler(Looper.getMainLooper()).postDelayed({ finish() }, duration * 1000L)
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (dismissible && (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_DPAD_CENTER)) { finish(); return true }
        return true
    }
    companion object {
        fun intent(ctx: Context, title: String?, text: String, duration: Int, high: Boolean) =
            Intent(ctx, MessageActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("title", title).putExtra("text", text).putExtra("duration", duration).putExtra("high", high)
    }
}
