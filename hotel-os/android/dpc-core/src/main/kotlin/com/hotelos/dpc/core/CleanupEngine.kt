package com.hotelos.dpc.core

import java.time.Instant

/**
 * Check-out cleanup. Honest by design: an app counts as cleaned only when Android reported success.
 * Never touches the DPC itself; never claims to delete data stored on the publishers' servers.
 */
class CleanupEngine(private val platform: DevicePlatform, private val now: () -> Instant = Instant::now) {
    data class Item(val packageName: String, val action: CleanupPolicy)

    suspend fun run(items: List<Item>): CleanupReport {
        platform.goHome()
        val results = items.filter { it.packageName != platform.ownPackage }.map { item ->
            val r: Result<Unit> = when (item.action) {
                CleanupPolicy.KEEP -> Result.success(Unit)
                CleanupPolicy.CLEAR_DATA -> platform.clearApplicationUserData(item.packageName)
                CleanupPolicy.RESET_SESSION -> platform.requestSessionReset(item.packageName)
            }
            CleanupAppResult(item.packageName, item.action.name, r.isSuccess, r.exceptionOrNull()?.message)
        }
        val ok = results.count { it.ok }
        val outcome = when {
            results.isEmpty() || ok == results.size -> "SUCCEEDED"
            ok == 0 -> "FAILED"
            else -> "PARTIAL"
        }
        platform.goHome()
        return CleanupReport(outcome, results, now().toString())
    }
}
