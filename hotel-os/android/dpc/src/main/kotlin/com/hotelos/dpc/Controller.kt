package com.hotelos.dpc

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import com.hotelos.dpc.core.CleanupEngine
import com.hotelos.dpc.core.CleanupReport
import com.hotelos.dpc.core.CommandExecutor
import com.hotelos.dpc.core.CommandHandlers
import com.hotelos.dpc.core.CommandResult
import com.hotelos.dpc.core.DeviceStateReport
import com.hotelos.dpc.core.EffectivePolicy
import com.hotelos.dpc.core.EnrollRequest
import com.hotelos.dpc.core.HardwareInfo
import com.hotelos.dpc.core.InMemoryCommandJournal
import com.hotelos.dpc.core.NetworkInfo
import com.hotelos.dpc.core.PolicyStore
import com.hotelos.dpc.core.PolicyVerifier
import com.hotelos.dpc.core.ReconcileReport
import com.hotelos.dpc.core.Reconciler
import com.hotelos.dpc.core.VerifyResult
import com.hotelos.dpc.core.WsClientMessage
import com.hotelos.dpc.core.WsServerMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/**
 * Orchestrates the controller: enrollment, policy sync + verification + reconciliation,
 * command execution, state reporting, launcher watchdog. Single instance per process.
 */
