package com.hotelos.dpc.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant

/** Side effects that live in the Android layer (UI overlays, IPC to the launcher, log upload…). */
interface CommandHandlers {
    suspend fun syncNow()
    suspend fun restartLauncher(): Result<Unit>
    suspend fun refreshUi(): Result<Unit>
    suspend fun launchApp(packageName: String): Result<Unit>
    suspend fun showMessage(title: String?, text: String, durationSec: Int, highPriority: Boolean): Result<Unit>
    suspend fun uploadLogs(minutes: Int): Result<Unit>
    suspend fun diagnostics(): JsonObject
    suspend fun reportCleanup(jobId: String, report: CleanupReport): Result<Unit>
}

/**
 * Executes server commands. Idempotent: an id already executed is never executed twice
 * (journal persisted by the caller). Unknown/unsupported types fail explicitly – never a fake success.
 */
class CommandExecutor(
    private val platform: DevicePlatform,
    private val handlers: CommandHandlers,
    private val cleanup: CleanupEngine,
    private val journal: CommandJournal,
    private val currentPolicy: () -> EffectivePolicy?,
    private val now: () -> Instant = Instant::now,
) {
    /** Returns null when the command must be skipped (already executed or expired). */
    suspend fun execute(cmd: DeviceCommand): CommandResult? {
        if (journal.isDone(cmd.id)) return null
        if (Instant.parse(cmd.expiresAt).isBefore(now())) {
            journal.markDone(cmd.id)
            return CommandResult("FAILED", "expired before execution")
        }
        val result = try { run(cmd) } catch (e: Exception) { CommandResult("FAILED", e.message ?: e.javaClass.simpleName) }
        journal.markDone(cmd.id)
        return result
    }

    private fun Result<Unit>.toCommandResult(okMsg: String? = null) =
        fold({ CommandResult("SUCCEEDED", okMsg) }, { CommandResult("FAILED", it.message ?: "failed") })

    private suspend fun run(cmd: DeviceCommand): CommandResult {
        val p = cmd.payload
        return when (cmd.type) {
            "SYNC_NOW" -> { handlers.syncNow(); CommandResult("SUCCEEDED") }
            "REFRESH_UI" -> handlers.refreshUi().toCommandResult()
            "RESTART_LAUNCHER" -> handlers.restartLauncher().toCommandResult()
            "REBOOT_DEVICE" -> {
                // Result is reported before rebooting; the server sees the device come back via heartbeat.
                journal.markDone(cmd.id)
                platform.reboot()
                CommandResult("SUCCEEDED", "reboot requested")
            }
            "LAUNCH_APP" -> {
                val pkg = p["packageName"]?.jsonPrimitive?.contentOrNull ?: return CommandResult("FAILED", "packageName missing")
                val allowed = currentPolicy()?.apps?.any { it.packageName == pkg && it.state == AppDesiredState.ALLOWED } == true
                if (!allowed) CommandResult("FAILED", "$pkg is not allowed by the current policy") else handlers.launchApp(pkg).toCommandResult()
            }
            "SHOW_MESSAGE" -> {
                val text = p["text"]?.jsonPrimitive?.contentOrNull ?: return CommandResult("FAILED", "text missing")
                handlers.showMessage(
                    p["title"]?.jsonPrimitive?.contentOrNull,
                    text,
                    p["durationSec"]?.jsonPrimitive?.intOrNull ?: 30,
                    p["priority"]?.jsonPrimitive?.contentOrNull == "HIGH",
                ).toCommandResult()
            }
            "UPLOAD_LOGS" -> handlers.uploadLogs(p["minutes"]?.jsonPrimitive?.intOrNull ?: 60).toCommandResult()
            "RUN_DIAGNOSTICS" -> CommandResult("SUCCEEDED", data = handlers.diagnostics())
            "CHECKOUT_CLEANUP" -> {
                val jobId = p["cleanupJobId"]?.jsonPrimitive?.contentOrNull ?: return CommandResult("FAILED", "cleanupJobId missing")
                val items = p["apps"]?.jsonArray?.mapNotNull { el ->
                    val o = el.jsonObject
                    val pkg = o["packageName"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val action = runCatching { CleanupPolicy.valueOf(o["action"]!!.jsonPrimitive.content) }.getOrNull() ?: return@mapNotNull null
                    CleanupEngine.Item(pkg, action)
                } ?: emptyList()
                val report = cleanup.run(items)
                // The server closes the command when it receives the report.
                handlers.reportCleanup(jobId, report).fold(
                    { CommandResult(if (report.outcome == "FAILED") "FAILED" else "SUCCEEDED", "cleanup ${report.outcome}") },
                    { CommandResult("FAILED", "cleanup done (${report.outcome}) but report upload failed: ${it.message}") },
                )
            }
            else -> CommandResult("FAILED", "NOT_IMPLEMENTED: ${cmd.type} is not supported by this controller version",
                buildJsonObject { put("type", cmd.type) })
        }
    }
}

/** Persisted set of executed command ids (bounded). */
interface CommandJournal {
    fun isDone(id: String): Boolean
    fun markDone(id: String)
}

class InMemoryCommandJournal(private val capacity: Int = 500) : CommandJournal {
    private val ids = LinkedHashSet<String>()
    @Synchronized override fun isDone(id: String) = id in ids
    @Synchronized override fun markDone(id: String) {
        ids += id
        while (ids.size > capacity) ids.remove(ids.first())
    }
}
