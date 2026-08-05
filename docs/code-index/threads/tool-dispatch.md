# Thread: tool dispatch

## Overview

The unified execution flow resolves model tool calls to builtin handlers, MCP servers, or authenticated remote nodes. Current isolation checks are applied at the concrete execution boundary.

## Steps

1. The LLM returns one or more tool calls in a `ChatResult`.
2. The message-processing loop schedules the batch in model order. Adjacent direct `exec` calls form a bounded parallel segment; every other direct or unified tool is a serial barrier.
3. Direct builtins resolve exhaustive ownership metadata independently from permission policy. Only node-environment builtins select the session's current node; all other ownership classes remain in the main process in the current local-only runtime.
4. Isolation checks evaluate the resolved concrete execution target before the selected handler runs.
5. The closed v1 main-management set (`send_to_session`, `send_to_channel`, `list_agents`, and timer CRUD) enters one versioned local RPC service. Its handler reconstructs only source session identity before invoking the existing authoritative raw handler.
6. `search_tools` discovers non-default builtins, MCP tools, and tools advertised by the selected node.
7. `call_tool` parses a `toolId` or explicit source descriptor and resolves one concrete builtin, MCP, or node target.
8. Direct compatibility tools, unified discovery/calls, and ToolScript nested MCP calls enter the fixed local `mcp-external@1` service. Its authoritative handler alone calls `mcpClient`; safe text cleanup and MCP image-content promotion still occur at the client boundary while non-image content remains structured.
9. Direct or unified node-environment builtins resolved to a remote node and dynamic remote Node-domain calls enter the fixed v1 Node execution service, then use `nodesManager` over the authenticated node connection. Dynamic `node:master/<tool>` calls bypass RPC only for the canonical node-environment set and use the local named handler. The service itself rejects `master`, stale sources, disconnected nodes, isolation-binding violations, and names not currently advertised by a remote node. A node-side approval interceptor may still reject the call. Old node image-result shapes are adapted only at this remote ingress under [D-node-thread-tool-result-compatibility](./node-communication.md#d-node-thread-tool-result-compatibility).
10. Master and node file wrappers use the shared file-tool core after their own path, context, and isolation handling.
11. Recognized image payloads are promoted to image parts and receive stable IDs before the remaining text/structured response passes through the oversized-output guard. Successful master/node patch results already carry shared per-file change-count summaries from [D-apply-patch-change-counts](../units/shared-apply-patch.md#d-apply-patch-change-counts).
12. ToolScript nested calls use the same registered tool surfaces and appear as subcalls of the outer run.

## Modules involved

- [tools and permissions](../modules/tools-and-permissions.md)
- [llm](../modules/llm.md)
- [nodes](../modules/nodes.md)
- [cli-node](../modules/cli-node.md)
- [shared utilities](../modules/shared-utilities.md)
- [scripting](../modules/scripting.md)
- [session core](../modules/session-core.md)

## Key units

- [src-tools](../units/src-tools.md)
- [src-isolated-check](../units/src-isolated-check.md)
- [src-permissions](../units/src-permissions.md)
- [src-mcp-client](../units/src-mcp-client.md)
- [src-mcp-external-service](../units/src-mcp-external-service.md)
- [src-nodes-manager](../units/src-nodes-manager.md)
- [src-node-execution](../units/src-node-execution.md)
- [shared-node-tools](../units/shared-node-tools.md)
- [src-toolscript](../units/src-toolscript.md)

## Invariants

- Isolation is enforced against the resolved execution node and tool arguments.
- An isolated session cannot use master file paths outside its own agent directory.
- Unified wrappers do not bypass the concrete target's existing guards.
- Tool output is bounded before it enters model context.
- MCP configuration reads use one authoritative live snapshot after first load; managed updates persist before replacing that snapshot.
- MCP list/discovery/call/config operations share one versioned local service with source/isolation checks, exact plain-record/JSON DTO validation, cloned results/errors, full call-argument permission parity, redacted summaries, all-server stored-secret error fencing, and terminal drain fencing. Managed transport semantics are validated once by the authoritative client before persistence/publication. No Session-worker reverse transport is connected yet.
- Recognized image bytes stay in structured image parts rather than entering text excerpts; non-image text, JSON, audio, resource, and blob content remain subject to the normal output budget.
- MCP and node credentials remain transport/runtime state and are not exposed to the model through tool summaries.
- Tool batches emit one result for every call and append one tool message only after the batch settles. Image/result parts and function responses remain in original model-call order rather than completion order.
- Direct builtins and unified builtin calls share `resolveBuiltinToolPlacement`; ToolScript nested calls inherit it through the existing `call_tool` wrapper.
- The first main-management service is local-only. It has a fixed seven-operation allowlist and carries no live Session, history, queue, patch, or callback; no child reverse wiring exists yet.
- The first Node execution service is local-only and accepts dynamic names only inside one authenticated remote node's currently advertised tool set. The colocated `master` execution environment bypasses it and runs the local named handler directly, while master Node discovery exposes exactly the canonical node-environment definitions.

## Compatibility

- Free-form object arguments may use documented JSON-string fallbacks.
- Generic dispatch recognizes only current structured image result fields. The separately deletable old-node result reader is canonical in [D-node-thread-tool-result-compatibility](./node-communication.md#d-node-thread-tool-result-compatibility).
- Removed internal wrappers are not retained merely as model-facing aliases; persisted or external readers are documented only when they still exist in source.

## Design decisions

### D-dispatch-resolved-target

Unified discovery and invocation resolve a concrete target before execution. Permissions and tool-local validation apply to that resolved operation rather than to discovery metadata alone.

### D-dispatch-shared-file-semantics

Master and node file tools share read/write semantics while retaining separate transport, path-resolution, and isolation wrappers.

### D-dispatch-output-boundary

Tool results remain structured through execution and are normalized/guarded exactly once before becoming model input. Recognized image payloads are promoted to structured image parts before the generic text/structured-output guard runs; the guard applies to the remaining response and must never turn image base64 into a text excerpt or truncation marker. Non-image content receives no multimodal exemption.

### D-dispatch-exec-parallel-segments

Phase-one batch concurrency is intentionally narrow: only adjacent direct calls whose tool name is exactly `exec` run concurrently, with an internal maximum concurrency of four. Every non-`exec` call—including unified `call_tool`, MCP, node-dynamic, ToolScript, file, session, and wait/control tools—flushes the previous exec segment and runs serially. Each exec segment snapshots session node/cwd routing once, settles all calls, then replays cwd changes in model-call order before the next barrier; the last model call therefore owns the resulting session cwd. Results, images, errors, and progress stay model-ordered and one failure does not discard siblings. A stop request waits for the active segment, skips later barriers, and does not claim to terminate already-started operating-system processes. This is an internal scheduler contract, not a public configuration or generalized resource-lock API.

### D-dispatch-mcp-live-configuration

[2026-08-01] The first managed/runtime MCP configuration read establishes one authoritative in-memory snapshot. Subsequent MCP listing, discovery, and calls read that snapshot rather than rereading the backing file. `mcp_config` mutations must persist successfully before replacing the live snapshot, become visible to subsequent MCP operations immediately, and require no Foxwarm restart. Manual backing-file edits do not alter the live snapshot; do not add file watching or an agent-facing manual reload path.

### D-dispatch-node-environment-placement

[2026-08-05] Keep process-placement ownership separate from permission policy and model schemas. The registered node-environment builtins are exactly `read`, `write`, `edit`, `apply_patch`, `exec`, and `browse_*`: they execute directly in the selected local environment when `currentNode=master` and use the authenticated node connection when a remote current node is selected. Unified builtin calls use the same placement boundary. Explicit dynamic `source=node,nodeId=master` calls and master Node discovery are allowed only for this exact canonical set; they invoke the existing local named handler without RPC and cannot turn Main/session/MCP tools into Node calls. `delete_file` is removed from definitions, runtime exports, permissions, and advertised master capabilities without an alias; structured `apply_patch` deletion and explicit `exec` remain available. Compound file/channel/image operations and agent-memory tools are not node-environment primitives merely because they may touch files.

## Canonical ownership

MCP result cleanup is canonical in [D-mcp-source-normalization](../units/src-mcp-client.md#d-mcp-source-normalization).
