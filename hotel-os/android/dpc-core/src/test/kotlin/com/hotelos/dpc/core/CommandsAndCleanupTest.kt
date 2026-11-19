package com.hotelos.dpc.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.addJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class CommandsAndCleanupTest {
    private val now = Instant.parse("2026-11-19T12:00:00Z")

    private class Handlers : CommandHandlers {
        val messages = mutableListOf<String>()
        val launched = mutableListOf<String>()
        val reports = mutableListOf<Pair<String, CleanupReport>>()
        var syncs = 0
        override suspend fun syncNow() { syncs++ }
        override suspend fun restartLauncher() = Result.success(Unit)
        override suspend fun refreshUi() = Result.success(Unit)
        override suspend fun launchApp(packageName: String): Result<Unit> { launched += packageName; return Result.success(Unit) }
        override suspend fun showMessage(title: String?, text: String, durationSec: Int, highPriority: Boolean): Result<Unit> { messages += text; return Result.success(Unit) }
        override suspend fun uploadLogs(minutes: Int) = Result.failure<Unit>(UnsupportedOperationException("NOT_IMPLEMENTED: log upload"))
        override suspend fun diagnostics() = JsonObject(emptyMap())
        override suspend fun reportCleanup(jobId: String, report: CleanupReport): Result<Unit> { reports += jobId to report; return Result.success(Unit) }
    }

    private fun cmd(id: String, type: String, payload: JsonObject = JsonObject(emptyMap()), expires: String = "2026-11-20T00:00:00Z") =
        DeviceCommand(id, type, payload, "2026-11-19T11:00:00Z", expires)

    private fun setup(): Triple<CommandExecutor, Handlers, FakeDevicePlatform> {
        val p = FakeDevicePlatform()
        val h = Handlers()
        val ex = CommandExecutor(p, h, CleanupEngine(p) { now }, InMemoryCommandJournal(), { Fixtures.policy }) { now }
        return Triple(ex, h, p)
    }

    @Test
    fun `executes once, skips duplicates and expired`() = runTest {
        val (ex, h, _) = setup()
        val c = cmd("c1", "SHOW_MESSAGE", buildJsonObject { put("text", "Bonjour") })
        assertEquals("SUCCEEDED", ex.execute(c)!!.status)
        assertNull(ex.execute(c))
        assertEquals(listOf("Bonjour"), h.messages)
        assertEquals("FAILED", ex.execute(cmd("c2", "SYNC_NOW", expires = "2026-11-19T00:00:00Z"))!!.status)
        assertEquals(0, h.syncs)
    }

    @Test
    fun `refuses to launch an app the policy does not allow`() = runTest {
        val (ex, h, _) = setup()
        assertEquals("FAILED", ex.execute(cmd("c3", "LAUNCH_APP", buildJsonObject { put("packageName", "com.google.android.youtube.tv") }))!!.status)
        assertEquals("SUCCEEDED", ex.execute(cmd("c4", "LAUNCH_APP", buildJsonObject { put("packageName", "com.netflix.ninja") }))!!.status)
        assertEquals(listOf("com.netflix.ninja"), h.launched)
    }

    @Test
    fun `unsupported and not-implemented commands fail explicitly`() = runTest {
        val (ex, _, _) = setup()
        assertTrue(ex.execute(cmd("c5", "ENTER_MAINTENANCE"))!!.message!!.startsWith("NOT_IMPLEMENTED"))
        assertEquals("FAILED", ex.execute(cmd("c6", "UPLOAD_LOGS"))!!.status)
    }

    @Test
    fun `checkout cleanup reports partial results honestly`() = runTest {
        val (ex, h, p) = setup()
        p.clearFails += "com.google.android.youtube.tv"
        val payload = buildJsonObject {
            put("cleanupJobId", "job-1")
            put("apps", buildJsonArray {
                addJsonObject { put("packageName", "com.netflix.ninja"); put("action", "CLEAR_DATA") }
                addJsonObject { put("packageName", "com.google.android.youtube.tv"); put("action", "CLEAR_DATA") }
                addJsonObject { put("packageName", "com.hotelos.iptv"); put("action", "RESET_SESSION") }
                addJsonObject { put("packageName", "com.hotelos.dpc"); put("action", "CLEAR_DATA") }
            })
        }
        val r = ex.execute(cmd("c7", "CHECKOUT_CLEANUP", payload))!!
        assertEquals("SUCCEEDED", r.status)
        val report = h.reports.single().second
        assertEquals("PARTIAL", report.outcome)
        assertEquals(listOf("com.netflix.ninja"), p.cleared)
        assertEquals(listOf("com.hotelos.iptv"), p.sessionResets)
        assertTrue(report.apps.none { it.packageName == "com.hotelos.dpc" }, "the controller never wipes itself")
        assertTrue(p.homeCalls >= 1)
    }
}
