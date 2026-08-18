# Unit: src-node-execution

Files: src/nodeExecutionService.ts, src/nodeExecution.ts, src/nodeExecution.test.ts
Secondary files: src/llm.ts, src/tools/nodeTools.ts, src/tools/unifiedTools.test.ts, src/toolscript.test.ts, src/nodeExecutionExternalPlacement.test.ts, src/index.ts

## Purpose

Provides the versioned RPC boundary for model-tool execution and bounded topology/file-transfer operations over registered nodes. Main-local callers use a local transport; a Session worker borrows its one reverse transport to reach the same Main-owned handler. Main remains the sole owner of authenticated node WebSocket connections, while the colocated `master` execution environment bypasses dynamic execution and runs existing local named handlers directly.

## Key exports

- `nodeExecutionServiceDescriptor` — version 1 descriptor with fixed dynamic execute, topology list, selection validation, and compound copy methods.
- `createNodeExecutionServiceHandler()` — validates source identity, optional exact worker-source fence, remote target, isolation binding, connection state, advertised tool, args, and optional routing snapshot before dispatch.
- `executeRemoteNodeTool()` / `listNodeTopology()` / `validateNodeSelection()` / `copyBetweenNodes()` — placement-neutral callers for dynamic execution and operation-specific topology/copy behavior.
- `initializeNodeExecution()` / `shutdownNodeExecution()` — owned-local or borrowed-reverse client lifecycle with one-way terminal fencing.
- `resetNodeExecutionForTests()` — explicit test-only reset after terminal shutdown.

## Boundary

Dynamic requests contain only `sourceSessionId`, a non-master `nodeId`, the dynamic node-domain `toolName`, cloneable args, and an optional bounded `{ currentNode, cwd }` routing snapshot. Operation-specific requests carry only source/optional node filters, a display/routing current node, a selection target, or copy source/target node IDs, paths, and overwrite intent. Topology returns at most 100 nodes/200 tools per node/256 KiB total; IDs/names/types/descriptions/default cwd/paths have explicit character caps, each plain finite JSON schema is at most 16 KiB, and accessor/oversize schemas are omitted without evaluation. Plain schemas retain own enumerable `__proto__`/`constructor`/`prototype` data properties without prototype mutation. Select never mutates Main Session state. Copy paths are length-checked without trimming so whitespace remains exact. Main validates canonical source base64, decoded size, and source digest before any target write, then returns only exact validated target metadata (safe nonnegative size, 64-hex digest, boolean overwrite, bounded optional path), never base64. Worker direct/unified builtins include routing snapshots only for the authoritative current remote node; explicit other-node calls omit cwd. Local transport cloning owns request, response, and error parity.

Every reverse method fences the exact expected source before lookup/effect. The dynamic handler rejects missing/deleted source sessions, `nodeId=master`, disconnected targets, and names absent from the authenticated node's advertised tool set. For an isolated source, topology visibility derives only from Main's authoritative binding/source; request currentNode is never permission authority. Compound copy preserves the existing special permission contract: master↔bound/current is allowed with master paths restricted to the isolated agent directory, while other remote nodes are rejected; generic remote-target validation is applied only to non-master endpoints. The service cannot dispatch a builtin, Main-management operation, callback, Session patch, history, or queue payload.

Direct adjacent `exec` calls pass the batch's captured node/cwd snapshot. Worker direct non-exec and unified builtins also pass the exact-owner snapshot when they target its current remote node because Main's projection is not authoritative yet. Dynamic explicit node calls omit it, so a cwd is not leaked to an explicitly selected other target.

## Integration

- The canonical resolved-tool executor calls this service after a direct, unified, or ToolScript invocation resolves to a remote Node target. A master target still invokes the local named Node-capability handler directly and never enters this service.
- Static node-environment capabilities retain their ordinary tool permission check before this boundary. Dynamic custom names are authorized here by exact source existence, isolated bound/current target restrictions, connection state, and the selected node's advertised tool set; Main-local and borrowed reverse callers share that behavior.
- Direct Node capabilities, `call_tool(source=node)`, and ToolScript Node calls converge on `executeRemoteNodeTool()` for remote targets. An explicit `nodeId=master` call first passes the shared source/target isolation check, then bypasses RPC only when the tool belongs to `NODE_ENVIRONMENT_BUILTIN_NAMES`.
- Worker node list/search and selection validation use the operation-specific facade. The Worker mutates/persists its exact hot owner only after validation; Main local selection retains its existing path. Master Node discovery derives definitions from canonical node-environment metadata.
- `NodesManager.executeTool()` remains the authoritative WebSocket request/result/timeout and cwd-forwarding implementation after service validation.
- `src/index.ts` initializes this service locally and terminally drains it before other Main services.

## Lifecycle

Production initialization is bound to one exact local/borrowed transport; a conflicting concurrent placement cannot silently join. Shutdown fences initialization and all new calls before waiting for an in-flight initializer. Main-local placement drains/closes its owned transport. Borrowed Session-worker placement only clears its client; the worker drains/closes the shared reverse transport once after all borrowed facades are fenced. The service cannot lazy-reopen during later shutdown. Same-process reuse exists only through the test-only reset after no client, transport, or initializer remains.

## Tests

Focused coverage proves shared direct/dynamic routing, master-local bypass with an RPC spy, isolated allow/deny, stale/offline/unadvertised rejection, parallel-exec and dynamic cwd snapshot behavior, result cloning, remote image/error handling, ToolScript nesting, and terminal accepted-call drain/new-call fencing.
