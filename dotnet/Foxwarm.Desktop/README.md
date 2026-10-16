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
   **Foxwarm.Desktop.exe**. Keep the DLLs, native assets, templates and `webui`
   directory together. Configure a model/provider in the WebUI's Setup page.

Microsoft downloads:
- https://dotnet.microsoft.com/download/dotnet/10.0
- https://developer.microsoft.com/microsoft-edge/webview2/

The backend runs inside the desktop application's process. WebView2 uses its
normal browser/renderer subprocesses. The app starts its own authenticated
loopback-only server on an available port; you do not need to start a server.
No API keys or existing account settings are included.

## Window and tray

Closing the window hides it to the tray. Double-click the fox tray icon or use
**Open** to restore it. Use **Exit** to stop the app and backend. Starting another
copy shows a message instead of starting another backend. External links open in
your default browser; the app view remains on its own local WebUI.

Settings, conversations, workspace and the owned WebView2 profile live under
`%LOCALAPPDATA%\Foxwarm\Desktop`, not in the extracted ZIP. They remain when the
app is restarted or the ZIP is replaced. Do not share that directory: it can
contain provider credentials and chat history. Exit Foxwarm before backing it up.
For isolated development, `FOXWARM_DATA_DIR` changes this data directory and
`FOXWARM_EXPERIMENT_TOOL_ROOT` changes the workspace. Server port/bind/public-URL
settings do not change the desktop's loopback listener.

## Prototype limits

This is the existing WebUI and .NET host, not a complete Windows tool port.
Local Linux shell execution, local PTY terminals and native Monty ToolScript
execution are unavailable on Windows. Unsupported local exec/ToolScript tools
are not advertised; supported connected Nodes retain their own capabilities.
Chat, provider setup, file tools and persistent settings/history are available.
Linux directory-fsync durability is not claimed on Windows. Code workbench
assets, optional external tools/services, vector search and optional HEIF support
are not supplied by this package. There is no updater, autostart or installer.

The fox icon is derived from OpenMoji and distributed under CC BY-SA 4.0;
see `Foxwarm-icon-LICENSE.txt`. The WebView2 SDK is version 1.0.4258.31;
its notice/license is included with the package.

## Build from source

Build the current WebUI first (`npm ci`, `npm --prefix packages/webui ci`,
`npm --prefix packages/webui run build`), then use the .NET 10 SDK:

```sh
dotnet publish dotnet/Foxwarm.Desktop -c Release -r win-x64 --self-contained false -p:EnableWindowsTargeting=true -o desktop-publish
```

The repository's normal Shared/CLI builds supply the optional Node bootstrap
assets. A C# build does not build the WebUI. Do not package application state,
private configuration, `node_modules`, or .NET runtimes in the desktop ZIP.
