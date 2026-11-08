# Unit: macOS Desktop host

Files: `dotnet/Foxwarm.Desktop.Mac/Foxwarm.Desktop.Mac.csproj`, `dotnet/Foxwarm.Desktop.Mac/Program.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopApplication.cs`, `dotnet/Foxwarm.Desktop.Mac/Info.plist`, `dotnet/Foxwarm.Desktop.Mac/README.md`

## Contract

The AppKit application owns one WKWebView window and the complete same-process [Main host](./host-runtime.md). It uses the original WebUI and [shared delivery resource graph](./core-delivery-cli.md); no separate backend, MAUI layer, privileged JavaScript bridge, or Desktop-specific Agent migration participates.

Main data defaults to the user's `Library/Application Support/Foxwarm/Desktop/data`, with the existing `FOXWARM_DATA_DIR` override. `HostPaths.ForDataRoot` and `ModelConfiguration` retain the canonical Agent layout and configured `paths.agentsDir`. There is no sibling Desktop workspace. WebKit owns its application-specific persistent profile under the user's Library; Main state and the compiled content-rule store stay outside the application bundle.

`Program.Main` restores `ObjCRuntime.Runtime.OriginalWorkingDirectory` before private helper dispatch. Apple's native launcher changes cwd to the bundle before managed entry; leaving that change in effect makes the real exec child ignore its caller-selected working directory and write into the bundle. It also sets the standard `APP_CONTEXT_BASE_DIRECTORY` to the bundle's `Contents/MonoBundle` before Main or helpers initialize: managed Apple builds already use that resource root, while NativeAOT otherwise defaults to `Contents/MacOS`. This preserves all existing Main consumers of `AppContext.BaseDirectory`, including login, bootstrap resources, Monty, artifacts, and the PTY helper, without a second resource graph. Exec, Vector, and terminal helpers return before the per-user mutex or `NSApplication` startup.

## Native shell and security

`DesktopApplication.StartAsync` starts Main with its ordinary canonical paths and lifecycle, then uses `CaptureDesktopAsync` and the remembered-port behavior documented by the [Desktop HTTP boundary](./host-runtime.md#desktop-boundary). It posts the token to the owned endpoint's existing `/api/auth`, then installs a native HttpOnly, SameSite Strict cookie before navigation. The token does not enter navigation URLs or JavaScript.

The navigation delegate accepts the owned HTTP origin. External HTTP(S) top-level navigation and popups use the default browser. WKContentRuleList blocks off-origin HTTP(S) resources; media capture is denied by the UI delegate. The host installs no script-message handler or injected host object. The Edit menu supplies standard native text-editing selectors. The UI delegate supplies native alert/confirmation sheets and the file chooser used by the original WebUI's existing browser APIs.

Close keeps the process and Main alive. Open Foxwarm and the application-reopen delegate restore the existing window. Quit returns AppKit's deferred termination reply while startup settles and the existing Main drain/disposal completes. Ordinary Main shutdown also terminates the shell through its host observer. That observer is installed before the desktop publishes its port or initializes WebKit, and posts termination to AppKit's main thread; an immediate administrative shutdown must not wait for browser startup to install its lifecycle observer.

## Build and qualification boundary

The project uses bundle identifier `net.foxwarm.desktop`, matching the canonical project domain. It targets `net10.0-macos`, macOS 15 under the existing .NET 10 support policy, and the existing precompiled `osx-arm64` native dependency path. It references the full Main project. `PrepareMacBundleResources` maps inherited Main content beneath the Apple assembly/resource root while retaining Main's relative paths. It removes repeated source identities before Apple's native-library processing: the PTY library arrives through Main, BrowserSupport, and NodePrimitives, and duplicate processing races on the same temporary dylib.

Managed builds and `dotnet publish -p:PublishAot=true` use the Apple SDK directly. The latter remains subject to the complete application's trimming and NativeAOT constraints. The project does not change release jobs or provide a signing/notarization policy. The optional full Code workbench is not added here.

Managed and NativeAOT Intel x64 runs exercised the original WebUI/Setup, native cookie/WebSocket and resource policy, native dialogs and window/menu lifecycle, real ToolScript/exec and Darwin PTY helpers, canonical Agent paths, persistence/restart, and local/child Vector indexing/search/recall. The Intel Vector runs used a temporary native LanceDB build matching the pinned binding source; no x64 package, acquisition fallback, or release target is added. Arm64 NativeAOT cross-publication used the existing precompiled NuGet native assets, but the arm64 app was not executed. This is source/build integration without a macOS Desktop release package or release-workflow entry. Local ad-hoc signatures do not establish Developer ID signing or notarization. Apple Silicon execution, minimum-OS execution, complete browser/file-dialog behavior, the optional full Code workbench, and other optional services require separate evidence.
