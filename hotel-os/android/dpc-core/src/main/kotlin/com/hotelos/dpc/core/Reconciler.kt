package com.hotelos.dpc.core

object MaintenanceWindows {
    /** Window "HH:MM"–"HH:MM" in the hotel time zone; may wrap past midnight (e.g. 23:00–05:00). */
    fun isOpen(w: MaintenanceWindow, tz: String, at: java.time.Instant): Boolean {
        val zone = runCatching { java.time.ZoneId.of(tz) }.getOrDefault(java.time.ZoneOffset.UTC)
        val t = at.atZone(zone).toLocalTime()
        val start = java.time.LocalTime.parse(w.start)
        val end = java.time.LocalTime.parse(w.end)
        return if (start <= end) !t.isBefore(start) && t.isBefore(end) else !t.isBefore(start) || t.isBefore(end)
    }
}

/** Outcome of one reconciliation pass. */
data class ReconcileReport(
    val policyVersion: Int,
    val errors: List<ReconcileError>,
    val actions: List<String>,
    val kioskActive: Boolean,
    val observed: List<ObservedApp>,
)

/**
 * Idempotent desired-state → actual-state loop. Runs at boot, on every new policy and periodically.
 * Order matters and is chosen so the device is never left without a working home screen:
 *   1. our launcher installed/updated first, 2. persistent HOME set, 3. only then stock launcher blocked.
 */
