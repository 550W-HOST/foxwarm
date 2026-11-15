package io.foxwarm.android

import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class LifecycleTest {
    @Test fun servicesCanBeConstructedBeforeTheirContextIsAttached() {
        Robolectric.buildService(DeviceAccessibilityService::class.java).create().destroy()
        Robolectric.buildService(NodeService::class.java).create().destroy()
    }

    @Test fun savedRunningPreferenceDoesNotDisableConnectAfterProcessLoss() {
        val application = RuntimeEnvironment.getApplication()
        application.getSharedPreferences("node", Context.MODE_PRIVATE).edit().putBoolean("running", true).commit()
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup()
        try {
            fun children(view: View): Sequence<View> = sequence {
                yield(view)
                if (view is ViewGroup) for (i in 0 until view.childCount) yieldAll(children(view.getChildAt(i)))
            }
            val button = children(activity.get().window.decorView).filterIsInstance<Button>().single { it.text == "Connect" }
            assertTrue(button.isEnabled)
        } finally { activity.pause().stop().destroy() }
    }
}
