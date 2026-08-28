# Unit: src-nodes-manager

Files: src/nodes/manager.ts, src/nodes/protocolCompatibility.test.ts, src/nodes/sessionEventCapability.ts, src/nodes/sessionEventCapability.test.ts, src/nodes/legacyToolResultCompatibility.ts, src/nodes/legacyToolResultCompatibility.test.ts

## Purpose

Maintains the in-memory authenticated remote-node transport/runtime and routes tool/file/session requests between Foxwarm sessions and remote WebSocket connections. The manager still registers the local `master` record for existing local/compound/service behavior, while generic Node discovery and non-master provider resolution live in `src/nodes/providerRegistry.ts`.

## Key Exports

- `NodesManager` — class that owns node registration, runtime node state, pending tool/file operations, and session-access checks.
- `nodesManager` — singleton used by the LLM/tool layer, WebSocket handlers, slash commands, and node tools.
- `NodeServiceRequestError` — structured unavailable/unsupported/timeout/service failure propagated to authenticated Code HTTP routes.
- `NodeProtocolIncompatibleError` — structured non-retryable guard raised before any operation can reach a quarantined authenticated Node.
- `adaptLegacyRemoteNodeToolResult` — pure, separately deletable read-old adapter used only at remote model-tool response ingress.

## Function Index

| Function | Description |
|----------|-------------|
| `setupTools()` | Initializes the legacy/master tool-name set used for local execution and legacy nodes. |
| `registerMasterNode()` | Registers the built-in `master` node with local tools and no WebSocket. |
| `registerNode(ws, req, customNodeId?)` | Registers a legacy remote node; closes an older connection with the same id. |
| `registerNodeWithTools(ws, req, nodeType, capabilities, customNodeId?)` | Registers an authenticated/capability-advertising node and stores its dynamic tool names. |
| `registerIncompatibleNodeWithTools(...)` | Retains an authenticated incompatible connection for status/heartbeat while exposing no executable tools or services. |
| `unregisterNode(nodeId, ws?)` | Removes a node if the close/error event belongs to the active WebSocket for that id. |
| `disconnectNode(nodeId, reason?)` | Forcibly removes a non-master runtime node, rejects pending operations for it, and closes its WebSocket. |
| `getCurrentNode(sessionId)` / `setCurrentNode(sessionId, nodeId)` | Reads or validates a session's current node selection. |
| `getNode(nodeId)` / `listNodes()` / `listNodesWithTools()` | Query runtime node state and dynamic capabilities. |
| `listNodeServiceSummaries()` | Returns a copy of connected node IDs/types/service versions and activity without exposing model-tool schemas. |
| `executeNodeTool(...)` / `executeTool(...)` | Dispatches a tool call locally for `master` or over WebSocket for a remote node; direct parallel exec may provide a node/cwd routing snapshot. |
| `handleToolResponse(...)` / `handleToolError(...)` | Resolves/rejects a pending remote tool call by call id. |
| `adaptLegacyRemoteNodeToolResult(result)` | Converts the explicitly supported old remote-node image result shapes to current structured inline data without mutating canonical or malformed values. |
| `readFileFromNode(...)` / `writeFileToNode(...)` | Reads/writes local or remote files through the node file-transfer protocol. |
| `handleFileReadResponse(...)` / `handleFileWriteResponse(...)` / `handleFileTransferError(...)` | Resolves/rejects pending remote file transfers. |
| `requestNodeService(...)` | Dispatches a fixed-operation backend service only when the connected node advertises a supported service version. |
| `sendNodeServiceCommand(...)` | Sends a capability-checked fixed backend command without allocating a pending response, used for terminal input/resize. |
| `handleNodeServiceResponse(...)` / `handleNodeServiceError(...)` | Correlates service replies by request id and verifies they came from the target node. |
| `onNodeServiceEvent(...)` / `handleNodeServiceEvent(...)` | Subscribes and dispatches authenticated asynchronous service events such as PTY output/exit. |
| `listNodeIdsWithService(service)` | Lists connected remote nodes advertising the requested backend service. |
| `listSessionsForNode(...)` / `getSessionHistoryForNode(...)` | Provides node-scoped session list/history for CLI-node/TUI integrations. |
| `handleSessionEvent(...)` / `handleSessionUserMessage(...)` | Accepts ordinary node-originated session events under current ownership and exec completion under a signed start-time capability. |
| `updateNodeActivity(nodeId)` | Refreshes last-activity timestamp for connected nodes. |
| `getToolDefinition(toolName)` | Looks up master-side tool definitions lazily to avoid circular imports. |
| `executeToolLocally(toolName, args, sessionId)` | Invokes a master-local tool with a runtime-node-aware context. |

