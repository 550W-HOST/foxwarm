# Thread: tool dispatch

## Overview

The unified execution flow resolves model tool calls to builtin handlers, MCP servers, or generic Nodes. Generic ordered authorization and the current isolation compatibility layer are applied at the concrete execution boundary.

## Steps

The default-injected `task` builtin is Main Management-owned for all placements; its closed action contract, atomic claim and context-derived identity are canonical in [src-tasks](../units/src-tasks.md). It never changes Session state.

Dedicated compaction uses its own bounded gate rather than the ordinary tool loop. Pending arguments-file repair retains the existing concrete master-file authorization and isolation checks; see [D-context-compact-runtime-gate](./context-compaction.md#d-context-compact-runtime-gate).

1. The LLM returns one or more tool calls in a `ChatResult`.
2. Before target resolution, per-call `onToolStart` publication, or tool effect, ordinary model-turn batches consume the reserved top-level cancellation controls. Batch-level returned-call progress/runtime state may already have been published by the turn runner. One `__cancelAllToolsThisTurn:true` returns a canceled response for every call without resolving any of them; `__cancelTool:true` skips only that call. Invalid reserved values fail only their own call. The controls are removed from execution arguments while the canonical assistant call remains unchanged. The dedicated compact-plan tool is excluded from this ordinary model-facing cancellation schema surface.
3. The turn host calls `toolExecutor.executeTools` directly; its typed result separates the canonical tool Message from transient control/post-actions. The executor schedules the remaining batch in model order. Adjacent direct `exec` calls form a bounded parallel segment; every other direct or unified tool is a serial barrier.
   A successful builtin `node` selection takes effect before later exec/file calls in the same model response. Failed selection skips the remaining unstarted calls without resolving them; see [Node selection batch prerequisite](./tool-dispatch-authorization.md#d-dispatch-node-selection-batch-prerequisite).
   The segment carries one process-local ExecRuntime plus the exact current Session persistence hook. Each call keeps all exec lifecycle methods on that runtime; deferred cwd changes replay against the same passed owner in model order.
4. Direct provider calls, unified `call_tool`, and ToolScript nested calls resolve one canonical `ResolvedTool` before permission or execution. Capability source (`builtin`, `node`, or `mcp`), exact execution Node ID, and process/service owner remain separate. `ResolvedTool` does not classify Node implementations. A root builtin `node` schema field selects the current tool's placement only when explicit placement metadata says so: `send_file` and `image_write_to_file` consume it as their file source/target, while `create_child_session.node` remains a semantic authorization/effect argument and the management operation itself stays on Main. `call_tool` itself is a permission-neutral dispatcher/container rather than a concrete builtin capability: authorization belongs only to the resolved target, and MCP retains its authoritative Main service recheck for the concrete server/tool. Node-environment direct tools select the session's current Node. Main-local production uses local facades, while Session-worker production borrows reverse Main Management, Node, MCP, vector, file, delivery, and presentation facades through the exact Worker source boundary.
5. A trusted Worker placement guard runs after concrete target resolution but before logging, broadcast/progress, concrete permission checks, or handler initialization. Supported calls then evaluate the instance-level ordered policy against that resolved target. A generic deny stops the call for isolated or non-isolated Sessions; a generic allow proceeds to the unchanged exact isolated-Agent and structural/tool-local checks.
6. The closed Main Management v10 boundary admits exactly 21 model-facing operations plus a narrow internal Session-target authorization read: messaging, agent listing, timer CRUD, child/session catalog operations, bounded cross-session recall/archive reads, Main-owned agent/session creation, other-target session deletion, node bootstrap/pairing, and master-only atomic policy replacement. Main-local callers use cloned local RPC; Session Workers use the exact-source/generation-fenced reverse service. The service repeats generic builtin authorization. The internal relation read returns only canonical target ID/Agent/direct-parent facts and performs no effect or foreign history hydration. Operations needing source settings receive only a detached read-only authority inside Main; deletion composes the operation-specific lifecycle orchestrator and rejects self/alias targets before effect. No live mutable Session, generic builtin dispatch, callback, or fallback crosses the boundary.
7. `search_tools` discovers non-default builtins, MCP tools, and tools advertised by the selected node.
8. `call_tool` parses a `toolId` or explicit source descriptor through the same resolver used by direct calls. `source=node` defaults to the current execution Node when `nodeId` is omitted. A node-environment name passed as `source=builtin` is rejected as a source mismatch rather than treated as an alias. Local builtins retain the exact ToolContext; Worker explicit master Node calls are restricted to the canonical node-environment set. Static Node capabilities keep their existing tool permission checks, while custom advertised capabilities use the exact source/Node binding and advertised-tool checks at the shared Node execution service in Main-local and reverse Worker placement.
9. Internal MCP configuration/server-list builtins, unified discovery/calls, and ToolScript nested MCP calls enter the fixed `mcp-external@3` facade. Main-local callers use local RPC; a Session worker uses its borrowed reverse client. The exact-source-fenced authoritative Main handler calls `mcpClient`; safe text cleanup and MCP image-content promotion still occur at the client boundary while non-image content remains structured. A separately verified inbound external context runs only on Main and uses an external-specific MCP adapter/permission check without fabricating an internal `sourceSessionId` or using the Worker reverse RPC.
10. Direct or unified node-environment builtins resolved to a non-master Node enter the fixed Node execution facade. Main-local callers use local RPC; a Session worker uses its borrowed reverse client with an exact source fence. Main resolves the exact provider. Authenticated remote Nodes retain their resident complete-tool forwarding adapter. Primitive providers instead expose fixed filesystem support (`read` or `read-write`) and optional complete exec: Core derives canonical model schemas and composes `read`, `write`, `edit`, and `apply_patch` over provider parent/stat/ranged-read/readdir/whole-write/mkdir/remove calls, preserving exact target-namespace paths and routing context. Executable providers use one bounded `foxwarm-node-provider@1` process per list/filesystem/exec/lifecycle request. The separate `node` builtin remains the provider-neutral lifecycle control plane. Unsupported backends, operations, identities, or lifecycle actions never fall back to master. Old authenticated-node image-result shapes are adapted only at that provider's remote response ingress under [D-node-thread-tool-result-compatibility](./node-communication.md#d-node-thread-tool-result-compatibility).
11. Main and Node read/write/patch wrappers use the shared file-tool core after their own path, context, and isolation handling. Patch parsing/matching is shared as well; exact edit replacement remains separate but uses the same target-local file contract. Local Main and CLI Node use the native backend; primitive Providers supply their own backend/parent namespace, and authenticated remote calls still execute on the Node.
12. Recognized image payloads are promoted to image parts and receive stable IDs before the remaining text/structured response passes through the oversized-output guard. Successful master/node patch results already carry shared per-file change-count summaries from [D-apply-patch-change-counts](../units/shared-apply-patch.md#d-apply-patch-change-counts).
13. ToolScript nested calls use the same registered tool surfaces. Execution responses are lean; nested activity travels as model-invisible presentation metadata. See [D-dispatch-toolscript-execution-projection](./tool-dispatch-node-execution.md#d-dispatch-toolscript-execution-projection).

## Modules involved

- [tools and permissions](../modules/tools-and-permissions.md)
- [llm](../modules/llm.md)
- [nodes](../modules/nodes.md)
- [cli-node](../modules/cli-node.md)
- [shared utilities](../modules/shared-utilities.md)
- [scripting](../modules/scripting.md)
- [session core](../modules/session-core.md)

## Key units

- [src-tool-executor](../units/src-tool-executor.md)

- [src-tools](../units/src-tools.md)
- [src-isolated-check](../units/src-isolated-check.md)
- [src-permissions](../units/src-permissions.md)
- [src-tool-authorization](../units/src-tool-authorization.md)
- [src-mcp-client](../units/src-mcp-client.md)
- [src-mcp-external-service](../units/src-mcp-external-service.md)
- [src-mcp-inbound-catalog](../units/src-mcp-inbound-catalog.md)
- [src-nodes-manager](../units/src-nodes-manager.md)
- [src-node-execution](../units/src-node-execution.md)
- [shared-node-tools](../units/shared-node-tools.md)
- [src-toolscript](../units/src-toolscript.md)

## Subject threads

- [Authorization and batches](./tool-dispatch-authorization.md) — generic authorization, resolved targets, exact Agent rules, batch scheduling, model-requested cancellation, and output bounds.
- [MCP](./tool-dispatch-mcp.md) — MCP configuration snapshots, the versioned facade, the inbound bridge, and explicit notifications.
- [Node execution](./tool-dispatch-node-execution.md) — Node providers, environment placement, file-tool semantics, and ToolScript/programmatic data.

## Invariants

Subject-specific invariants are listed in the subject threads above.

## Compatibility

- Free-form object arguments may use documented JSON-string fallbacks.
- Generic dispatch recognizes only current structured image result fields. The separately deletable old-node result reader is canonical in [D-node-thread-tool-result-compatibility](./node-communication.md#d-node-thread-tool-result-compatibility).
- Removed internal wrappers are not retained merely as model-facing aliases; persisted or external readers are documented only when they still exist in source.

## Design decisions

Decision records are owned by the subject threads above. Link to the owning subject thread rather than to this entry.
