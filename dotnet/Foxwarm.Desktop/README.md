# Foxwarm Desktop for Windows

The macOS Desktop is the separate [AppKit host](../Foxwarm.Desktop.Mac/README.md), with its own build and release notes.

## Install and run

This is an unsigned **Windows x64** desktop app compiled to native code
(NativeAOT). It needs no .NET installation, Visual C++ redistributable or
installer: the package carries the Visual C++ runtime DLLs its components import.

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

Desktop hosts the existing WebUI in WinUI 3 using the Windows App SDK WinUI component **2.6.5**
and WebView2 SDK **1.0.4258.31**. Main remains in the same process. The release
package is a NativeAOT publication (`-p:PublishAot=true`), like the macOS
Desktop; a plain `dotnet build` or publish without it remains a managed
development build.

The Windows App SDK is app-local (`WindowsAppSDKSelfContained=true`), independent
of .NET self-containment. The WinUI target uses Windows SDK 19041 contracts and
minimum API metadata 17763 (Windows 10 1809); this is not a new supported Windows
minimum. The .NET 10 supported-OS policy continues to apply. Minimum-OS GUI
qualification remains outstanding.

Desktop publication requires Windows SDK manifest/XAML/resource tools. The
Windows release job builds this package through the release packager;
the Ubuntu producer continues to build Linux/Windows server packages. Compiling
C# alone on Linux does not create a runnable WinUI package.

## Packaging checks

The **Release packages** workflow publishes this package with the same delivery
graph as the server packages. A Windows job extracts the finished ZIP and checks
the WebUI, native x64 dependencies, that it holds no .NET runtime or managed
assembly, that every imported DLL is in the package or part of Windows, collected
artifact/extension resources and licenses. It then launches that extracted
executable with disposable data and a configured canonical Agent root, attaches to
its actual WebView2 view, verifies native cookie sign-in, authenticated WebSockets
and Setup, runs a native ToolScript turn with exec-helper execution
against a local model fixture, indexes and searches through the Vector child
(only the child loads LanceDB), and checks that the process loaded no CoreCLR.
It closes the window to the notification area, reopens it from the icon, exits
through the icon's **Exit** menu item and checks restart persistence and
ordinary shutdown. It also executes the packaged esbuild/sharp dependencies. A separate
`desktop-acceptance` artifact records the acceptance result without user state,
tokens or browser profiles.

Real Explorer recreation has also been exercised. Windows sign-out and
power-loss recovery remain outside these checks.
WebView2 debugging is enabled only for acceptance, through the test child's
environment or an app-specific policy on the disposable Windows runner. Normal
Desktop startup does not enable it.

## Window and tray

Closing the window hides it to the tray. Double-click the fox tray icon or use
**Open** to restore it. The icon returns if Explorer recreates the taskbar while
Foxwarm is running. Use **Exit** to stop the app and backend. Starting another
copy shows a message instead of starting another backend. The single-instance
lock applies to the same user across Windows login sessions, so those sessions
cannot run competing writers against the same user data. External links open in
your default browser; the app view remains on its own local WebUI.

Settings, conversations and the owned WebView2 profile live under
`%LOCALAPPDATA%\Foxwarm\Desktop\data`, not in the extracted ZIP. Each Agent owns
its own directory: `data/agents/main`, `data/agents/<name>`. `paths.agentsDir` in
`state/config.yaml` can select a different Agent root, using the normal
installation-relative path rules. `FOXWARM_DATA_DIR` selects a different data
directory for isolated development. These locations remain when the app is
restarted or the ZIP is replaced; they can contain provider credentials and
private history. Exit Foxwarm before backing them up.

The former Desktop sibling `workspace` layout is retired. Desktop does not
detect or migrate it, and does not move or delete old files. This does not change
the server's independently supported legacy-data readers. Server port/bind/public-URL
settings do not change the Desktop loopback listener.

## Runtime limits

The existing WebUI and .NET host provide native Windows PowerShell execution,
ConPTY terminals and ordinary Monty 0.0.19 ToolScript. Independent exec commands
survive normal Main shutdown; interactive terminals belong to Main and close
with it. The same Desktop executable serves the private Code helper before
UI/single-instance startup. These native tools require no console apphost/runtimeconfig,
Node installation, WSL or alternate backend. Native Code drive paths use the existing
Code URI mapping; UNC/device paths are not supported. Connected Nodes retain
their own capabilities. Chat, setup, file tools and persistent history remain
available.
Linux directory-fsync durability is not claimed on Windows. The release packager
adds the pinned Code workbench assets; direct .NET publication does not acquire
them. Optional external tools/services and HEIF support remain unbundled. There is no updater, autostart or installer.

