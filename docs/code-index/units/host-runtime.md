# Unit: Host startup, configuration, and HTTP ingress

Files: `dotnet/Foxwarm/AssemblyInfo.cs`, `dotnet/Foxwarm/ConfigurationYaml.cs`, `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/Skills.cs`

## Purpose

Composes the .NET executable, captures environment/configuration, builds ASP.NET middleware, and exposes health, auth, admin, WebUI, and Code entry points.

## Stable methods and callers

- `Program.cs` is the executable entry that resolves data/workspace roots, captures `HttpServerSettings`, constructs `SessionManager`, `TerminalRegistry`, `SessionRuntime`, `MessageRouter`, `HttpServer`, and `WebUIChannel`, then loads Main state before serving.
- `HttpServer` owns prefix normalization, token/cookie auth, static WebUI entry, `/health`, `/admin/shutdown`, and registration of Code/WebUI/external Node routes.
- `HttpServerSettings.CaptureAsync`/`Enabled` determine port, bind address, public origin, the login token read from or created at `state/token` under the data root, and WebUI mode; the optional `FOXWARM_EXPERIMENT_BIND_ADDRESS` accepts an IPv4 address and defaults to loopback. `ConfigurationYaml` parses source-compatible YAML; `Skills` enumerates configured Agent skills.

## Contract and side effects

HTTP authorization happens before state-changing routes and static application content; `/api/auth` is the administrator token exchange. Public Node setup templates/source assets do not carry credentials; `/node_ws` uses its own approved Node credentials or pairing token, never the administrator cookie/token. Ordinary HTTP/WebUI requests are not restricted by their `Origin` header; the token and cookie are the login boundary. The token has no environment-variable override, and a blank or invalid token file fails startup without replacement. Request body limits, WebSocket keepalive, deployment-relative prefixes, and derived browser cookie behavior are host boundaries. Program shutdown begins Session/terminal drain before disposing the app.

This is the current .NET experiment/host entry, not the repository's switched root launcher: root `package.json` still builds/starts the TypeScript `lib/index.js` path, while `Program` requires explicit experiment-host environment such as `FOXWARM_EXPERIMENT_TOOL_ROOT`. The index therefore maps .NET startup as the target Main implementation without claiming root CLI/packaging migration is complete.

Protected `GET /api/auth/session` returns the ordinary administrator role used by the merged WebUI when WebUI is enabled. It uses the same token/cookie middleware as other protected routes; it does not introduce restricted identities or an access-management runtime.

## Tests

`dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.cs`; `AppConfigurationRulesTests.cs`; `WebUiStartupTests.cs` auth/startup coverage.
