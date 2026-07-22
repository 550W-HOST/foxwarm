# Unit: src-nodes-manager

Files: src/nodes/manager.ts, src/nodes/legacyToolResultCompatibility.ts, src/nodes/legacyToolResultCompatibility.test.ts

## Purpose

Maintains the in-memory view of connected nodes and routes tool/file/session requests between Foxwarm sessions and remote node WebSocket connections. The manager always registers the local `master` node, tracks remote node capabilities, dispatches remote tool calls, and enforces node-scoped session access for node-originated events.

## Key Exports

- `NodesManager` — class that owns node registration, runtime node state, pending tool/file operations, and session-access checks.
- `nodesManager` — singleton used by the LLM/tool layer, WebSocket handlers, slash commands, and node tools.
- `NodeServiceRequestError` — structured unavailable/unsupported/timeout/service failure propagated to authenticated Code HTTP routes.
- `adaptLegacyRemoteNodeToolResult` — pure, separately deletable read-old adapter used only at remote model-tool response ingress.

## Function Index

| Function | Description |
|----------|-------------|
| `setupTools()` | Initializes the legacy/master tool-name set used for local execution and legacy nodes. |
| `registerMasterNode()` | Registers the built-in `master` node with local tools and no WebSocket. |
| `registerNode(ws, req, customNodeId?)` | Registers a legacy remote node; closes an older connection with the same id. |
| `registerNodeWithTools(ws, req, nodeType, capabilities, customNodeId?)` | Registers an authenticated/capability-advertising node and stores its dynamic tool names. |
| `unregisterNode(nodeId, ws?)` | Removes a node if the close/error event belongs to the active WebSocket for that id. |
| `disconnectNode(nodeId, reason?)` | Forcibly removes a non-master runtime node, rejects pending operations for it, and closes its WebSocket. |
| `getCurrentNode(sessionId)` / `setCurrentNode(sessionId, nodeId)` | Reads or validates a session's current node selection. |
| `getNode(nodeId)` / `listNodes()` / `listNodesWithTools()` | Query runtime node state and dynamic capabilities. |
| `executeNodeTool(...)` / `executeTool(...)` | Dispatches a tool call locally for `master` or over WebSocket for a remote node. |
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
| `handleSessionEvent(...)` / `handleSessionUserMessage(...)` | Accepts node-originated session events only when the node owns the session context. |
| `updateNodeActivity(nodeId)` | Refreshes last-activity timestamp for connected nodes. |
| `getToolDefinition(toolName)` | Looks up master-side tool definitions lazily to avoid circular imports. |
| `executeToolLocally(toolName, args, sessionId)` | Invokes a master-local tool with a runtime-node-aware context. |

## Dependencies

- `ws` — WebSocket connection objects for remote nodes.
- `../sessionManager` — session lookup, isolation metadata, queueing node-originated events.
- `../nodeFileTransfer` — master-side read/write transfer helpers.
- `./registry` — reserved node-id checks for runtime registration.
- `../tools` (lazy require) — local tool implementations and definitions.

## Behavior

- `master` is always present in the runtime node map and cannot be disconnected by `disconnectNode`.
- Registering a remote node with an already-online id closes the previous WebSocket and replaces runtime capabilities.
- Remote tool calls, file transfers, and backend service requests are tracked by generated ids and time out if no response arrives. Service timers are cleared on reply/disconnect. Fixed commands avoid per-keystroke response state; authenticated service events are dispatched to registered listeners.
- Node disconnect emits `node-unavailable` to each advertised service before removal, allowing terminal bridges to close clients while leaving detached node-owned PTYs eligible for rediscovery after a same-process reconnect.
- `disconnectNode` is used by administrative `/node remove` and `/node move` flows so deleting or renaming approved credentials also removes online runtime state and rejects pending work for the old node id.
- Node-originated session access is allowed only when the target session's `currentNode` matches the node id or the session's agent is isolated and bound to that node.
- Local/master execution passes `__runtimeNodeId` through tool context when needed, then strips it from user-visible tool args.
- Remote model-tool responses pass through one isolated compatibility adapter before their pending call resolves. Master-local and MCP results never enter this adapter. The adapter's complete deletion contract is canonical in [D-node-thread-tool-result-compatibility](../threads/node-communication.md#d-node-thread-tool-result-compatibility).

## Integration

- `src/nodes/websocket.ts` registers authenticated node sockets with `registerNodeWithTools`, forwards responses/events into this manager, and unregisters sockets on close/error.
- `src/commands.ts` uses `nodesManager` for `/node` list/switch/remove/move runtime behavior.
- `src/tools/nodeTools.ts`, `src/tools/unifiedSearch.ts`, `src/llm.ts`, and channel/file helpers query the singleton for node availability and remote execution.

## Design Decisions

- [2026-06-24] Administrative node deletion/rename should not leave an online node usable under stale credentials; the manager exposes `disconnectNode` so command flows can unregister the runtime node and close its WebSocket after registry mutation.
