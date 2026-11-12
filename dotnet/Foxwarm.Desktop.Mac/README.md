# Foxwarm Desktop for macOS

This AppKit application hosts the original WebUI in WKWebView and runs the complete C# Main host in the same process. It does not use MAUI, a JavaScript host bridge, or a separate backend implementation.

## Build

Use a patched .NET 10 SDK and the `macos` workload compatible with the installed Xcode. The application targets macOS 15 or later, following the existing .NET 10 platform support policy. The product resource target is `osx-arm64`, matching the precompiled LanceDB assets supplied by the existing NuGet dependency. The same project also builds on Intel, but Vector there needs a locally built native library.

Prepare the normal repository dependencies and shared resources, then build:

```sh
npm ci
npm --prefix packages/webui ci
npm run build:assets
dotnet build dotnet/Foxwarm.Desktop.Mac/Foxwarm.Desktop.Mac.csproj \
  -c Debug -r osx-arm64 --self-contained true \
  -p:FoxwarmConsoleEntry=false -p:ArtifactTargetRid=osx-arm64
```

For NativeAOT, use `dotnet publish` with the same arguments, `-c Release`, and `-p:PublishAot=true`. A native build alone does not qualify optional services or resolve all trimming warnings. The Apple SDK produces `Foxwarm.app` under `bin/`; distribute the whole bundle, not its executable alone. The project disables the SDK's installer package. Bundled native libraries are copied without being linked into the executable, which links only system and .NET runtime libraries. Releases build it with `node scripts/release/package.mjs --build-assets --output dist --target desktop-osx-arm64`, which publishes NativeAOT and packs the bundle into `foxwarm-desktop-osx-arm64.zip`. Developer ID signing, notarization, an installer and an updater are separate work.

## Verified scope and distribution status

Managed and NativeAOT builds were executed on Intel x64 with macOS 15.8.1, .NET SDK 10.0.403 / runtime 10.0.14, macOS workload 26.2.10233 (workload set 10.0.202), and Xcode 26.3. The runs exercised the original WebUI and Setup, native HttpOnly/SameSite cookies, WebSockets, off-origin resource blocking, native alert/confirmation sheets, menu/window lifecycle, ToolScript and exec helpers, canonical Agent paths, persistence/restart, and local/child Vector indexing, search and recall. NativeAOT Main and its Vector child ran without CoreCLR. The packaged Darwin PTY helper and Node artifact dependencies were also exercised.

Managed and NativeAOT `osx-arm64` builds were also executed on Apple Silicon with macOS 26.5.2 and the same SDK, workload and Xcode. Those runs covered first-run Setup and model connection test through the WebUI, a WebUI turn against a scripted local model, ToolScript, exec in the Agent directory, PTY input/output/resize/cancel and a WebUI terminal tab, close-to-hide, reopen through the application and the menu, Quit with Main drain, restart with the remembered port and data retained, and Vector indexing and search through the WebUI and API with the precompiled NuGet arm64 LanceDB library. NativeAOT Main and its Vector child ran without CoreCLR.

Intel Vector qualification used a temporary native library built from the existing LanceDB binding source pin. That library and its build procedure are not a product acquisition path. Minimum-OS execution and all optional services remain outside this qualification.

Releases publish the NativeAOT bundle as `foxwarm-desktop-osx-arm64.zip`. The release workflow's `macos-desktop` job accepts each build from the extracted ZIP with `dotnet/scripts/qualify-desktop-mac-package.mjs`. Bundles carry the SDK's ad-hoc signature; Developer ID signing and notarization are not provided. No installer or updater is supplied. The optional full Code workbench was not included in these runs, and interactive file picking/download behaviors were not fully qualified.

## Data and behavior

Main data defaults to `~/Library/Application Support/Foxwarm/Desktop/data`. The ordinary `FOXWARM_DATA_DIR` override remains available. Main's canonical `HostPaths` and `paths.agentsDir` select Agent directories; this application creates no sibling workspace and performs no Desktop-specific layout migration. WKWebView uses the application-specific native WebKit profile in the user's Library, also when `FOXWARM_DATA_DIR` selects another data directory; WebKit's public API cannot place a persistent profile elsewhere. Runtime data is outside the application bundle.

The window opens the owned loopback endpoint. Native code validates the instance token through Main's existing `/api/auth` endpoint, then installs an HttpOnly, SameSite Strict cookie with the native cookie store. The token is never placed in a URL or JavaScript. External HTTP(S) navigation opens in the default browser; off-origin HTTP(S) resource loads and media capture are denied. The application supplies the normal Edit menu for WebUI text fields.

Closing the window keeps Main running. Open Foxwarm and reopening the application restore the window. Only one instance runs per user: a second launch, including `open -n`, brings the running instance's window forward and exits. Quit drains Main through its existing lifecycle before terminating. Private exec, Vector, and terminal helpers dispatch before the GUI or single-instance lock. The entry restores the Apple launcher's original working directory before helper dispatch so exec runs in its selected directory rather than the signed bundle.

The bundle consumes Main's existing WebUI, skills, templates, Node resources, extension bundles, native dependencies, and artifact runtime graph. The full optional Code workbench is not added by this project.
