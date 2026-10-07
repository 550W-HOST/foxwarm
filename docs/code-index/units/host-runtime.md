# Unit: Host startup, configuration, and HTTP ingress

Files: `dotnet/Foxwarm/AssemblyInfo.cs`, `dotnet/Foxwarm/ConfigurationYaml.cs`, `dotnet/Foxwarm/HttpServer.cs`, `dotnet/Foxwarm/HttpServerSettings.cs`, `dotnet/Foxwarm/Program.cs`, `dotnet/Foxwarm/Skills.cs`

## Purpose

Composes the .NET executable, captures environment/configuration, builds ASP.NET middleware, and exposes health, auth, admin, WebUI, and Code entry points.

## Stable methods and callers

- `Program.cs` is the executable entry that resolves data/workspace roots, captures `HttpServerSettings`, constructs `SessionManager`, `TerminalRegistry`, `SessionRuntime`, `MessageRouter`, `HttpServer`, and `WebUIChannel`, then loads Main state before serving.
- `HttpServer` owns prefix normalization, origin checks, token/cookie auth, static WebUI entry, `/health`, `/admin/shutdown`, and registration of Code/WebUI routes.
- `HttpServerSettings.CaptureAsync`/`Enabled` determine port/address/token/WebUI mode; `ConfigurationYaml` parses source-compatible YAML; `Skills` enumerates configured Agent skills.

## Contract and side effects

HTTP authorization happens before state-changing routes and static application content; `/api/auth` is the only unauthenticated token exchange. Request body limits, WebSocket keepalive, deployment-relative prefixes, and derived browser cookie behavior are host boundaries. Program shutdown begins Session/terminal drain before disposing the app.

This is the current .NET experiment/host entry, not the repository's switched root launcher: root `package.json` still builds/starts the TypeScript `lib/index.js` path, while `Program` requires explicit experiment-host environment such as `FOXWARM_EXPERIMENT_TOOL_ROOT`. The index therefore maps .NET startup as the target Main implementation without claiming root CLI/packaging migration is complete.

## Tests

`dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.cs`; `AppConfigurationRulesTests.cs`; `WebUiStartupTests.cs` auth/startup coverage.
