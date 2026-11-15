package io.foxwarm.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NodeProtocolTest {
    @Test fun pairingPreservesDeploymentPathAndEscapesCredential() {
        val pairing = Pairing.manual("https://example.invalid/foxwarm/", "phone-1", "token+&=value")
        assertEquals("wss://example.invalid/foxwarm/node_ws?id=phone-1&auth=token%2B%26%3Dvalue", pairing.socketUrl())
        assertFalse(pairing.toString().contains(pairing.authToken))
        val qr = """{"type":"foxwarm-node","version":1,"baseUrl":"https://example.invalid/foxwarm","nodeId":"phone-1","authToken":"token+&=value"}"""
        assertEquals(pairing, Pairing.fromQr(qr))
    }

    @Test fun pairingRejectsUnsupportedOrAmbiguousInput() {
        for (address in listOf("file:///tmp/main", "https://user:pass@example.invalid", "https://example.invalid/?query", "https://example.invalid/#fragment", "http://example.invalid\\bad")) {
            assertThrows(IllegalArgumentException::class.java) { Pairing.manual(address, "phone", "token") }
        }
        assertThrows(IllegalArgumentException::class.java) { Pairing.fromQr("https://example.invalid") }
        assertThrows(IllegalArgumentException::class.java) { Pairing.fromQr("""{"type":"foxwarm-node","version":2}""") }
    }

    @Test fun negotiatesNewestCommonVersionAndLegacy() {
        assertEquals(1, NodeProtocol.negotiated(JSONObject()))
        for (max in 1..3) assertEquals(max, NodeProtocol.negotiated(response(1, max, max)))
        assertEquals(3, NodeProtocol.negotiated(response(2, 8, 3)))
        for (value in listOf(response(4, 8, 4), response(1, 3, 2), response(3, 2, 3), response(0, 3, 3))) {
            assertThrows(IllegalArgumentException::class.java) { NodeProtocol.negotiated(value) }
        }
        assertThrows(IllegalArgumentException::class.java) { NodeProtocol.negotiated(response(1, 3, 3).apply { getJSONObject("nodeProtocol").put("negotiated", 3.0) }) }
        assertThrows(IllegalArgumentException::class.java) { NodeProtocol.negotiated(response(1, 3, 3).apply { getJSONObject("nodeProtocol").put("extra", true) }) }
    }

    @Test fun registrationDeclaresOnlySupportedOrdinaryTools() {
        val registration = NodeProtocol.registration()
        assertEquals(3, registration.getJSONObject("nodeProtocol").getInt("max"))
        val capabilities = registration.getJSONObject("capabilities")
        assertEquals(setOf("tools"), capabilities.keys().asSequence().toSet())
        val tools = capabilities.getJSONArray("tools")
        assertEquals(9, tools.length())
        for (i in 0 until tools.length()) {
            val schema = tools.getJSONObject(i).getJSONObject("parameters")
            assertEquals("object", schema.getString("type"))
            val properties = schema.getJSONObject("properties")
            val required = schema.getJSONArray("required")
            for (j in 0 until required.length()) assertTrue(properties.has(required.getString(j)))
        }
    }

    private fun response(min: Int, max: Int, negotiated: Int) = JSONObject().put("nodeProtocol", JSONObject()
        .put("master", JSONObject().put("min", min).put("max", max)).put("negotiated", negotiated))
}
