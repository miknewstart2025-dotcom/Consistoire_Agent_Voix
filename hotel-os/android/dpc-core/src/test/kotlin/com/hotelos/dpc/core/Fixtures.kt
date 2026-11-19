package com.hotelos.dpc.core

object Fixtures {
    fun text(name: String): String = javaClass.getResource("/fixtures/$name")!!.readText()
    val signed: SignedPolicy get() = ProtocolJson.decodeFromString(SignedPolicy.serializer(), text("signed-policy.json"))
    val key: PolicyPublicKey get() = ProtocolJson.decodeFromString(PolicyPublicKey.serializer(), text("policy-key.json"))
    val deviceId: String get() = text("device-id.txt").trim()
    val policy: EffectivePolicy get() = (PolicyVerifier(listOf(key), deviceId).verify(signed, 0) as VerifyResult.Valid).policy

    fun policyWith(f: (EffectivePolicy) -> EffectivePolicy) = f(policy)
}
