# Unit: CLI node client

Files: packages/cli-node/src/client.ts, packages/cli-node/src/nodePtyService.ts, packages/cli-node/src/nodePtyService.test.ts, packages/cli-node/scripts/build-bundle.js, packages/cli-node-runtime/package.json, packages/cli-node-runtime/package-lock.json

## Purpose

Implements the full remote Node.js client: pairing/authenticated WebSocket connection, shared-tool execution, service dispatch, bidirectional file transfer, protocol heartbeat/reconnect, localhost trigger, session RPC, and optional node-local Code PTYs.

## Key exports

- `NodeClient`, `NodeClientOptions`.
- `CliNodeSessionSummary`, `CliNodeHistoryMessage`.
- `NodePtyService`, `loadNodePtyService`.

## Public `NodeClient` methods

- `connect()`, `disconnect()`.
- `startLocalTriggerServer()`.
- `sendSessionEvent(sessionId, message, eventType?)`.
- `listBoundSessions()`.
- `getSessionHistory(sessionId, count=30)`.
- `sendSessionMessage(sessionId, message)`.

`listSessions()` is not the current API name. Auto-approve configuration belongs to the TUI, which implements it inside `toolCallInterceptor`.

## Stable sections

| Section | Responsibility |
|---|---|
| credential helpers | load/save/clear local approved credentials |
| local trigger | loopback HTTP server, random token, state files, helper script |
| connection setup | proxy-aware URL, pairing or auth headers, handlers, reconnect |
| heartbeat | client protocol ping/pong and stale-socket termination |
| message dispatch | pairing/auth, model tools, file transfer, services, session RPC |
| node PTY service | lifecycle, backlog, detach/reattach, helper IPC, output events |
| request helper | request-ID correlation for session RPC |

## Behavior

- Pairing mode sends `pair_request`; approved credentials are saved and the socket reconnects in authenticated mode before `node_register`.
- Authentication failure clears local credentials and returns to pairing behavior.
- Client heartbeat sends WebSocket ping frames every 30 seconds, expects pong within 10 seconds, and reconnects after a 5-second delay.
- Model tool calls resolve against shared `nodeTools`, explicitly use the shared native file-operations backend in the CLI process, and may be rejected/timed out by `toolCallInterceptor`.
- Current shared tool image results use structured inline data; old node result reading exists only at the master ingress under [D-node-thread-tool-result-compatibility](../threads/node-communication.md#d-node-thread-tool-result-compatibility).
- File transfer uses shared node file-transfer helpers.
- `node_service_request`, `node_service_command`, and `node_service_event` are separate from model-tool interception.
- Optional `node-pty` is loaded from `FOXWARM_NODE_RUNTIME_DIR` or the sibling runtime package; service version is advertised only after success.
- PTYs keep bounded output, support detach/reattach, and use capability-bound local IPC for the terminal `code` helper.
- The trigger server binds loopback, requires its generated bearer token, and removes discoverability files on shutdown.

## Dependencies

- `packages/shared/dist/nodeTools`, `fileOperations`, and `nodeCapabilities`.
- Shared node file-transfer and VS Code service dispatch modules.
- `masterProxy` for standard proxy handling.
- `packages/cli-node-runtime` for optional official `node-pty`.

## Design decisions

### D-cli-client-optional-pty

The native PTY runtime is a separate target package. Missing PTY support does not remove filesystem, Git, model-tool, file-transfer, or session capabilities.

## Canonical ownership

Terminal helper IPC is canonical in [D-node-thread-helper-ipc](../threads/node-communication.md#d-node-thread-helper-ipc).
