# Foxwarm Desktop — Windows prototype

## Install and run

This is an unsigned, framework-dependent **Windows x64** prototype. No installer
or .NET runtime is bundled.

1. Install the **.NET 10 SDK (x64)**. It includes the .NET, Windows Desktop and
   ASP.NET Core shared runtimes used by this app. Alternatively, install both
   the **.NET 10 Desktop Runtime (x64)** and **ASP.NET Core 10 Runtime (x64)**.
   Use the current serviced .NET 10 release. A .NET 8 or 9 runtime alone is not enough.
2. Install the **Microsoft Edge WebView2 Evergreen Runtime (x64)** if it is not
   already installed. Microsoft Edge alone is not a substitute for this runtime.
3. Extract the entire ZIP to a folder you can read, then open
   **Foxwarm.Desktop.exe**. Keep the DLLs, native assets, templates and `webui-dist`
   directory together. Configure a model/provider in the WebUI's Setup page.

To prepare image, chart or React artifacts, also install Node.js and make `node`
available on PATH before starting Desktop. The package includes the collected
compiler and image dependencies, but not the Node runtime itself.

Microsoft downloads:
- https://dotnet.microsoft.com/download/dotnet/10.0
- https://developer.microsoft.com/microsoft-edge/webview2/

The backend runs inside the desktop application's process. WebView2 uses its
normal browser/renderer subprocesses. The app starts its own authenticated
loopback-only server; you do not need to start a server. It remembers its last
successfully bound port so browser preferences survive a normal restart. If that
port is occupied, it binds a new available port without connecting to the other
process; browser-only theme/layout preferences start fresh for that new origin.
No API keys or existing account settings are included.

## Download a GitHub Actions package

Open the repository's **Actions → Tests** workflow and select a successful run
for the desired commit. Download the
**foxwarm-desktop-win-x64-framework-dependent** artifact, then extract the
`foxwarm-desktop-win-x64-framework-dependent.zip` inside it. The ZIP contains the
complete Desktop application; launch `Foxwarm.Desktop.exe` from the extracted
folder. Install the shared frameworks and WebView2 listed above first.
Artifacts expire after 14 days; this is not an installer or an automatic update
channel. The existing **Run workflow** action can build another package.

The Windows packaging job uses the same delivery helper as local builds. It
extracts the finished ZIP and checks the WebUI, native x64 dependencies, collected
artifact/extension resources, licenses and framework-dependent runtime metadata.
It then launches that extracted executable with disposable data and workspace,
attaches to its actual WebView2 view, verifies native cookie sign-in and Setup,
runs a native ToolScript turn against a local model fixture, and checks ordinary
shutdown/restart persistence. It also executes the packaged esbuild/sharp
dependencies. The ZIP is uploaded only after these checks succeed; a separate
`desktop-acceptance` artifact records the acceptance result without user state,
tokens or browser profiles.

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
and the .NET 10 SDK, then run the delivery helper from the repository root. It builds
the shared assets, publishes Desktop, and removes console-only entry files:

```sh
bash dotnet/scripts/publish-desktop.sh desktop-publish
```

The Core project supplies the same WebUI, public skills, templates, Node bootstrap,
artifact runtime and tracked extension resources to Desktop. Missing required built assets fail
publish; a backend-only C# build does not build the frontend. Desktop does not
ship the console Core CLI or its apphost/runtimeconfig. Do not package application state,
private configuration, source dependency caches or .NET runtimes. Preserve the
artifact resources selected by the delivery collector, including their required
`node_modules` directories; do not replace them with the source dependency tree.
