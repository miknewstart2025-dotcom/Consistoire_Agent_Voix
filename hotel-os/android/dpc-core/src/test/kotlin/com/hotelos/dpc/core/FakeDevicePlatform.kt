package com.hotelos.dpc.core

/**
 * SIMULATION of Android for unit tests. Models documented DevicePolicyManager behaviour, plus
 * configurable refusals to mimic OEM firmware limits. Passing tests here proves the controller's
 * logic – NOT that a given TV box behaves this way ([HW-REQUIRED] validation is separate).
 */
class FakeDevicePlatform(
    override val ownPackage: String = "com.hotelos.dpc",
    var deviceOwner: Boolean = true,
) : DevicePlatform {
    val packages = linkedMapOf<String, InstalledPackage>()
    val restrictions = mutableSetOf<String>()
    val unsuspendable = mutableSetOf<String>()
    val unhideable = mutableSetOf<String>()
    var homeAccepted = true
    var homeEffective = true
    private var home: String? = "com.google.android.apps.tv.launcherx"
    var lockTask: List<String> = emptyList()
    var statusBarDisabled = false
    var timezone = "UTC"
    val cleared = mutableListOf<String>()
    val clearFails = mutableSetOf<String>()
    val sessionResets = mutableListOf<String>()
    var homeCalls = 0
    var reboots = 0

    fun add(pkg: String, system: Boolean = true, launcher: Boolean = true, version: Long = 1) {
        packages[pkg] = InstalledPackage(pkg, pkg.substringAfterLast('.'), version, "$version", system, true, false, false, launcher, null)
    }

    override fun isDeviceOwner() = deviceOwner
    override fun installedPackages() = packages.values.toList()
    override fun setPackagesSuspended(packages: List<String>, suspended: Boolean): List<String> {
        val failed = packages.filter { it in unsuspendable || it !in this.packages }
        packages.filter { it !in failed }.forEach { this.packages[it] = this.packages[it]!!.copy(suspended = suspended) }
        return failed
    }
    override fun isPackageSuspended(pkg: String) = packages[pkg]?.suspended
    override fun setApplicationHidden(pkg: String, hidden: Boolean): Boolean {
        if (pkg in unhideable || pkg !in packages) return false
        packages[pkg] = packages[pkg]!!.copy(hidden = hidden)
        return true
    }
    override fun isApplicationHidden(pkg: String) = packages[pkg]?.hidden == true
    override fun setUninstallBlocked(pkg: String, blocked: Boolean) {}
    override fun activeUserRestrictions() = restrictions.toSet()
    override fun setUserRestriction(key: String, enabled: Boolean) { if (enabled) restrictions += key else restrictions -= key }
    override fun setPersistentHome(launcherPackage: String): Boolean {
        if (!homeAccepted) return false
        if (homeEffective) home = launcherPackage
        return true
    }
    override fun clearPersistentHome() { home = null }
    override fun currentHomePackage() = home
    override fun setLockTaskPackages(packages: List<String>) { lockTask = packages }
    override fun setStatusBarDisabled(disabled: Boolean): Boolean { statusBarDisabled = disabled; return true }
    override fun setKeyguardDisabled(disabled: Boolean) = true
    override fun setScreenCaptureDisabled(disabled: Boolean) {}
    override fun setTimeZone(tz: String): Boolean { timezone = tz; return true }
    override fun setAutoTime(enabled: Boolean) {}
    override suspend fun clearApplicationUserData(pkg: String): Result<Unit> =
        if (pkg in clearFails) Result.failure(IllegalStateException("clearApplicationUserData refused")) else { cleared += pkg; Result.success(Unit) }
    override suspend fun requestSessionReset(pkg: String): Result<Unit> { sessionResets += pkg; return Result.success(Unit) }
    override fun goHome() { homeCalls++ }
    override fun reboot() { reboots++ }
}

class FakeInstaller(private val platform: FakeDevicePlatform) : PackageInstallerPort {
    val installs = mutableListOf<String>()
    var failing = mutableSetOf<String>()
    override suspend fun installOrUpdate(packageName: String, artifact: ApkArtifact): Result<Unit> {
        if (packageName in failing) return Result.failure(IllegalStateException("INSTALL_FAILED_VERIFICATION_FAILURE"))
        installs += packageName
        platform.add(packageName, system = false, version = artifact.versionCode)
        return Result.success(Unit)
    }
    override suspend fun uninstall(packageName: String): Result<Unit> { platform.packages.remove(packageName); return Result.success(Unit) }
}
