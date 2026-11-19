package com.hotelos.dpc

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.admin.DeviceAdminReceiver
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.hotelos.dpc.core.AppDesiredState
import com.hotelos.dpc.core.EffectivePolicy
import com.hotelos.dpc.core.ProtocolJson

class HotelOsControllerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ControllerService.start(this)
    }
}

class HotelDeviceAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) { ControllerService.start(context) }
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) { ControllerService.start(context) }
    companion object { fun component(ctx: Context) = ComponentName(ctx, HotelDeviceAdminReceiver::class.java) }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { ControllerService.start(context) }
}

/**
 * Receives server URL + enrollment token from the provisioning station over ADB:
 *   adb shell am broadcast -a com.hotelos.dpc.CONFIGURE -n com.hotelos.dpc/.ProvisioningConfigReceiver \
 *       --es serverUrl https://api.example.com --es enrollmentToken <token>
 * Only accepted while not enrolled. Sender restricted to shell/system by the DUMP permission.
 */
class ProvisioningConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = ControllerPrefs(context)
        if (prefs.isEnrolled) { resultCode = 409; resultData = "already enrolled"; return }
        val url = intent.getStringExtra("serverUrl")
        val token = intent.getStringExtra("enrollmentToken")
        if (url == null || !url.startsWith("https://") && !url.startsWith("http://10.") && !url.startsWith("http://192.168.")) {
            resultCode = 400; resultData = "serverUrl must be https"; return
        }
        if (token == null || token.length < 16) { resultCode = 400; resultData = "enrollmentToken missing"; return }
        prefs.serverUrl = url
        prefs.enrollmentToken = token
        resultCode = 200; resultData = "configured"
        ControllerService.start(context)
    }
}

/** Keeps the controller alive (foreground). Notifications are not visible on most TV launchers. */
class ControllerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("controller", "HOTEL OS", NotificationManager.IMPORTANCE_MIN))
        val n = Notification.Builder(this, "controller").setContentTitle("HOTEL OS").setSmallIcon(android.R.drawable.stat_notify_sync).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, n)
        detectCrashLoop()
        Controller.get(this).start()
        return START_STICKY
    }

    /** If the controller itself restarted 5 times in 10 minutes, log loudly (reported via diagnostics). */
    private fun detectCrashLoop() {
        val prefs = ControllerPrefs(this)
        val now = System.currentTimeMillis()
        val starts = (prefs.recentStarts.split(',').mapNotNull { it.toLongOrNull() } + now).filter { now - it < 600_000 }
        prefs.recentStarts = starts.joinToString(",")
        if (starts.size >= 5) Log.e("HotelOsController", "controller crash-loop detected (${starts.size} starts in 10 min)")
    }

    companion object {
        fun start(ctx: Context) {
            val i = Intent(ctx, ControllerService::class.java)
            runCatching { ctx.startForegroundService(i) }.onFailure { Log.e("HotelOsController", "cannot start service", it) }
        }
    }
}

/** AIDL endpoint for HOTEL LAUNCHER / HOTEL IPTV (signature permission enforced in the manifest). */
class DeviceIpcService : Service() {
    private val binder = object : IHotelDevice.Stub() {
        private fun controller() = Controller.get(this@DeviceIpcService)
        override fun getPolicyJson(): String? = controller().policy?.let { ProtocolJson.encodeToString(EffectivePolicy.serializer(), it) }
        override fun getDelegatedToken(): String? = controller().delegatedToken()
        override fun getApiBaseUrl(): String? = controller().prefs.serverUrl
        override fun heartbeat(packageName: String, versionCode: Int) {
            if (packageName == controller().policy?.kiosk?.launcherPackage) controller().lastLauncherHeartbeat = SystemClock.elapsedRealtime()
        }
        override fun launchAllowedApp(packageName: String): Boolean {
            val c = controller()
            val allowed = c.policy?.apps?.any { it.packageName == packageName && it.state == AppDesiredState.ALLOWED } == true
            if (!allowed) return false
            val pm = packageManager
            val i = pm.getLeanbackLaunchIntentForPackage(packageName) ?: pm.getLaunchIntentForPackage(packageName) ?: return false
            startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return true
        }
    }
    override fun onBind(intent: Intent?): IBinder = binder
}
