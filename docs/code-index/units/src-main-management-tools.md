# Unit: src-main-management-tools

Files: src/mainManagementToolService.ts, src/mainManagementTools.ts, src/mainManagementTools.test.ts
Secondary files: src/tools.ts, src/tools/toolsChannelNaming.test.ts, src/timers.test.ts, src/toolscript.test.ts

## Purpose

Provides the versioned local RPC boundary for a closed first set of tools whose mutable state is owned by the main process. Current direct builtin calls, unified builtin calls, and ToolScript nested calls all reach the same local service; no child-to-parent transport is wired yet.

## Key exports

- `mainManagementToolServiceDescriptor` — version 1 descriptor with one closed `execute` method.
- `MAIN_MANAGEMENT_TOOL_OPERATIONS` — exact allowlist: `send_to_session`, `send_to_channel`, `list_agents`, and timer CRUD.
- `createMainManagementToolServiceHandler()` — validates source identity and operation, then invokes the existing authoritative raw handler.
- `initializeMainManagementTools()` / `shutdownMainManagementTools()` — local transport lifecycle and graceful drain.
- `executeMainManagementTool()` — placement-neutral local caller used by the seven public tool wrappers.
- `tool_send_to_session`, `tool_send_to_channel`, `tool_list_agents`, and timer CRUD wrappers — current real builtin entry points.

## Boundary

Requests contain only `sourceSessionId`, an allowlisted operation, and cloneable tool args. Responses contain the existing structured handler result, including tool-loop control metadata. The local transport structured-clones request, response, and handler errors.

The handler rejects missing/deleted source sessions before dispatch. It reconstructs only `{ sessionId }` as the trusted tool context; isolation, relation, channel, target-session, and timer-scope checks remain in the existing raw handlers. The switch reads module exports at call time so established test/runtime replacement seams are not frozen during service initialization.

This boundary has no arbitrary builtin dispatch, Session/history/queue payload, mutable patch, callback, generic registry, capability negotiation, retry/outbox protocol, process reverse transport, or Session-worker caller.

## Integration

- `src/tools.ts` maps the seven public named exports and `callTool` entries to these wrappers rather than the raw handlers.
- `src/llm.ts` direct tool execution therefore enters this service through current named exports.
- `src/tools/unifiedSearch.ts` executes builtin calls through `tools.callTool`, reaching the same service.
- ToolScript nested calls continue through the existing unified `call_tool` wrapper and require no private registry.
- `src/index.ts` initializes the local service after SessionRuntime and drains it during graceful shutdown.

## Tests

Focused coverage verifies the closed allowlist, missing/stale source failures, structured-clone isolation, late handler replacement, structured error parity, direct/unified send delivery and handoff control metadata, isolated-session rejection, channel delivery, timer CRUD scoping, ToolScript nesting, and clean shutdown/reinitialization.
