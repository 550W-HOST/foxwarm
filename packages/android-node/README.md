# Foxwarm Android Node

A sideloadable Android app that connects a phone directly to a Foxwarm Main server. Android 11 (API 30) or later is required. It uses an accessibility service for device control and screenshots, and a user-started foreground service for the connection. Google Play Services, ADB and a host-side Python process are not required.

## Pair a phone

1. Download the release APK from [foxwarm.net/android](https://foxwarm.net/android), or scan the download QR code in WebUI onboarding. Open it and allow your browser to install apps when prompted.
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
- `android_long_press`: hold screen coordinates for 100–5000 ms (default 600).
- `android_double_tap`: two coordinate taps with a 40–300 ms gap (default 100), dispatched as one gesture.
- `android_device_state`: screen interactive, keyguard showing, screen-lock security and active package.
- `android_wake`: turn on the display and ask Android to dismiss the keyguard or show its credential prompt.
- `android_lock`: use Android's accessibility lock-screen action.
- `android_unlock`: one attempt using the on-device numeric PIN; declared only when enabled in the app.
- `android_input`: replace text in the focused editable field or an exact resource-ID match.
- `android_global_action`: back, home, recents or notifications.
- `android_current_app`: active-window package name.
- `android_launch_app`: launch an installed app by package name.
- `android_screenshot`: JPEG image plus the original width and height in screen pixels.

Screenshots use `AccessibilityService.takeScreenshot`, without MediaProjection consent. Main may resize the image for vision; use the returned original size when mapping coordinates. Protected content can block capture. Custom-rendered apps may expose little accessibility structure; coordinate gestures still depend on the visible screen. Text input uses Android's set-text action and reports unsupported fields. This app does not offer shell commands, force-stop or installation.

## Optional PIN unlock

PIN unlock is off by default. Open **Manage PIN unlock** on the phone and confirm its screen lock before viewing or changing the setting. Enter the current numeric PIN there to enable it. Patterns, passwords and biometrics are not supported. The app never displays the saved PIN. Its remote device tools are paused for the entire credential-confirmation and settings flow.

The PIN is AES-GCM encrypted using an Android Keystore key in private, backup-excluded storage. It never enters the Node protocol, tool results or logs. `android_unlock` wakes the phone, requests the credential prompt, finds the System UI digit keys and invokes accessibility click actions. It presses a visible confirm key if needed and verifies that the keyguard is gone. It does not inject the PIN through coordinate taps or generic text input.

Each call permits one attempt. An unsuccessful or interrupted attempt disables further attempts until the PIN is entered again through the protected app settings. There is no automatic retry. Enabling or disabling the setting reconnects the Node once to update its declared tools; ordinary attempts and status refreshes do not change its capabilities.

`android_wake` reports `dismissed`, `bouncer_shown`, `cancelled`, `error` or `dismissal_requested`, together with device state. Android supplies success/cancel/error callbacks; `bouncer_shown` means the numeric pad was observed through accessibility. `dismissal_requested` means the request is still pending and no numeric pad was observed. A secure screenshot can be black even when the display is interactive, so use `android_device_state` to inspect screen/keyguard state. OEM gesture acceptance does not establish that a lock screen reacted to the gesture.

## Build and test

Use JDK 17 and an Android SDK with `platforms;android-35` and `build-tools;35.0.0`. Set `JAVA_HOME` and `ANDROID_HOME` to those installations. The Gradle wrapper pins Gradle 8.11.1; Android Gradle Plugin is 8.9.2 and Kotlin is 2.1.10. The app targets API 35.

From the repository root:

```sh
packages/android-node/gradlew -p packages/android-node \
  :core:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Output: `packages/android-node/app/build/outputs/apk/debug/app-debug.apk`. All debug builds use the committed [debug-only signing key](signing/README.md), application ID `io.foxwarm.android.debug` and label **Foxwarm Node (Debug)**. CI and local APKs can upgrade that installation in place. An older unsuffixed debug installation is separate and the new app needs pairing once. Debug and release app IDs coexist; never use the public debug key for release signing. Public releases use a dedicated release key; switching between the debug and release apps means pairing each once. See the [installation guide](https://foxwarm.net/docs/installing/#android-node) for the release certificate fingerprint.

The Release workflow also assembles the release variant. By default, it is debug-signed and named `<root package version>-dev`. Tagged builds pass `-PreleaseVersion=<version>` and produce `app-release-unsigned.apk`, which the workflow signs and verifies before publication. An explicit signing qualification uses `-PreleaseSigning=true` without a release version and produces an unsigned `-dev` APK for the same signing step. See the [release contract](../../docs/code-index/units/release-packages.md#android-node-apk) for version codes, secrets and certificate checks.

`core` is the production JVM-compatible pairing/protocol/WebSocket client. Its tests exercise registration, protocol negotiation, result/error correlation, heartbeat, reconnect, stale-work fencing and quarantine. Robolectric checks Android component startup, connection controls after process loss, PIN encryption and attempt state, protected settings, device state and gesture timing. Neither test environment substitutes for physical-device qualification.

After building the repository's Main and runtime assets with `npm run build`, run the owned-process integration test:

```sh
node packages/android-node/node-test/main-host.mjs
```

This launches a disposable Main and the actual JVM Node client with synthetic device operations. It exercises the QR credential, a deployment-prefixed WebSocket endpoint, protocol 3, ordinary results/errors, image history and reconnect after Main restart. It uses separate temporary data and no running installation. `FOXWARM_ANDROID_GRADLE` can select a local Gradle executable instead of the wrapper.

See [phone testing](PHONE-TESTING.md) for the device acceptance checklist.
