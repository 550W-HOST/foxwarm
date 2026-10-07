# Unit: Terminal and Code helper services

Files: `dotnet/Foxwarm/Terminal/CodeHelperServer.cs`, `dotnet/Foxwarm/Terminal/TerminalClient.cs`, `dotnet/Foxwarm/Terminal/TerminalNative.cs`, `dotnet/Foxwarm/Terminal/TerminalRegistry.cs`

## Purpose

Owns local PTY registry, native process/session lifecycle, terminal client protocol, and Code helper IPC used by WebUI terminal/workbench routes.

## Stable methods and callers

- `TerminalRegistry` creates/looks up/attaches/detaches terminal sessions, tracks owner/session/target metadata, and publishes realtime terminal events.
- `TerminalNative` starts the platform PTY/process, reads/writes bounded frames, handles resize/close/exit, and disposes process resources.
- `TerminalClient` validates client messages/acks and maps them to registry/native operations; `CodeHelperServer` serves the shared Code helper IPC endpoint with auth/path checks.

Callers: `Program`/`HttpServer`, `WebUIChannel.Terminal`, Code workbench routes, React terminal/workbench units, and shared Code IPC. Terminal process state is not Session history authority.

## Contract and side effects

Terminal routes require normal host auth and deployment-relative identifiers. PTY failure/exit produces explicit terminal events; it does not mutate Session queue or report a model turn completion. Code helper file/Git capabilities remain bounded by the Code server and Main tool/path policy.

## Tests

`dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs`; `WebUiRealtimeRevisionTests.cs`; terminal/PTY protocol fixtures.
