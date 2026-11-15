package io.foxwarm.android

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CompletableFuture

/** Android must see an Activity visible over the keyguard to accept requestDismissKeyguard. */
class WakeActivity : Activity() {
    companion object {
        private var pending: CompletableFuture<String>? = null
        private var current: WakeActivity? = null

        // All access is on the main thread. The tool executor serializes wake/unlock requests.
        fun request(context: Context): CompletableFuture<String> {
            current?.finish()
            pending?.complete("cancelled")
            val result = CompletableFuture<String>()
            pending = result
            try {
                context.startActivity(Intent(context, WakeActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))
            } catch (_: Exception) {
                result.complete("error")
                pending = null
            }
            return result
        }
    }
    private val handler = Handler(Looper.getMainLooper())
    private var result: CompletableFuture<String>? = null
    private var requested = false
    private val expire = Runnable { result?.complete("cancelled"); finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        result = pending
        pending = null
        if (result == null || PinSettingsActivity.active) { finish(); return }
        current = this
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        handler.postDelayed(expire, 20_000)
    }

    override fun onPostResume() {
        super.onPostResume()
        if (result == null || result!!.isDone || requested) return
        requested = true
        val manager = getSystemService(KeyguardManager::class.java)
        if (!manager.isKeyguardLocked) { result?.complete("dismissed"); finish(); return }
        manager.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() { result?.complete("dismissed"); finish() }
            override fun onDismissCancelled() { result?.complete("cancelled"); finish() }
            override fun onDismissError() { result?.complete("error"); finish() }
        })
    }

    override fun onDestroy() {
        handler.removeCallbacks(expire)
        result?.complete("cancelled")
        if (current === this) current = null
        super.onDestroy()
    }
}
