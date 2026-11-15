package io.foxwarm.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** No PIN is exposed through preferences, status, exceptions or the Node protocol. */
class PinStore(context: Context, private val key: () -> SecretKey = ::androidKey) {
    companion object {
        const val PREFERENCES = "pin_unlock"
        const val ENABLED = "enabled"
        private const val ALIAS = "foxwarm.pin-unlock"
        private val lock = Any()
        private fun androidKey(): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            }.generateKey()
        }
    }
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val enabled: Boolean get() = preferences.getBoolean(ENABLED, false)
    val needsConfirmation: Boolean get() = preferences.getBoolean("needs_confirmation", false)

    fun enable(pin: CharArray) = synchronized(lock) {
        require(pin.size in 4..64 && pin.all { it in '0'..'9' }) { "Use a numeric PIN with at least four digits." }
        val bytes = ByteArray(pin.size) { pin[it].code.toByte() }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val encrypted = cipher.doFinal(bytes)
            check(preferences.edit().putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putBoolean(ENABLED, true).putBoolean("needs_confirmation", false).commit())
        } catch (_: Exception) {
            throw IllegalStateException("Could not save PIN unlock settings.")
        } finally { bytes.fill(0) }
    }

    fun disable() = synchronized(lock) {
        check(preferences.edit().clear().commit()) { "Could not save PIN unlock settings." }
    }

    /** Consume permission before any device effects; crashes and interrupted attempts also require confirmation. */
    fun beginAttempt(): CharArray = synchronized(lock) {
        check(enabled) { "PIN unlock is off." }
        check(!needsConfirmation) { "Enter the PIN again in the app before another attempt." }
        check(preferences.edit().putBoolean("needs_confirmation", true).commit()) { "Could not start PIN unlock." }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP)))
            val bytes = cipher.doFinal(Base64.decode(preferences.getString("ciphertext", ""), Base64.NO_WRAP))
            try { CharArray(bytes.size) { bytes[it].toInt().toChar() } } finally { bytes.fill(0) }
        } catch (_: Exception) { throw IllegalStateException("Enter the PIN again in the app before another attempt.") }
    }

    fun completeAttempt() = synchronized(lock) {
        check(preferences.edit().putBoolean("needs_confirmation", false).commit()) { "Could not save PIN unlock settings." }
    }
}