class Controller private constructor(private val ctx: Context) {
    private val tag = "HotelOsController"
    val prefs = ControllerPrefs(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).build()
    val identity = KeystoreIdentity()
    val platform = AndroidDevicePlatform(ctx)
    private val api = ApiClient(http, { prefs.serverUrl ?: error("server not configured") }, { prefs.deviceId }, identity)
    private val reconciler = Reconciler(platform, ApkInstaller(ctx, http)) { Log.i(tag, it) }
    private val store = PolicyStore(File(ctx.filesDir, "policy.json"))
    private val journal = InMemoryCommandJournal()
    private val syncLock = Mutex()
    @Volatile var policy: EffectivePolicy? = null
        private set
    @Volatile private var lastReport: ReconcileReport? = null
    @Volatile var lastLauncherHeartbeat = 0L
    private val executor by lazy { CommandExecutor(platform, Handlers(), CleanupEngine(platform), journal, { policy }) }
    private val ws = WsClient(http, scope, { prefs.wsUrl }, { api.token() }, { send -> send(WsClientMessage.Hello(policy?.version ?: 0)) }, ::onWs)
    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch {
            if (!platform.isDeviceOwner()) { Log.e(tag, "not Device Owner – see docs/PROVISIONING.md"); return@launch }
            if (!prefs.isEnrolled) enrollLoop()
            verifier()?.let { v -> store.load(v)?.let { policy = it; reconcile(it) } } // offline-first: last valid policy
            if (prefs.isEnrolled && policy?.launcher?.roomNumber == null) showPairing()
            ws.start()
            launch { periodicSync() }
            launch { heartbeatLoop() }
            launch { watchdogLoop() }
        }
    }

    private fun verifier(): PolicyVerifier? {
        val id = prefs.deviceId ?: return null
        val keys = prefs.policyKeys
        return if (keys.isEmpty()) null else PolicyVerifier(keys, id)
    }

    private suspend fun enrollLoop() {
        while (!prefs.isEnrolled) {
            val token = prefs.enrollmentToken
            if (token == null || prefs.serverUrl == null) { delay(30_000); continue }
            try {
                val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }
                identity.ensureKey(challenge)
                val res = api.enroll(EnrollRequest(token, identity.publicKeySpkiBase64(), identity.attestationChain(), hardware(), BuildConfig.VERSION_CODE, platform.isDeviceOwner()))
                prefs.deviceId = res.deviceId
                prefs.wsUrl = res.wsUrl
                prefs.policyKeys = res.policyPublicKeys
                prefs.pairingCode = res.pairingCode
                prefs.enrollmentToken = null
                Log.i(tag, "enrolled as ${res.deviceId}")
            } catch (e: ApiException) {
                Log.e(tag, "enrollment refused: ${e.message}")
                if (e.code in listOf(403, 410)) prefs.enrollmentToken = null // token invalid: needs a new provisioning
                delay(60_000)
            } catch (e: Exception) {
                Log.w(tag, "enrollment failed, retrying", e); delay(30_000)
            }
        }
    }

    /** Fetch → verify → persist → reconcile → report. Safe to call concurrently (serialized). */
    suspend fun syncNow() = syncLock.withLock {
        if (!prefs.isEnrolled) return@withLock
        val v = verifier() ?: return@withLock
        runCatching { api.policy(policy?.version ?: 0) }
            .onSuccess { signed ->
                if (signed != null) when (val r = v.verify(signed, policy?.version ?: 0)) {
                    is VerifyResult.Valid -> { store.save(r.signed); policy = r.policy; reconcile(r.policy) }
                    is VerifyResult.Rejected -> Log.e(tag, "policy rejected: ${r.reason}")
                }
            }
            .onFailure { Log.w(tag, "policy fetch failed (offline? keeping last valid policy)", it) }
        runCatching { api.commands().forEach { runCommand(it) } }
        reportState()
    }

    private suspend fun reconcile(p: EffectivePolicy) {
        reconciler.setMaintenance(prefs.maintenanceUntil > System.currentTimeMillis())
        lastReport = reconciler.reconcile(p)
        if (p.launcher.roomNumber != null) prefs.pairingCode = null
    }

    private suspend fun reportState() {
        val p = policy ?: return
        val r = lastReport ?: reconciler.reconcile(p).also { lastReport = it }
        val pm = ctx.packageManager
        fun ver(pkg: String) = runCatching { pm.getPackageInfo(pkg, 0).longVersionCode.toInt() }.getOrNull()
        val stat = StatFs(Environment.getDataDirectory().path)
        val mem = ActivityManager.MemoryInfo().also { ctx.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }
        runCatching {
            api.state(
                DeviceStateReport(
                    policyVersionApplied = r.policyVersion,
                    reconcileErrors = r.errors,
                    isDeviceOwner = platform.isDeviceOwner(),
                    kioskActive = r.kioskActive,
                    launcherHealthy = launcherHealthy(),
                    dpcVersionCode = BuildConfig.VERSION_CODE,
                    launcherVersionCode = ver(p.kiosk.launcherPackage),
                    iptvVersionCode = ver("com.hotelos.iptv"),
                    apps = r.observed,
                    inventoryIsDelta = false,
                    storageFreeMb = (stat.availableBytes / 1_048_576).toInt(),
                    ramFreeMb = (mem.availMem / 1_048_576).toInt(),
                    uptimeSec = (SystemClock.elapsedRealtime() / 1000).toInt(),
                    network = network(),
                    buildFingerprint = Build.FINGERPRINT,
                ),
            )
        }.onFailure { Log.w(tag, "state report failed", it) }
    }

    private suspend fun runCommand(c: com.hotelos.dpc.core.DeviceCommand) {
        ws.send(WsClientMessage.CommandUpdate(c.id, CommandResult("ACKED")))
        val result = executor.execute(c) ?: return
        if (!ws.send(WsClientMessage.CommandUpdate(c.id, result))) runCatching { api.commandResult(c.id, result) }
    }

    private suspend fun onWs(m: WsServerMessage) {
        when (m) {
            is WsServerMessage.PolicyChanged -> if (m.version != policy?.version) syncNow()
            is WsServerMessage.Command -> runCommand(m.command)
            is WsServerMessage.Welcome -> if (m.latestPolicyVersion != policy?.version) syncNow()
            is WsServerMessage.Error -> Log.w(tag, "server: ${m.code} ${m.message}")
        }
    }

    private suspend fun periodicSync() {
        while (scope.isActive) {
            syncNow()
            delay(((policy?.system?.telemetryIntervalSec ?: 300) * 1000L))
        }
    }

    private suspend fun heartbeatLoop() {
        while (scope.isActive) { ws.send(WsClientMessage.Heartbeat); delay(60_000) }
    }

    fun launcherHealthy() = SystemClock.elapsedRealtime() - lastLauncherHeartbeat < 120_000

    /**
     * Launcher watchdog: if no heartbeat for 2 min, bring HOME to front; after 3 failed restarts
     * in 10 min, switch HOME to the built-in recovery launcher and report it.
     */
    private suspend fun watchdogLoop() {
        val failures = ArrayDeque<Long>()
        delay(120_000)
        while (scope.isActive) {
            delay(60_000)
            val p = policy ?: continue
            if (launcherHealthy() || prefs.maintenanceUntil > System.currentTimeMillis()) continue
            val now = SystemClock.elapsedRealtime()
            failures.addLast(now)
            while (failures.isNotEmpty() && now - failures.first() > 600_000) failures.removeFirst()
            if (failures.size >= 3) {
                Log.e(tag, "launcher crash-loop: switching to recovery home")
                platform.setRecoveryHome()
                platform.goHome()
            } else {
                platform.setPersistentHome(p.kiosk.launcherPackage)
                platform.goHome()
            }
        }
    }

    fun showPairing() {
        ctx.startActivity(Intent(ctx, PairingActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    suspend fun renewPairingCode(): String? = runCatching { api.pairingCode().pairingCode }.getOrNull()?.also { prefs.pairingCode = it }

    fun delegatedToken(): String? = if (prefs.isEnrolled) runCatching { api.token() }.getOrNull() else null

    private fun hardware() = HardwareInfo(
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        brand = Build.BRAND,
        buildFingerprint = Build.FINGERPRINT,
        sdkInt = Build.VERSION.SDK_INT,
        androidRelease = Build.VERSION.RELEASE,
        supportedAbis = Build.SUPPORTED_ABIS.toList(),
        serial = runCatching { Build.getSerial() }.getOrNull(), // allowed for Device Owner
        androidId = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID),
        ramMb = (ActivityManager.MemoryInfo().also { ctx.getSystemService(ActivityManager::class.java).getMemoryInfo(it) }.totalMem / 1_048_576).toInt(),
        storageTotalMb = (StatFs(Environment.getDataDirectory().path).totalBytes / 1_048_576).toInt(),
    )

    private fun network(): NetworkInfo {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val type = when {
            caps == null -> "NONE"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            else -> "OTHER"
        }
        val ip = cm.getLinkProperties(cm.activeNetwork)?.linkAddresses?.firstOrNull { it.address is java.net.Inet4Address }?.address?.hostAddress
        return NetworkInfo(type, ip = ip)
    }

    private inner class Handlers : CommandHandlers {
        override suspend fun syncNow() = this@Controller.syncNow()
        override suspend fun restartLauncher(): Result<Unit> = runCatching {
            val pkg = policy?.kiosk?.launcherPackage ?: error("no policy")
            ctx.sendBroadcast(Intent("com.hotelos.action.RESTART").setPackage(pkg), AndroidDevicePlatform.PERMISSION_DEVICE_SERVICE)
            platform.goHome()
        }
        override suspend fun refreshUi(): Result<Unit> = runCatching {
            val pkg = policy?.kiosk?.launcherPackage ?: error("no policy")
            ctx.sendBroadcast(Intent("com.hotelos.action.REFRESH").setPackage(pkg), AndroidDevicePlatform.PERMISSION_DEVICE_SERVICE)
        }
        override suspend fun launchApp(packageName: String): Result<Unit> = runCatching {
            val i = ctx.packageManager.getLeanbackLaunchIntentForPackage(packageName) ?: ctx.packageManager.getLaunchIntentForPackage(packageName) ?: error("no launch intent for $packageName")
            ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        override suspend fun showMessage(title: String?, text: String, durationSec: Int, highPriority: Boolean): Result<Unit> = runCatching {
            ctx.startActivity(MessageActivity.intent(ctx, title, text, durationSec, highPriority))
        }
        override suspend fun uploadLogs(minutes: Int): Result<Unit> =
            Result.failure(UnsupportedOperationException("NOT_IMPLEMENTED: log upload endpoint not available yet (Phase 7)"))
        override suspend fun diagnostics(): JsonObject = buildJsonObject {
            put("deviceOwner", platform.isDeviceOwner())
            put("home", platform.currentHomePackage())
            put("launcherHealthy", launcherHealthy())
            put("policyVersion", policy?.version ?: 0)
            put("wsConnected", ws.connected)
            put("network", network().type)
            put("fingerprint", Build.FINGERPRINT)
        }
        override suspend fun reportCleanup(jobId: String, report: CleanupReport): Result<Unit> = runCatching { api.cleanupReport(jobId, report) }
    }

    companion object {
        @Volatile private var instance: Controller? = null
        fun get(ctx: Context) = instance ?: synchronized(this) { instance ?: Controller(ctx.applicationContext).also { instance = it } }
    }
}
