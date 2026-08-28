# Unit: src-nodes-misc

Files: src/nodes/websocket.ts, src/nodes/websocketProtocol.test.ts, src/nodes/httpRoutes.ts, src/nodes/httpRoutes.test.ts, src/nodes/runSh.test.ts, src/nodes/runPs1.test.ts, src/nodes/bootstrapInfo.ts, src/nodes/bootstrapInfo.test.ts, src/nodes/cliSessionAccess.test.ts, src/tools/changeCurrentNode.test.ts, src/commands/nodeCommand.test.ts, templates/node/run.sh, templates/node/run.ps1

## Purpose

Manages node connectivity to the master server via WebSocket (pairing and authenticated modes), serves HTTP bootstrap/template routes for node onboarding scripts, and provides utilities to generate bootstrap information (pairing tokens, endpoint URLs, example commands) for operators setting up new nodes.

## Key Exports

- `registerNodeWebSocket(httpServer, nodeToken)` — registers the `/node_ws` WebSocket endpoint handling pairing and approved-node connections
- `registerNodeHttpRoutes(httpServer)` — registers HTTP GET routes for node bootstrap scripts and source tarball
- `inferNodeBootstrapBaseUrl(req)` — derives the base URL from request headers
- `renderNodeTemplateText(templateText, req)` — replaces placeholder in template text with inferred base URL
- `NODE_TEMPLATE_BASE_URL_PLACEHOLDER` — the placeholder string used in templates
- `NODE_SOURCE_FILES` — list of paths included in the source tarball
- `buildNodeBootstrapInfo(options)` — constructs a `NodeBootstrapInfo` object with endpoints and examples
- `ensureNodePairingToken()` — reads or generates the persistent pairing token
- `NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER` — placeholder constant (`$BASE_URL`)
- `NodeBootstrapInfo` (interface) — shape of the bootstrap info response

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `rawDataToString(message)` | ~15 | Converts WebSocket RawData to a UTF-8 string |
| `setupNodeHeartbeat(ws, params)` | ~45 | Configures ping/pong heartbeat with timeout termination |
| `registerNodeWebSocket(httpServer, nodeToken)` | ~200 | Main WebSocket handler for pairing and approved node connections |
| `processNodeMessage(messageText)` (inner) | ~120 | Dispatches incoming node messages by type |
| `ensureNodeTemplateFiles()` | ~7 | Validates that all required template files exist on disk |
| `firstHeaderValue(value)` | ~6 | Extracts first value from a potentially comma-separated header |
| `sanitizeBootstrapProto(value)` | ~6 | Validates and normalizes protocol to http/https |
| `sanitizeBootstrapHost(value)` | ~6 | Validates host header against safe character pattern |
| `inferNodeBootstrapBaseUrl(req)` | ~10 | Builds base URL from forwarded/host headers and protocol |
| `renderNodeTemplateText(templateText, req)` | ~5 | Replaces placeholder with inferred base URL |
| `addTextRoute(httpServer, routePath, filePath, contentType)` | ~10 | Registers a GET route that serves a rendered template file |
| `registerNodeHttpRoutes(httpServer)` | ~40 | Registers all node HTTP routes including source tarball |
| `buildEndpointUrls(baseUrlPlaceholder)` | ~20 | Constructs endpoint path/URL map from a base URL |
| `buildNodeBootstrapInfo(options)` | ~40 | Assembles full bootstrap info with examples and explanations |
| `ensureNodePairingToken()` | ~15 | Reads token from file or generates and persists a new one |
| `makeRequest(headers, protocol)` (test) | ~6 | Test helper to create a mock request object |
| `makeId(prefix)` (test) | ~5 | Test helper generating unique IDs |
| `seedSession(sessionId, nodeId, agent)` (test) | ~12 | Test helper that creates a session with history |
| `withTempDir(run)` (test) | ~10 | Test helper providing a temp directory with cleanup |
| `capabilities(label)` (test) | ~5 | Test helper building a minimal capabilities object |

