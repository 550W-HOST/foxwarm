package io.foxwarm.android

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NodeClientTest {
    private class Peer : WebSocketListener() {
        val frames = LinkedBlockingQueue<JSONObject>()
        val opened = LinkedBlockingQueue<WebSocket>()
        override fun onOpen(webSocket: WebSocket, response: Response) { opened.put(webSocket) }
        override fun onMessage(webSocket: WebSocket, text: String) { frames.put(JSONObject(text)) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
        fun socket() = opened.poll(5, TimeUnit.SECONDS) ?: error("Socket did not open")
        fun frame() = frames.poll(5, TimeUnit.SECONDS) ?: error("Frame did not arrive")
    }
    private fun registered() = """{"type":"registered","nodeId":"phone","nodeProtocol":{"master":{"min":1,"max":3},"negotiated":3}}"""
    private fun call(id: String, tool: String = "android_current_app") = JSONObject().put("type", "tool_call")
        .put("callId", id).put("tool", tool).put("args", JSONObject().put("probe", id)).toString()

    @Test fun dispatchCorrelationErrorsAndHeartbeatUseActualClient() {
        MockWebServer().use { server ->
            val peer = Peer(); server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val statuses = LinkedBlockingQueue<String>()
            NodeClient(Pairing.manual(server.url("/mount").toString(), "phone", "secret"), { name, args ->
                if (name == "fail") error("Device operation failed")
                JSONObject().put("packageName", "test.app").put("probe", args.getString("probe"))
            }, statuses::add).use { client ->
                client.start()
                val socket = peer.socket()
                assertEquals("node_register", peer.frame().getString("type"))
                assertEquals("/mount/node_ws?id=phone&auth=secret", server.takeRequest().path)
                socket.send(registered())
                socket.send(call("one"))
                val reply = peer.frame()
                assertEquals("tool_call_response", reply.getString("type")); assertEquals("one", reply.getString("callId"))
                assertEquals("one", reply.getJSONObject("result").getString("probe"))
                socket.send(call("two", "fail"))
                val failure = peer.frame()
                assertEquals("tool_call_error", failure.getString("type")); assertEquals("two", failure.getString("callId"))
                socket.send("""{"type":"ping"}""")
                assertEquals("pong", peer.frame().getString("type"))
            }
        }
    }

    @Test fun heartbeatDoesNotWaitForDeviceAndReconnectFencesQueuedEffects() {
        MockWebServer().use { server ->
            val first = Peer(); val second = Peer()
            server.enqueue(MockResponse().withWebSocketUpgrade(first)); server.enqueue(MockResponse().withWebSocketUpgrade(second))
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val calls = AtomicInteger()
            NodeClient(Pairing.manual(server.url("/").toString(), "phone", "secret"), { _, _ ->
                calls.incrementAndGet(); entered.countDown(); release.await(5, TimeUnit.SECONDS); JSONObject()
            }, {}, 20).use { client ->
                client.start(); val socket = first.socket(); first.frame(); socket.send(registered())
                socket.send(call("slow")); assertTrue(entered.await(5, TimeUnit.SECONDS))
                socket.send(call("queued")); socket.send("""{"type":"ping"}""")
                assertEquals("pong", first.frame().getString("type"))
                socket.close(1000, "restart")
                val replacement = second.socket(); assertEquals("node_register", second.frame().getString("type"))
                replacement.send(registered()); release.countDown()
                replacement.send("""{"type":"ping"}"""); assertEquals("pong", second.frame().getString("type"))
                assertNull(second.frames.poll(200, TimeUnit.MILLISECONDS))
                assertEquals(1, calls.get())
            }
        }
    }

    @Test fun incompatibleConnectionKeepsHeartbeatWithoutWorkOrReconnect() {
        MockWebServer().use { server ->
            val peer = Peer(); server.enqueue(MockResponse().withWebSocketUpgrade(peer))
            val calls = AtomicInteger()
            NodeClient(Pairing.manual(server.url("/").toString(), "phone", "secret"), { _, _ -> calls.incrementAndGet(); JSONObject() }, {}, 10).use { client ->
                client.start(); val socket = peer.socket(); peer.frame()
                socket.send(call("before-registration"))
                socket.send("""{"type":"node_incompatible"}""")
                socket.send(registered()); socket.send(call("after-quarantine")); socket.send("""{"type":"ping"}""")
                assertEquals("pong", peer.frame().getString("type"))
                assertEquals(0, calls.get())
                socket.close(1000, "incompatible")
                assertNotNull(server.takeRequest(1, TimeUnit.SECONDS))
                assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
            }
        }
    }

    @Test fun rejectedCredentialStopsRetryWithoutExposingSecret() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(403))
            val rejected = CountDownLatch(1)
            NodeClient(Pairing.manual(server.url("/").toString(), "phone", "private-secret"), { _, _ -> JSONObject() }, { status ->
                assertFalse(status.contains("private-secret"))
                if (status.startsWith("Credential rejected")) rejected.countDown()
            }, 10).use { client ->
                client.start(); assertTrue(rejected.await(5, TimeUnit.SECONDS))
                assertNotNull(server.takeRequest(1, TimeUnit.SECONDS)); assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
            }
        }
    }
}
