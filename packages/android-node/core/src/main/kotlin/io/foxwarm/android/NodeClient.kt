package io.foxwarm.android

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.Closeable
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Serial connection state and a separate tool lane keep heartbeat independent of device work. */
class NodeClient(
    private val pairing: Pairing,
    private val execute: (String, JSONObject) -> JSONObject,
    private val status: (String) -> Unit,
    private val reconnectBaseMs: Long = 1000,
) : Closeable {
    private val http = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
    private val state = Executors.newSingleThreadScheduledExecutor()
    private val tools = Executors.newSingleThreadExecutor()
    private var socket: WebSocket? = null
    private var retry: ScheduledFuture<*>? = null
    private var attempt = 0
    private var generation = 0L
    private var registered = false
    private var quarantined = false
    @Volatile private var closed = false

    fun start() = enqueue { if (socket == null && retry == null && !quarantined) connect() }

    private fun enqueue(action: () -> Unit) {
        if (!closed) runCatching { state.execute { if (!closed) action() } }
    }

    private fun connect() {
        val current = ++generation
        registered = false
        status("Connecting")
        socket = http.newWebSocket(Request.Builder().url(pairing.socketUrl()).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = enqueue {
                if (current != generation) return@enqueue
                webSocket.send(NodeProtocol.registration().toString())
                status("Registering")
            }

            override fun onMessage(webSocket: WebSocket, text: String) = enqueue {
                if (current != generation) return@enqueue
                try {
                    val message = JSONObject(text)
                    when (message.optString("type")) {
                        "ping" -> webSocket.send(JSONObject().put("type", "pong").toString())
                        "registered" -> if (!quarantined && !registered) {
                            try {
                                val version = NodeProtocol.negotiated(message)
                                require(message.optString("nodeId") == pairing.nodeId)
                                registered = true
                                attempt = 0
                                status("Connected · protocol $version")
                            } catch (_: Exception) {
                                quarantine("Protocol mismatch. Update the app or Main server.")
                            }
                        }
                        "node_incompatible" -> quarantine("Protocol mismatch. Update the app or Main server.")
                        "tool_call" -> if (registered && !quarantined) {
                            val callId = message.getString("callId")
                            val tool = message.getString("tool")
                            val args = message.optJSONObject("args") ?: JSONObject()
                            tools.execute {
                                // Queued work from a retired socket must not cause new device effects.
                                val allowed = state.submit<Boolean> { !closed && current == generation && registered && !quarantined }.get()
                                if (allowed) {
                                    val reply = try {
                                        JSONObject().put("type", "tool_call_response").put("callId", callId).put("result", execute(tool, args))
                                    } catch (failure: Exception) {
                                        JSONObject().put("type", "tool_call_error").put("callId", callId)
                                            .put("error", failure.message ?: "Android action failed.")
                                    }
                                    enqueue { if (current == generation && registered && !quarantined) webSocket.send(reply.toString()) }
                                }
                            }
                        }
                    }
                } catch (_: Exception) {
                    quarantine("Invalid server message. Update the app or Main server.")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = enqueue {
                lost(current, code == 1008)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = enqueue {
                lost(current, response?.code == 401 || response?.code == 403)
            }
        })
    }

    private fun quarantine(message: String) {
        quarantined = true
        registered = false
        status(message)
        // Keep transport heartbeat for server diagnostics, without application work or retry loops.
    }

    private fun lost(current: Long, credentialRejected: Boolean) {
        if (current != generation) return
        ++generation
        socket = null
        registered = false
        if (credentialRejected) quarantine("Credential rejected. Create a new Node credential and reconnect.")
        if (quarantined) return
        val delay = (reconnectBaseMs * (1L shl attempt.coerceAtMost(6))).coerceAtMost(60_000)
        attempt++
        status("Disconnected · retrying in ${maxOf(1, delay / 1000)} s")
        retry = state.schedule({ retry = null; if (!closed) connect() }, delay, TimeUnit.MILLISECONDS)
    }

    override fun close() {
        if (closed) return
        closed = true
        state.execute {
            ++generation
            registered = false
            retry?.cancel(false)
            socket?.cancel()
            socket = null
            status("Stopped")
            tools.shutdownNow()
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
            state.shutdown()
        }
    }
}
