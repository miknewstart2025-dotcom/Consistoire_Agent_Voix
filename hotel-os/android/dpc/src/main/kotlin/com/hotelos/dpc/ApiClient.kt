package com.hotelos.dpc

import com.hotelos.dpc.core.CleanupReport
import com.hotelos.dpc.core.CommandResult
import com.hotelos.dpc.core.DeviceCommand
import com.hotelos.dpc.core.DeviceJwt
import com.hotelos.dpc.core.DeviceStateReport
import com.hotelos.dpc.core.DerSigner
import com.hotelos.dpc.core.EnrollRequest
import com.hotelos.dpc.core.EnrollResponse
import com.hotelos.dpc.core.PairingCode
import com.hotelos.dpc.core.ProtocolJson
import com.hotelos.dpc.core.SignedPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ApiException(val code: Int, message: String) : Exception(message)

/** REST client for apps/api /device/v1. Every call carries a fresh 5-minute device JWT. */
class ApiClient(
    private val http: OkHttpClient,
    private val baseUrl: () -> String,
    private val deviceId: () -> String?,
    private val signer: DerSigner,
) {
    private val json = "application/json".toMediaType()

    fun token(): String = DeviceJwt.create(deviceId() ?: error("not enrolled"), signer, System.currentTimeMillis() / 1000)

    private fun req(path: String, auth: Boolean = true) = Request.Builder().url(baseUrl().trimEnd('/') + path).apply {
        if (auth) header("Authorization", "Bearer ${token()}")
    }

    private suspend fun <T> call(r: Request, ser: KSerializer<T>?): T? = withContext(Dispatchers.IO) {
        http.newCall(r).execute().use { resp ->
            if (resp.code == 304 || resp.code == 204) return@use null
            val body = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw ApiException(resp.code, "HTTP ${resp.code} ${r.url.encodedPath}: ${body.take(300)}")
            ser?.let { ProtocolJson.decodeFromString(it, body) }
        }
    }

    private fun <T> T.body(ser: KSerializer<T>) = ProtocolJson.encodeToString(ser, this).toRequestBody(json)

    suspend fun enroll(r: EnrollRequest) = call(req("/device/v1/enroll", auth = false).post(r.body(EnrollRequest.serializer())).build(), EnrollResponse.serializer())!!
    suspend fun pairingCode() = call(req("/device/v1/pairing-code").post("{}".toRequestBody(json)).build(), PairingCode.serializer())!!
    /** null = unchanged (304). */
    suspend fun policy(currentVersion: Int): SignedPolicy? =
        call(req("/device/v1/policy").header("If-None-Match", "\"$currentVersion\"").get().build(), SignedPolicy.serializer())
    suspend fun state(s: DeviceStateReport) { call(req("/device/v1/state").post(s.body(DeviceStateReport.serializer())).build(), null) }
    suspend fun commands(): List<DeviceCommand> = call(req("/device/v1/commands").get().build(), ListSerializer(DeviceCommand.serializer()))!!
    suspend fun commandResult(id: String, r: CommandResult) { call(req("/device/v1/commands/$id/result").post(r.body(CommandResult.serializer())).build(), null) }
    suspend fun cleanupReport(jobId: String, r: CleanupReport) { call(req("/device/v1/cleanup/$jobId/report").post(r.body(CleanupReport.serializer())).build(), null) }
}
