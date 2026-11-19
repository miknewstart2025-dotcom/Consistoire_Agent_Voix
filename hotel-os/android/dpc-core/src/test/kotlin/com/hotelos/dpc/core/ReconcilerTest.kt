package com.hotelos.dpc.core

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ReconcilerTest {
    private val netflix = "com.netflix.ninja"
    private val youtube = "com.google.android.youtube.tv"
    private val stockLauncher = "com.google.android.apps.tv.launcherx"
    private val settings = "com.android.tv.settings"
    private val files = "com.example.files"

    private fun box() = FakeDevicePlatform().apply {
        add("com.hotelos.dpc", system = false, launcher = false)
        add("com.hotelos.launcher", system = false)
        add(netflix); add(youtube); add(stockLauncher); add(settings)
        add(files, system = false)
        add("com.google.android.webview", launcher = false)
    }

    @Test
    fun `enforces app states, restrictions, kiosk and deny-by-default`() = runTest {
        val p = box()
        val inst = FakeInstaller(p)
        val r = Reconciler(p, inst).reconcile(Fixtures.policy)
        assertEquals(emptyList<ReconcileError>(), r.errors)
        assertTrue(r.kioskActive)
        assertEquals("com.hotelos.launcher", p.currentHomePackage())
        assertTrue(p.packages[youtube]!!.suspended)
        assertFalse(p.packages[netflix]!!.suspended)
        assertTrue(p.packages[files]!!.suspended, "unlisted launchable app must be suspended")
        assertFalse(p.packages["com.google.android.webview"]!!.suspended, "no launcher entry: untouched")
        assertTrue(p.packages[stockLauncher]!!.hidden)
        assertTrue(p.packages[settings]!!.hidden)
        assertFalse(p.packages["com.hotelos.dpc"]!!.suspended)
        assertEquals(listOf("com.hotelos.iptv"), inst.installs)
        assertTrue("no_debugging_features" in p.restrictions)
        assertEquals(Fixtures.policy.system.timezone, p.timezone)
        assertTrue(r.observed.first { it.packageName == youtube }.canSuspend == true)
    }

    @Test
    fun `is idempotent`() = runTest {
        val p = box()
        val rec = Reconciler(p, FakeInstaller(p))
        rec.reconcile(Fixtures.policy)
        val second = rec.reconcile(Fixtures.policy)
        assertTrue(second.actions.none { it.startsWith("installed") || it.startsWith("restriction") || it.startsWith("suspended unlisted") }, second.actions.toString())
    }

    @Test
    fun `falls back to hiding when suspension is refused and reports measured capability`() = runTest {
        val p = box().apply { unsuspendable += youtube }
        val r = Reconciler(p, FakeInstaller(p)).reconcile(Fixtures.policy)
        assertTrue(p.packages[youtube]!!.hidden)
        val obs = r.observed.first { it.packageName == youtube }
        assertEquals(false, obs.canSuspend)
        assertEquals(true, obs.canHide)
    }

    @Test
    fun `reports an unenforceable app instead of pretending`() = runTest {
        val p = box().apply { unsuspendable += youtube; unhideable += youtube }
        val r = Reconciler(p, FakeInstaller(p)).reconcile(Fixtures.policy)
        assertTrue(r.errors.any { it.key == "apps.$youtube.hide" })
        assertFalse(p.packages[youtube]!!.suspended || p.packages[youtube]!!.hidden)
    }

    @Test
    fun `never blocks the stock launcher when our HOME is not effective`() = runTest {
        val p = box().apply { homeEffective = false }
        val r = Reconciler(p, FakeInstaller(p)).reconcile(Fixtures.policy)
        assertFalse(r.kioskActive)
        assertFalse(p.packages[stockLauncher]!!.hidden, "would leave the TV without any home screen")
        assertTrue(r.errors.any { it.key == "kiosk.home" })
    }

    @Test
    fun `without launcher installed, keeps recovery home and reports`() = runTest {
        val p = box().apply { packages.remove("com.hotelos.launcher") }
        val r = Reconciler(p, null).reconcile(Fixtures.policy)
        assertFalse(r.kioskActive)
        assertTrue(r.errors.any { it.key == "kiosk.launcher" })
        assertFalse(p.packages[stockLauncher]!!.hidden)
    }

    @Test
    fun `does nothing without Device Owner and says so`() = runTest {
        val p = box().apply { deviceOwner = false }
        val r = Reconciler(p, FakeInstaller(p)).reconcile(Fixtures.policy)
        assertEquals("deviceOwner", r.errors.single().key)
        assertFalse(p.packages[youtube]!!.suspended)
    }

    @Test
    fun `strict mode allowlists launcher, allowed apps and helpers`() = runTest {
        val p = box()
        val policy = Fixtures.policyWith { it.copy(kiosk = it.kiosk.copy(mode = KioskMode.STRICT_LOCK_TASK, lockTaskExtraPackages = listOf("com.google.android.webview"))) }
        Reconciler(p, FakeInstaller(p)).reconcile(policy)
        assertEquals(setOf("com.hotelos.launcher", netflix, "com.hotelos.iptv", "com.google.android.webview"), p.lockTask.toSet())
    }

    @Test
    fun `maintenance lifts selected restrictions and restores stock settings, then re-locks`() = runTest {
        val p = box()
        val rec = Reconciler(p, FakeInstaller(p))
        rec.reconcile(Fixtures.policy)
        rec.setMaintenance(true)
        rec.reconcile(Fixtures.policy)
        assertFalse("no_debugging_features" in p.restrictions)
        assertTrue("no_factory_reset" in p.restrictions)
        assertFalse(p.packages[settings]!!.hidden)
        rec.setMaintenance(false)
        rec.reconcile(Fixtures.policy)
        assertTrue("no_debugging_features" in p.restrictions)
        assertTrue(p.packages[settings]!!.hidden)
    }

    @Test
    fun `re-allowing an app unsuspends it`() = runTest {
        val p = box()
        val rec = Reconciler(p, FakeInstaller(p))
        rec.reconcile(Fixtures.policy)
        val allowYoutube = Fixtures.policyWith { pol -> pol.copy(apps = pol.apps.map { if (it.packageName == youtube) it.copy(state = AppDesiredState.ALLOWED, visibleInLauncher = true) else it }) }
        rec.reconcile(allowYoutube)
        assertFalse(p.packages[youtube]!!.suspended)
    }

    @Test
    fun `install failures are reported, not hidden`() = runTest {
        val p = box()
        val inst = FakeInstaller(p).apply { failing += "com.hotelos.iptv" }
        val r = Reconciler(p, inst).reconcile(Fixtures.policy)
        assertTrue(r.errors.any { it.key == "apps.com.hotelos.iptv.install" && it.message.contains("VERIFICATION") })
    }

    @Test
    fun `updates wait for the maintenance window, first installs and launcher do not`() = runTest {
        val p = box().apply { add("com.hotelos.iptv", system = false, version = 5) }
        val inst = FakeInstaller(p)
        // Fixture timezone + window 03:00–05:00; 20:00 local is outside.
        val tz = java.time.ZoneId.of(Fixtures.policy.system.timezone)
        val evening = java.time.LocalDate.of(2026, 11, 19).atTime(20, 0).atZone(tz).toInstant()
        val night = java.time.LocalDate.of(2026, 11, 20).atTime(3, 30).atZone(tz).toInstant()
        val policy = Fixtures.policyWith { pol -> pol.copy(apps = pol.apps.map { if (it.artifact != null) it.copy(artifact = it.artifact.copy(updateWindow = "MAINTENANCE")) else it }) }
        val r1 = Reconciler(p, inst, now = { evening }).reconcile(policy)
        assertTrue(r1.actions.any { it.startsWith("deferred update com.hotelos.iptv") })
        assertEquals(emptyList<String>(), inst.installs)
        Reconciler(p, inst, now = { night }).reconcile(policy)
        assertEquals(listOf("com.hotelos.iptv"), inst.installs)
    }

    @Test
    fun `maintenance window wraps around midnight`() {
        val w = MaintenanceWindow("23:00", "05:00")
        fun at(h: Int) = java.time.LocalDate.of(2026, 1, 1).atTime(h, 0).atZone(java.time.ZoneOffset.UTC).toInstant()
        assertTrue(MaintenanceWindows.isOpen(w, "UTC", at(23)))
        assertTrue(MaintenanceWindows.isOpen(w, "UTC", at(2)))
        assertFalse(MaintenanceWindows.isOpen(w, "UTC", at(5)))
        assertFalse(MaintenanceWindows.isOpen(w, "UTC", at(12)))
    }
}
