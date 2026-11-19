package com.hotelos.dpc.core

import kotlinx.serialization.builtins.ListSerializer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.Base64

/** Fixtures are produced by the TypeScript policy engine + signing code (scripts/gen-android-fixtures.mjs). */
class ProtocolContractTest {
    @Test
    fun `verifies a policy signed by the server and parses it`() {
        val r = PolicyVerifier(listOf(Fixtures.key), Fixtures.deviceId).verify(Fixtures.signed, currentVersion = 0)
        val p = assertInstanceOf(VerifyResult.Valid::class.java, r).policy
        assertEquals(3, p.version)
        assertEquals("he", p.launcher.language)
        assertEquals("ברוכים הבאים", p.launcher.welcomeMessage["he"])
        assertEquals(AppDesiredState.SUSPENDED, p.apps.first { it.packageName == "com.google.android.youtube.tv" }.state)
        assertEquals(12L, p.apps.first { it.packageName == "com.hotelos.iptv" }.artifact!!.versionCode)
        assertEquals(UnlistedAppsRule.SUSPENDED, p.kiosk.unlistedLaunchableApps)
    }

    @Test
    fun `rejects tampered payload, wrong device, unknown key and rollback`() {
        val s = Fixtures.signed
        val v = PolicyVerifier(listOf(Fixtures.key), Fixtures.deviceId)
        val json = String(Base64.getDecoder().decode(s.payload)).replace("\"ALLOWED\"", "\"HIDDEN\"")
        val tampered = s.copy(payload = Base64.getEncoder().encodeToString(json.toByteArray()))
        assertEquals(VerifyResult.Rejected("bad signature"), v.verify(tampered, 0))
        assertTrue((PolicyVerifier(listOf(Fixtures.key), "other").verify(s, 0) as VerifyResult.Rejected).reason.contains("another device"))
        assertTrue((v.verify(s.copy(kid = "nope"), 0) as VerifyResult.Rejected).reason.contains("unknown signing key"))
        assertTrue((v.verify(s, currentVersion = 4) as VerifyResult.Rejected).reason.contains("rollback"))
    }

    @Test
    fun `parses every websocket frame type`() {
        val frames = WsJson.decodeFromString(ListSerializer(WsServerMessage.serializer()), Fixtures.text("ws-frames.json"))
        assertInstanceOf(WsServerMessage.Welcome::class.java, frames[0])
        assertEquals(4, (frames[1] as WsServerMessage.PolicyChanged).version)
        assertEquals("SHOW_MESSAGE", (frames[2] as WsServerMessage.Command).command.type)
        assertInstanceOf(WsServerMessage.Error::class.java, frames[3])
        val hello = WsJson.encodeToString(WsClientMessage.serializer(), WsClientMessage.Hello(3))
        assertEquals("""{"t":"hello","policyVersion":3,"protocol":1}""", hello)
    }
}
