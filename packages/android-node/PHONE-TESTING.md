# Real-phone acceptance checklist

Record the phone model, Android version, display resolution and APK version. Use a test Main server and non-sensitive apps. The automated tests qualify the transport and component startup; these checks qualify Android/OEM behavior.

## Installation and setup

- [ ] Install the APK on Android 11 or later. Launch Foxwarm Node; the setup page fits with status/navigation bars and the keyboard visible.
- [ ] Create an Android Node in System → Nodes → New nodes. Scan its QR code. Confirm the displayed address and Node ID match. Check manual entry with a separate test Node.
- [ ] Camera permission denial leaves manual entry usable. A non-Foxwarm QR code shows an error without replacing the current connection.
- [ ] Enable accessibility. On Android 13+, follow Allow restricted settings if Android blocks the sideloaded app. Return to the app and confirm Accessibility enabled.
- [ ] Open battery settings and select unrestricted battery use. Allow notifications, connect, and confirm the Node appears online in Foxwarm with its 14 base Android tools.

## Device tools

- [ ] Open Settings or another non-sensitive app. Read the UI tree and visible elements. Compare labels, package name and screen-pixel bounds with the phone.
- [ ] Tap a unique resource ID/text selector, then a coordinate. An ambiguous selector must report multiple matches without clicking.
- [ ] Swipe vertically and horizontally, including after rotating the screen. Check coordinate edges and duration.
- [ ] Focus an editable test field. Replace its text, including Unicode. Target a field by resource ID and verify the correct field changes. An unsupported field should return an error.
- [ ] Run back, home, recents and notifications. Launch Settings by package name and confirm current app reports the active-window package.
- [ ] Capture a screenshot in portrait and landscape. Check that Foxwarm renders it as an image and gives the original screen dimensions. Verify a coordinate derived from that pixel space taps the expected place.
- [ ] Capture the app's protected setup screen or another protected screen. Expect a capture error rather than exposed protected content. Do not use sensitive screenshots in reports.

## Lock screen and gestures

- [ ] On a non-sensitive screen, hold with `android_long_press` at the default and a custom duration. Check the expected long-click UI opens.
- [ ] Double-tap a known double-tap target using `android_double_tap` with `intervalMs: 100`, then 200. Check two taps arrive in order with a gap, rather than two simultaneous touches.
- [ ] Check `android_device_state` while unlocked, on a lit lock screen, with the screen off, and in always-on display (AOD). Confirm `interactive`, `keyguardLocked`, `deviceSecure` and the active package against the phone. AOD should remain non-interactive even if a clock is visible.
- [ ] Call `android_lock` from an unlocked app. Verify the phone locks and the returned state reflects it.
- [ ] Call `android_wake` from screen-off and AOD, including while the connection app is backgrounded. Confirm the display turns on without a physical button.
- [ ] On HyperOS and another available Android build, call `android_wake` from the lit lock screen. Confirm the credential prompt opens without a swipe. Record its outcome and state, including any OEM background-launch permission needed.
- [ ] Repeat wake with a non-secure screen lock and with a secure PIN lock. Check dismiss/cancel/error outcomes against the phone. For a pattern/password lock, a pending request may remain `dismissal_requested` because only a numeric pad is detected.

## Optional on-device PIN unlock

Use a test PIN and a phone without a destructive failed-attempt policy. Never include the PIN in reports, tool inputs or screenshots.

- [ ] Fresh install: PIN unlock is off and `android_unlock` is absent from the Node's tools.
- [ ] Open Manage PIN unlock. Android requires screen-lock confirmation before showing controls. Cancel; the setting stays unchanged. Try remote tree, tap, input and unlock calls during confirmation and settings; all are refused.
- [ ] After local confirmation, enable with the current numeric PIN. The field is hidden from screenshots and accessibility, and does not survive recreation. Verify the Node reconnects once and adds `android_unlock`.
- [ ] Lock and run `android_unlock`: screen-off/AOD wake, prompt opening, digit node clicks, optional confirm, and keyguard disappearance all work. Test both auto-confirm and confirm-button configurations when available.
- [ ] After success, another lock/unlock call works. Confirm the returned object and connection logs contain only outcomes and state, never the PIN or its digits.
- [ ] With a deliberately incorrect saved test PIN, make exactly one call. Check there is one attempt and no retry. A second call must refuse before typing; it must still refuse after app process restart. Locally confirm the screen lock and enter the correct PIN again to restore permission.
- [ ] Check an unavailable PIN pad or interrupted attempt also requires entering the PIN again. A partially filled pad must not receive appended digits.
- [ ] Change the PIN through protected settings and disable the feature. Saving an enabled PIN should not reconnect solely because the PIN changed; disabling reconnects once and removes the tool. Subsequent direct calls to `android_unlock` refuse.

## Debug signing continuity

- [ ] Install a debug APK from one build workspace, pair it and enable accessibility. Upgrade in place with a debug APK from another workspace or CI; pairing and settings remain intact.
- [ ] Confirm the debug app is labeled Foxwarm Node (Debug), uses `io.foxwarm.android.debug`, and can coexist with an unsuffixed release installation. An older unsuffixed debug APK does not share pairing data with the new debug identity.

## Lifecycle

- [ ] Turn Wi-Fi off and on. Observe reconnect/backoff and verify a tool works again without re-pairing.
- [ ] Restart the test Main server. The phone reconnects with the saved credential.
- [ ] Leave the app in the background and remove it from recents. Check connection and device tools after 10 minutes; record any OEM auto-start setting needed.
- [ ] Use Stop in the notification and in the app. The Node goes offline and Connect becomes available. Reconnect without entering credentials again.
- [ ] Disable accessibility while connected. Tool calls report that accessibility must be enabled; re-enable it and try again.
- [ ] Force-stop or reboot the phone. Open the app, confirm the saved fields and tap Connect. Automatic boot startup is not configured.
- [ ] Remove the test Node in Main. Confirm its old credential cannot register again. Create a fresh Node credential, stop the app connection, replace the fields and reconnect.

Report failures with the operation, observed app/Node state, Android version and reproducible steps. Keep QR codes, credentials and private screen contents out of screenshots and logs shared with others.
