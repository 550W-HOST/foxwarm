package io.foxwarm.android

import android.app.KeyguardManager
import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.Button
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.view.WindowManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class ScreenControlTest {
    @Test fun gesturesHaveOneHoldOrTwoNonOverlappingTaps() {
        val hold = ScreenGestures.hold(120f, 240f, 850)
        assertEquals(1, hold.strokeCount)
        assertEquals(850L, hold.getStroke(0).duration)
        val double = ScreenGestures.doubleTap(120f, 240f, 140)
        assertEquals(2, double.strokeCount)
        assertEquals(0L, double.getStroke(0).startTime)
        assertEquals(140L, double.getStroke(1).startTime - double.getStroke(0).duration)
        assertEquals(ScreenGestures.TAP_MS, double.getStroke(1).duration)
        assertThrows(IllegalArgumentException::class.java) { ScreenGestures.hold(0f, 0f, 0) }
        assertThrows(IllegalArgumentException::class.java) { ScreenGestures.doubleTap(0f, 0f, 0) }
    }

    @Test fun deviceStateReadsPowerAndKeyguardWithoutAnActiveWindow() {
        val controller = Robolectric.buildService(DeviceAccessibilityService::class.java).create()
        try {
            val service = controller.get()
            shadowOf(service.getSystemService(PowerManager::class.java)).setIsInteractive(false)
            val keyguard = shadowOf(service.getSystemService(KeyguardManager::class.java))
            keyguard.setKeyguardLocked(true)
            keyguard.setIsDeviceSecure(true)
            val state = service.deviceState()
            assertFalse(state.getBoolean("interactive"))
            assertTrue(state.getBoolean("keyguardLocked"))
            assertTrue(state.getBoolean("deviceSecure"))
            assertTrue(state.isNull("packageName"))
        } finally { controller.destroy() }
    }

    @Test fun credentialFlowBlocksRemoteToolsAndProtectsTheWindow() {
        val context = RuntimeEnvironment.getApplication()
        val keyguard = shadowOf(context.getSystemService(KeyguardManager::class.java))
        keyguard.setIsDeviceSecure(true)
        val settings = Robolectric.buildActivity(PinSettingsActivity::class.java).setup()
        val service = Robolectric.buildService(DeviceAccessibilityService::class.java).create()
        try {
            assertTrue(PinSettingsActivity.active)
            assertTrue(settings.get().window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            assertThrows(IllegalStateException::class.java) { service.get().execute("android_unlock", JSONObject()) }
            assertThrows(IllegalStateException::class.java) { service.get().execute("android_get_ui_tree", JSONObject()) }
            assertFalse(PinStore(context).enabled)
        } finally { settings.pause().stop().destroy(); service.destroy() }
        assertFalse(PinSettingsActivity.active)
    }

    @Test fun settingsControlsRequireSuccessfulSystemConfirmation() {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(context.getSystemService(KeyguardManager::class.java)).setIsDeviceSecure(true)
        val settings = Robolectric.buildActivity(PinSettingsActivity::class.java).setup()
        try {
            fun children(view: View): Sequence<View> = sequence {
                yield(view)
                if (view is ViewGroup) for (index in 0 until view.childCount) yieldAll(children(view.getChildAt(index)))
            }
            val activity = settings.get()
            assertFalse(children(activity.window.decorView).any { it is EditText })
            val confirmation = shadowOf(activity).nextStartedActivityForResult
            assertNotNull(confirmation)
            shadowOf(activity).receiveResult(confirmation.intent, Activity.RESULT_OK, null)
            val input = children(activity.window.decorView).filterIsInstance<EditText>().single()
            assertFalse(input.isSaveEnabled)
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, (input.parent as View).importantForAccessibility)
            assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, input.importantForAutofill)
            assertTrue(PinSettingsActivity.active)
            val cancel = children(activity.window.decorView).filterIsInstance<Button>().single { it.text == "Cancel" }
            cancel.performClick()
            assertTrue(activity.isFinishing)
        } finally { settings.pause().stop().destroy() }
    }

    @Test fun closingOneSettingsInstanceDoesNotUnpauseAnother() {
        val first = Robolectric.buildActivity(PinSettingsActivity::class.java).create()
        val second = Robolectric.buildActivity(PinSettingsActivity::class.java).create()
        first.destroy()
        assertTrue(PinSettingsActivity.active)
        second.destroy()
        assertFalse(PinSettingsActivity.active)
    }

    @Test fun wakeUsesPrivateActivityAndCallbackOutcome() {
        val context = RuntimeEnvironment.getApplication()
        val keyguard = shadowOf(context.getSystemService(KeyguardManager::class.java))
        keyguard.setKeyguardLocked(false)
        val result = WakeActivity.request(context)
        val started = shadowOf(context).nextStartedActivity
        assertEquals(WakeActivity::class.java.name, started.component?.className)
        assertTrue(started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        val activity = Robolectric.buildActivity(WakeActivity::class.java, started).setup()
        try { assertEquals("dismissed", result.getNow(null)) }
        finally { activity.pause().stop().destroy() }
    }
}
