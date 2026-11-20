package io.foxwarm.android

import android.accessibilityservice.GestureDescription
import android.graphics.Path

object ScreenGestures {
    const val TAP_MS = 60L
    fun hold(x: Float, y: Float, durationMs: Long): GestureDescription {
        require(durationMs in 100..5000) { "durationMs must be between 100 and 5000." }
        return GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(point(x, y), 0, durationMs)).build()
    }
    fun doubleTap(x: Float, y: Float, intervalMs: Long): GestureDescription {
        require(intervalMs in 40..300) { "intervalMs must be between 40 and 300." }
        return GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(point(x, y), 0, TAP_MS))
            .addStroke(GestureDescription.StrokeDescription(point(x, y), TAP_MS + intervalMs, TAP_MS)).build()
    }
    private fun point(x: Float, y: Float) = Path().apply { moveTo(x, y) }
}
