package io.foxwarm.android

import org.json.JSONArray
import org.json.JSONObject

object NodeProtocol {
    const val MIN = 1
    const val MAX = 3

    fun registration(unlockEnabled: Boolean = false): JSONObject = JSONObject()
        .put("type", "node_register")
        .put("nodeType", "android-node")
        .put("nodeProtocol", JSONObject().put("min", MIN).put("max", MAX))
        .put("capabilities", JSONObject().put("tools", tools(unlockEnabled)))

    fun negotiated(message: JSONObject): Int {
        if (!message.has("nodeProtocol")) return 1
        val protocol = message.getJSONObject("nodeProtocol")
        require(protocol.keys().asSequence().toSet() == setOf("master", "negotiated")) { "Invalid Node protocol response." }
        val master = protocol.getJSONObject("master")
        require(master.keys().asSequence().toSet() == setOf("min", "max")) { "Invalid Main protocol range." }
        fun integer(value: Any): Int {
            require(value is Int && value in 1..1_000_000) { "Invalid protocol version." }
            return value
        }
        val min = integer(master.get("min"))
        val max = integer(master.get("max"))
        val selected = integer(protocol.get("negotiated"))
        require(min <= max && maxOf(MIN, min) <= minOf(MAX, max) && selected == minOf(MAX, max)) {
            "Incompatible Node protocol selection."
        }
        return selected
    }

    fun screenshot(base64: String, width: Int, height: Int): JSONObject = JSONObject()
        .put("output", "Screen size: $width × $height pixels. Tap and swipe use these screen coordinates.")
        .put("width", width).put("height", height)
        .put("inlineData", JSONObject().put("mimeType", "image/jpeg").put("data", base64))

    private fun property(type: String, description: String) = JSONObject().put("type", type).put("description", description)
    private fun tool(name: String, description: String, properties: JSONObject = JSONObject(), vararg required: String) = JSONObject()
        .put("name", name).put("description", description)
        .put("parameters", JSONObject().put("type", "object").put("properties", properties)
            .put("additionalProperties", false).put("required", JSONArray(required.toList())))

    fun tools(unlockEnabled: Boolean = false): JSONArray = JSONArray().apply {
        put(tool("android_get_ui_tree", "Read the active Android window's accessibility tree, including text, resource IDs, bounds and available actions. Some apps expose only part of their interface. Bounds are in screen pixels."))
        put(tool("android_list_elements", "List visible elements in the active Android window with text, resource IDs and screen bounds. Bounds are in screen pixels.", JSONObject()
            .put("clickableOnly", property("boolean", "Return only clickable elements."))
            .put("limit", property("integer", "Maximum elements to return (1–500; default 200).").put("minimum", 1).put("maximum", 500).put("default", 200))))
        put(tool("android_tap", "Tap screen coordinates, or click the element whose text or resource ID matches exactly. Give either x and y, or one of text and resourceId. Fails if more than one element matches.", JSONObject()
            .put("x", property("number", "Horizontal screen coordinate in pixels."))
            .put("y", property("number", "Vertical screen coordinate in pixels."))
            .put("text", property("string", "Exact visible element text."))
            .put("resourceId", property("string", "Exact Android resource ID."))))
        put(tool("android_swipe", "Swipe between two screen coordinates.", JSONObject()
            .put("x1", property("number", "Starting horizontal screen coordinate in pixels."))
            .put("y1", property("number", "Starting vertical screen coordinate in pixels."))
            .put("x2", property("number", "Ending horizontal screen coordinate in pixels."))
            .put("y2", property("number", "Ending vertical screen coordinate in pixels."))
            .put("durationMs", property("integer", "Gesture duration in milliseconds (50–5000; default 300).").put("minimum", 50).put("maximum", 5000).put("default", 300)), "x1", "y1", "x2", "y2"))
        put(tool("android_input", "Replace text in the focused editable field, or in a field matched by resource ID.", JSONObject()
            .put("text", property("string", "Text to place in the field."))
            .put("resourceId", property("string", "Exact Android resource ID of the editable field; omit to use input focus.")), "text"))
        put(tool("android_global_action", "Perform an Android system navigation action.", JSONObject()
            .put("action", property("string", "System action to perform.").put("enum", JSONArray(listOf("back", "home", "recents", "notifications")))), "action"))
        put(tool("android_current_app", "Get the package name of the active Android window."))
        put(tool("android_launch_app", "Open an installed Android app by package name.", JSONObject()
            .put("packageName", property("string", "Android package name, for example com.android.settings.")), "packageName"))
        put(tool("android_device_state", "Get whether the screen is on, whether the lock screen is showing, whether a screen lock is set, and the active app's package name."))
        put(tool("android_wake", "Turn on the screen and ask Android to dismiss the lock screen. A secure lock screen shows its PIN, pattern or password prompt instead. Returns the dismissal outcome and device state."))
        put(tool("android_lock", "Lock the screen with Android's accessibility system action and return the device state."))
        put(tool("android_long_press", "Press and hold one screen coordinate.", JSONObject()
            .put("x", property("number", "Horizontal screen coordinate in pixels."))
            .put("y", property("number", "Vertical screen coordinate in pixels."))
            .put("durationMs", property("integer", "Hold duration in milliseconds (100–5000; default 600).").put("minimum", 100).put("maximum", 5000).put("default", 600)), "x", "y"))
        put(tool("android_double_tap", "Tap one screen coordinate twice, with a gap between taps, as one gesture.", JSONObject()
            .put("x", property("number", "Horizontal screen coordinate in pixels."))
            .put("y", property("number", "Vertical screen coordinate in pixels."))
            .put("intervalMs", property("integer", "Time between the first tap ending and the second tap starting, in milliseconds (40–300; default 100).").put("minimum", 40).put("maximum", 300).put("default", 100)), "x", "y"))
        if (unlockEnabled) put(tool("android_unlock", "Make one unlock attempt using the numeric PIN saved on this phone. The PIN stays on the phone. After an unsuccessful attempt, confirm the PIN again in the app before retrying. Patterns, passwords and biometrics are not supported. Returns the outcome and device state."))
        put(tool("android_screenshot", "Capture the Android screen as an image, with its size in screen pixels. Tap and swipe coordinates use the same pixel space. Protected screens may block capture."))
    }
}
