package io.foxwarm.android

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

/** The same per-Node credential returned by administrator onboarding. */
data class Pairing(val baseUrl: String, val nodeId: String, val authToken: String) {
    fun socketUrl(): String {
        val url = baseUrl.toHttpUrl().newBuilder()
            .addPathSegment("node_ws")
            .addQueryParameter("id", nodeId)
            .addQueryParameter("auth", authToken)
            .build().toString()
        return url.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
    }

    // Credentials must never appear in logs or status text.
    override fun toString() = "Pairing(nodeId=$nodeId)"

    companion object {
        fun manual(baseUrl: String, nodeId: String, authToken: String): Pairing {
            val raw = baseUrl.trim()
            require(raw.startsWith("https://") || raw.startsWith("http://")) { "Enter an HTTP or HTTPS Main server address." }
            require(!raw.contains('\\') && !raw.contains('?') && !raw.contains('#') && raw.none { it.code < 32 || it.code == 127 }) {
                "The address cannot contain a query, fragment or control characters."
            }
            val url = raw.toHttpUrl()
            require(url.username.isEmpty() && url.password.isEmpty()) { "The address cannot include a username or password." }
            val id = nodeId.trim()
            require(id.matches(Regex("[a-zA-Z0-9_-]+"))) { "Enter the Node ID from onboarding." }
            val token = authToken.trim()
            require(token.isNotEmpty() && token.none { it.isWhitespace() }) { "Enter the Node credential from onboarding." }
            return Pairing(url.toString().trimEnd('/'), id, token)
        }

        fun fromQr(text: String): Pairing {
            val json = try { JSONObject(text) } catch (_: Exception) { throw IllegalArgumentException("This is not a Foxwarm Node QR code.") }
            require(json.optString("type") == "foxwarm-node" && json.opt("version") == 1) { "This is not a supported Foxwarm Node QR code." }
            return manual(json.getString("baseUrl"), json.getString("nodeId"), json.getString("authToken"))
        }
    }
}
