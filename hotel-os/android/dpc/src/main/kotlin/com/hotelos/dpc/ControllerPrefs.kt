package com.hotelos.dpc

import android.content.Context
import com.hotelos.dpc.core.PolicyPublicKey
import com.hotelos.dpc.core.ProtocolJson
import kotlinx.serialization.builtins.ListSerializer

/** Non-secret controller state. Secrets (device key) live in Android Keystore, never here. */
class ControllerPrefs(context: Context) {
    private val sp = context.getSharedPreferences("controller", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("serverUrl", null)
        set(v) = sp.edit().putString("serverUrl", v).apply()
    /** One-time enrollment token from the provisioning station; erased after enrollment. */
    var enrollmentToken: String?
        get() = sp.getString("enrollmentToken", null)
        set(v) = sp.edit().putString("enrollmentToken", v).apply()
    var deviceId: String?
        get() = sp.getString("deviceId", null)
        set(v) = sp.edit().putString("deviceId", v).apply()
    var wsUrl: String?
        get() = sp.getString("wsUrl", null)
        set(v) = sp.edit().putString("wsUrl", v).apply()
    var pairingCode: String?
        get() = sp.getString("pairingCode", null)
        set(v) = sp.edit().putString("pairingCode", v).apply()
    var policyKeys: List<PolicyPublicKey>
        get() = sp.getString("policyKeys", null)?.let { ProtocolJson.decodeFromString(ListSerializer(PolicyPublicKey.serializer()), it) } ?: emptyList()
        set(v) = sp.edit().putString("policyKeys", ProtocolJson.encodeToString(ListSerializer(PolicyPublicKey.serializer()), v)).apply()
    var maintenanceUntil: Long
        get() = sp.getLong("maintenanceUntil", 0)
        set(v) = sp.edit().putLong("maintenanceUntil", v).apply()
    /** Startup counter used to detect our own crash loops. */
    var recentStarts: String
        get() = sp.getString("recentStarts", "") ?: ""
        set(v) = sp.edit().putString("recentStarts", v).apply()
    val isEnrolled get() = deviceId != null
}