Artifact preparation uses a short-lived Node process for validation, raster
inspection and React compilation. Its Windows esbuild/sharp dependencies and
fixed WebUI React runtime come from the shared delivery collector. They do not
host a TypeScript Main backend or execute authored React during compilation.

Optional Vector indexing/search includes the pinned LanceDB native dependency,
not an embedding service. Configure a compatible embedding endpoint to enable
it; disabled configuration does not start a native owner. The default supervised
child runs through the Desktop executable before UI and single-instance setup,
without a separate console apphost/runtimeconfig. The LanceDB library and the
ToolScript worker import the Visual C++ runtime, whose DLLs ship beside them
(`VC-RUNTIME-NOTICE.txt`); the Universal C runtime is part of Windows 10 and later.
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
and a patched .NET 10 SDK on Windows, then run the release packager from the repository root. It
publishes Desktop with NativeAOT for `win-x64` on Windows, removes console-only
entry files and copies the Visual C++ runtime DLLs that packaged binaries import
from the given redistributable directory:

```sh
node scripts/release/package.mjs --build-assets --output dist --vc-runtime "<VS>\VC\Redist\MSVC\<version>\x64\Microsoft.VC143.CRT" --target desktop-win-x64
```

The Core project supplies the same WebUI, public skills, templates, Node bootstrap,
artifact runtime and tracked extension resources to Desktop. Missing required built assets fail
publish; a backend-only C# build does not build the frontend. Desktop does not
ship the console Core CLI or its apphost/runtimeconfig. Do not package application state,
private configuration or source dependency caches. Preserve the
artifact resources selected by the delivery collector, including their required
`node_modules` directories; do not replace them with the source dependency tree.

For a managed backend/UI compile before collecting release resources:

```powershell
dotnet build dotnet/Foxwarm.Desktop -c Release -p:FoxwarmConsoleEntry=false -p:ArtifactTargetRid=win-x64
```

NativeAOT needs Visual Studio Build Tools with the Desktop development
with C++ workload (x64/x86 tools and Windows SDK). The SDK locates the installed
linker and import libraries through `vswhere`/`vcvarsall`; the portable NuGet
Windows SDK BuildTools package alone does not supply that installation. Restore
pins Windows SDK BuildTools 10.0.26100.4654 through Windows App SDK WinUI component 2.6.5. The
package's XAML compiler uses .NET Framework 4.7.2 for `App.xaml`, which supplies
the application/control resources. The window and original WebUI remain unchanged
by this resource definition.

### NativeAOT publication

Use a patched SDK (qualified with .NET SDK 10.0.403, runtime and ILCompiler
10.0.14) rather than forcing one runtime version onto every framework reference:
WinUI also resolves a separately versioned Windows SDK projection. The packager
publishes with `-p:PublishAot=true`; the equivalent direct publication, without
the Code workbench and Visual C++ runtime copy, is:

```powershell
dotnet publish dotnet/Foxwarm.Desktop -c Release -r win-x64 --self-contained true -p:PublishAot=true -p:FoxwarmConsoleEntry=false -p:ArtifactTargetRid=win-x64 -o desktop-native
```

Keep the app-local WinUI and WebView2 native libraries and resources beside the
executable. NativeAOT does not make this a single-file application. Main and
Desktop are compiled into `Foxwarm.Desktop.exe`; the WinRT projections need no
managed assembly. The Desktop's own code has no trim/AOT warnings (the release
job fails on one); Main's are reviewed by the Tests workflow's native lane.

### Windows App SDK components

Desktop references `Microsoft.WindowsAppSDK.WinUI`, whose supported dependency
closure supplies Base, Foundation and InteractiveExperiences plus WebView2.
`WindowsAppSDKSelfContained` keeps the SDK's own component manifest/resource and
payload-copy targets in charge. The umbrella-only ML, AI, Search, Widgets and
DWrite component packages are not selected; no post-publish DLL blacklist is used.
The separate Runtime package supplies framework-package deployment, which this
app-local self-contained host does not use. WinUI's license also covers the
identical Foundation/InteractiveExperiences license terms. Base is explicitly
referenced to retain its complete common notice, including the WinUI notice;
this does not expand the component closure. WebView2 and Main dependency notices
also ship with the application.
