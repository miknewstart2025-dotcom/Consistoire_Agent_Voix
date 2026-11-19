package com.hotelos.dpc

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.UserManager
import com.hotelos.dpc.core.DevicePlatform
import com.hotelos.dpc.core.InstalledPackage
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.coroutines.resume

/**
 * Production DevicePlatform: thin mapping to DevicePolicyManager / PackageManager.
 * [HW-REQUIRED] Behaviour of each call is firmware-dependent and validated per model by the certification suite.
 */
class AndroidDevicePlatform(private val context: Context) : DevicePlatform {
    private val dpm = context.getSystemService(DevicePolicyManager::class.java)
    private val pm = context.packageManager
    private val admin = HotelDeviceAdminReceiver.component(context)
    private val executor = Executors.newSingleThreadExecutor()

    override val ownPackage: String = context.packageName
    override fun isDeviceOwner() = dpm.isDeviceOwnerApp(context.packageName)

    override fun installedPackages(): List<InstalledPackage> {
        val launchable = buildSet {
            for (cat in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)) {
                pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(cat), PackageManager.MATCH_DISABLED_COMPONENTS)
                    .forEach { add(it.activityInfo.packageName) }
            }
        }
        val flags = PackageManager.MATCH_UNINSTALLED_PACKAGES or PackageManager.GET_SIGNING_CERTIFICATES
        return pm.getInstalledPackages(flags).map { pi ->
            val ai = pi.applicationInfo!!
            InstalledPackage(
                packageName = pi.packageName,
                label = runCatching { ai.loadLabel(pm).toString() }.getOrNull(),
                versionCode = pi.longVersionCode,
                versionName = pi.versionName,
                system = ai.flags and ApplicationInfo.FLAG_SYSTEM != 0,
                enabled = ai.enabled,
                suspended = isPackageSuspended(pi.packageName) ?: false,
                hidden = dpm.isApplicationHidden(admin, pi.packageName),
                hasLauncherEntry = pi.packageName in launchable,
                signerSha256 = pi.signingInfo?.apkContentsSigners?.firstOrNull()?.let { sha256(it.toByteArray()) },
            )
        }
    }

    override fun setPackagesSuspended(packages: List<String>, suspended: Boolean): List<String> =
        runCatching { dpm.setPackagesSuspended(admin, packages.toTypedArray(), suspended).toList() }.getOrElse { packages }

    override fun isPackageSuspended(pkg: String): Boolean? =
        runCatching { dpm.isPackageSuspended(admin, pkg) }.getOrNull()

    override fun setApplicationHidden(pkg: String, hidden: Boolean) =
        runCatching { dpm.setApplicationHidden(admin, pkg, hidden) }.getOrDefault(false)

    override fun isApplicationHidden(pkg: String) = runCatching { dpm.isApplicationHidden(admin, pkg) }.getOrDefault(false)
    override fun setUninstallBlocked(pkg: String, blocked: Boolean) { runCatching { dpm.setUninstallBlocked(admin, pkg, blocked) } }

    override fun activeUserRestrictions(): Set<String> =
        dpm.getUserRestrictions(admin).keySet().filter { dpm.getUserRestrictions(admin).getBoolean(it) }.toSet()

    override fun setUserRestriction(key: String, enabled: Boolean) {
        if (enabled) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
    }

    override fun setPersistentHome(launcherPackage: String): Boolean {
        val home = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
            .firstOrNull { it.activityInfo.packageName == launcherPackage } ?: return false
        val filter = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        return runCatching {
            dpm.clearPackagePersistentPreferredActivities(admin, launcherPackage)
            dpm.addPersistentPreferredActivity(admin, filter, ComponentName(launcherPackage, home.activityInfo.name))
        }.isSuccess
    }

    fun setRecoveryHome() {
        val filter = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
        dpm.addPersistentPreferredActivity(admin, filter, ComponentName(context, RecoveryHomeActivity::class.java))
    }

    override fun clearPersistentHome() { dpm.clearPackagePersistentPreferredActivities(admin, context.packageName) }

    override fun currentHomePackage(): String? =
        pm.resolveActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName

    override fun setLockTaskPackages(packages: List<String>) {
        dpm.setLockTaskPackages(admin, (packages + context.packageName).distinct().toTypedArray())
        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
    }

    override fun setStatusBarDisabled(disabled: Boolean) = runCatching { dpm.setStatusBarDisabled(admin, disabled) }.getOrDefault(false)
    override fun setKeyguardDisabled(disabled: Boolean) = runCatching { dpm.setKeyguardDisabled(admin, disabled) }.getOrDefault(false)
    override fun setScreenCaptureDisabled(disabled: Boolean) { dpm.setScreenCaptureDisabled(admin, disabled) }
    override fun setTimeZone(tz: String) = runCatching { dpm.setTimeZone(admin, tz) }.getOrDefault(false)

    override fun setAutoTime(enabled: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) dpm.setAutoTimeEnabled(admin, enabled) else @Suppress("DEPRECATION") dpm.setAutoTimeRequired(admin, enabled)
    }

    override suspend fun clearApplicationUserData(pkg: String): Result<Unit> = suspendCancellableCoroutine { cont ->
        try {
            dpm.clearApplicationUserData(admin, pkg, executor) { _, succeeded ->
                cont.resume(if (succeeded) Result.success(Unit) else Result.failure(IllegalStateException("clearApplicationUserData refused for $pkg")))
            }
        } catch (e: SecurityException) {
            cont.resume(Result.failure(e))
        }
    }

    override suspend fun requestSessionReset(pkg: String): Result<Unit> {
        // First-party apps expose a signature-protected receiver; the broadcast is explicit (package-scoped).
        context.sendBroadcast(Intent(ACTION_RESET_SESSION).setPackage(pkg), PERMISSION_DEVICE_SERVICE)
        return Result.success(Unit)
    }

    override fun goHome() {
        context.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun reboot() = dpm.reboot(admin)

    fun hasRestriction(key: String) = context.getSystemService(UserManager::class.java).hasUserRestriction(key)

    companion object {
        const val ACTION_RESET_SESSION = "com.hotelos.action.RESET_SESSION"
        const val PERMISSION_DEVICE_SERVICE = "com.hotelos.permission.DEVICE_SERVICE"
        fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
