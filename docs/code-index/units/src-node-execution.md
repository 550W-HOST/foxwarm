# Unit: src-node-execution

Files: src/nodeExecutionService.ts, src/nodeExecution.ts, src/nodeExecution.test.ts
Secondary files: src/llm.ts, src/tools/nodeTools.ts, src/tools/unifiedTools.test.ts, src/toolscript.test.ts, src/nodeExecutionExternalPlacement.test.ts, src/index.ts

## Purpose

Provides the versioned RPC boundary for complete Node capability execution and bounded topology/file-transfer operations. Main-local callers use a local transport; a Session worker borrows its one reverse transport to reach the same Main-owned handler. Main resolves every non-master Node through the generic provider registry, while the colocated `master` Node preserves direct local named-handler execution.

## Key exports

- `nodeExecutionServiceDescriptor` — version 1 descriptor with fixed complete-capability execute, topology list, selection validation, and compound copy methods.
- `createNodeExecutionServiceHandler()` — validates source identity, optional exact worker-source fence, non-master target, isolation binding, args, and optional routing snapshot before authoritative provider resolution.
- `executeNodeTool()` / `listNodeTopology()` / `validateNodeSelection()` / `copyBetweenNodes()` — placement-neutral callers for Node execution and operation-specific topology/copy behavior.
- `initializeNodeExecution()` / `shutdownNodeExecution()` — owned-local or borrowed-reverse client lifecycle with one-way terminal fencing.
- `resetNodeExecutionForTests()` — explicit test-only reset after terminal shutdown.

## Boundary

Dynamic requests contain only `sourceSessionId`, a non-master `nodeId`, the Node capability name, cloneable args, and an optional bounded `{ currentNode, cwd }` routing snapshot. Main converts that into a complete provider request with exact source agent context. Main-local calls derive cwd only when the authoritative catalog current Node equals the target; reverse Worker calls use only the exact-owner snapshot and never substitute Main's projection. Operation-specific requests carry only source/optional node filters, a display/routing current node, a selection target, or copy source/target Node IDs, paths, and overwrite intent. Topology returns at most 100 Nodes/200 tools per Node/256 KiB total and now includes bounded `kind`, `provider`, and `availability`; IDs/names/types/descriptions/default cwd/paths retain explicit character caps, each plain finite JSON schema is at most 16 KiB, and accessor/oversize schemas are omitted without evaluation. Plain schemas retain own enumerable `__proto__`/`constructor`/`prototype` data properties without prototype mutation. Select never mutates Main Session state. Copy paths are length-checked without trimming so whitespace remains exact. Main validates canonical source base64, decoded size, and source digest before any target write, then returns only exact validated target metadata (safe nonnegative size, 64-hex digest, boolean overwrite, bounded optional path), never base64. Worker direct/unified builtins include routing snapshots only for the authoritative current non-master Node; explicit other-Node calls omit cwd. Local transport cloning owns request, response, and error parity.

Every reverse method fences the exact expected source before lookup/effect. The dynamic handler rejects missing/deleted source sessions and `nodeId=master`, then the registry rejects unknown/unavailable Nodes and names absent from the selected provider's advertised capability set. Provider calls receive the RPC request's cancellation signal as process-local call metadata; executable providers use it to terminate their one-shot child and never serialize the signal. For an isolated source, topology visibility derives only from Main's authoritative source plus the canonical master and bound/current targets; request currentNode is never permission authority, and exact/default evaluation filters advertised descriptors before they cross the service boundary. Compound copy preserves the existing authenticated-transport special permission contract: master↔bound/current is allowed with master paths restricted to the isolated agent directory, while other remote nodes are rejected. Copy has not yet been generalized to arbitrary providers. The service cannot dispatch a builtin, Main-management operation, callback, Session patch, history, or queue payload.

Direct adjacent `exec` calls pass the batch's captured Node/cwd snapshot. Worker direct non-exec and unified builtins also pass the exact-owner snapshot when they target its current non-master Node because Main's projection is not authoritative yet. Dynamic explicit other-Node calls omit it, so cwd is not leaked across Node targets.

## Integration

- The canonical resolved-tool executor calls this service after a direct, unified, or ToolScript invocation resolves to any non-master Node ID. It does not classify the implementation. A master target still invokes the local named Node-capability handler directly and never enters this service.
- Static node-environment capabilities retain their source-aware tool permission check before this boundary. Dynamic custom names also receive exact deny/allow evaluation, while missing-rule behavior deliberately reaches this service so exact source existence, isolated bound/current target restrictions, connection state, and the selected node's advertised tool set remain authoritative; Main-local and borrowed reverse callers share that behavior.
- Direct Node capabilities, `call_tool(source=node)`, and ToolScript Node calls converge on `executeNodeTool()` for non-master targets. An explicit `nodeId=master` call first passes the shared source/target isolation check, then bypasses RPC only when the tool belongs to `NODE_ENVIRONMENT_BUILTIN_NAMES`.
- Worker node list/search and selection validation use the operation-specific facade. The Worker mutates/persists its exact hot owner only after validation; Main local selection retains its existing path. Master Node discovery derives definitions from canonical node-environment metadata.
- `NodeProviderRegistry` is the authoritative non-master provider resolver after service validation. The authenticated remote provider delegates to `NodesManager.executeTool()`, which retains WebSocket request/result/timeout and cwd-forwarding behavior. Configured executable providers receive the same complete request through `foxwarm-node-provider@1`; their process protocol and limits are owned by [src-node-providers](./src-node-providers.md).
- `src/index.ts` initializes this service locally and terminally drains it before other Main services.

## Lifecycle

Production initialization is bound to one exact local/borrowed transport; a conflicting concurrent placement cannot silently join. Shutdown fences initialization and all new calls before waiting for an in-flight initializer. Main-local placement drains/closes its owned transport. Borrowed Session-worker placement only clears its client; the worker drains/closes the shared reverse transport once after all borrowed facades are fenced. The service cannot lazy-reopen during later shutdown. Same-process reuse exists only through the test-only reset after no client, transport, or initializer remains.

## Tests

Focused coverage proves shared direct/dynamic routing, master-local bypass with an RPC spy, isolated allow/deny, stale/offline/unadvertised rejection, parallel-exec and dynamic cwd snapshot behavior, result cloning, authenticated remote image/error handling, ToolScript nesting, terminal accepted-call drain/new-call fencing, and a deterministic test-only sandbox-kind provider that lists/selects/invokes without a WebSocket.
