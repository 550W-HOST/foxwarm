package io.foxwarm.android

import android.app.KeyguardManager
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ScrollView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** Non-exported, credential-gated settings. Our remote bridge is suspended throughout this flow. */
class PinSettingsActivity : ComponentActivity() {
    companion object {
        @Volatile private var openActivities = 0
        val active get() = openActivities > 0
    }
    private val store by lazy { PinStore(this) }
    private var authenticated = false
    private val confirm = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            authenticated = true
            showSettings()
        } else finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        openActivities++
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val manager = getSystemService(KeyguardManager::class.java)
        @Suppress("DEPRECATION")
        val intent = manager.createConfirmDeviceCredentialIntent("Manage PIN unlock", "Confirm your screen lock to view or change PIN unlock.")
        if (intent == null) {
            setContentView(TextView(this).apply { text = "Set a screen lock PIN in Android Settings first." })
        } else if (savedInstanceState == null) confirm.launch(intent)
        // Recreation abandons the settings flow; never persist or restore authentication.
        else finish()
    }

    private fun showSettings() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        fun text(value: String) = TextView(this).apply { text = value; textSize = 18f; layout.addView(this) }
        fun button(value: String, action: () -> Unit) = Button(this).apply {
            text = value; isAllCaps = false; setOnClickListener { action() }; layout.addView(this)
        }
        text("PIN unlock")
        text(if (!store.enabled) "Off" else if (store.needsConfirmation) "Enter the PIN again to allow another attempt" else "On")
        text("Enter your current numeric device PIN. After any unsuccessful unlock attempt, enter it again here before retrying.")
        val input = EditText(this).apply {
            hint = "Device PIN"
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(InputFilter.LengthFilter(64))
            isSingleLine = true
            isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            layout.addView(this)
        }
        val error = text("")
        button("Save and enable") {
            val pin = CharArray(input.length()) { input.text[it] }
            try {
                check(authenticated) { "Screen lock confirmation is required." }
                store.enable(pin)
                input.text.clear()
                finish()
            } catch (failure: Exception) { error.text = failure.message }
            finally { pin.fill('\u0000') }
        }
        button("Turn off") {
            try { store.disable(); input.text.clear(); finish() }
            catch (_: Exception) { error.text = "Could not save PIN unlock settings." }
        }
        button("Cancel") { input.text.clear(); finish() }
        val scroll = ScrollView(this).apply { addView(layout) }
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
    }

    override fun onStop() {
        super.onStop()
        // Leaving authenticated settings closes the authorization window.
        if (authenticated) finish()
    }
    override fun onDestroy() { openActivities--; authenticated = false; super.onDestroy() }
}