## Dependencies

- `ws` — WebSocket connection objects for remote nodes.
- `../sessionManager` / `../sessionRuntime` — catalog/isolation metadata, projection-aware current assignment and history reads, and queueing node-originated events.
- `../nodeFileTransfer` — master-side read/write transfer helpers.
- `./registry` — reserved node-id checks for runtime registration.
- `../tools` (lazy require) — local tool implementations and definitions.

## Behavior

- `master` is always present in the runtime node map and cannot be disconnected by `disconnectNode`. Its advertised model-tool set and discovery schemas are derived from canonical `NODE_ENVIRONMENT_BUILTIN_NAMES`, not a handwritten broad list.
- Registering a remote node with an already-online id closes the previous WebSocket and replaces runtime capabilities.
- Every runtime record carries core protocol compatibility. Negotiated generation 1 and 2 Nodes are executable and retain advertised tool/service/session-event paths; quarantined disjoint Nodes stay in `listNodes()` and service-summary status, while tool discovery omits them and selection, tools, file transfer, backend services, and application events fail before dispatch. Canonical contract: [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility).
- Remote tool calls, file transfers, and backend service requests are tracked by generated ids and time out if no response arrives. Service timers are cleared on reply/disconnect. Fixed commands avoid per-keystroke response state; authenticated service events are dispatched to registered listeners.
- Node disconnect emits `node-unavailable` to each advertised service before removal, allowing terminal bridges to close clients while leaving detached node-owned PTYs eligible for rediscovery after a same-process reconnect.
- `disconnectNode` is used by administrative `/node remove` and `/node move` flows so deleting or renaming approved credentials also removes online runtime state and rejects pending work for the old node id.
- Ordinary node-originated session access is allowed only when the target session's projection-aware `currentNode` matches the node id or the session's agent is isolated and bound to that node. Remote exec dispatch additionally allocates the canonical exec ID and signed completion capability; negotiated generation 1 may perform the exact-error-gated legacy spelling fallback before process start, while generation 2 retains structured collision retries. Completion verifies authenticated node/session/exec scope and uses a deterministic external event ID, so later routing changes do not lose the result. Exact retained mailbox rows suppress replay independently, while the Session authority retains only the newest 32 IDs for suppression after mailbox cleanup. Canonical contracts: [core protocol compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility) and [remote exec completion](../threads/node-communication.md#d-node-thread-remote-exec-completion).
- Local/master execution passes `__runtimeNodeId` through tool context when needed, then strips it from user-visible tool args.
- Remote dispatch normally reads current session routing at call time. A direct parallel-exec segment may pass its one captured current-node/cwd snapshot so all calls in that segment route consistently even if live session metadata changes while they run.
- Remote model-tool responses pass through one isolated compatibility adapter before their pending call resolves. Master-local and MCP results never enter this adapter. The adapter's complete deletion contract is canonical in [D-node-thread-tool-result-compatibility](../threads/node-communication.md#d-node-thread-tool-result-compatibility).

## Integration

- `src/nodes/websocket.ts` registers authenticated node sockets with `registerNodeWithTools`, forwards responses/events into this manager, and unregisters sockets on close/error.
- `src/commands.ts` uses `nodesManager` for `/node` list/switch/remove/move runtime behavior.
- `AuthenticatedRemoteNodeProvider` adapts connected runtime descriptors, dynamic capabilities, default cwd, and complete tool forwarding to this manager without changing WebSocket internals.
- `src/nodeExecutionService.ts` validates the closed model-tool forwarding request before resolving the exact provider; authenticated remote execution then calls `executeTool`. Channel/file/backend-service helpers continue to use the manager's transport-specific operations directly.
- `src/tools/nodeTools.ts` and `src/tools/unifiedSearch.ts` use the fixed Node facade where Session-worker placement requires Main-owned topology or execution.
- The WebUI node-summary route combines `listNodeServiceSummaries()` with approved registry records so launch selectors can distinguish online capabilities from offline snapshots.

## Design Decisions

- [2026-06-24] Administrative node deletion/rename should not leave an online node usable under stale credentials; the manager exposes `disconnectNode` so command flows can unregister the runtime node and close its WebSocket after registry mutation.
