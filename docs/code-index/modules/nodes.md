# Module: nodes

## Responsibility

Main-owned generic Node discovery/provider resolution plus authenticated remote-node lifecycle: pairing and approved credentials, the `/node_ws` protocol, connected-node registration/dispatch, node-scoped session-event authorization, backend service transport, and public bootstrap artifacts.

## Units

- [src-node-providers](../units/src-node-providers.md) — generic safe descriptors/registry, optional provider lifecycle, master and authenticated-remote adapters, and startup-configured executable sandbox providers.
- [src-docker-worktree-provider](../units/src-docker-worktree-provider.md) — resident first-party Linux Docker provider for one existing worktree, read-only Git metadata, strict lifecycle state, and shared file capabilities.
- [src-nodes-manager](../units/src-nodes-manager.md) — connected-node map, model-tool dispatch, backend-service request/command/event routing, and session access checks.
- [src-node-execution](../units/src-node-execution.md) — fixed versioned Main RPC boundary for generic non-master Node capability execution, topology, selection, provider lifecycle, and compound copy.
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
- `nodeProviderRegistry` — production registry for fixed master/authenticated-remote providers plus normalized startup executable providers.
- `foxwarm-node-provider@1` — one-shot bounded JSON stdin/stdout contract for trusted executable sandbox providers, including optional create/ensure/inspect/destroy operations; see `docs/executable-node-provider-protocol.md`.
- `executeNodeTool()` — placement-neutral service caller for direct and dynamic non-master Node capability execution.

## Bootstrap surface

Unauthenticated bootstrap routes are:

- `/node/run.sh` — bare-metal launcher; requires an explicit `--dir`.
- `/node/run-docker.sh` — Docker wrapper.
- `/node/run-interactive.sh` and compatibility `/node/run-cli-node.sh` — CLI/TUI launcher.
- `/node/run.ps1` — PowerShell launcher.
- `/node/docker-compose.yaml` — compose template.
- `/node/source.tar.gz` — minimal dynamic archive containing shared, CLI-node, PTY-runtime, and sandbox-start sources/artifacts.

The source archive normally includes the built CLI bundles produced by the master build. `run.sh` uses `client.bundle.js` without installing the CLI dependency tree; if the bundle is absent it requires npm and builds shared/CLI as a fallback. The optional `node-pty` runtime is installed separately. Bare-metal failure leaves non-PTY capabilities available; Docker image preparation treats its required installation path as fatal.

The operator-facing deployment/configuration workflow is documented by the single `skills/node-setup/SKILL.md` source skill. Temporary isolated-worker creation remains a separate `skills/isolated-worker/SKILL.md` workflow: it may bind an already-online Node or compose one configured provider `ensure` plus read-only inspect before agent/session creation. It does not create Git worktrees, add a lease/ownership layer, or replace node setup.

## Invariants

- The master persists only SHA-256 authentication-token hashes. Plaintext exists only in the pending approval/claim handoff.
- Pending pairings expire after one hour; unclaimed approved handoffs are cleaned with their node record.
- Node IDs are slugged, validated against reserved IDs, and deduplicated.
- Master-side WebSocket heartbeat sends protocol ping frames every 30 seconds and requires liveness within 10 seconds.
- Pre-authentication messages are queued and replayed after authentication.
- Node-to-session `session_event` is allowed only when the target session's `currentNode` equals the authenticated node ID, or the target belongs to an isolated agent bound to that node. The master validates with the authenticated node ID.
- Agent isolation is an agent-level permission boundary. Selecting a session `currentNode` routes execution but does not create isolation or an exclusive lease.
- Backend services are versioned fixed protocols and do not pass through model-tool approval.
- Generic Node capability execution resolves the exact non-master provider in Main; unsupported capabilities never fall back to master.
- Executable providers are startup-only trusted configuration, advertise sandbox-kind Nodes, and receive complete capability calls rather than low-level file/process RPC. Their path and restriction semantics remain provider-defined.
- Docker worktree providers are startup-configured resident Main providers. They accept only existing allowlisted Git worktrees, mount source writable and Git administration read-only, and advertise only shared file capabilities in the initial phase.
- Node lifecycle is a provider-neutral Main-owned control plane through the existing `node` builtin. Create/ensure route by exact configured provider ID; inspect/destroy resolve the exact existing Node owner. Provider effect and data-retention text remains descriptive rather than a generic deletion or security guarantee.

## Compatibility

- Approved-node rename is server-side registry migration plus old-runtime disconnect. The current client has no credential-rewrite protocol; the operator updates/restarts/re-pairs the node.
- `/node/run-cli-node.sh` remains a bootstrap route alias for the current interactive script.
- Existing numbered `nodes.json` backups remain readable through the durable JSON store.

## Design decisions

### D-node-credential-hash

Persist approved authentication tokens only as hashes on the master; return plaintext once through the approved pending claim.

### D-node-session-event-scope

The authenticated node ID is mandatory input to master-side session-event authorization. Client-provided target data cannot bypass current-node or isolated-agent binding checks.

### D-node-isolation-boundary

`currentNode` is execution routing. `agent.isolatedNode` is the isolation boundary inherited by that agent's sessions. Pairing/binding does not imply node exclusivity or environment virtualization.

### D-node-bootstrap-bundle

Bootstrap distributes one minimal dynamic source archive with prebuilt CLI bundles when available, plus an explicit build fallback and separately installed optional PTY runtime.

Generic Node/provider ownership is canonical in [D-dispatch-generic-node-providers](../threads/tool-dispatch.md#d-dispatch-generic-node-providers).

### D-node-isolated-worker-provider-compose

[2026-08-21] The bundled `isolated-worker` ToolScript may optionally compose the existing provider-neutral `ensure`/`inspect` lifecycle before creating a bound isolated agent and parent-linked session. Provider ID and exact existing worktree path are explicit inputs; absent-Node dry run remains mutation-free and reports deferred canonical evidence. The human-readable Node list is section-parsed exactly so Node IDs and provider IDs cannot alias across the `Lifecycle providers:` boundary. Apply validates the exact ready Docker-worktree descriptor/details before agent mutation. Post-ensure accounting separates raw exact requested-Node presence from full workflow validation and reports `present` or `unknown`, with unknown represented as a possible survivor. This orchestration is fail-fast and non-transactional, preserves the existing explicit agent cleanup boundary, never auto-destroys a Node, and does not imply Node ownership or exclusivity. Preflight absence plus post-ensure presence is only an observation and possible surviving mutation, not proof that this workflow created or owns the Node; cleanup retains it by default and requires independent confirmation before any separate explicit destroy.

### D-node-android-adb-host

[2026-08-06] The current `packages/android-node` implementation is an unpublished ADB host-run node. Inline screenshots are JPEG quality 80. Connection configuration reads only the current `FOXWARM_*` environment variables; removed predecessor aliases are not accepted. It is not the unimplemented Termux/standalone accessibility-and-capture architecture.

## Canonical ownership

Approved-node rename/runtime invalidation is canonical in [D-node-thread-rename](../threads/node-communication.md#d-node-thread-rename).
