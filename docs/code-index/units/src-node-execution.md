# Unit: src-node-execution

Files: src/nodeExecutionService.ts, src/nodeExecution.ts, src/nodeExecution.test.ts
Secondary files: src/llm.ts, src/tools/nodeTools.ts, src/tools/unifiedTools.test.ts, src/toolscript.test.ts, src/index.ts

## Purpose

Provides the versioned RPC boundary for model-tool execution over a connected remote node. Main-local callers use a local transport; a Session worker borrows its one reverse transport to reach the same Main-owned handler. Main remains the sole owner of authenticated node WebSocket connections, while the colocated `master` execution environment bypasses this service and runs the existing local named handler directly.

## Key exports

- `nodeExecutionServiceDescriptor` — version 1 descriptor with one fixed `execute` method.
- `createNodeExecutionServiceHandler()` — validates source identity, optional exact worker-source fence, remote target, isolation binding, connection state, advertised tool, args, and optional routing snapshot before dispatch.
- `executeRemoteNodeTool()` — placement-neutral current caller used by direct remote node-environment builtins and dynamic node calls.
- `initializeNodeExecution()` / `shutdownNodeExecution()` — owned-local or borrowed-reverse client lifecycle with one-way terminal fencing.
- `resetNodeExecutionForTests()` — explicit test-only reset after terminal shutdown.

## Boundary

Requests contain only `sourceSessionId`, a non-master `nodeId`, the dynamic node-domain `toolName`, cloneable args, and an optional bounded `{ currentNode, cwd }` routing snapshot. Responses contain the existing structured remote tool result. Local transport cloning owns request, response, and error parity.

The handler rejects missing/deleted source sessions, `nodeId=master`, disconnected targets, and names absent from the authenticated node's current advertised tool set. For an isolated source, the target must remain its bound/current node under the existing agent-isolation semantics. Dynamic names are accepted only inside this authenticated Node domain; the service cannot dispatch a builtin, Main-management operation, file-transfer compound, callback, Session patch, history, or queue payload.

Direct adjacent `exec` calls pass the batch's captured node/cwd snapshot. Dynamic explicit node calls omit it, so `NodesManager` sends a cwd only when its authoritative live routing node matches the target; a master-local cwd is not leaked to an explicit remote target.

## Integration

- `src/llm.ts` and unified builtin dispatch call this service only after placement resolves a node-environment builtin to a remote execution node. `executionNode=master` still invokes the local named builtin directly and never enters this service.
- Remote `remote_node({ action: "call" })`, `call_tool(source=node)`, and ToolScript node/builtin wrappers converge on `executeRemoteNodeTool()`. An explicit `nodeId=master` call first passes the shared source/target isolation check, then bypasses RPC only when the tool belongs to `NODE_ENVIRONMENT_BUILTIN_NAMES`.
- Node list/select/management queries remain on their existing Main path. Master Node discovery derives its definitions from the same canonical node-environment metadata.
- `NodesManager.executeTool()` remains the authoritative WebSocket request/result/timeout and cwd-forwarding implementation after service validation.
- `src/index.ts` initializes this service locally and terminally drains it before other Main services.

## Lifecycle

Production initialization is bound to one exact local/borrowed transport; a conflicting concurrent placement cannot silently join. Shutdown fences initialization and all new calls before waiting for an in-flight initializer. Main-local placement drains/closes its owned transport. Borrowed Session-worker placement only clears its client; the worker drains/closes the shared reverse transport once after all borrowed facades are fenced. The service cannot lazy-reopen during later shutdown. Same-process reuse exists only through the test-only reset after no client, transport, or initializer remains.

## Tests

Focused coverage proves shared direct/dynamic routing, master-local bypass with an RPC spy, isolated allow/deny, stale/offline/unadvertised rejection, parallel-exec and dynamic cwd snapshot behavior, result cloning, remote image/error handling, ToolScript nesting, and terminal accepted-call drain/new-call fencing.
