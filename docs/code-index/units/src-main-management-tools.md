# Unit: src-main-management-tools

Files: src/mainManagementToolService.ts, src/mainManagementTools.ts, src/mainManagementTools.test.ts, src/mainManagementWaitTimeout.test.ts, src/sessionWorkerCrossSession.test.ts
Secondary files: src/tools.ts, src/tools/toolsChannelNaming.test.ts, src/timers.test.ts, src/toolscript.test.ts

## Purpose

Provides the versioned RPC boundary for a closed first set of tools whose mutable state is owned by Main. Main-local direct/unified/ToolScript calls retain the LocalRpcTransport; an activated Session worker injects a reverse process transport into the same client/descriptor for timeout-wait scheduling.

## Key exports

- `mainManagementToolServiceDescriptor` — version 1 descriptor with closed `execute` and separate internal `scheduleWaitTimeout` methods.
- `MAIN_MANAGEMENT_TOOL_OPERATIONS` — exact allowlist: `send_to_session`, `send_to_channel`, `list_agents`, timer CRUD, `create_child_session`, `session_list`, and `get_session_messages`.
- `createMainManagementToolServiceHandler()` — validates source identity and operation, optionally fences a reverse handler to one expected worker source before any lookup/mutation, then invokes the existing authoritative raw handler. When bound with an expected generation/incarnation and the worker store, it also rejects stale worker generations retryably before any operation runs.
- `initializeMainManagementTools()` / `shutdownMainManagementTools()` — placement-injectable local or child-reverse client lifecycle and one-way terminal graceful drain.
- `resetMainManagementToolsForTests()` — explicit test-only reset after a completed terminal shutdown.
- `executeMainManagementTool()` — placement-neutral local caller used by the seven public tool wrappers.
- `scheduleMainWaitTimeout()` — placement-neutral caller for the exact internal wait-timeout DTO; it does not expand the model-operation allowlist.
- `tool_send_to_session`, `tool_send_to_channel`, `tool_create_child_session`, `tool_list_agents`, and timer CRUD wrappers — current real builtin entry points.

## Boundary

Requests contain only `sourceSessionId`, an allowlisted operation, and cloneable tool args. Responses contain the existing structured handler result, including tool-loop control metadata. The local transport structured-clones request, response, and handler errors.

The separate internal wait-timeout method accepts exactly `{ sourceSessionId, waitId, timeoutSeconds }`, requires a live source plus non-empty IDs and positive finite seconds, and calls the canonical Main-owned timer scheduler. It returns only `{ scheduled: true, waitId }`; no callback, Session, arbitrary operation, or timer CRUD args cross this method.

The handler rejects missing/deleted source sessions before dispatch. It reconstructs only `{ sessionId }` as the trusted tool context; isolation, relation, channel, target-session, and timer-scope checks remain in the existing raw handlers. The switch reads module exports at call time so established test/runtime replacement seams are not frozen during service initialization.

The `create_child_session` operation accepts only bounded cloneable args (suffix, fork, message, noFurtherAssistantReply, waitAfterHandoff). A fork of a worker-fenced source derives from the authoritative JSON through a strictly read-only detached read (supplied to the canonical creation path as a never-persisted source override); Main never hydrates or writes the fenced parent authority. `session_list` renders the Main-owned catalog; `get_session_messages` serves a worker-fenced target from a read-only detached authority read and never rehydrates the Main catalog session.

This boundary has no arbitrary builtin dispatch, Session/history/queue payload, mutable patch, callback, capability negotiation, retry/outbox protocol, or fallback from child reverse placement to a child-local handler. Main registers it alongside the exact Node/MCP/vector descriptors on one per-worker reverse server; SessionRuntime publication/routing remains unwired.

Production shutdown sets a terminal fence before awaiting initialization or drain. Concurrent initialization is bound to one stored placement/transport: an identical caller may join, while local-vs-reverse or different reverse transports fail rather than silently joining. In-flight initialization state is cleared on success, failure, terminal cleanup, and test reset. Main-local placement drains/closes its owned transport; borrowed worker placement only clears its client so the worker can drain/close its one shared reverse channel after all facades are fenced. Later initialize/execute calls cannot recreate the service before process exit. Same-process reuse is available only through the explicitly test-only reset after no client, transport, or initializer remains.

## Integration

- `src/tools.ts` maps the public named exports and `callTool` entries to these wrappers rather than the raw handlers; worker `session(action=list)` and cross-session `get_session_messages` calls also route here from their raw handlers under Session-worker placement.
- `src/llm.ts` direct tool execution therefore enters this service through current named exports.
- `src/tools/unifiedSearch.ts` executes builtin calls through `tools.callTool`, reaching the same service.
- ToolScript nested calls continue through the existing unified `call_tool` wrapper and require no private registry.
- `src/index.ts` initializes the local service after SessionRuntime and drains it during graceful shutdown.
- `src/sessionWorker.ts` injects the reverse client before activation/run; `tool_wait` with a timeout is the first real child caller of the named `scheduleWaitTimeout` method.

## Tests

Focused coverage verifies the closed seven-operation allowlist, missing/stale source failures, structured-clone isolation, late handler replacement, structured error parity, direct/unified send delivery and handoff control metadata, isolated-session rejection, channel delivery, timer CRUD scoping, ToolScript nesting, exact internal wait-timeout DTO and scheduling, accepted-call drain, initialization fencing, terminal rejection, and explicit test-only reset.
