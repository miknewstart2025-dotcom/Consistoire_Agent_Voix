package com.hotelos.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Drawable
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import androidx.tv.material3.Card
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.hotelos.dpc.core.AppDesiredState
import com.hotelos.dpc.core.EffectivePolicy
import kotlinx.coroutines.delay
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

class HomeActivity : ComponentActivity() {
    private lateinit var link: DeviceLink
    private var guestLanguage by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link = DeviceLink(this).also { it.bind() }
        ControlReceiver.onSignal = { action ->
            when (action) {
                "com.hotelos.action.RESET_SESSION" -> guestLanguage = null
                "com.hotelos.action.REFRESH" -> link.refresh()
                "com.hotelos.action.RESTART" -> recreate()
            }
        }
        setContent {
            val policy by link.policy.collectAsState()
            LaunchedEffect(Unit) {
                while (true) { link.heartbeat(versionCode()); link.refresh(); delay(30_000) }
            }
            BackHandler { /* HOME never exits */ }
            val p = policy
            if (p == null) Starting() else Home(p, guestLanguage ?: p.launcher.language, onLanguage = { guestLanguage = it }, onLaunch = ::launch)
        }
    }

    private fun versionCode() = packageManager.getPackageInfo(packageName, 0).longVersionCode.toInt()

    private fun launch(pkg: String) {
        if (!link.launch(pkg)) android.widget.Toast.makeText(this, I18n.t(guestLanguage ?: "en", "unavailable"), android.widget.Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() { link.unbind(); ControlReceiver.onSignal = null; super.onDestroy() }
}

class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { onSignal?.invoke(intent.action ?: return) }
    companion object { @Volatile var onSignal: ((String) -> Unit)? = null }
}

private fun parseColor(hex: String) = Color(android.graphics.Color.parseColor(hex))

@Composable
private fun Starting() {
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        Text(I18n.t(Locale.getDefault().language, "starting"), color = Color.White, fontSize = 28.sp)
    }
}

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun Home(p: EffectivePolicy, lang: String, onLanguage: (String) -> Unit, onLaunch: (String) -> Unit) {
    val primary = parseColor(p.launcher.branding.primaryColor)
    val accent = parseColor(p.launcher.branding.accentColor)
    val dir = if (lang in I18n.RTL) LayoutDirection.Rtl else LayoutDirection.Ltr
    CompositionLocalProvider(LocalLayoutDirection provides dir) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(primary, Color.Black)))) {
            p.launcher.branding.backgroundUrl?.let { AsyncImage(model = it, contentDescription = null, modifier = Modifier.fillMaxSize(), alpha = 0.35f) }
            Column(Modifier.fillMaxSize().padding(horizontal = 58.dp, vertical = 36.dp)) {
                Header(p, lang, accent)
                Spacer(Modifier.height(24.dp))
                val welcome = p.launcher.welcomeMessage[lang] ?: p.launcher.welcomeMessage.values.firstOrNull()
                val greeting = listOfNotNull(I18n.t(lang, "welcome"), p.launcher.guestFirstName).joinToString(" ")
                Text(greeting, color = Color.White, fontSize = 40.sp, fontWeight = FontWeight.Light)
                if (welcome != null) Text(welcome, color = Color.White.copy(alpha = 0.85f), fontSize = 20.sp, modifier = Modifier.padding(top = 8.dp))
                Spacer(Modifier.weight(1f))
                Text(I18n.t(lang, "apps"), color = accent, fontSize = 18.sp, modifier = Modifier.padding(bottom = 12.dp))
                AppRow(p, onLaunch)
                Spacer(Modifier.height(20.dp))
                LanguageRow(p.launcher.availableLanguages, lang, accent, onLanguage)
            }
        }
    }
}

@Composable
private fun Header(p: EffectivePolicy, lang: String, accent: Color) {
    var now by remember { mutableStateOf(ZonedDateTime.now(ZoneId.of(p.launcher.timezone))) }
    LaunchedEffect(p.launcher.timezone) { while (true) { now = ZonedDateTime.now(ZoneId.of(p.launcher.timezone)); delay(15_000) } }
    val locale = Locale.forLanguageTag(lang)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (p.launcher.branding.logoUrl != null) AsyncImage(model = p.launcher.branding.logoUrl, contentDescription = p.launcher.branding.hotelName, modifier = Modifier.height(56.dp))
        else Text(p.launcher.branding.hotelName, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        Column(horizontalAlignment = Alignment.End) {
            Text(now.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)), color = Color.White, fontSize = 34.sp)
            Text(now.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL).withLocale(locale)), color = Color.White.copy(alpha = 0.8f), fontSize = 15.sp)
            p.launcher.roomNumber?.let { Text("${I18n.t(lang, "room")} $it", color = accent, fontSize = 16.sp) }
        }
    }
}

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun AppRow(p: EffectivePolicy, onLaunch: (String) -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val apps = p.apps.filter { it.state == AppDesiredState.ALLOWED && it.visibleInLauncher }.sortedBy { it.order }
    LazyRow(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        items(apps, key = { it.packageName }) { app ->
            val pm = ctx.packageManager
            val banner: Drawable? = remember(app.packageName) {
                runCatching { pm.getApplicationBanner(app.packageName) ?: pm.getApplicationIcon(app.packageName) }.getOrNull()
            }
            val label = remember(app.packageName) { app.label ?: runCatching { pm.getApplicationLabel(pm.getApplicationInfo(app.packageName, 0)).toString() }.getOrDefault(app.packageName) }
            var focused by remember { mutableStateOf(false) }
            Card(
                onClick = { onLaunch(app.packageName) },
                modifier = Modifier.size(width = 220.dp, height = 124.dp).onFocusChanged { focused = it.isFocused }
                    .scale(if (focused) 1.08f else 1f)
                    .border(if (focused) 3.dp else 0.dp, Color.White, RoundedCornerShape(12.dp)),
            ) {
                Box(Modifier.fillMaxSize().background(Color(0xFF1F2937)), contentAlignment = Alignment.Center) {
                    if (banner != null) Image(banner.toBitmap(320, 180).asImageBitmap(), contentDescription = label, modifier = Modifier.fillMaxSize())
                    else Text(label, color = Color.White, fontSize = 18.sp)
                }
            }
        }
    }
}

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun LanguageRow(langs: List<String>, current: String, accent: Color, onLanguage: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(I18n.t(current, "language"), color = Color.White.copy(alpha = 0.7f), fontSize = 14.sp)
        langs.forEach { l ->
            var focused by remember { mutableStateOf(false) }
            Box(
                Modifier.onFocusChanged { focused = it.isFocused }
                    .background(if (l == current) accent else if (focused) Color.White.copy(alpha = 0.3f) else Color.Transparent, RoundedCornerShape(16.dp))
                    .padding(horizontal = 14.dp, vertical = 6.dp)
                    .clickable { onLanguage(l) },
            ) { Text(I18n.NATIVE_NAMES[l] ?: l, color = Color.White, fontSize = 14.sp) }
        }
    }
}

