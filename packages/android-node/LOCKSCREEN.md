# Android lock-screen implementation notes

The app supports API 30–35. Physical-phone behavior is qualified by [PHONE-TESTING.md](PHONE-TESTING.md), including AOD and OEM lock screens.

## Background launch and wake

The current Android [activity security guide](https://developer.android.com/guide/components/activities/secure-bal) permits background launches when a bound service has the corresponding launch privileges. AOSP binds accessibility services with `BIND_ALLOW_BACKGROUND_ACTIVITY_STARTS` in `AccessibilityServiceConnection.bindLocked`:

- [Android 11 / API 30](https://android.googlesource.com/platform/frameworks/base/+/android-11.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
- [Android 12 / API 31](https://android.googlesource.com/platform/frameworks/base/+/android-12.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
- [Android 12L / API 32](https://android.googlesource.com/platform/frameworks/base/+/android-12.1.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
- [Android 13 / API 33](https://android.googlesource.com/platform/frameworks/base/+/android-13.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
- [Android 14 / API 34](https://android.googlesource.com/platform/frameworks/base/+/android-14.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)
- [Android 15 / API 35](https://android.googlesource.com/platform/frameworks/base/+/android-15.0.0_r1/services/accessibility/java/com/android/server/accessibility/AccessibilityServiceConnection.java)

`DeviceAccessibilityService` directly starts the private `WakeActivity`; it does not delegate a PendingIntent. The Android 14 sender and Android 15 creator PendingIntent opt-ins therefore do not apply to this call path. The foreground connection service by itself does not grant background activity launch privileges.

The Activity uses `setShowWhenLocked(true)` and `setTurnScreenOn(true)`. [KeyguardManager.requestDismissKeyguard](https://developer.android.com/reference/android/app/KeyguardManager#requestDismissKeyguard(android.app.Activity,%20android.app.KeyguardManager.KeyguardDismissCallback)) requires a visible Activity, including one visible over the keyguard. A secure, untrusted device opens credential UI; an insecure or trusted keyguard may dismiss immediately. Callbacks indicate dismissal, cancellation or error. There is no callback for “bouncer shown”: the app reports that outcome only when its accessibility reader sees a numeric PIN pad. A pending request without an observed numeric pad is `dismissal_requested`.

If the display remains non-interactive, a bounded wake lock uses `SCREEN_BRIGHT_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP`. The [PowerManager reference](https://developer.android.com/reference/android/os/PowerManager#ACQUIRE_CAUSES_WAKEUP) deprecates this flag from API 33 in favor of Activity screen-on flags and says future releases require `TURN_SCREEN_ON`. The manifest declares `WAKE_LOCK` and the API 34 `TURN_SCREEN_ON` permission. [AOSP defines the latter as signature/privileged/appop](https://android.googlesource.com/platform/frameworks/base/+/android-14.0.0_r1/core/res/AndroidManifest.xml), so declaration does not grant it to an ordinary sideloaded app. The Activity path is primary; a denied fallback returns the observed screen state rather than claiming that the phone woke. OEM permission or background policy failures must be checked on the phone.

## PIN handling

The encrypted PIN and attempt permission are app-private and excluded from backup/device transfer. AES-GCM uses an Android Keystore key that is available to the app while locked, because a user-authentication-bound key would prevent the opted-in background unlock. Screen-lock confirmation gates configuration access instead. This allows the paired server to unlock the device while enabled; only enable it for a trusted server.

The bridge never accepts a PIN parameter or serializes the stored PIN. The settings Activity blocks this app's device tools before opening system confirmation, so the stored PIN cannot satisfy its own configuration authorization. The editing window closes when the authenticated Activity leaves the foreground.

Digit lookup stays inside `com.android.systemui`, prefers known numeric-key resource IDs, and falls back to visible text or digit-leading content descriptions. It clicks a unique enabled accessibility node or a nearby clickable parent. A complete numeric pad is required before entry; observed prefilled password text causes refusal. A visible confirm key is clicked only if the keyguard remains after digit entry. Known System UI SIM PIN/PUK entry views are rejected so the device PIN is not sent to the SIM. Unknown or ambiguous layouts fail without coordinate guesses.

The persisted permission is consumed before waking or typing. Failure, interruption or process death requires the user to enter the PIN again through protected settings. Only verified keyguard disappearance restores permission. Android/OEM lockout policies still apply to the single submitted attempt.
