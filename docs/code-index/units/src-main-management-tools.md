# Unit: src-main-management-tools

Files: src/mainManagementToolService.ts, src/mainManagementTools.ts, src/mainManagementTools.test.ts, src/mainManagementWaitTimeout.test.ts, src/sessionWorkerCrossSession.test.ts
Secondary files: src/tools.ts, src/tools/toolsChannelNaming.test.ts, src/timers.test.ts, src/toolscript.test.ts

## Purpose

Provides the versioned RPC boundary for a closed first set of tools whose mutable state is owned by Main. Main-local direct/unified/ToolScript calls retain the LocalRpcTransport; an activated Session worker injects a reverse process transport into the same client/descriptor for the fixed management operations and timeout-wait scheduling.

## Key exports

- `mainManagementToolServiceDescriptor` — version 6 descriptor with closed `execute` and separate internal `scheduleWaitTimeout` methods.
- `MAIN_MANAGEMENT_TOOL_OPERATIONS` — exact 20-operation allowlist: messaging, agent listing, timer CRUD, child creation, session catalog/display/message reads, archive/recall reads, agent/session creation/deletion, and node bootstrap/pairing.
- `createMainManagementToolServiceHandler()` — validates source identity and operation, optionally fences a reverse handler to one expected worker source before any lookup/mutation, then invokes the existing authoritative raw handler. When bound with an expected generation/incarnation and the worker store, it also rejects stale worker generations retryably before any operation runs.
- `initializeMainManagementTools()` / `shutdownMainManagementTools()` — placement-injectable local or child-reverse client lifecycle and one-way terminal graceful drain.
- `resetMainManagementToolsForTests()` — explicit test-only reset after a completed terminal shutdown.
- `executeMainManagementTool()` — placement-neutral local/reverse caller used by the closed Main-owned tool operations.
- `scheduleMainWaitTimeout()` — placement-neutral caller for the exact internal wait-timeout DTO; it does not expand the model-operation allowlist.
- Placement-neutral wrappers cover every allowlisted model operation; recall/agent/node raw handlers select them only for Worker placement.

## Boundary

Requests contain only `sourceSessionId`, an allowlisted operation, and cloneable tool args. Responses contain the existing structured handler result, including tool-loop control metadata. The local transport structured-clones request, response, and handler errors.

The separate internal wait-timeout method accepts exactly `{ sourceSessionId, waitId, timeoutSeconds }`, requires a live source plus non-empty IDs and positive finite seconds, and calls the canonical Main-owned timer scheduler. It returns only `{ scheduled: true, waitId }`; no callback, Session, arbitrary operation, or timer CRUD args cross this method.

The handler rejects missing/deleted source sessions before dispatch and caps serialized args at 64 KiB. Operations needing source settings or permissions receive one detached read-only authority loaded inside Main plus a process-local read marker; vector scope resolution trusts that detached source without hydrating or persisting the catalog stub. Other operations reconstruct only `{ sessionId }`. Isolation, relation, channel, target-session, and timer-scope checks remain in the existing raw handlers.

The `create_child_session` operation accepts only bounded cloneable args (suffix, fork, message, node, forceModel, noFurtherAssistantReply, waitAfterHandoff), while `create_session` has its own closed creation-key set. Main-management and the local raw handlers call the same strict non-mutating creation normalizers before effects: they reject removed or unknown top-level keys and malformed/unknown nested `forceModel: { modelId?, effort? }` content, clone the accepted nested object, and preserve configured-model/canonical-effort validation. `node` retains exact local/reverse parity. Every child creation from a worker-fenced source derives current inherited settings—and fork history when requested—from the authoritative JSON through a strictly read-only detached read supplied to the canonical creation path as a never-persisted source override; Main never hydrates or writes the fenced parent authority. `create_agent` and `create_session` reuse that detached source for inherited settings while leaving it unchanged; source conversion and explicit another-source agent creation remain fenced. `delete_session` accepts exactly one bounded target ID, preserves the model isolation check, and invokes the Main-owned deletion orchestrator with repeated exact source-generation assertions; canonical source/alias self-delete fails before target preparation. `session_list` renders the Main-owned catalog; `session_update_display_name` performs the Main-owned catalog/presentation rename; `get_session_messages` uses the exact-owner detached SessionRuntime read. Cross-session `recall` and hidden archive readers execute exact source-range reloads in Main, preserve existing isolation/agent checks and preview bounds, and use the selected vector facade. Node bootstrap/list/approval operate only on Main-owned topology/registry state.

This boundary has no arbitrary builtin dispatch, live mutable `Session` reference, callback, capability negotiation, retry/outbox protocol, or fallback from child reverse placement to a child-local handler. Main registers it alongside the exact Node/MCP/vector descriptors on one per-worker reverse server; SessionRuntime projection/publication remains a separate fixed service.

Production shutdown sets a terminal fence before awaiting initialization or drain. Concurrent initialization is bound to one stored placement/transport: an identical caller may join, while local-vs-reverse or different reverse transports fail rather than silently joining. In-flight initialization state is cleared on success, failure, terminal cleanup, and test reset. Main-local placement drains/closes its owned transport; borrowed worker placement only clears its client so the worker can drain/close its one shared reverse channel after all facades are fenced. Later initialize/execute calls cannot recreate the service before process exit. Same-process reuse is available only through the explicitly test-only reset after no client, transport, or initializer remains.

## Integration

- `src/tools.ts` maps the public named exports and `callTool` entries to these wrappers rather than the raw handlers; Worker `session(action=list|update-display-name)` and cross-session `get_session_messages` calls also route here from their raw handlers under Session-worker placement. Those named re-exports are lazy call-throughs because this module's dependency chain can require `tools.ts` mid-evaluation in some process load orders (worker boot), which would otherwise capture undefined bindings.
- `src/llm.ts` direct tool execution therefore enters this service through current named exports.
- `src/tools/unifiedSearch.ts` executes builtin calls through `tools.callTool`, reaching the same service.
- ToolScript nested calls continue through the existing unified `call_tool` wrapper and require no private registry.
- `src/index.ts` initializes the local service after SessionRuntime and drains it during graceful shutdown.
- `src/sessionWorker.ts` injects the reverse client before activation/run; `tool_wait` with a timeout is the first real child caller of the named `scheduleWaitTimeout` method.

## Tests

Focused coverage verifies the closed operation allowlist, missing/stale source failures, bounded structured-clone isolation, late handler replacement, direct/unified/ToolScript parity, real-child recall/archive/agent/session/node operations, real-child other-target deletion, read-only detached source inheritance, source-conversion fencing, wait-timeout scheduling, accepted-call drain, and lifecycle fences.
