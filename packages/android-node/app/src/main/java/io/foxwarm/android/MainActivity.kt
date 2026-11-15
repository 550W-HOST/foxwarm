package io.foxwarm.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : ComponentActivity() {
    private lateinit var address: EditText
    private lateinit var nodeId: EditText
    private lateinit var credential: EditText
    private lateinit var status: TextView
    private lateinit var accessibility: TextView
    private lateinit var battery: TextView
    private lateinit var error: TextView
    private lateinit var connect: Button
    private lateinit var stop: Button
    private lateinit var scan: Button
    private lateinit var layout: LinearLayout
    private val preferences by lazy { NodePreferences(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val scanCode = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { text ->
            try { showPairing(Pairing.fromQr(text)); error.text = "QR code loaded. Check the server address, then Connect." }
            catch (_: Exception) { error.text = "This QR code does not contain a valid Foxwarm Node connection." }
        }
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        startConnection()
        if (!granted) error.text = "Notifications are off. Enable them in App settings to see connection status and Stop."
    }
    private val refresh = object : Runnable {
        override fun run() { updateStatus(); handler.postDelayed(this, 1000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(250, 248, 244)) }
        layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(24), dp(24), dp(24)) }
        scroll.addView(layout)
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(scroll)
        text("Foxwarm Node", 28)
        text("Connect this phone to your Main server.", 16)
        status = text("Stopped", 18)
        text("1 · Pair this phone", 20)
        text("In Foxwarm, open System → Nodes → New nodes → Android and create a credential. Scan its QR code or enter the three fields below.")
        scan = button("Scan QR code") {
            scanCode.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("Scan the Android Node QR code").setBeepEnabled(false))
        }
        address = field("Main server address", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        nodeId = field("Node ID", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        credential = field("Credential", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        preferences.load()?.let(::showPairing)
        text("Use HTTPS outside a trusted local network. This server can read and control your phone while connected.")
        text("2 · Allow device access", 20)
        accessibility = text("")
        button("Open Accessibility settings") { openSettings(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        text("On Android 13 or later, a sideloaded app may need one more step: open App info, tap ⋮, choose Allow restricted settings, then enable Foxwarm Node in Accessibility.")
        button("Open App info") { openSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
        battery = text("")
        button("Battery optimisation settings") { openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        text("Set Foxwarm Node to unrestricted battery use to help it stay connected. Some phones also have an auto-start setting.")
        text("3 · Connect", 20)
        error = text("").apply { setTextColor(Color.rgb(160, 40, 20)); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        connect = button("Connect") {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            else startConnection()
        }
        stop = button("Stop") {
            preferences.running = false
            stopService(Intent(this, NodeService::class.java))
            updateStatus()
        }
        text("Stop here or in the persistent notification. After restarting the phone, open this app and connect again.")
    }

    private fun startConnection() {
        try {
            val pairing = Pairing.manual(address.text.toString(), nodeId.text.toString(), credential.text.toString())
            check(DeviceAccessibilityService.current != null) { "Enable Foxwarm Node in Accessibility settings first." }
            preferences.save(pairing)
            startForegroundService(Intent(this, NodeService::class.java))
            error.text = ""
        } catch (failure: Exception) { error.text = failure.message ?: "Could not start the connection." }
        updateStatus()
    }

    private fun updateStatus() {
        status.text = NodeService.connectionStatus
        accessibility.text = if (DeviceAccessibilityService.current != null) "Accessibility enabled" else "Accessibility is off"
        battery.text = if (getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)) "Battery use is unrestricted" else "Battery optimisation is on"
        val running = NodeService.isRunning
        connect.isEnabled = !running
        stop.isEnabled = running
        listOf(address, nodeId, credential, scan).forEach { it.isEnabled = !running }
    }

    private fun showPairing(pairing: Pairing) {
        address.setText(pairing.baseUrl); nodeId.setText(pairing.nodeId); credential.setText(pairing.authToken)
    }
    private fun openSettings(intent: Intent) {
        try { startActivity(intent) } catch (_: Exception) { error.text = "Open this setting in the phone's Settings app." }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun text(value: String, size: Int = 14): TextView = TextView(this).apply {
        text = value; textSize = size.toFloat(); setTextColor(Color.rgb(45, 40, 35))
        setPadding(0, dp(10), 0, dp(8)); this@MainActivity.layout.addView(this)
    }
    private fun field(label: String, type: Int): EditText {
        text(label)
        return EditText(this).apply {
            hint = label; contentDescription = label; inputType = type
            isSingleLine = true; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            isSaveEnabled = false; this@MainActivity.layout.addView(this)
        }
    }
    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label; isAllCaps = false; setOnClickListener { action() }; this@MainActivity.layout.addView(this)
    }
    override fun onResume() { super.onResume(); handler.post(refresh) }
    override fun onPause() { handler.removeCallbacks(refresh); super.onPause() }
}
