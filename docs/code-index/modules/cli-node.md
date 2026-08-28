# Module: CLI node

## Responsibility

The CLI node is the full remote worker client. It connects to the master over WebSocket, pairs or authenticates, executes shared node tools, transfers files, advertises versioned Code services, optionally hosts node-local PTYs, exposes a localhost session-event trigger, and provides an Ink/React approval TUI.

## Units

- [cli-node-client](../units/cli-node-client.md) — connection, pairing/auth, tool/service dispatch, file transfer, heartbeat, trigger server, and PTY host.
- [cli-node-master-proxy](../units/cli-node-master-proxy.md) — standard environment proxy resolution and safe logging.
- [cli-node-tui](../units/cli-node-tui.md) — bound-session/history UI and model-tool approval.

Cross-module protocol: [node communication](../threads/node-communication.md).

## Public interfaces

- `NodeClient` and `NodeClientOptions`.
- `NodeClient.connect()`, `disconnect()`, `startLocalTriggerServer()`, `sendSessionEvent()`, `listBoundSessions()`, `getSessionHistory()`, and `sendSessionMessage()`.
- `CliNodeSessionSummary`, `CliNodeHistoryMessage`.
- `NodePtyService`, `loadNodePtyService`.
- `createMasterWebSocketOptions`, `getMasterProxyInfo`, `sanitizeProxyUrl`.

Auto-approve flags are TUI options implemented by the TUI's `toolCallInterceptor`; they are not `NodeClientOptions` fields.

## Behavior

- Pairing success persists `nodeId`/`authToken` locally; authentication failure clears stale credentials before reconnection.
- Pairing and registration advertise the bounded core Node-protocol range. The client validates Master's negotiated response before starting exec recovery; an incompatible response disables automatic reconnect until the process is updated/restarted. Canonical contract: [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).
- Both master and CLI client use WebSocket protocol ping/pong heartbeat at 30-second intervals with a 10-second timeout.
- Shared `nodeTools` execute after the optional model-tool interceptor approves them.
- File transfer sends one whole-file base64 payload with SHA-256 metadata in each JSON request/response.
- Versioned `vscode-fs`/`vscode-git` and optional `vscode-pty` are backend services, not model tools; they bypass the TUI interceptor and accept only fixed operations.
- The localhost trigger uses a random bearer token, state metadata, and a helper shell script to call the existing `sendSessionEvent` path.
- HTTP(S) proxy selection comes only from standard upper/lower-case proxy variables and `NO_PROXY`; WebSocket schemes are mapped to HTTP schemes for `proxy-from-env`.

## Packaging

- The master build produces `client.bundle.js` and `tui.bundle.js` with esbuild.
- The bootstrap source archive normally carries those bundles; remote startup does not install master-only dependencies.
- `packages/cli-node-runtime` isolates official `node-pty`. Loading failure disables only `vscode-pty` on bare metal.
- Windows bootstrap uses PowerShell; no cmd workflow is maintained.

## Compatibility

- `/node/run-cli-node.sh` remains an HTTP alias for the current interactive launcher.
- No old `interactive-node` package/command alias is documented as current.

## Design decisions

### D-cli-node-one-client

Connection, authentication, tool/service transport, file transfer, heartbeat, trigger, and session RPC share one `NodeClient`; the TUI supplies policy through the interceptor.

### D-cli-node-standard-proxy

Proxy behavior is centralized and follows standard environment variables, including `NO_PROXY`; logs redact userinfo.

## Canonical ownership

Bootstrap artifact ownership: [D-node-bootstrap-bundle](./nodes.md#d-node-bootstrap-bundle). Model tool/backend service separation: [D-node-thread-tool-service-split](../threads/node-communication.md#d-node-thread-tool-service-split).
