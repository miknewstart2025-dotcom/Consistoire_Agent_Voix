package com.hotelos.dpc.core

import java.io.File

/**
 * Last valid signed policy, persisted so the box keeps working offline and after reboot.
 * The file holds the SIGNED envelope: it is re-verified when loaded (tamper-evident).
 */
class PolicyStore(private val file: File) {
    fun save(signed: SignedPolicy) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(ProtocolJson.encodeToString(SignedPolicy.serializer(), signed))
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }

    fun load(verifier: PolicyVerifier): EffectivePolicy? {
        if (!file.exists()) return null
        val signed = runCatching { ProtocolJson.decodeFromString(SignedPolicy.serializer(), file.readText()) }.getOrNull() ?: return null
        return (verifier.verify(signed, currentVersion = 0) as? VerifyResult.Valid)?.policy
    }
}
