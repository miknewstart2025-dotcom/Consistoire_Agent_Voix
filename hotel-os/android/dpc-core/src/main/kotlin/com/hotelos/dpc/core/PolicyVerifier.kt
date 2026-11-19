package com.hotelos.dpc.core

import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

sealed interface VerifyResult {
    data class Valid(val policy: EffectivePolicy, val signed: SignedPolicy) : VerifyResult
    data class Rejected(val reason: String) : VerifyResult
}

/**
 * Verifies a policy envelope BEFORE parsing it (signature over the exact payload bytes),
 * then checks it targets this device and is not older than the currently applied policy
 * (anti-rollback). Keys: set at enrollment, rotation = several trusted kids.
 */
class PolicyVerifier(trustedKeys: List<PolicyPublicKey>, private val deviceId: String) {
    private val keys: Map<String, PublicKey> = trustedKeys.associate { it.kid to decodeSpki(it.spki) }

    fun verify(signed: SignedPolicy, currentVersion: Int): VerifyResult {
        if (signed.alg != "ES256") return VerifyResult.Rejected("unsupported alg ${signed.alg}")
        val key = keys[signed.kid] ?: return VerifyResult.Rejected("unknown signing key ${signed.kid}")
        val payload = try { Base64.getDecoder().decode(signed.payload) } catch (e: IllegalArgumentException) { return VerifyResult.Rejected("payload not base64") }
        val sig = try { Base64.getDecoder().decode(signed.signature) } catch (e: IllegalArgumentException) { return VerifyResult.Rejected("signature not base64") }
        val ok = try {
            Signature.getInstance("SHA256withECDSA").run { initVerify(key); update(payload); verify(sig) }
        } catch (e: Exception) { false }
        if (!ok) return VerifyResult.Rejected("bad signature")
        val policy = try { ProtocolJson.decodeFromString(EffectivePolicy.serializer(), payload.toString(Charsets.UTF_8)) } catch (e: Exception) {
            return VerifyResult.Rejected("unparseable policy: ${e.message}")
        }
        if (policy.deviceId != deviceId) return VerifyResult.Rejected("policy is for another device")
        if (policy.version != signed.version) return VerifyResult.Rejected("envelope/payload version mismatch")
        if (policy.version < currentVersion) return VerifyResult.Rejected("rollback attempt: ${policy.version} < $currentVersion")
        if (policy.schema != 1) return VerifyResult.Rejected("unsupported policy schema ${policy.schema}")
        return VerifyResult.Valid(policy, signed)
    }

    companion object {
        fun decodeSpki(b64: String): PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(b64)))
    }
}
