package io.foxwarm.android

import org.json.JSONObject
import java.io.File

/** Only the device bridge is synthetic; pairing, registration, transport and image writing are production code. */
fun main() {
    val pairing = Pairing.fromQr(File(System.getenv("FOXWARM_ANDROID_PAIRING_FILE")).readText())
    NodeClient(pairing, { tool, args ->
        println("DEVICE_CALL $tool")
        when (tool) {
            "android_screenshot" -> NodeProtocol.screenshot(File(System.getenv("FOXWARM_ANDROID_IMAGE_FILE")).readText(), 1440, 3200)
            "android_global_action" -> error("Synthetic device action unavailable")
            else -> JSONObject().put("packageName", "owned.test.app").put("args", args)
        }
    }, { println("NODE_STATUS $it") }).use { client ->
        client.start()
        readlnOrNull()
    }
}
