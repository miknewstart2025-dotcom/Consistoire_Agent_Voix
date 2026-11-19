package com.hotelos.dpc

import android.util.Log
import com.hotelos.dpc.core.WsClientMessage
import com.hotelos.dpc.core.WsJson
import com.hotelos.dpc.core.WsServerMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.random.Random

/** Persistent WebSocket with exponential backoff + jitter. REST polling keeps working when it is down. */
class WsClient(
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val url: () -> String?,
    private val token: () -> String,
    private val onOpen: (send: (WsClientMessage) -> Unit) -> Unit,
    private val onMessage: suspend (WsServerMessage) -> Unit,
) {
    @Volatile private var socket: WebSocket? = null
    @Volatile var connected = false
        private set

    fun start() = scope.launch {
        var attempt = 0
        while (isActive) {
            val u = url()
            if (u == null) { delay(30_000); continue }
            val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
            socket = http.newWebSocket(Request.Builder().url(u).header("Authorization", "Bearer ${token()}").build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    connected = true; attempt = 0
                    onOpen { m -> webSocket.send(WsJson.encodeToString(WsClientMessage.serializer(), m)) }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val msg = runCatching { WsJson.decodeFromString(WsServerMessage.serializer(), text) }.getOrNull() ?: return
                    scope.launch { runCatching { onMessage(msg) }.onFailure { Log.w(TAG, "ws handler", it) } }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { connected = false; closed.complete(Unit) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { connected = false; closed.complete(Unit) }
            })
            closed.await()
            attempt++
            val backoff = (1000L shl minOf(attempt, 6)).coerceAtMost(60_000) + Random.nextLong(0, 2000)
            delay(backoff)
        }
    }

    fun send(m: WsClientMessage): Boolean = socket?.send(WsJson.encodeToString(WsClientMessage.serializer(), m)) ?: false

    companion object { private const val TAG = "HotelOsWs" }
}
