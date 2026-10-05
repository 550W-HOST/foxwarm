# Unit: src-nodes-misc

Files: src/nodes/websocket.ts, src/nodes/websocketProtocol.test.ts, src/nodes/httpRoutes.ts, src/nodes/httpRoutes.test.ts, src/nodes/runSh.test.ts, src/nodes/runPs1.test.ts, src/nodes/bootstrapInfo.ts, src/nodes/bootstrapInfo.test.ts, src/nodes/cliSessionAccess.test.ts, src/tools/changeCurrentNode.test.ts, src/commands/nodeCommand.test.ts, templates/node/run.sh, templates/node/run-docker.sh, templates/node/run-interactive.sh, templates/node/run.ps1, templates/node/docker-compose.yaml, scripts/start-sandbox-node.sh

## Purpose

Manages node connectivity to the master server via WebSocket (pairing and authenticated modes), serves HTTP bootstrap/template routes for node onboarding scripts, and provides utilities to generate bootstrap information (pairing tokens, endpoint URLs, example commands) for operators setting up new nodes.

## Key Exports

- `registerNodeWebSocket(httpServer, nodeToken)` — registers the `/node_ws` WebSocket endpoint handling pairing and approved-node connections
- `registerNodeHttpRoutes(httpServer)` — registers Node bootstrap/source routes and Shell HTTP transport; returns the Shell runtime teardown callback
- `inferNodeBootstrapBaseUrl(req)` — derives the base URL from request headers
- `renderNodeTemplateText(templateText, req)` — replaces placeholder in template text with inferred base URL
- `NODE_TEMPLATE_BASE_URL_PLACEHOLDER` — the placeholder string used in templates
- `NODE_SOURCE_FILES` — list of paths included in the source tarball
- `buildNodeBootstrapInfo(options)` — constructs a `NodeBootstrapInfo` object with complete configured or replaceable example addresses
- `buildNodeBootstrapCommands(options)` — pure shared generation of independent shell, PowerShell, and Compose commands for CLI help and authenticated WebUI onboarding
- `buildNodeManualComposeExample(token, baseUrl?, nodeId?)` — generates shell-literal, owner-only Compose `.env` setup instructions
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
| `buildNodeBootstrapCommands(options)` | ~35 | Builds independent literal-address commands using contextual quoting |
| `buildNodeManualComposeExample(token, baseUrl?, nodeId?)` | ~15 | Renders Compose bootstrap commands with quoted public URL values |
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

- WebSocket supports two connection modes: **pairing** (new node presents a shared token, sends `pair_request`, waits for approval) and **approved** (returning or pre-created node authenticates with node ID + auth token, then registers). `pair_pending` carries the complete pending ID without a six-digit display code; rejected-credential diagnostics never log query strings.
- Pairing persists the offered core protocol range. Approved registration negotiates it before capability admission; omitted metadata is executable legacy generation 1, current peers select generation 3, and only malformed/disjoint authenticated peers receive a structured upgrade-required response while remaining connected under a message quarantine. Canonical contract: [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).
- Heartbeat pings every 30s; terminates the socket if no pong within 10s. Activity is recorded in both the in-memory manager and the persistent registry.
- Messages received before authentication completes are queued and replayed once ready.
- Authenticated message dispatch forwards `node_service_response`, `node_service_error`, `node_service_event` and external exec registration/completion/query responses to the manager with the actual socket's node identity. Signed external receipts are context/Node-scoped and do not enter Session events.
- HTTP routes serve shell scripts, PowerShell scripts, docker-compose YAML, and a gzipped source tarball. The tarball includes the separately locked `packages/cli-node-runtime` package but excludes its platform-installed node_modules. Text routes replace a placeholder with the request-derived HTTP origin even if a public config URL is set; a deployment path requires an explicit launcher host flag.
- Bare-metal `run.sh` requires an explicit `--dir` and derives its source, env, data, log, PID/mode, launcher, and generated-unit paths beneath that root. `-d` prefers tmux and falls back to nohup; `--install` installs a root system service or non-root user service and runs the foreground launcher directly under systemd supervision.
- Windows `run.ps1` binds node agent storage to the absolute `<StateDir>\agents` path through `FOXWARM_AGENTS_DIR`, clears the higher-precedence single-agent override, and starts Node from the script directory, so inherited environment or invoking a saved bootstrap script from another project cannot relocate node-owned capture state into the caller cwd.
- Source-distribution regression coverage builds the same allowlisted tar archive with package node_modules excluded and starts the real prebuilt client bundle through `run.sh` in a clean temporary root, preventing externalized bundle modules from accidentally relying on the master checkout's dependencies.
- Docker node bootstrap uses pinned Node 24 and installs the runtime package strictly. Shell/PowerShell bootstrap installs only that package after extracting the prebuilt JS bundle and continues without PTY capability if npm/native installation is unavailable.
- `ensureNodePairingToken` lazily generates a 32-byte hex token on first use and persists it to disk.
- `buildNodeBootstrapInfo` and CLI help reuse `buildNodeBootstrapCommands`: each example inlines its full URL and explicit host, with contextual shell/PowerShell quoting and a literal Compose heredoc. Without config `url`, commands use `http://YOUR_MASTER:<HTTP_PORT>`; no `BASE_URL` preparation is required. Existing metadata field positions remain available, including the legacy placeholder field; they are not command prerequisites.

## Integration

- The WebSocket endpoint is the primary communication channel between remote nodes and the master; it feeds `nodesManager` which exposes node tools to sessions and the agent loop.
- HTTP bootstrap routes enable one-liner node setup from any machine that can reach the master.
- `/node/run-shell.sh` serves the independent POSIX sh/curl client; the same route registration installs its authenticated HTTP transport. The Shell Node's execution/output/completion contract is owned by [src-nodes-shell-http](./src-nodes-shell-http.md).
- `buildNodeBootstrapInfo` is exposed as the `node_bootstrap_info` tool in the tool catalog. Session Workers call it, pending-pair listing, and approval through the exact-source-fenced Main-management topology boundary; node registry/token authority stays in Main.
- Tests for `/node` commands and `change_current_node` verify the CLI surface for managing nodes, including approved-node remove/move behavior, online-runtime disconnects, and switching a session's active node context.
- CLI session access tests confirm that node-scoped session isolation is enforced (a node can only see its own sessions).