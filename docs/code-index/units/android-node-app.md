# Unit: Android Node app

Files: `packages/android-node/core/src/main/kotlin/io/foxwarm/android/Pairing.kt`, `packages/android-node/core/src/main/kotlin/io/foxwarm/android/NodeProtocol.kt`, `packages/android-node/core/src/main/kotlin/io/foxwarm/android/NodeClient.kt`, `packages/android-node/app/src/main/java/io/foxwarm/android/MainActivity.kt`, `packages/android-node/app/src/main/java/io/foxwarm/android/NodePreferences.kt`, `packages/android-node/app/src/main/java/io/foxwarm/android/NodeService.kt`, `packages/android-node/app/src/main/java/io/foxwarm/android/DeviceAccessibilityService.kt`, `packages/android-node/app/src/main/AndroidManifest.xml`, `packages/android-node/app/src/main/res/xml/accessibility_service.xml`, `packages/android-node/app/src/main/res/xml/data_extraction_rules.xml`, `packages/android-node/build.gradle.kts`, `packages/android-node/app/build.gradle.kts`, `packages/android-node/core/build.gradle.kts`, `packages/android-node/settings.gradle.kts`

Secondary integration: [Node onboarding](./webui-node-onboarding.md), [external Node trust](./external-nodes.md), `.github/workflows/tests.yml`, `packages/android-node/README.md`, `packages/android-node/PHONE-TESTING.md`.

## Contract and decision

### D-node-android-on-device

[2026-11-15, user decision] Android Node runs as an on-phone app, replacing the unpublished host-side ADB/Python implementation. The first deliverable is a sideloadable APK for physical-phone testing. Release distribution and signing follow the [Android release contract](./release-packages.md#android-node-apk). The app uses the existing per-Node trust and ordinary tool protocol, with an accessibility service and a persistent foreground connection service.

The app requires API 30 (Android 11), targets API 35 and uses `AccessibilityService.takeScreenshot`; there is no MediaProjection consent flow. QR scanning uses ZXing without Google Play Services. It advertises core protocol 1–3 and no backend services or external-owner features. The existing [protocol negotiation](../threads/node-communication.md#d-node-thread-core-protocol-compatibility) remains authoritative.

## Pairing and lifecycle

The administrator's existing explicit `onboarding/create` response carries `androidPairing`: `{type:"foxwarm-node", version:1, baseUrl, nodeId, authToken}`. This serializes the same one-time per-Node credential used by the other clients; it introduces no authentication scheme. WebUI renders the JSON as a QR code and displays the equivalent manual fields. The app validates the address and payload, saves the three fields in private preferences with backup/transfer disabled, and builds a deployment-prefixed `/node_ws?id=…&auth=…` URL. The setup Activity blocks screenshots and never saves credential fields in Activity instance state.

`MainActivity` owns scanning, manual entry, connection controls and links to accessibility, App info/restricted settings and battery optimisation. User-started `NodeService` owns the `specialUse` foreground notification and Stop action, saved desired-running state and sticky process restart. Connection controls reflect the live service rather than the persisted desire to run, so reopening after force-stop or reboot permits Connect. There is no boot receiver.

`NodeClient` is Android-independent production Kotlin using OkHttp. A serial scheduled lane owns connection generation, registration, exponential one-to-sixty-second retry and status. A separate serial tool executor prevents device calls from blocking heartbeat. Native WebSocket ping/pong and server JSON ping are supported. Work waits for valid registration; stale sockets cannot start queued work or send successor replies. Incompatible/malformed registration quarantines application work while retaining heartbeat, and does not reconnect after closure. Rejected credentials require operator action. Status strings omit socket URLs, credentials and raw transport exceptions.

## Device actions and image result

`DeviceAccessibilityService` dispatches actions on the Android main thread and waits on the tool lane for gesture/screenshot completion. It reads the active window, recycles acquired nodes and returns bounded tree/list results with truncation indicators. Password text is omitted. Exact text/resource-ID selectors require one visible match; exceeding the traversal bound fails selection instead of using an incomplete uniqueness check.

The nine `android_*` tools cover tree/list, coordinate or element tap, swipe, focused/resource-ID text replacement, back/home/recents/notifications, active package, package launch and screenshot. Bounds and gesture coordinates are screen pixels. `NodeProtocol.tools` is the declared tool schema; `execute` supplies the same actions. No arbitrary shell, force-stop, install or unlock tool is exposed.

Screenshots close the hardware buffer, copy into a software bitmap, JPEG-encode at quality 80 and recycle both bitmaps. `NodeProtocol.screenshot` emits the current `{output, width, height, inlineData:{mimeType,data}}` image result. The output preserves original screen dimensions for coordinate mapping after Main's vision resizing. Protected screens and unsupported accessibility actions report errors. The app's own credential setup screen is protected.

## Build and evidence owners

The Gradle wrapper pins 8.11.1; AGP 8.9.2 and Kotlin 2.1.10 build with JDK 17 and SDK 35. `app:assembleDebug` creates a debug-signed APK. Version names and monotonic version codes come from the root release version through `app/build.gradle.kts`; signing and non-tag qualification are owned by the [release workflow](./release-packages.md#android-node-apk). The Android CI job runs core JVM tests, Robolectric lifecycle tests, lint, APK assembly and the owned Main integration driver; it uploads the APK and test reports without release secrets.

- `core/src/test/kotlin/io/foxwarm/android/NodeProtocolTest.kt`: QR/manual parsing, prefixed/escaped endpoint, version validation and capability schema.
- `core/src/test/kotlin/io/foxwarm/android/NodeClientTest.kt`: production transport dispatch/error correlation, heartbeat during blocked device work, reconnect/queued-work fencing, quarantine and rejected-credential retry suppression.
- `app/src/test/java/io/foxwarm/android/LifecycleTest.kt`: service construction before Context attachment and Connect availability after process loss.
- `node-test/main-host.mjs` plus `MainPeer.kt`: actual JVM client against the repository's disposable Main harness; direct QR credential, protocol 3, prefixed URL, ordinary replies/errors, current screenshot writer through image history, persisted trust and cold Main reconnect. Only the Android device bridge is synthetic.
- `mainHostNodeOnboarding.e2e.mjs`: production WebUI Android choice, public download QR before creation, explicit creation, distinct pairing QR/manual fields, copy, narrow layout and credential lifetime.

Physical accessibility, camera scanning, display capture, OEM background policy and gesture behavior require the `packages/android-node/PHONE-TESTING.md` checklist; JVM tests do not qualify those effects.
