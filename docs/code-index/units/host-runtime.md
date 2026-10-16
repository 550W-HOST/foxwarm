# Unit: Host startup, configuration, and HTTP ingress

Files: `dotnet/Foxwarm/AssemblyInfo.cs`, `dotnet/Foxwarm/ConfigurationYaml.cs`, `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/MainHost.cs`, `dotnet/Foxwarm.Desktop/Program.cs`, `dotnet/Foxwarm.Desktop/DesktopWindow.cs`, `dotnet/Foxwarm.Desktop/Foxwarm.Desktop.csproj`, `dotnet/Foxwarm.Desktop/README.md`, `dotnet/scripts/publish-desktop.sh`, `dotnet/Foxwarm/Skills.cs`

## Purpose

Composes the .NET executable, captures environment/configuration, builds ASP.NET middleware, and exposes health, auth, admin, WebUI, and Code entry points.

## Stable methods and callers

- `Program.cs` preserves the console/Code-helper entry and captures environment/settings. `MainHost.CreateAsync` shares the in-process Session/terminal/runtime/router/HTTP/WebUI composition with the Windows desktop; disposal begins admission shutdown, stops HTTP, drains Sessions and disposes resources.
- `Foxwarm.Desktop` is a framework-dependent `net10.0-windows`/`win-x64` WinForms host using WebView2 SDK 1.0.4258.31. It owns a per-user named mutex, one window/tray, one embedded Main host and one WebView2 profile. Close hides; Open restores; Exit drains/disposes; Windows shutdown is not hide-to-tray.
- `HttpServer` owns prefix normalization, token/cookie auth, static WebUI entry, `/health`, `/admin/shutdown`, and registration of Code/WebUI/external Node routes.
- `HttpServerSettings.CaptureAsync`/`Enabled` determine port, bind address, public origin, the login token read from or created at `state/token` under the data root, and WebUI mode; the optional `FOXWARM_EXPERIMENT_BIND_ADDRESS` accepts an IPv4 address and defaults to loopback. `ConfigurationYaml` parses source-compatible YAML; `Skills` enumerates configured Agent skills.

## Contract and side effects

HTTP authorization happens before state-changing routes and static application content; `/api/auth` is the administrator token exchange. Public Node setup templates/source assets do not carry credentials; `/node_ws` uses its own approved Node credentials or pairing token, never the administrator cookie/token. Ordinary HTTP/WebUI requests are not restricted by their `Origin` header; the token and cookie are the login boundary. The token has no environment-variable override, and a blank or invalid token file fails startup without replacement. Request body limits, WebSocket keepalive, deployment-relative prefixes, and derived browser cookie behavior are host boundaries. Program shutdown begins Session/terminal drain before disposing the app.

This is the current .NET experiment/host entry, not the repository's switched root launcher: root `package.json` still builds/starts the TypeScript `lib/index.js` path, while `Program` requires explicit experiment-host environment such as `FOXWARM_EXPERIMENT_TOOL_ROOT`. The index therefore maps .NET startup as the target Main implementation without claiming root CLI/packaging migration is complete.

The separate test container documented in `test/README.md` publishes this executable and the current WebUI through `test/Dockerfile` and `test/docker-compose.yml`. Its Linux x64 image includes native Monty with notices, built Shared/CLI Node archive inputs, tracked Code extensions, the PTY helper and local Git. Official Code workbench assets use an optional read-only Compose override; optional HEIF libraries are not installed. Host build outputs, state and workspace are excluded from the Docker context. This packaging does not switch the root launcher or expand the implementation's phase boundaries.

Protected `GET /api/auth/session` returns the ordinary administrator role used by the merged WebUI when WebUI is enabled. It uses the same token/cookie middleware as other protected routes; it does not introduce restricted identities or an access-management runtime.

[Outbound MCP OAuth routes](./dotnet-mcp-oauth.md) use the same administrator boundary. Only exact GET `/api/mcp/oauth/client.json` and `/api/mcp/oauth/callback` bypass it. The fixed callback GET reflects no parameters and exchanges no code; its first-party authenticated JSON completion preserves Strict-cookie behavior after cross-site consent. OAuth callbacks derive from captured startup app `url`, not Host or the ordinary address fallback/override; deployment prefixes remain intact.

## Desktop boundary

`CaptureDesktopAsync` retains file-token validation, enables WebUI and selects IPv4 loopback independently of configured server port/bind/public URL. It reads the last successfully bound port from `state/desktop-port`, defaulting to zero. The desktop saves the actual successful port after startup so ordinary restarts retain the WebUI origin and browser preferences. Kestrel's normal socket factory first binds that remembered endpoint; only `AddressAlreadyInUse` retries the socket bind at port zero. This does not recreate Main, replay Session startup, probe/adopt the occupant, or migrate browser preferences across origins. The startup callback updates the shared public address before the desktop consumes it. Console port/public-prefix validation remains unchanged. The native host posts the token only to that owned endpoint's existing `/api/auth`, transfers the returned HttpOnly/Strict cookie into its owned WebView2, and never includes the token in navigation or arbitrary requests. Top-level external navigation/popups go to the default browser; off-origin HTTP resource loads are blocked. There is no host-object/message bridge.

Default desktop home is `%LOCALAPPDATA%\Foxwarm\Desktop`, with separate `data` (host authority and owned `webview2` profile) and `workspace` subdirectories; existing data/workspace overrides support isolated development. The ZIP contains the built original WebUI, managed/native Windows dependencies, templates and notices, not runtime/state/credentials. Desktop and ASP.NET Core .NET 10 x64 shared frameworks plus WebView2 Evergreen are required. The repository's Linux PTY target is skipped for Windows RIDs even when built on Linux.

The prototype is not a full Windows tool port: local exec and Main-native ToolScript are omitted from unsupported platform discovery, local PTY reports platform unavailability, and optional Code/HEIF/vector/external-service assets are not supplied. The identity ledger retains flush-to-disk and atomic replacement on Windows; directory synchronization uses the pre-existing `Unsupported` result. Successful normal restart tests do not qualify power-loss durability.

## Tests

`dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.cs`; `AppConfigurationRulesTests.cs`; `EmbeddedHostTests.cs` (shared startup/disposal, remembered/occupied port and actual bound address, cookie/token auth, token/config restart, invalid token); `WebUiStartupTests.cs` auth/startup coverage.