## Dependencies

- `../httpServer` — `HttpServer` class for registering routes and WebSocket handlers
- `./manager` — `nodesManager` for node registration, tool dispatch, session access
- `./registry` — pairing lifecycle functions (`createPendingPairing`, `authenticateApprovedNode`, `claimApprovedPairing`, `touchApprovedNode`, etc.)
- `../common` — `logger`
- `../config` — `BASE_DIR`, `HTTP_PORT`, `NODE_TOKEN_FILE`, `getAgentDir`
- `../sessionManager` — session CRUD and isolation checks (in tests)
- `../tools` — tool definitions catalog (in tests)
- `../commands` — `COMMANDS` registry (in tests)

## Behavior

- WebSocket supports two connection modes: **pairing** (new node presents a shared token, sends `pair_request`, waits for approval) and **approved** (returning node authenticates with node ID + auth token, then registers).
- Pairing persists the offered core protocol range. Approved registration negotiates it before capability admission; omitted metadata is legacy generation 1, compatible peers receive the selected protocol, and incompatible authenticated peers receive a structured upgrade-required response while remaining connected under a message quarantine. Canonical contract: [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).
- Heartbeat pings every 30s; terminates the socket if no pong within 10s. Activity is recorded in both the in-memory manager and the persistent registry.
- Messages received before authentication completes are queued and replayed once ready.
- Authenticated message dispatch forwards `node_service_response`, `node_service_error`, and `node_service_event` to the manager with the actual socket's node identity, preventing one node from satisfying another node's pending request/event channel.
- HTTP routes serve shell scripts, PowerShell scripts, docker-compose YAML, and a gzipped source tarball. The tarball includes the separately locked `packages/cli-node-runtime` package but excludes its platform-installed node_modules. Text routes replace a placeholder with the request-derived base URL.
- Bare-metal `run.sh` requires an explicit `--dir` and derives its source, env, data, log, PID/mode, launcher, and generated-unit paths beneath that root. `-d` prefers tmux and falls back to nohup; `--install` installs a root system service or non-root user service and runs the foreground launcher directly under systemd supervision.
- Windows `run.ps1` binds node agent storage to the absolute `<StateDir>\agents` path through `FOXWARM_AGENTS_DIR`, clears the higher-precedence single-agent override, and starts Node from the script directory, so inherited environment or invoking a saved bootstrap script from another project cannot relocate node-owned capture state into the caller cwd.
- Source-distribution regression coverage builds the same allowlisted tar archive with package node_modules excluded and starts the real prebuilt client bundle through `run.sh` in a clean temporary root, preventing externalized bundle modules from accidentally relying on the master checkout's dependencies.
- Docker node bootstrap uses pinned Node 24 and installs the runtime package strictly. Shell/PowerShell bootstrap installs only that package after extracting the prebuilt JS bundle and continues without PTY capability if npm/native installation is unavailable.
- `ensureNodePairingToken` lazily generates a 32-byte hex token on first use and persists it to disk.
- `buildNodeBootstrapInfo` intentionally uses a `$BASE_URL` placeholder rather than guessing the external address, with operator instructions.

## Integration

- The WebSocket endpoint is the primary communication channel between remote nodes and the master; it feeds `nodesManager` which exposes node tools to sessions and the agent loop.
- HTTP bootstrap routes enable one-liner node setup from any machine that can reach the master.
- `buildNodeBootstrapInfo` is exposed as the `node_bootstrap_info` tool in the tool catalog. Session Workers call it, pending-pair listing, and approval through the exact-source-fenced Main-management topology boundary; node registry/token authority stays in Main.
- Tests for `/node` commands and `change_current_node` verify the CLI surface for managing nodes, including approved-node remove/move behavior, online-runtime disconnects, and switching a session's active node context.
- CLI session access tests confirm that node-scoped session isolation is enforced (a node can only see its own sessions).