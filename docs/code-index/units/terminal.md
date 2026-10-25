# Unit: Terminal and Code helper services

Files: `dotnet/Foxwarm/Terminal/TerminalClient.cs`, `dotnet/Foxwarm/Terminal/TerminalRegistry.cs`, `dotnet/Foxwarm/Terminal/TerminalRouter.cs`, `dotnet/Foxwarm/Terminal/TerminalRouter.Remote.cs`

## Purpose

Owns local PTY registry, native process/session lifecycle, terminal client protocol, and Code helper IPC used by WebUI terminal/workbench routes.

## Stable methods and callers

- `TerminalRegistry` creates/looks up/attaches/detaches terminal sessions, tracks owner/session/target metadata, and publishes realtime terminal events.
- The [shared primitive library](./dotnet-node-primitives.md) owns `TerminalNative`, ConPTY and same-executable helper IPC; Main retains registry, HTTP/authentication and browser/control ownership. `TerminalNative` starts the platform PTY/process, reads/writes bounded frames, handles resize/close/exit, and disposes process resources. Linux retains its owned native shim; Windows 10 build 17763+ uses kernel32 ConPTY with independent input/output pipes and a retained exact process handle. ConPTY creation clears inherited standard handles, resize uses signed COORD limits, and close drains output while ClosePseudoConsole terminates attached applications. These terminal resources belong to Main shutdown, unlike independent exec. Local terminal cwd retains native `Path.GetFullPath` behavior, including the Windows current-drive `/` root used by the ordinary WebUI; mapped Code drive paths are converted before that resolution.
- `TerminalClient` validates client messages/acks and maps them to registry/native operations; `CodeHelperServer` serves the shared Code helper IPC endpoint with auth/path checks. Windows uses a current-user-only named pipe and PowerShell/cmd launchers for the same executable. `NativeHelperEntry.TryRunAsync` dispatches that helper before either Main composition or Desktop UI/mutex initialization, including the reduced Desktop package. The CLI dispatches the same helper before connection/pairing. Helper JSON is explicit and native-publish compatible; managed launchers use the actual entry command, not the shared library DLL. Main alone supplies its Windows Code path mapping. See [Code path mapping](../threads/code-integration.md#d-code-real-path-uri) for drive-path presentation and native dispatch.

Callers: host `Program.cs`/`HttpServer`, `WebUIChannel.Terminal`, Code workbench routes, React terminal/workbench units, and shared Code IPC. Terminal process state is not Session history authority.

## Remote router

`TerminalRouter` keeps `TerminalRegistry`/`TerminalNative` as the local PTY implementation and uses advertised `vscode-pty` for remote create/list/get/attach/input/resize/detach/close. Remote records are transient browser attachment descriptors, not durable Main process ownership. List/get after reconnect or a Main restart query the unchanged CLI service and rediscover actual process IDs; missing/offline services do not invent terminal success or fall back to Master.

List responses register returned descriptors and return the observed snapshot; absent entries do not delete cached records or disconnect live attachments, including terminals created while an older list is in flight. Definitive get-null, exit, explicit close and connection lifecycle signals retain their existing cleanup behavior.

One Node attachment fans out ready/backlog/output to multiple browser clients. Attachment readiness publishes before subsequent same-socket output events. Final browser/page/extension detach releases that service attachment; explicit user close sends the kill operation. A Node disconnect closes affected browser streams with a transport error, not a fabricated process exit. Returned Node/Session fields are not authority: routing and helper targets use the captured authenticated endpoint and terminal identity.

Only one live opt-in `control=code` client owns helper requests. Ordinary streams receive process output but no Code control. Pending callbacks bind terminal, request ID, owner and connection generation; a second client cannot acknowledge or take over an active owner's request. Owner detach rejects its pending callbacks, disconnect clears them, and old ACKs do not bind to a replacement attachment. Valid helper requests retain the official bounded payload, absolute remote path and line/column semantics. `code-result` returns over the exact authenticated service endpoint. This adds no general remote OS abstraction or Provider lifecycle.

## Contract and side effects

Terminal routes require normal host auth and deployment-relative identifiers. PTY exit may hold a snapshot of browser clients while ordinary detach disposes one of them. Finishing that snapshot synchronizes lifetime cancellation with disposal; a retired client must not throw and prevent PTY cleanup. PTY failure/exit produces explicit terminal events; it does not mutate Session queue or report a model turn completion. Code helper file/Git capabilities remain bounded by the Code server and Main tool/path policy.

## Tests

`packages/webui/test/experimentHostCode.e2e.mjs` proves the shell's `cd`/`pwd` file effect and waits within the same bound for the same terminal PID to report its prompt-published cwd before testing reload and explicit close.

`packages/webui/test/terminalNative.e2e.mjs` (owned real Main PTY authentication, unavailable remote Node without local fallback, UTF-8, resize, Ctrl-C, detach/backlog, exit and Code helper control); `dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs`; `dotnet/Foxwarm.Tests/Tools/WindowsLocalToolsTests.cs` (guarded Windows native lifecycle tests); `TerminalNativeConsumerTests.cs` (real Main shell dimensions/cwd/cleanup and early same-executable helper IPC/capability expiry); `TerminalClientLifecycleTests.cs` (real paired WebSockets, normal detach/disposal followed by retained exit-snapshot completion); `WebUiRealtimeRevisionTests.cs`; `NodeServiceTransportTests.cs`; `packages/webui/test/experimentHostNodeCode.e2e.mjs` (real CLI process/input/output/resize, two browser clients, pending helper owner-detach rejection, ordinary-client exclusion, explicit close and reconnect/restart rediscovery); `packages/webui/test/experimentHostNodeTerminalList.e2e.mjs` (delayed genuine list response, concurrently created real CLI PTY, unchanged browser attachment/PID/output and explicit kill).
