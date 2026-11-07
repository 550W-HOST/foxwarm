# Foxwarm Desktop for Windows

## Install and run

This is an unsigned **Windows x64** desktop app. The release package includes the
.NET runtime; no installer is needed.

1. Install the **Microsoft Edge WebView2 Evergreen Runtime (x64)** if it is not
   already installed (Windows 10 and 11 normally include it). Microsoft Edge alone
   is not a substitute for this runtime.
2. Download `foxwarm-desktop-win-x64.zip` from the repository's GitHub releases,
   extract the entire ZIP to a folder you can read, then open
   **Foxwarm.Desktop.exe**. Keep the DLLs, native assets, templates and `webui-dist`
   directory together. Configure a model/provider in the WebUI's Setup page.

To prepare image, chart or React artifacts, also install Node.js and make `node`
available on PATH before starting Desktop. The package includes the collected
compiler and image dependencies, but not the Node runtime itself.

WebView2 download: https://developer.microsoft.com/microsoft-edge/webview2/

The backend runs inside the desktop application's process. WebView2 uses its
normal browser/renderer subprocesses. The app starts its own authenticated
loopback-only server; you do not need to start a server. It remembers its last
successfully bound port so browser preferences survive a normal restart. If that
port is occupied, it binds a new available port without connecting to the other
process; browser-only theme/layout preferences start fresh for that new origin.
No API keys or existing account settings are included.

To update, exit the app and replace the extracted folder with the new release.
Settings and data stay in the user profile (see below).

## WinUI build qualification

This branch hosts the existing WebUI in WinUI 3 using Windows App SDK **2.6.5**
and WebView2 SDK **1.0.4258.31**. Main remains in the same process. Managed
publication is the default; `-p:PublishAot=true` selects a separate NativeAOT
publication attempt. Enabling it does not qualify all Main services for AOT.

The Windows App SDK is app-local (`WindowsAppSDKSelfContained=true`), independent
of .NET self-containment. The WinUI target uses Windows SDK 19041 contracts and
minimum API metadata 17763 (Windows 10 1809); this is not a new supported Windows
minimum. The .NET 10 supported-OS policy continues to apply. Minimum-OS GUI
qualification remains outstanding.

**Delivery decision required before adoption:** the original WinForms Desktop
could be cross-published on Linux. The WinUI SDK invokes Windows `mt.exe` to
merge manifests and `makepri.exe` to build resources, including for the
programmatic window used here. Linux restore and C# compilation do not produce
a runnable package. Desktop publication now needs Windows; the public release
workflow has not been moved in this attempt. NativeAOT also needs Windows native
linker/SDK import libraries. No alternative backend or Linux emulation path is
introduced.

## Packaging checks

The **Release packages** workflow publishes this package with the same delivery
graph as the server packages. A Windows job extracts the finished ZIP and checks
the WebUI, native x64 dependencies, the embedded .NET 10 runtime, collected
artifact/extension resources and licenses. It then launches that extracted
executable with disposable data and workspace, attaches to its actual WebView2
view, verifies native cookie sign-in and Setup, runs a native ToolScript turn
against a local model fixture, and checks ordinary shutdown/restart persistence.
It also executes the packaged esbuild/sharp dependencies. A separate
`desktop-acceptance` artifact records the acceptance result without user state,
tokens or browser profiles.

The existing managed-package acceptance lane must be rerun for WinUI before its
results apply to this host. NativeAOT package validation is not yet qualified.
These checks do not cover tray interaction, Windows sign-out, power-loss
recovery, optional Vector/embedding services or the unbundled Code workbench.
WebView2 debugging is enabled only for acceptance, through the test child's
environment or an app-specific policy on the disposable Windows runner. Normal
Desktop startup does not enable it.

## Window and tray

Closing the window hides it to the tray. Double-click the fox tray icon or use
**Open** to restore it. Use **Exit** to stop the app and backend. Starting another
copy shows a message instead of starting another backend. The single-instance
lock applies to the same user across Windows login sessions, so those sessions
cannot run competing writers against the same user data. External links open in
your default browser; the app view remains on its own local WebUI.

