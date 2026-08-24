# Module: nodes

## Responsibility

Master-side node lifecycle: pairing and approved credentials, the `/node_ws` protocol, connected-node registration/dispatch, node-scoped session-event authorization, backend service transport, and public bootstrap artifacts.

## Units

- [src-nodes-manager](../units/src-nodes-manager.md) — connected-node map, model-tool dispatch, backend-service request/command/event routing, and session access checks.
- [src-node-execution](../units/src-node-execution.md) — fixed versioned local RPC boundary for authenticated remote node model-tool execution.
- [src-nodes-misc](../units/src-nodes-misc.md) — WebSocket handler, heartbeat, bootstrap HTTP routes/info, and local node session events.
- [src-nodes-registry](../units/src-nodes-registry.md) — pending/approved registry, pairing lifecycle, credential hashes, rename/removal, and durable storage.

Client implementations are separate modules: [CLI node](./cli-node.md) and [browser node](./browser-node.md). Cross-module protocol: [node communication](../threads/node-communication.md).

## Public interfaces

- `registerNodeWebSocket(httpServer, nodeToken)` — `/node_ws` pairing/authenticated endpoint.
- `registerNodeHttpRoutes(httpServer)` — bootstrap scripts, compose template, and source bundle.
- `buildNodeBootstrapInfo(options)` — current endpoint/examples payload for `node_bootstrap_info`.
- Pending pairing create/list/approve/reject/claim operations.
- Approved-node list/authenticate/remove/move operations.
- `nodesManager` — registration, model-tool dispatch, backend-service dispatch, runtime disconnect, and access checks.
- `executeRemoteNodeTool()` — current local service caller for direct and dynamic remote node-domain tool execution.

## Bootstrap surface

Unauthenticated bootstrap routes are:

- `/node/run.sh` — bare-metal launcher; requires an explicit `--dir`.
- `/node/run-docker.sh` — Docker wrapper.
- `/node/run-interactive.sh` and compatibility `/node/run-cli-node.sh` — CLI/TUI launcher.
- `/node/run.ps1` — PowerShell launcher; binds node-owned agent storage to its absolute state directory and launches from the script directory rather than the caller's project cwd.
- `/node/docker-compose.yaml` — compose template.
- `/node/source.tar.gz` — minimal dynamic archive containing shared, CLI-node, PTY-runtime, and sandbox-start sources/artifacts.

The source archive normally includes the built CLI bundles produced by the master build. `run.sh` uses `client.bundle.js` without installing the CLI dependency tree; if the bundle is absent it requires npm and builds shared/CLI as a fallback. The optional `node-pty` runtime is installed separately. Bare-metal failure leaves non-PTY capabilities available; Docker image preparation treats its required installation path as fatal.

The operator-facing workflow is documented by the single `skills/node-setup/SKILL.md` source skill. Isolated-worker creation is a separate post-pairing workflow, not a second node-setup skill.

## Invariants

- The master persists only SHA-256 authentication-token hashes. Plaintext exists only in the pending approval/claim handoff.
- Pending pairings expire after one hour; unclaimed approved handoffs are cleaned with their node record.
- Node IDs are slugged, validated against reserved IDs, and deduplicated.
- Master-side WebSocket heartbeat sends protocol ping frames every 30 seconds and requires liveness within 10 seconds.
- Pre-authentication messages are queued and replayed after authentication.
- Ordinary node-to-session `session_event` is allowed only when the target session's `currentNode` equals the authenticated node ID, or the target belongs to an isolated agent bound to that node. Remote exec completion instead requires the scoped start-time capability, correlated ACK, deterministic mailbox identity, and newest-32 authoritative Session receipt contract defined by [D-node-thread-remote-exec-completion](../threads/node-communication.md#d-node-thread-remote-exec-completion).
- Agent isolation is an agent-level permission boundary. Selecting a session `currentNode` routes execution but does not create isolation or an exclusive lease.
- Backend services are versioned fixed protocols and do not pass through model-tool approval.

## Compatibility

- Approved-node rename is server-side registry migration plus old-runtime disconnect. The current client has no credential-rewrite protocol; the operator updates/restarts/re-pairs the node.
- `/node/run-cli-node.sh` remains a bootstrap route alias for the current interactive script.
- Existing numbered `nodes.json` backups remain readable through the durable JSON store.

## Design decisions

### D-node-credential-hash

Persist approved authentication tokens only as hashes on the master; return plaintext once through the approved pending claim.

### D-node-session-event-scope

The authenticated node ID is mandatory input to master-side session-event authorization. Client-provided target data cannot bypass current-node or isolated-agent binding checks; the only remote-exec exception is the signed, exec-scoped grant owned by [D-node-thread-remote-exec-completion](../threads/node-communication.md#d-node-thread-remote-exec-completion).

### D-node-isolation-boundary

`currentNode` is execution routing. `agent.isolatedNode` is the isolation boundary inherited by that agent's sessions. Pairing/binding does not imply node exclusivity or environment virtualization.

### D-node-bootstrap-bundle

Bootstrap distributes one minimal dynamic source archive with prebuilt CLI bundles when available, plus an explicit build fallback and separately installed optional PTY runtime.

### D-node-android-adb-host

[2026-08-06] The current `packages/android-node` implementation is an unpublished ADB host-run node. Inline screenshots are JPEG quality 80. Connection configuration reads only the current `FOXWARM_*` environment variables; removed predecessor aliases are not accepted. It is not the unimplemented Termux/standalone accessibility-and-capture architecture.

## Canonical ownership

Approved-node rename/runtime invalidation is canonical in [D-node-thread-rename](../threads/node-communication.md#d-node-thread-rename).
