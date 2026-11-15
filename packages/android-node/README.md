# Foxwarm Android Node

A sideloadable Android app that connects a phone directly to a Foxwarm Main server. Android 11 (API 30) or later is required. It uses an accessibility service for device control and screenshots, and a user-started foreground service for the connection. Google Play Services, ADB and a host-side Python process are not required.

## Pair a phone

1. Install the debug APK from the Android Node CI artifact, or build it below.
2. In Foxwarm, open **System → Nodes → New nodes → Android**. Enter an address reachable from the phone and a Node ID, then choose **Create**.
3. In the app, scan the QR code or enter the Main server address, Node ID and credential manually. Check the address before connecting. Use HTTPS outside a trusted local network.
4. Enable **Foxwarm Node** in Android Accessibility settings. On Android 13 or later, a sideloaded app may first require **App info → ⋮ → Allow restricted settings**. The app links to both settings screens.
5. Set battery use to unrestricted and allow notifications. Choose **Connect**. The persistent notification shows connection state and has a **Stop** action.
6. Select the phone Node in Foxwarm and use its `android_*` tools.

The credential is the existing per-Node credential, not a WebUI login token. It is saved in app-private preferences, excluded from Android backup/device transfer, and reused on reconnect. Closing onboarding discards its displayed credential and QR code. After a phone reboot or force-stop, open the app and connect again. Network interruption uses exponential retry from one to sixty seconds; rejected credentials and incompatible protocols require operator action.

Accessibility grants the paired server access to screen contents and device actions. Only connect to a trusted server. The setup screen blocks screenshots because it contains credentials. Stop disconnects the Node; disabling accessibility removes device-control access.

## Tools

- `android_get_ui_tree`: bounded active-window hierarchy, with actions and screen-pixel bounds.
- `android_list_elements`: visible elements, optionally clickable only; default 200, maximum 500.
- `android_tap`: screen coordinates or an exact text/resource-ID match. Multiple matches fail.
- `android_swipe`: start/end screen coordinates and a duration in milliseconds.
- `android_input`: replace text in the focused editable field or an exact resource-ID match.
- `android_global_action`: back, home, recents or notifications.
- `android_current_app`: active-window package name.
- `android_launch_app`: launch an installed app by package name.
- `android_screenshot`: JPEG image plus the original width and height in screen pixels.

Screenshots use `AccessibilityService.takeScreenshot`, without MediaProjection consent. Main may resize the image for vision; use the returned original size when mapping coordinates. Protected content can block capture. Custom-rendered apps may expose little accessibility structure; coordinate gestures still depend on the visible screen. Text input uses Android's set-text action and reports unsupported fields. This app does not offer shell commands, force-stop, installation or lockscreen bypass.

## Build and test

Use JDK 17 and an Android SDK with `platforms;android-35` and `build-tools;35.0.0`. Set `JAVA_HOME` and `ANDROID_HOME` to those installations. The Gradle wrapper pins Gradle 8.11.1; Android Gradle Plugin is 8.9.2 and Kotlin is 2.1.10. The app targets API 35.

From the repository root:

```sh
packages/android-node/gradlew -p packages/android-node \
  :core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Output: `packages/android-node/app/build/outputs/apk/debug/app-debug.apk`. Gradle creates a local debug signing key automatically. CI builds the same debug variant and uploads it without signing secrets. Debug keys can differ between builds; uninstalling a differently signed APK erases its saved credential. Release signing and distribution are not configured.

`core` is the production JVM-compatible pairing/protocol/WebSocket client. Its tests exercise registration, protocol negotiation, result/error correlation, heartbeat, reconnect, stale-work fencing and quarantine. Robolectric checks Android component startup and connection controls after process loss. Neither test environment substitutes for physical-device qualification.

After building the repository's Main and runtime assets with `npm run build`, run the owned-process integration test:

```sh
node packages/android-node/node-test/main-host.mjs
```

This launches a disposable Main and the actual JVM Node client with synthetic device operations. It exercises the QR credential, a deployment-prefixed WebSocket endpoint, protocol 3, ordinary results/errors, image history and reconnect after Main restart. It uses separate temporary data and no running installation. `FOXWARM_ANDROID_GRADLE` can select a local Gradle executable instead of the wrapper.

See [phone testing](PHONE-TESTING.md) for the device acceptance checklist.
