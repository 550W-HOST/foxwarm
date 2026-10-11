# Unit: Terminal and Code helper services

Files: `dotnet/Foxwarm/Terminal/CodeHelperServer.cs`, `dotnet/Foxwarm/Terminal/TerminalClient.cs`, `dotnet/Foxwarm/Terminal/TerminalNative.cs`, `dotnet/Foxwarm/Terminal/TerminalRegistry.cs`, `dotnet/Foxwarm/Terminal/TerminalRouter.cs`, `dotnet/Foxwarm/Terminal/TerminalRouter.Remote.cs`

## Purpose

Owns local PTY registry, native process/session lifecycle, terminal client protocol, and Code helper IPC used by WebUI terminal/workbench routes.

## Stable methods and callers

- `TerminalRegistry` creates/looks up/attaches/detaches terminal sessions, tracks owner/session/target metadata, and publishes realtime terminal events.
- `TerminalNative` starts the platform PTY/process, reads/writes bounded frames, handles resize/close/exit, and disposes process resources.
- `TerminalClient` validates client messages/acks and maps them to registry/native operations; `CodeHelperServer` serves the shared Code helper IPC endpoint with auth/path checks.

Callers: host `Program.cs`/`HttpServer`, `WebUIChannel.Terminal`, Code workbench routes, React terminal/workbench units, and shared Code IPC. Terminal process state is not Session history authority.

## Remote router

`TerminalRouter` keeps `TerminalRegistry`/`TerminalNative` as the local PTY implementation and uses advertised `vscode-pty` for remote create/list/get/attach/input/resize/detach/close. Remote records are transient browser attachment descriptors, not durable Main process ownership. List/get after reconnect or a Main restart query the unchanged CLI service and rediscover actual process IDs; missing/offline services do not invent terminal success or fall back to Master.

One Node attachment fans out ready/backlog/output to multiple browser clients. Attachment readiness publishes before subsequent same-socket output events. Final browser/page/extension detach releases that service attachment; explicit user close sends the kill operation. A Node disconnect closes affected browser streams with a transport error, not a fabricated process exit. Returned Node/Session fields are not authority: routing and helper targets use the captured authenticated endpoint and terminal identity.

Only one live opt-in `control=code` client owns helper requests. Ordinary streams receive process output but no Code control. Pending callbacks bind terminal, request ID, owner and connection generation; a second client cannot acknowledge or take over an active owner's request. Owner detach rejects its pending callbacks, disconnect clears them, and old ACKs do not bind to a replacement attachment. Valid helper requests retain the official bounded payload, absolute remote path and line/column semantics. `code-result` returns over the exact authenticated service endpoint. This adds no general remote OS abstraction or Provider lifecycle.

## Contract and side effects

Terminal routes require normal host auth and deployment-relative identifiers. PTY failure/exit produces explicit terminal events; it does not mutate Session queue or report a model turn completion. Code helper file/Git capabilities remain bounded by the Code server and Main tool/path policy.

## Tests

`dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs`; `WebUiRealtimeRevisionTests.cs`; `NodeServiceTransportTests.cs`; `packages/webui/test/experimentHostNodeCode.e2e.mjs` (real CLI process/input/output/resize, two browser clients, pending helper owner-detach rejection, ordinary-client exclusion, explicit close and reconnect/restart rediscovery).
