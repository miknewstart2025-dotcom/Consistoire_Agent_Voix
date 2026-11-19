package com.hotelos.dpc

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.hotelos.dpc.core.DerSigner
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * Device identity: EC P-256 key generated INSIDE Android Keystore (hardware-backed when available).
 * The private key never leaves the keystore. Key attestation chain is sent at enrollment when supported.
 */
class KeystoreIdentity(private val alias: String = "hotelos-device-key") : DerSigner {
    private val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun ensureKey(attestationChallenge: ByteArray?) {
        if (ks.containsAlias(alias)) return
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (attestationChallenge != null) setAttestationChallenge(attestationChallenge) }
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }

    fun publicKeySpkiBase64(): String = Base64.getEncoder().encodeToString(ks.getCertificate(alias).publicKey.encoded)

    fun attestationChain(): List<String>? =
        ks.getCertificateChain(alias)?.takeIf { it.size > 1 }?.map { Base64.getEncoder().encodeToString(it.encoded) }

    override fun signSha256WithEcdsa(data: ByteArray): ByteArray {
        val key = ks.getKey(alias, null) as PrivateKey
        return Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() }
    }

    /** Used after a rotation or when the device is re-enrolled. */
    fun delete() { if (ks.containsAlias(alias)) ks.deleteEntry(alias) }
}
