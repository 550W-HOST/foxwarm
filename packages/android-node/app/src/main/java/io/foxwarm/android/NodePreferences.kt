package io.foxwarm.android

import android.content.Context

class NodePreferences(context: Context) {
    private val preferences = context.getSharedPreferences("node", Context.MODE_PRIVATE)
    fun load(): Pairing? = runCatching {
        Pairing.manual(preferences.getString("baseUrl", "")!!, preferences.getString("nodeId", "")!!, preferences.getString("authToken", "")!!)
    }.getOrNull()
    fun save(pairing: Pairing) {
        check(preferences.edit().putString("baseUrl", pairing.baseUrl).putString("nodeId", pairing.nodeId)
            .putString("authToken", pairing.authToken).commit()) { "Could not save the connection." }
    }
    var running: Boolean
        get() = preferences.getBoolean("running", false)
        set(value) { preferences.edit().putBoolean("running", value).apply() }
}
