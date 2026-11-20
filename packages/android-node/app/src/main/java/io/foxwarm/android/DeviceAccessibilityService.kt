package io.foxwarm.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.app.KeyguardManager
import android.os.PowerManager
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** Device operations run on the accessibility service's main thread, never on the socket reader. */
@Suppress("DEPRECATION")
class DeviceAccessibilityService : AccessibilityService() {
    companion object { @Volatile var current: DeviceAccessibilityService? = null; private set }
    private val main = Handler(android.os.Looper.getMainLooper())
    override fun onServiceConnected() { current = this }
    override fun onDestroy() { if (current === this) current = null; super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    private fun <T> ui(action: () -> T): T {
        val work = FutureTask(action)
        main.post {
            if (PinSettingsActivity.active) work.cancel(false) else work.run()
        }
        try { return work.get(10, TimeUnit.SECONDS) }
        finally { work.cancel(false) }
    }

    fun execute(tool: String, args: JSONObject): JSONObject {
        check(!PinSettingsActivity.active) { "Remote device tools are paused while PIN unlock settings are open." }
        return when (tool) {
            "android_device_state" -> ui { deviceState() }
            "android_wake" -> wake()
            "android_lock" -> {
                ui { check(performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)) { "The lock action was unavailable." } }
                await(1500) { ui { getSystemService(KeyguardManager::class.java).isKeyguardLocked } }
                ui { success().put("deviceState", deviceState()) }
            }
            "android_unlock" -> unlock()
            "android_long_press", "android_double_tap" -> {
                val x = args.getDouble("x"); val y = args.getDouble("y")
                val gesture = ui {
                    checkCoordinates(x, y, x, y)
                    if (tool == "android_long_press") ScreenGestures.hold(x.toFloat(), y.toFloat(), args.optLong("durationMs", 600))
                    else ScreenGestures.doubleTap(x.toFloat(), y.toFloat(), args.optLong("intervalMs", 100))
                }
                dispatch(gesture)
            }
            "android_get_ui_tree" -> ui { snapshot(false, false, 1000) }
            "android_list_elements" -> ui {
                val limit = args.optInt("limit", 200)
                require(limit in 1..500) { "limit must be between 1 and 500." }
                snapshot(true, args.optBoolean("clickableOnly", false), limit)
            }
            "android_tap" -> {
                val coordinates = args.has("x") || args.has("y")
                val selectors = listOf("text", "resourceId").filter(args::has)
                require(if (coordinates) selectors.isEmpty() && args.has("x") && args.has("y") else selectors.size == 1) {
                    "Give x and y, or one of text and resourceId."
                }
                if (coordinates) gesture(args.getDouble("x"), args.getDouble("y"))
                else ui {
                    withRoot { root ->
                        val target = select(root, selectors.single(), args.getString(selectors.single()))
                        try {
                            check(target.isEnabled && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "The element did not accept a click. Use its screen bounds to tap coordinates." }
                            success()
                        } finally { target.recycle() }
                    }
                }
            }
            "android_swipe" -> {
                val duration = args.optLong("durationMs", 300)
                require(duration in 50..5000) { "durationMs must be between 50 and 5000." }
                gesture(args.getDouble("x1"), args.getDouble("y1"), args.getDouble("x2"), args.getDouble("y2"), duration)
            }
            "android_input" -> ui {
                withRoot { root ->
                    val target = if (args.has("resourceId")) select(root, "resourceId", args.getString("resourceId"))
                        else root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: error("Focus an editable field first.")
                    try {
                        check(target.isEditable && target.isEnabled) { "The field is not editable." }
                        val data = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, args.getString("text")) }
                        check(target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, data)) { "The field did not accept text." }
                        success()
                    } finally { target.recycle() }
                }
            }
            "android_global_action" -> ui {
                val action = when (args.getString("action")) {
                    "back" -> GLOBAL_ACTION_BACK
                    "home" -> GLOBAL_ACTION_HOME
                    "recents" -> GLOBAL_ACTION_RECENTS
                    "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
                    else -> error("Unsupported system action.")
                }
                check(performGlobalAction(action)) { "The system action was unavailable." }
                success()
            }
            "android_current_app" -> ui { withRoot { JSONObject().put("packageName", it.packageName?.toString() ?: JSONObject.NULL) } }
            "android_launch_app" -> ui {
                val intent = packageManager.getLaunchIntentForPackage(args.getString("packageName")) ?: error("No launchable app found for this package.")
                startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                success()
            }
            "android_screenshot" -> screenshot()
            else -> error("Unknown Android tool.")
        }
    }

    private fun success() = JSONObject().put("success", true)
    private fun <T> withRoot(action: (AccessibilityNodeInfo) -> T): T {
        val root = rootInActiveWindow ?: error("No active window is available. Unlock the phone and open an app.")
        try { return action(root) } finally { root.recycle() }
    }

    private fun describe(node: AccessibilityNodeInfo): JSONObject {
        val bounds = Rect(); node.getBoundsInScreen(bounds)
        return JSONObject()
            .put("text", if (node.isPassword) "" else node.text?.toString().orEmpty())
            .put("contentDescription", if (node.isPassword) "" else node.contentDescription?.toString().orEmpty())
            .put("resourceId", node.viewIdResourceName.orEmpty())
            .put("className", node.className?.toString().orEmpty())
            .put("packageName", node.packageName?.toString().orEmpty())
            .put("bounds", JSONObject().put("left", bounds.left).put("top", bounds.top).put("right", bounds.right).put("bottom", bounds.bottom))
            .put("clickable", node.isClickable).put("editable", node.isEditable)
            .put("enabled", node.isEnabled).put("focused", node.isFocused)
            .put("scrollable", node.isScrollable).put("selected", node.isSelected)
            .put("checked", node.isChecked).put("visible", node.isVisibleToUser)
            .put("password", node.isPassword)
            .put("actions", JSONArray(node.actionList.map { it.id }))
    }

    private fun snapshot(flat: Boolean, clickableOnly: Boolean, limit: Int): JSONObject = withRoot { root ->
        val elements = JSONArray()
        var visited = 0
        var emitted = 0
        var truncated = false
        fun visit(node: AccessibilityNodeInfo, depth: Int): JSONObject? {
            if (visited >= 2000 || depth > 40 || emitted >= limit) { truncated = true; return null }
            visited++
            val include = !flat || node.isVisibleToUser && (!clickableOnly || node.isClickable)
            val item = if (include) describe(node).also { emitted++; if (flat) elements.put(it) } else null
            val children = JSONArray()
            for (i in 0 until node.childCount) {
                if (emitted >= limit || visited >= 2000) { truncated = true; break }
                val child = node.getChild(i) ?: continue
                try { visit(child, depth + 1)?.let(children::put) } finally { child.recycle() }
            }
            if (!flat) item?.put("children", children)
            return item
        }
        val tree = visit(root, 0)
        JSONObject().put(if (flat) "elements" else "tree", if (flat) elements else tree)
            .put("truncated", truncated).put("coordinateSpace", "screen pixels")
    }

    private fun select(root: AccessibilityNodeInfo, field: String, value: String): AccessibilityNodeInfo {
        require(value.isNotEmpty()) { "An element selector cannot be empty." }
        var found: AccessibilityNodeInfo? = null
        var visited = 0
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            check(++visited <= 2000 && depth <= 40) { "The window is too large to match safely. Use screen coordinates." }
            val matches = if (field == "resourceId") node.viewIdResourceName == value else !node.isPassword && node.text?.toString() == value
            if (node.isVisibleToUser && matches) {
                check(found == null) { "More than one element matches. Use a unique resource ID or screen coordinates." }
                found = AccessibilityNodeInfo.obtain(node)
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                try { visit(child, depth + 1) } finally { child.recycle() }
            }
        }
        try { visit(root, 0); return found ?: error("No visible element matches.") }
        catch (failure: Exception) { found?.recycle(); throw failure }
    }

    private fun checkCoordinates(x1: Double, y1: Double, x2: Double, y2: Double) {
        val bounds = getSystemService(android.view.WindowManager::class.java).maximumWindowMetrics.bounds
        require(listOf(x1, x2).all { it.isFinite() && it >= 0 && it < bounds.width() } &&
            listOf(y1, y2).all { it.isFinite() && it >= 0 && it < bounds.height() }) { "Coordinates must be inside the screen in pixels." }
    }

    private fun gesture(x1: Double, y1: Double, x2: Double = x1, y2: Double = y1, duration: Long = 80): JSONObject {
        val description = ui {
            checkCoordinates(x1, y1, x2, y2)
            val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); if (x1 != x2 || y1 != y2) lineTo(x2.toFloat(), y2.toFloat()) }
            GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build()
        }
        return dispatch(description)
    }

    private fun dispatch(description: GestureDescription): JSONObject {
        val result = CompletableFuture<Unit>()
        ui {
            check(dispatchGesture(description, object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { result.complete(Unit) }
                override fun onCancelled(gestureDescription: GestureDescription?) { result.completeExceptionally(IllegalStateException("Gesture was cancelled.")) }
            }, main)) { "Android did not accept the gesture." }
        }
        val duration = (0 until description.strokeCount).maxOf { description.getStroke(it).startTime + description.getStroke(it).duration }
        result.get(duration + 3000, TimeUnit.MILLISECONDS)
        return success()
    }

    internal fun deviceState(): JSONObject {
        val manager = getSystemService(KeyguardManager::class.java)
        val root = rootInActiveWindow
        val packageName = try { root?.packageName?.toString() } finally { root?.recycle() }
        return JSONObject().put("interactive", getSystemService(PowerManager::class.java).isInteractive)
            .put("keyguardLocked", manager.isKeyguardLocked).put("deviceSecure", manager.isDeviceSecure)
            .put("packageName", packageName ?: JSONObject.NULL)
    }

    private fun <T> systemWindows(action: (List<AccessibilityNodeInfo>) -> T): T {
        val roots = windows.mapNotNull { it.root }.toMutableList()
        if (roots.isEmpty()) rootInActiveWindow?.let(roots::add)
        try { return action(roots) } finally { roots.forEach { it.recycle() } }
    }

    private fun await(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs
        do {
            if (condition()) return true
            Thread.sleep(100)
        } while (android.os.SystemClock.elapsedRealtime() < deadline)
        return condition()
    }

    private fun wake(): JSONObject {
        val request = ui { WakeActivity.request(this) }
        if (!await(1000) { ui { getSystemService(PowerManager::class.java).isInteractive } }) {
            // OEM fallback only. Activity flags are preferred; this legacy flag is deprecated at API 33.
            ui {
                runCatching {
                    val power = getSystemService(PowerManager::class.java)
                    val lock = power.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "$packageName:wake")
                    lock.acquire(2000)
                    main.postDelayed({ if (lock.isHeld) lock.release() }, 1000)
                }
            }
        }
        await(2000) { request.isDone || ui { systemWindows(KeyguardPinPad::ready) } }
        return ui {
            val outcome = when {
                request.isDone -> request.getNow("error")
                systemWindows(KeyguardPinPad::ready) -> "bouncer_shown"
                else -> "dismissal_requested"
            }
            JSONObject().put("outcome", outcome).put("deviceState", deviceState())
        }
    }

    private fun unlock(): JSONObject {
        val store = PinStore(this)
        val outcome = PinUnlocker(store, object : PinUnlocker.Device {
            override val locked get() = ui { getSystemService(KeyguardManager::class.java).isKeyguardLocked }
            override fun wake() { this@DeviceAccessibilityService.wake() }
            override fun waitForPad() = await(5000) { !locked || ui { systemWindows(KeyguardPinPad::ready) } } && locked
            override fun hasEnteredText() = ui { systemWindows(KeyguardPinPad::hasEnteredText) }
            override fun clickDigit(digit: Char): Boolean {
                val accepted = ui { systemWindows { KeyguardPinPad.clickDigit(it, digit) } }
                Thread.sleep(100)
                return accepted
            }
            override fun confirm() { ui { systemWindows(KeyguardPinPad::confirm) } }
            override fun awaitUnlocked(timeoutMs: Long) = await(timeoutMs) { !locked }
        }).unlock()
        return ui { JSONObject().put("outcome", outcome).put("needsConfirmation", store.needsConfirmation).put("deviceState", deviceState()) }
    }

    private fun screenshot(): JSONObject {
        val result = CompletableFuture<Bitmap>()
        ui {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    val buffer = screenshot.hardwareBuffer
                    try {
                        val hardware = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace) ?: error("Screenshot could not be read.")
                        try {
                            val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false) ?: error("Screenshot could not be copied.")
                            if (!result.complete(bitmap)) bitmap.recycle()
                        } finally { hardware.recycle() }
                    } catch (failure: Exception) { result.completeExceptionally(failure) }
                    finally { buffer.close() }
                }
                override fun onFailure(errorCode: Int) {
                    result.completeExceptionally(IllegalStateException("Screenshot unavailable (Android code $errorCode). Protected screens cannot be captured; retry after a moment."))
                }
            })
        }
        val bitmap = try { result.get(10, TimeUnit.SECONDS) } finally { result.cancel(false) }
        try {
            val bytes = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, bytes)) { "Screenshot encoding failed." }
            return NodeProtocol.screenshot(Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP), bitmap.width, bitmap.height)
        } finally { bitmap.recycle() }
    }
}
