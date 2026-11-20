package io.foxwarm.android

import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@Suppress("DEPRECATION")
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class KeyguardPinPadTest {
    private fun node(packageName: String = "com.android.systemui", clickable: Boolean = true) =
        AccessibilityNodeInfo.obtain(View(RuntimeEnvironment.getApplication())).apply {
            this.packageName = packageName
            isEnabled = true; isVisibleToUser = true; isClickable = clickable
        }

    @Test fun resourceIdsAndOemLabelsUseClickActionsOnly() {
        for (mode in 0..2) {
            val root = node(clickable = false)
            val clicked = mutableListOf<Char>()
            for (digit in '0'..'9') {
                val key = node().apply {
                    when (mode) {
                        0 -> viewIdResourceName = "com.android.systemui:id/key$digit"
                        1 -> text = digit.toString()
                        2 -> contentDescription = "$digit ABC"
                    }
                }
                shadowOf(key).setOnPerformActionListener { action, _ ->
                    assertEquals(AccessibilityNodeInfo.ACTION_CLICK, action)
                    clicked.add(digit)
                    true
                }
                shadowOf(root).addChild(key)
            }
            assertTrue(KeyguardPinPad.ready(listOf(root)))
            assertTrue(KeyguardPinPad.clickDigit(listOf(root), '4'))
            assertEquals(listOf('4'), clicked)
        }
    }

    @Test fun advertisedClickActionWorksWithoutTheClickableFlag() {
        val key = node(clickable = false).apply {
            viewIdResourceName = "com.android.systemui:id/key4"
            addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
        }
        var clicked = false
        shadowOf(key).setOnPerformActionListener { _, _ -> clicked = true; true }
        assertTrue(KeyguardPinPad.clickDigit(listOf(key), '4'))
        assertTrue(clicked)
    }

    @Test fun duplicateAndForeignKeysNeverReceiveClicks() {
        val foreign = node("other.app").apply { text = "4" }
        assertFalse(KeyguardPinPad.clickDigit(listOf(foreign), '4'))
        val root = node(clickable = false)
        repeat(2) { shadowOf(root).addChild(node().apply { text = "4" }) }
        assertFalse(KeyguardPinPad.clickDigit(listOf(root), '4'))
        assertFalse(KeyguardPinPad.ready(listOf(root)))
    }

    @Test fun simPinAndPukChallengesDoNotReceiveTheDevicePin() {
        for (entryId in listOf("simPinEntry", "simPukEntry")) {
            val root = node(clickable = false)
            shadowOf(root).addChild(node().apply { viewIdResourceName = "com.android.systemui:id/$entryId" })
            for (digit in '0'..'9') shadowOf(root).addChild(node().apply { viewIdResourceName = "com.android.systemui:id/key$digit" })
            assertFalse(KeyguardPinPad.ready(listOf(root)))
            assertFalse(KeyguardPinPad.clickDigit(listOf(root), '4'))
        }
    }

    @Test fun existingPasswordTextAndVisibleConfirmAreDetectedWithoutExportingText() {
        val root = node(clickable = false)
        shadowOf(root).addChild(node().apply { isPassword = true; text = "••" })
        var confirms = 0
        val enter = node().apply { viewIdResourceName = "com.android.systemui:id/key_enter" }
        shadowOf(enter).setOnPerformActionListener { action, _ ->
            assertEquals(AccessibilityNodeInfo.ACTION_CLICK, action)
            confirms++
            true
        }
        shadowOf(root).addChild(enter)
        assertTrue(KeyguardPinPad.hasEnteredText(listOf(root)))
        assertTrue(KeyguardPinPad.confirm(listOf(root)))
        assertEquals(1, confirms)
    }
}
