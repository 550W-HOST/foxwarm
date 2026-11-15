package io.foxwarm.android

import android.view.accessibility.AccessibilityNodeInfo

/** Bounded, System UI-only node-action matching. Never inject coordinates or return PIN text. */
@Suppress("DEPRECATION")
object KeyguardPinPad {
    private const val SYSTEM_UI = "com.android.systemui"
    private val confirmIds = setOf("key_enter", "key_enter_button", "enter", "ok", "confirm_button", "pin_ok_button")
    private val confirmLabels = setOf("ok", "enter", "done", "confirm", "unlock", "确定", "确认")

    fun ready(roots: List<AccessibilityNodeInfo>): Boolean {
        if (hasSimChallenge(roots)) return false
        val keys = ('0'..'9').map { find(roots, it) }
        return try { keys.all { it != null } } finally { keys.forEach { it?.recycle() } }
    }

    fun clickDigit(roots: List<AccessibilityNodeInfo>, digit: Char): Boolean {
        val key = find(roots, digit) ?: return false
        return try { key.performAction(AccessibilityNodeInfo.ACTION_CLICK) } finally { key.recycle() }
    }

    fun confirm(roots: List<AccessibilityNodeInfo>): Boolean {
        val key = find(roots, null) ?: return false
        return try { key.performAction(AccessibilityNodeInfo.ACTION_CLICK) } finally { key.recycle() }
    }

    fun hasEnteredText(roots: List<AccessibilityNodeInfo>): Boolean {
        var entered = false
        walk(roots) { if (it.isPassword && !it.text.isNullOrEmpty()) entered = true }
        return entered
    }

    private fun hasSimChallenge(roots: List<AccessibilityNodeInfo>): Boolean {
        var found = false
        walk(roots) { node ->
            val identity = (node.viewIdResourceName.orEmpty() + " " + node.className?.toString().orEmpty()).lowercase().replace("_", "")
            if (node.isVisibleToUser && ("simpin" in identity || "simpuk" in identity)) found = true
        }
        return found
    }

    private fun find(roots: List<AccessibilityNodeInfo>, digit: Char?): AccessibilityNodeInfo? {
        if (hasSimChallenge(roots)) return null
        var rank = 0
        val matches = mutableListOf<AccessibilityNodeInfo>()
        try {
            walk(roots) { node ->
                if (!node.isVisibleToUser || node.isPassword) return@walk
                val id = node.viewIdResourceName?.substringAfterLast('/').orEmpty()
                val text = node.text?.toString()?.trim().orEmpty()
                val description = node.contentDescription?.toString()?.trim().orEmpty()
                val score = if (digit == null) {
                    when {
                        id in confirmIds -> 3
                        text.lowercase() in confirmLabels || description.lowercase() in confirmLabels -> 2
                        else -> 0
                    }
                } else {
                    when {
                        id in setOf("key$digit", "key_$digit", "digit$digit", "digit_$digit", "num$digit") -> 3
                        text == digit.toString() || description == digit.toString() -> 2
                        description.startsWith("$digit ") || description.startsWith("$digit,") -> 1
                        else -> 0
                    }
                }
                if (score == 0 || score < rank) return@walk
                val target = clickable(node) ?: return@walk
                if (score > rank) { matches.forEach { it.recycle() }; matches.clear(); rank = score }
                if (matches.any { it == target }) target.recycle() else matches.add(target)
            }
            return if (matches.size == 1) matches.removeAt(0) else null
        } finally { matches.forEach { it.recycle() } }
    }

    private fun clickable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var candidate = AccessibilityNodeInfo.obtain(node)
        repeat(4) {
            if (candidate.packageName?.toString() != SYSTEM_UI) { candidate.recycle(); return null }
            val supportsClick = candidate.isClickable || candidate.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK }
            if (candidate.isEnabled && candidate.isVisibleToUser && supportsClick) return candidate
            val parent = candidate.parent
            candidate.recycle()
            candidate = parent ?: return null
        }
        candidate.recycle()
        return null
    }

    private fun walk(roots: List<AccessibilityNodeInfo>, action: (AccessibilityNodeInfo) -> Unit) {
        var visited = 0
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            check(++visited <= 2000 && depth <= 40) { "System UI is too large to inspect safely." }
            if (node.packageName?.toString() != SYSTEM_UI) return
            action(node)
            for (index in 0 until node.childCount) {
                val child = node.getChild(index) ?: continue
                try { visit(child, depth + 1) } finally { child.recycle() }
            }
        }
        roots.forEach { visit(it, 0) }
    }
}
