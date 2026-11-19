package com.hotelos.dpc.core

import java.util.Base64

/** Signs bytes with the device private key (Android Keystore on device). Returns a DER ECDSA signature. */
fun interface DerSigner {
    fun signSha256WithEcdsa(data: ByteArray): ByteArray
}

/**
 * Builds the short-lived ES256 JWT used for every request (see apps/api DeviceAuthService).
 * JWS requires the raw r||s (P1363) form, while Java/Android Signature produces DER: we convert.
 */
object DeviceJwt {
    private val b64 = Base64.getUrlEncoder().withoutPadding()
    const val TTL_SEC = 300L

    fun create(deviceId: String, signer: DerSigner, nowEpochSec: Long, ttlSec: Long = TTL_SEC): String {
        val header = """{"alg":"ES256","typ":"JWT"}"""
        val payload = """{"sub":"$deviceId","iss":"$deviceId","aud":"hotel-os","iat":$nowEpochSec,"exp":${nowEpochSec + ttlSec}}"""
        val signingInput = b64.encodeToString(header.toByteArray()) + "." + b64.encodeToString(payload.toByteArray())
        val der = signer.signSha256WithEcdsa(signingInput.toByteArray(Charsets.US_ASCII))
        return signingInput + "." + b64.encodeToString(derToP1363(der, 32))
    }

    /** DER SEQUENCE { INTEGER r, INTEGER s } -> fixed-length r||s. */
    fun derToP1363(der: ByteArray, size: Int): ByteArray {
        require(der.size >= 8 && der[0] == 0x30.toByte()) { "not a DER sequence" }
        var i = 2
        if (der[1].toInt() and 0x80 != 0) i = 2 + (der[1].toInt() and 0x7f)
        fun readInt(): ByteArray {
            require(der[i] == 0x02.toByte()) { "expected INTEGER" }
            val len = der[i + 1].toInt() and 0xff
            val v = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            val stripped = v.dropWhile { it == 0.toByte() }.toByteArray()
            require(stripped.size <= size) { "integer too large" }
            return ByteArray(size - stripped.size) + stripped
        }
        val r = readInt()
        val s = readInt()
        return r + s
    }
}
