package com.hotelos.dpc.core

/** Snapshot of one installed package as seen by PackageManager / DevicePolicyManager. */
data class InstalledPackage(
    val packageName: String,
    val label: String?,
    val versionCode: Long,
    val versionName: String?,
    val system: Boolean,
    val enabled: Boolean,
    val suspended: Boolean,
    val hidden: Boolean,
    val hasLauncherEntry: Boolean,
    val signerSha256: String?,
)

/**
 * Everything the controller does to Android goes through this port.
 * Production implementation: AndroidDevicePlatform (DevicePolicyManager, PackageManager) in :dpc.
 * Tests use FakeDevicePlatform – a simulation, never presented as hardware validation.
 *
 * Every setter returns whether Android ACCEPTED the call; the reconciler always reads back afterwards.
 */
interface DevicePlatform {
    val ownPackage: String
    fun isDeviceOwner(): Boolean
    fun installedPackages(): List<InstalledPackage>

    /** DevicePolicyManager.setPackagesSuspended – returns the packages that could NOT be (un)suspended. */
    fun setPackagesSuspended(packages: List<String>, suspended: Boolean): List<String>
    fun isPackageSuspended(pkg: String): Boolean?
    /** DevicePolicyManager.setApplicationHidden */
    fun setApplicationHidden(pkg: String, hidden: Boolean): Boolean
    fun isApplicationHidden(pkg: String): Boolean
    fun setUninstallBlocked(pkg: String, blocked: Boolean)

    fun activeUserRestrictions(): Set<String>
    fun setUserRestriction(key: String, enabled: Boolean)

    /** addPersistentPreferredActivity(HOME) towards the launcher's HOME activity. */
    fun setPersistentHome(launcherPackage: String): Boolean
    fun clearPersistentHome()
    fun currentHomePackage(): String?
    fun setLockTaskPackages(packages: List<String>)
    fun setStatusBarDisabled(disabled: Boolean): Boolean
    fun setKeyguardDisabled(disabled: Boolean): Boolean
    fun setScreenCaptureDisabled(disabled: Boolean)
    fun setTimeZone(tz: String): Boolean
    fun setAutoTime(enabled: Boolean)

    /** DevicePolicyManager.clearApplicationUserData (API 28+). Suspends until Android reports the result. */
    suspend fun clearApplicationUserData(pkg: String): Result<Unit>
    /** Asks a HOTEL OS app (launcher, iptv) to reset its guest session through its signature-protected service. */
    suspend fun requestSessionReset(pkg: String): Result<Unit>
    fun goHome()
    fun reboot()
}

/** Download + verify + silent install (PackageInstaller session as Device Owner). Implemented in :dpc. */
interface PackageInstallerPort {
    suspend fun installOrUpdate(packageName: String, artifact: ApkArtifact): Result<Unit>
    suspend fun uninstall(packageName: String): Result<Unit>
}