Settings, conversations, workspace and the owned WebView2 profile live under
`%LOCALAPPDATA%\Foxwarm\Desktop`, not in the extracted ZIP. Host state is in
its `data` subdirectory and the workspace is a separate `workspace` subdirectory. They remain when the
app is restarted or the ZIP is replaced. Do not share that directory: it can
contain provider credentials and chat history. Exit Foxwarm before backing it up.
For isolated development, `FOXWARM_DATA_DIR` changes the host data directory; by default its sibling
`workspace` is the tool workspace. These two directories must not overlap. Server port/bind/public-URL
settings do not change the desktop's loopback listener.

## Prototype limits

The existing WebUI and .NET host provide native Windows PowerShell execution,
ConPTY terminals and ordinary Monty 0.0.19 ToolScript. Independent exec commands
survive normal Main shutdown; interactive terminals belong to Main and close
with it. The same Desktop executable serves the private Code helper before
UI/single-instance startup. These native tools require no console apphost/runtimeconfig,
Node installation, WSL or alternate backend. Native Code drive paths use the existing
Code URI mapping; UNC/device paths are not supported. Connected Nodes retain
their own capabilities. Chat, setup, file tools and persistent history remain
available.
Linux directory-fsync durability is not claimed on Windows. Code workbench
assets, optional external tools/services and optional HEIF support are not
supplied by this package. There is no updater, autostart or installer.

Artifact preparation uses a short-lived Node process for validation, raster
inspection and React compilation. Its Windows esbuild/sharp dependencies and
fixed WebUI React runtime come from the shared delivery collector. They do not
host a TypeScript Main backend or execute authored React during compilation.

Optional Vector indexing/search includes the pinned LanceDB native dependency,
not an embedding service. Configure a compatible embedding endpoint to enable
it; disabled configuration does not start a native owner. The default supervised
child runs through the Desktop executable before UI and single-instance setup,
without a separate console apphost/runtimeconfig. Windows x64 requires system
Visual C++/Universal C runtime dependencies; minimum versions are not established.
The package includes `LanceDB-LICENSE.txt` and `Apache-Arrow-LICENSE.txt`. A successful
cross-build does not establish Windows application or child runtime qualification.

The fox icon is derived from OpenMoji and distributed under CC BY-SA 4.0;
see `Foxwarm-icon-LICENSE.txt`. The WebView2 SDK is version 1.0.4258.31;
its notice/license is included with the package.

## Build from source

Native worker preparation needs Python 3 (`python3` on Linux, `python` on
Windows) and access to the official npm registry during the first target build.
The exact official Monty 0.0.19 standalone worker is cached only under `obj`
and copied with its notices into output; no native binary is tracked. Git is
an optional external tool for Code SCM, not a bundled dependency.

Install the repository's npm dependencies (`npm ci`, `npm --prefix packages/webui ci`)
and the .NET 10 SDK on Windows, then run the release packager from the repository root. It
publishes Desktop self-contained for `win-x64` on Windows and removes
console-only entry files:

```sh
node scripts/release/package.mjs --build-assets --output dist --target desktop-win-x64
```

The Core project supplies the same WebUI, public skills, templates, Node bootstrap,
artifact runtime and tracked extension resources to Desktop. Missing required built assets fail
publish; a backend-only C# build does not build the frontend. Desktop does not
ship the console Core CLI or its apphost/runtimeconfig. Do not package application state,
private configuration or source dependency caches. Preserve the
artifact resources selected by the delivery collector, including their required
`node_modules` directories; do not replace them with the source dependency tree.

For a backend/UI compile before collecting release resources:

```powershell
dotnet build dotnet/Foxwarm.Desktop -c Release -p:FoxwarmConsoleEntry=false -p:ArtifactTargetRid=win-x64
```

NativeAOT additionally needs Visual Studio Build Tools with the Desktop development
with C++ workload (x64/x86 tools and Windows SDK). The SDK locates the installed
linker and import libraries through `vswhere`/`vcvarsall`; the portable NuGet
Windows SDK BuildTools package alone does not supply that installation. Restore
pins Windows SDK BuildTools 10.0.26100.4654 through Windows App SDK 2.6.5. The
package's XAML compiler targets use .NET Framework 4.7.2 when XAML source is present;
this host creates its two controls in C# and has no separate XAML view.
