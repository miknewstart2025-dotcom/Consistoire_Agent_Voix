package com.hotelos.dpc.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class DeviceJwtTest {
    @Test
    fun `produces an ES256 JWT whose P1363 signature verifies`() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val signer = DerSigner { data -> Signature.getInstance("SHA256withECDSA").run { initSign(kp.private); update(data); sign() } }
        repeat(50) {
            val jwt = DeviceJwt.create("dev-1", signer, nowEpochSec = 1_800_000_000)
            val (h, p, s) = jwt.split(".")
            val raw = Base64.getUrlDecoder().decode(s)
            assertEquals(64, raw.size)
            // Re-encode r||s to DER and verify with the JCA.
            val r = BigInteger(1, raw.copyOfRange(0, 32)).toByteArray()
            val ss = BigInteger(1, raw.copyOfRange(32, 64)).toByteArray()
            val der = byteArrayOf(0x30, (4 + r.size + ss.size).toByte(), 0x02, r.size.toByte()) + r + byteArrayOf(0x02, ss.size.toByte()) + ss
            val ok = Signature.getInstance("SHA256withECDSA").run { initVerify(kp.public); update("$h.$p".toByteArray()); verify(der) }
            assertTrue(ok)
            assertTrue(String(Base64.getUrlDecoder().decode(p)).contains("\"aud\":\"hotel-os\""))
        }
    }
}