class Reconciler(
    private val platform: DevicePlatform,
    private val installer: PackageInstallerPort?,
    private val log: (String) -> Unit = {},
    private val now: () -> java.time.Instant = java.time.Instant::now,
) {
    private var maintenance = false

    /** Maintenance mode (technician session): kiosk loosened, nothing uninstalled or wiped. */
    fun setMaintenance(on: Boolean) { maintenance = on }

    suspend fun reconcile(policy: EffectivePolicy): ReconcileReport {
        val errors = mutableListOf<ReconcileError>()
        val actions = mutableListOf<String>()
        fun err(key: String, msg: String) { errors += ReconcileError(key, msg); log("reconcile error $key: $msg") }

        if (!platform.isDeviceOwner()) {
            err("deviceOwner", "HOTEL DEVICE CONTROLLER is not Device Owner – nothing can be enforced")
            return ReconcileReport(policy.version, errors, actions, false, observe(emptyMap(), emptyMap()))
        }

        val canSuspend = mutableMapOf<String, Boolean>()
        val canHide = mutableMapOf<String, Boolean>()
        val protectedPkgs = PROTECTED_PACKAGES + platform.ownPackage + policy.kiosk.launcherPackage

        // ---- 1. restrictions
        val desired = policy.restrictions.toSet() - (if (maintenance) Restrictions.LIFTED_IN_MAINTENANCE else emptySet())
        val active = platform.activeUserRestrictions()
        for (r in Restrictions.MANAGED) {
            val want = r in desired
            if (want != (r in active)) {
                platform.setUserRestriction(r, want)
                actions += "restriction $r=$want"
            }
        }
        for (r in policy.restrictions) if (r !in Restrictions.MANAGED) err("restrictions.$r", "unknown restriction ignored")

        // ---- 2. first-party / catalog installs (launcher first)
        var installed = platform.installedPackages().associateBy { it.packageName }
        val toInstall = policy.apps
            .filter { it.state == AppDesiredState.ALLOWED && it.artifact != null }
            .filter { a -> installed[a.packageName].let { it == null || it.versionCode < a.artifact!!.versionCode } }
            .sortedByDescending { it.packageName == policy.kiosk.launcherPackage }
        val inWindow = MaintenanceWindows.isOpen(policy.system.maintenanceWindow, policy.system.timezone, now())
        for (a in toInstall) {
            if (installer == null) { err("apps.${a.packageName}", "installer unavailable"); continue }
            val isUpdate = installed.containsKey(a.packageName)
            // Never update an app under the guest's feet: wait for the maintenance window (first installs are immediate).
            if (isUpdate && a.artifact!!.updateWindow == "MAINTENANCE" && !inWindow && a.packageName != policy.kiosk.launcherPackage) {
                actions += "deferred update ${a.packageName}@${a.artifact.versionCode} until maintenance window"
                continue
            }
            installer.installOrUpdate(a.packageName, a.artifact!!)
                .onSuccess { actions += "installed ${a.packageName}@${a.artifact.versionCode}" }
                .onFailure { err("apps.${a.packageName}.install", it.message ?: "install failed") }
        }
        if (toInstall.isNotEmpty()) installed = platform.installedPackages().associateBy { it.packageName }

        // ---- 3. kiosk
        var kioskActive = false
        val launcherPresent = installed.containsKey(policy.kiosk.launcherPackage)
        if (!launcherPresent) {
            err("kiosk.launcher", "${policy.kiosk.launcherPackage} not installed – recovery home stays active")
        } else if (platform.setPersistentHome(policy.kiosk.launcherPackage)) {
            kioskActive = platform.currentHomePackage() == policy.kiosk.launcherPackage
            if (!kioskActive) err("kiosk.home", "persistent HOME accepted but not effective on this firmware")
        } else {
            err("kiosk.home", "persistent HOME refused by the system")
        }
        if (!maintenance) {
            if (!platform.setStatusBarDisabled(true)) actions += "status bar disable not supported"
            platform.setKeyguardDisabled(true)
        } else {
            platform.setStatusBarDisabled(false)
        }
        val allowedPkgs = policy.apps.filter { it.state == AppDesiredState.ALLOWED }.map { it.packageName }
        if (policy.kiosk.mode == KioskMode.STRICT_LOCK_TASK && !maintenance) {
            platform.setLockTaskPackages((listOf(policy.kiosk.launcherPackage) + allowedPkgs + policy.kiosk.lockTaskExtraPackages).distinct())
        } else {
            platform.setLockTaskPackages(emptyList())
        }

        // ---- 4. app states
        val listed = policy.apps.associateBy { it.packageName }
        for (a in policy.apps) {
            if (a.packageName in protectedPkgs) continue
            val pkg = installed[a.packageName] ?: continue
            when (a.state) {
                AppDesiredState.ALLOWED -> {
                    if (pkg.hidden) setHidden(a.packageName, false, canHide, ::err, actions)
                    if (pkg.suspended) setSuspended(a.packageName, false, canSuspend, ::err, actions)
                    if (a.artifact != null) platform.setUninstallBlocked(a.packageName, true)
                }
                AppDesiredState.SUSPENDED -> {
                    if (!setSuspended(a.packageName, true, canSuspend, ::err, actions)) {
                        // Fallback: hide when suspension is refused for this package.
                        setHidden(a.packageName, true, canHide, ::err, actions)
                    }
                }
                AppDesiredState.HIDDEN -> setHidden(a.packageName, true, canHide, ::err, actions)
                AppDesiredState.UNINSTALLED -> {
                    if (maintenance) continue
                    if (pkg.system) {
                        setHidden(a.packageName, true, canHide, ::err, actions)
                    } else if (installer == null) {
                        err("apps.${a.packageName}.uninstall", "installer unavailable")
                    } else {
                        platform.setUninstallBlocked(a.packageName, false)
                        installer.uninstall(a.packageName)
                            .onSuccess { actions += "uninstalled ${a.packageName}" }
                            .onFailure { err("apps.${a.packageName}.uninstall", it.message ?: "uninstall failed") }
                    }
                }
            }
        }

        // ---- 5. deny-by-default for unlisted launchable apps
        if (policy.kiosk.unlistedLaunchableApps == UnlistedAppsRule.SUSPENDED) {
            val exempt = protectedPkgs + policy.kiosk.lockTaskExtraPackages + listed.keys + policy.kiosk.systemPackagesToBlock
            val targets = installed.values.filter { it.hasLauncherEntry && it.packageName !in exempt && !it.suspended && !it.hidden }.map { it.packageName }
            if (targets.isNotEmpty()) {
                val failed = platform.setPackagesSuspended(targets, true).toSet()
                for (p in targets) {
                    canSuspend[p] = p !in failed
                    if (p in failed) err("apps.$p.unlisted", "unlisted launchable app could not be suspended") else actions += "suspended unlisted $p"
                }
            }
        }

        // ---- 6. block stock launcher / settings / store – ONLY once our HOME is effective
        if (kioskActive && !maintenance) {
            for (p in policy.kiosk.systemPackagesToBlock) {
                if (p in protectedPkgs) continue
                val pkg = installed[p] ?: continue
                if (!pkg.hidden) setHidden(p, true, canHide, ::err, actions)
            }
        } else if (maintenance) {
            for (p in policy.kiosk.systemPackagesToBlock) if (installed[p]?.hidden == true) setHidden(p, false, canHide, ::err, actions)
        }

        // ---- 7. system
        if (!platform.setTimeZone(policy.system.timezone)) err("system.timezone", "time zone ${policy.system.timezone} refused")
        platform.setAutoTime(policy.system.autoTime)
        platform.setScreenCaptureDisabled(policy.system.screenCaptureDisabled)

        return ReconcileReport(policy.version, errors, actions, kioskActive, observe(canSuspend, canHide))
    }

    private fun setSuspended(pkg: String, on: Boolean, cap: MutableMap<String, Boolean>, err: (String, String) -> Unit, actions: MutableList<String>): Boolean {
        val failed = platform.setPackagesSuspended(listOf(pkg), on)
        val readBack = platform.isPackageSuspended(pkg)
        val ok = pkg !in failed && readBack == on
        if (on) cap[pkg] = ok
        if (ok) actions += "suspended $pkg=$on" else if (!on) err("apps.$pkg.suspend", "could not unsuspend")
        return ok
    }

    private fun setHidden(pkg: String, on: Boolean, cap: MutableMap<String, Boolean>, err: (String, String) -> Unit, actions: MutableList<String>): Boolean {
        val accepted = platform.setApplicationHidden(pkg, on)
        val ok = accepted && platform.isApplicationHidden(pkg) == on
        if (on) cap[pkg] = ok
        if (ok) actions += "hidden $pkg=$on" else err("apps.$pkg.hide", if (on) "could not hide (package protected on this model)" else "could not unhide")
        return ok
    }

    /** Inventory as it really is after enforcement, with measured capabilities. */
    fun observe(canSuspend: Map<String, Boolean>, canHide: Map<String, Boolean>): List<ObservedApp> =
        platform.installedPackages().map {
            ObservedApp(
                packageName = it.packageName,
                label = it.label,
                versionCode = it.versionCode,
                versionName = it.versionName,
                system = it.system,
                enabled = it.enabled,
                suspended = it.suspended,
                hidden = it.hidden,
                hasLauncherEntry = it.hasLauncherEntry,
                signerSha256 = it.signerSha256,
                canSuspend = canSuspend[it.packageName],
                canHide = canHide[it.packageName],
            )
        }
}
