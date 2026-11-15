package io.foxwarm.android

/** One submitted PIN at most. The store consumes permission before waking or reading System UI. */
class PinUnlocker(private val store: PinStore, private val device: Device) {
    interface Device {
        val locked: Boolean
        fun wake()
        fun waitForPad(): Boolean
        fun hasEnteredText(): Boolean
        fun clickDigit(digit: Char): Boolean
        fun confirm()
        fun awaitUnlocked(timeoutMs: Long): Boolean
    }

    fun unlock(): String {
        check(store.enabled) { "PIN unlock is off." }
        check(!store.needsConfirmation) { "Enter the PIN again in the app before another attempt." }
        if (!device.locked) return "already_unlocked"
        var pin: CharArray? = null
        try {
            pin = store.beginAttempt()
            device.wake()
            if (device.waitForPad()) {
                check(!device.hasEnteredText())
                for (digit in pin) check(device.clickDigit(digit))
                if (!device.awaitUnlocked(800)) device.confirm()
                if (device.awaitUnlocked(2500)) {
                    store.completeAttempt()
                    return "unlocked"
                }
            } else if (!device.locked) {
                store.completeAttempt()
                return "unlocked"
            } else return "pin_pad_unavailable"
        } catch (_: Exception) {
            // Platform and keystore errors may contain sensitive values; never publish them.
        } finally { pin?.fill('\u0000') }
        return "failed"
    }
}
