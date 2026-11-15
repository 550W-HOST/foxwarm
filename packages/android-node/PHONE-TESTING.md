# Real-phone acceptance checklist

Record the phone model, Android version, display resolution and APK version. Use a test Main server and non-sensitive apps. The automated tests qualify the transport and component startup; these checks qualify Android/OEM behavior.

## Installation and setup

- [ ] Install the APK on Android 11 or later. Launch Foxwarm Node; the setup page fits with status/navigation bars and the keyboard visible.
- [ ] Create an Android Node in System → Nodes → New nodes. Scan its QR code. Confirm the displayed address and Node ID match. Check manual entry with a separate test Node.
- [ ] Camera permission denial leaves manual entry usable. A non-Foxwarm QR code shows an error without replacing the current connection.
- [ ] Enable accessibility. On Android 13+, follow Allow restricted settings if Android blocks the sideloaded app. Return to the app and confirm Accessibility enabled.
- [ ] Open battery settings and select unrestricted battery use. Allow notifications, connect, and confirm the Node appears online in Foxwarm with its nine Android tools.

## Device tools

- [ ] Open Settings or another non-sensitive app. Read the UI tree and visible elements. Compare labels, package name and screen-pixel bounds with the phone.
- [ ] Tap a unique resource ID/text selector, then a coordinate. An ambiguous selector must report multiple matches without clicking.
- [ ] Swipe vertically and horizontally, including after rotating the screen. Check coordinate edges and duration.
- [ ] Focus an editable test field. Replace its text, including Unicode. Target a field by resource ID and verify the correct field changes. An unsupported field should return an error.
- [ ] Run back, home, recents and notifications. Launch Settings by package name and confirm current app reports the active-window package.
- [ ] Capture a screenshot in portrait and landscape. Check that Foxwarm renders it as an image and gives the original screen dimensions. Verify a coordinate derived from that pixel space taps the expected place.
- [ ] Capture the app's protected setup screen or another protected screen. Expect a capture error rather than exposed protected content. Do not use sensitive screenshots in reports.

## Lifecycle

- [ ] Turn Wi-Fi off and on. Observe reconnect/backoff and verify a tool works again without re-pairing.
- [ ] Restart the test Main server. The phone reconnects with the saved credential.
- [ ] Leave the app in the background and remove it from recents. Check connection and device tools after 10 minutes; record any OEM auto-start setting needed.
- [ ] Use Stop in the notification and in the app. The Node goes offline and Connect becomes available. Reconnect without entering credentials again.
- [ ] Disable accessibility while connected. Tool calls report that accessibility must be enabled; re-enable it and try again.
- [ ] Force-stop or reboot the phone. Open the app, confirm the saved fields and tap Connect. Automatic boot startup is not configured.
- [ ] Remove the test Node in Main. Confirm its old credential cannot register again. Create a fresh Node credential, stop the app connection, replace the fields and reconnect.

Report failures with the operation, observed app/Node state, Android version and reproducible steps. Keep QR codes, credentials and private screen contents out of screenshots and logs shared with others.
