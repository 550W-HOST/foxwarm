# Foxwarm Desktop for macOS

This AppKit application hosts the original WebUI in WKWebView and runs the complete C# Main host in the same process. It does not use MAUI, a JavaScript host bridge, or a separate backend implementation.

## Build

Use a patched .NET 10 SDK and the `macos` workload compatible with the installed Xcode. The application targets macOS 14 or later. The product resource target is `osx-arm64`, matching the precompiled LanceDB assets supplied by the existing NuGet dependency. An Intel build does not establish Apple Silicon runtime qualification.

Prepare the normal repository dependencies and shared resources, then build:

```sh
npm ci
npm --prefix packages/webui ci
npm run build:assets
dotnet build dotnet/Foxwarm.Desktop.Mac/Foxwarm.Desktop.Mac.csproj \
  -c Debug -r osx-arm64 --self-contained true \
  -p:FoxwarmConsoleEntry=false -p:ArtifactTargetRid=osx-arm64
```

For NativeAOT, use `dotnet publish` with the same arguments, `-c Release`, and `-p:PublishAot=true`. A native build alone does not qualify optional services or resolve all trimming warnings. The Apple SDK produces `Foxwarm.app`; distribute the whole bundle, not its executable alone. Developer ID signing, notarization, an installer, an updater, and release workflow adoption are separate work.

## Verified scope and distribution status

Managed and NativeAOT builds were executed on Intel x64 with macOS 15.8.1, .NET SDK 10.0.403 / runtime 10.0.14, macOS workload 26.2.10233 (workload set 10.0.202), and Xcode 26.3. The runs exercised the original WebUI and Setup, native HttpOnly/SameSite cookies, WebSockets, off-origin resource blocking, native alert/confirmation sheets, menu/window lifecycle, ToolScript and exec helpers, canonical Agent paths, persistence/restart, and local/child Vector indexing, search and recall. NativeAOT Main and its Vector child ran without CoreCLR. The packaged Darwin PTY helper and Node artifact dependencies were also exercised.

Intel Vector qualification used a temporary native library built from the existing LanceDB binding source pin. That library and its build procedure are not a product acquisition path. The committed project uses the precompiled NuGet macOS arm64 native assets. An arm64 NativeAOT app was cross-published on Intel but was **not run on Apple Silicon**. Minimum-OS execution and all optional services remain outside this qualification.

This is a source/build integration only: there is **no macOS Desktop release package or release-pipeline target**. Local `.app` bundles use SDK ad-hoc signatures for development; Developer ID signing and notarization are not provided or qualified. No installer or updater is supplied. The optional full Code workbench was not included in these runs, and interactive file picking/download behaviors were not fully qualified.

## Data and behavior

Main data defaults to `~/Library/Application Support/Foxwarm/Desktop/data`. The ordinary `FOXWARM_DATA_DIR` override remains available. Main's canonical `HostPaths` and `paths.agentsDir` select Agent directories; this application creates no sibling workspace and performs no Desktop-specific layout migration. WKWebView uses the application-specific native WebKit profile in the user's Library. Runtime data is outside the application bundle.

The window opens the owned loopback endpoint. Native code validates the instance token through Main's existing `/api/auth` endpoint, then installs an HttpOnly, SameSite Strict cookie with the native cookie store. The token is never placed in a URL or JavaScript. External HTTP(S) navigation opens in the default browser; off-origin HTTP(S) resource loads and media capture are denied. The application supplies the normal Edit menu for WebUI text fields.

Closing the window keeps Main running. Open Foxwarm and reopening the application restore the window. Quit drains Main through its existing lifecycle before terminating. Private exec, Vector, and terminal helpers dispatch before the GUI or single-instance lock. The entry restores the Apple launcher's original working directory before helper dispatch so exec runs in its selected directory rather than the signed bundle.

The bundle consumes Main's existing WebUI, skills, templates, Node resources, extension bundles, native dependencies, and artifact runtime graph. The full optional Code workbench is not added by this project.
