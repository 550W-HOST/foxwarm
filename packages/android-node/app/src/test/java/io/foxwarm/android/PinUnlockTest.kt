package io.foxwarm.android

import android.content.Context
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import javax.crypto.KeyGenerator

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PinUnlockTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private fun store() = PinStore(context) { key }
    private val pin = "583719"

    @Before fun clear() {
        context.getSharedPreferences(PinStore.PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit()
        ShadowLog.clear()
    }

    @Test fun encryptedRoundTripConsumesPermissionAcrossStoreRecreation() {
        val store = store()
        assertFalse(store.enabled)
        assertThrows(IllegalStateException::class.java) { store.beginAttempt() }
        store.enable(pin.toCharArray())
        assertTrue(store.enabled)
        val persisted = context.getSharedPreferences(PinStore.PREFERENCES, Context.MODE_PRIVATE).all.toString()
        assertFalse(persisted.contains(pin))
        val retrieved = store.beginAttempt()
        assertArrayEquals(pin.toCharArray(), retrieved)
        retrieved.fill('\u0000')
        assertTrue(store().needsConfirmation)
        assertThrows(IllegalStateException::class.java) { store().beginAttempt() }
        store.enable(pin.toCharArray())
        assertFalse(store.needsConfirmation)
        store.disable()
        assertFalse(store().enabled)
        assertTrue(context.getSharedPreferences(PinStore.PREFERENCES, Context.MODE_PRIVATE).all.isEmpty())
    }

    private class Device : PinUnlocker.Device {
        override var locked = true
        var ready = true
        var entered = false
        var throwOnDigit = false
        var unlockOnConfirm = false
        var unlockOnLastDigit = false
        var wakeCount = 0
        var confirms = 0
        val digits = mutableListOf<Char>()
        override fun wake() { wakeCount++ }
        override fun waitForPad() = ready
        override fun hasEnteredText() = entered
        override fun clickDigit(digit: Char): Boolean {
            digits.add(digit)
            if (throwOnDigit) error("Sensitive platform detail: $digit")
            if (unlockOnLastDigit && digits.size == 6) locked = false
            return true
        }
        override fun confirm() { confirms++; if (unlockOnConfirm) locked = false }
        override fun awaitUnlocked(timeoutMs: Long) = !locked
    }

    @Test fun failedAttemptNeverRetriesAndRefusesUntilPinIsEnteredAgain() {
        val store = store(); store.enable(pin.toCharArray())
        val device = Device()
        val unlocker = PinUnlocker(store, device)
        val result = unlocker.unlock()
        assertEquals("failed", result)
        assertEquals(pin.toList(), device.digits)
        assertEquals(1, device.confirms)
        assertThrows(IllegalStateException::class.java) { unlocker.unlock() }
        assertEquals(1, device.wakeCount)
        assertEquals(6, device.digits.size)
        assertTrue(store().needsConfirmation)
        assertFalse(result.contains(pin))
        assertFalse(ShadowLog.getLogs().any { it.msg.contains(pin) })
        store.enable(pin.toCharArray())
        device.unlockOnConfirm = true
        assertEquals("unlocked", unlocker.unlock())
        assertFalse(store.needsConfirmation)
    }

    @Test fun autoConfirmSkipsEnterAndAnUnlockedPhoneDoesNotConsumeAnAttempt() {
        val store = store(); store.enable(pin.toCharArray())
        val device = Device().apply { unlockOnLastDigit = true }
        assertEquals("unlocked", PinUnlocker(store, device).unlock())
        assertEquals(0, device.confirms)
        assertFalse(store.needsConfirmation)
        assertEquals("already_unlocked", PinUnlocker(store, device).unlock())
        assertEquals(1, device.wakeCount)
    }

    @Test fun missingPadExistingInputAndMidEntryFailureStopWithoutRetry() {
        for (scenario in 0..2) {
            val store = store(); store.enable(pin.toCharArray())
            val device = Device().apply {
                ready = scenario != 0
                entered = scenario == 1
                throwOnDigit = scenario == 2
            }
            val result = PinUnlocker(store, device).unlock()
            assertEquals(if (scenario == 0) "pin_pad_unavailable" else "failed", result)
            assertTrue(store.needsConfirmation)
            assertEquals(if (scenario == 2) 1 else 0, device.digits.size)
            assertEquals(0, device.confirms)
            assertFalse(result.contains("Sensitive"))
        }
    }

    @Test fun keystoreFailuresAreSanitizedAndLeaveAttemptsBlocked() {
        store().enable(pin.toCharArray())
        val broken = PinStore(context) { error("secret $pin") }
        val result = PinUnlocker(broken, Device()).unlock()
        assertEquals("failed", result)
        assertTrue(broken.needsConfirmation)
        val failure = assertThrows(IllegalStateException::class.java) { broken.enable(pin.toCharArray()) }
        assertFalse(failure.toString().contains(pin))
        assertFalse(ShadowLog.getLogs().any { it.msg.contains(pin) })
    }
}
