# Thread: tool dispatch

## Overview

The unified execution flow resolves model tool calls to builtin handlers, MCP servers, or authenticated remote nodes. Current isolation checks are applied at the concrete execution boundary.

## Steps

1. The LLM returns one or more tool calls in a `ChatResult`.
2. The message-processing loop schedules the batch in model order. Adjacent direct `exec` calls form a bounded parallel segment; every other direct or unified tool is a serial barrier.
   The segment carries one process-local ExecRuntime plus the exact current Session persistence hook. Each call keeps all exec lifecycle methods on that runtime; deferred cwd changes replay against the same passed owner in model order.
3. Direct provider calls, unified `call_tool`, and ToolScript nested calls resolve one canonical `ResolvedTool` before permission or execution. Capability source (`builtin`, `node`, or `mcp`), execution target, and process/service owner remain separate. Node-environment direct tools select the session's current node. Main-local production uses local facades, while Session-worker production borrows reverse Main Management, remote Node, MCP, vector, file, delivery, and presentation facades through the exact Worker source boundary.
4. A trusted Worker placement guard runs after concrete target resolution but before logging, broadcast/progress, concrete permission checks, or handler initialization. Supported calls then apply isolation checks against that resolved target before the selected handler runs.
5. The closed Main Management v4 boundary admits exactly 20 operations: messaging, agent listing, timer CRUD, child/session catalog operations, bounded cross-session recall/archive reads, Main-owned agent/session creation, other-target session deletion, and node bootstrap/pairing. Main-local callers use cloned local RPC; Session Workers use the exact-source/generation-fenced reverse service. Operations needing source settings receive only a detached read-only authority inside Main; deletion composes the operation-specific lifecycle orchestrator and rejects self/alias targets before effect. No live mutable Session, generic builtin dispatch, callback, or fallback crosses the boundary.
6. `search_tools` discovers non-default builtins, MCP tools, and tools advertised by the selected node.
7. `call_tool` parses a `toolId` or explicit source descriptor through the same resolver used by direct calls. `source=node` defaults to the current execution target when `nodeId` is omitted. A node-environment name passed as `source=builtin` is rejected as a source mismatch rather than treated as an alias. Local builtins retain the exact ToolContext; Worker explicit master Node calls are restricted to the canonical node-environment set. Static node-environment capabilities keep their existing tool permission checks, while custom advertised remote-node capabilities use the exact source/target binding and advertised-tool checks at the shared Node execution service in Main-local and reverse Worker placement.
8. MCP configuration/server-list builtins, unified discovery/calls, and ToolScript nested MCP calls enter the fixed `mcp-external@1` facade. Main-local callers use local RPC; a Session worker uses its borrowed reverse client. The exact-source-fenced authoritative Main handler alone calls `mcpClient`; safe text cleanup and MCP image-content promotion still occur at the client boundary while non-image content remains structured.
9. Direct or unified node-environment builtins resolved to a remote node and dynamic remote Node-domain calls enter the fixed v1 Node execution facade, then use Main's `nodesManager` over the authenticated node connection. Main-local callers use local RPC; a Session worker uses its borrowed reverse client with an exact source fence. Dynamic `node:master/<tool>` calls bypass RPC only for the canonical node-environment set and use the local named handler. The service itself rejects `master`, stale sources, disconnected nodes, isolation-binding violations, and names not currently advertised by a remote node. A node-side approval interceptor may still reject the call. Old node image-result shapes are adapted only at this remote ingress under [D-node-thread-tool-result-compatibility](./node-communication.md#d-node-thread-tool-result-compatibility).
10. Master and node file wrappers use the shared file-tool core after their own path, context, and isolation handling. That core composes a low-level target-local file backend; local Main and CLI Node use the native backend, while authenticated remote Node execution still performs all primitives on the remote side.
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

- Isolation is enforced against the canonical resolved capability source plus exact Node/server identity; structural path, target, relation, and tool-local guards remain separate and non-bypassable.
- An isolated session cannot use master file paths outside its own agent directory.
- Unified wrappers do not bypass the concrete target's existing guards.
- Tool output is bounded before it enters model context.
- MCP configuration reads use one authoritative live snapshot after first load; managed updates persist before replacing that snapshot.
- MCP list/discovery/call/config operations share one versioned local/reverse facade with source/isolation checks, exact plain-record/JSON DTO validation, cloned results/errors, full call-argument permission parity, redacted summaries, all-server stored-secret error fencing, and terminal drain fencing. Managed transport semantics are validated once by the authoritative Main client before persistence/publication.
- Recognized image bytes stay in structured image parts rather than entering text excerpts; non-image text, JSON, audio, resource, and blob content remain subject to the normal output budget.
- MCP and node credentials remain transport/runtime state and are not exposed to the model through tool summaries.
- Tool batches emit one result for every call and append one tool message only after the batch settles. Image/result parts and function responses remain in original model-call order rather than completion order.
- Direct, unified, and ToolScript calls share one `ResolvedTool` resolver/executor. Placement metadata remains process ownership rather than capability identity. A trusted current-session-effects marker—not model arguments or mere Session presence—selects Worker fences. The same argument-normalizing guard runs before concrete permissions and returns a stable retryable code even for malformed always-unsupported calls. Unified/ToolScript local calls cannot reconstruct context through child `nodesManager`/`sessionManager`.
- Worker direct and unified node-environment calls targeting the exact current remote node carry `{currentNode,cwd}` from the authoritative owner; explicit dynamic other-node calls omit cwd. This prevents Main's stale projection from becoming routing authority without leaking cwd to another target.
- Main Management, remote Node execution, MCP external, bounded vector calls, file delivery, intermediate/final delivery, and presentation events are reverse-wired for the activated WorkerHost through one shared channel. Main Management version 4 retains a fixed 20-operation allowlist: the prior messaging/timer/catalog operations plus cross-session recall/archive reads, Main-owned agent/session creation, other-target session deletion, and node bootstrap/pairing. It carries no live mutable Session, queue, patch, or child callback; operations needing source settings receive one detached read-only authority inside Main. Unsupported operations still fail before effects rather than falling back to Main hydration.
- The Node execution facade uses local or borrowed reverse transport to one Main handler and accepts dynamic names only inside one authenticated remote node's currently advertised tool set. For isolated sources, that service restricts custom advertised capabilities to the exact bound/current node in both placements; custom tools are not narrowed by the static node-environment permission list. The colocated `master` execution environment bypasses the service and runs only a canonical node-environment handler, while master Node discovery exposes exactly those definitions.

## Compatibility

- Free-form object arguments may use documented JSON-string fallbacks.
- Generic dispatch recognizes only current structured image result fields. The separately deletable old-node result reader is canonical in [D-node-thread-tool-result-compatibility](./node-communication.md#d-node-thread-tool-result-compatibility).
- Removed internal wrappers are not retained merely as model-facing aliases; persisted or external readers are documented only when they still exist in source.

## Design decisions

### D-dispatch-resolved-target

[2026-08-18] Direct provider calls, `call_tool`, and ToolScript nested calls resolve one canonical operation before execution. The canonical capability sources are `builtin`, `node`, and `mcp`; source is independent from execution target and process/service owner. Direct `read`, `write`, `edit`, `apply_patch`, `exec`, and `browse_*` calls are Node capabilities targeting the current execution environment, and explicit `source=node` calls use that same current target when `nodeId` is omitted. Unified discovery emits those capabilities as Node results and does not duplicate them under the builtin source. `source=builtin` must reject those Node-capability names with a clear mismatch instead of retaining an alias. Obsolete dedicated Node/MCP discovery and invocation wrappers are absent rather than compatibility-routed. Permissions and tool-local validation apply to the resolved operation, while existing typed Main/Node/MCP/file services continue owning their effects.

### D-dispatch-exact-agent-tool-rules

[2026-08-19] Agent metadata may persist optional exact `toolRules`. Each rule is only `effect=allow|deny`, canonical `source=builtin|node|mcp`, and an exact non-empty tool name; Node rules additionally require one exact node and MCP rules one exact server. Builtin rules accept neither. Wildcards, regex/pattern fields, session/argument/path matchers, extra fields, and duplicate/conflicting exact identities are rejected before mutation effects. The persisted replacement is bounded to 256 rules and each exact node/server/tool string to 128 UTF-8 bytes; input is rejected rather than truncated. Rules belong only to the exact agent and never inherit through `agent.inherit`; absent and empty rules retain the historical isolated defaults, and rules are inert for non-isolated agents.

For an isolated agent, exact deny overrides a historical default allow and exact allow may add the named capability. An allow never bypasses the authenticated target/service boundary, advertised Node tool set, master-exec prohibition, agent-scoped master paths, copy/channel/timer/session relationships, Worker placement guards, or concrete tool-local validation. Node custom-tool missing-rule behavior deliberately reaches the exact bound/current Node service, preserving the established advertised-capability contract. MCP missing-rule behavior remains deny; an isolated agent discovers and invokes only exact allowed server/tool identities through the source-fenced MCP service.

Authorization and visibility use the same identity evaluation. `search_tools`, Node topology, and MCP discovery omit denied or structurally unavailable capabilities before metadata reaches the model. Main-local, reverse Worker, direct, unified, and ToolScript paths converge on the same rules. Session workers receive a normalized exact-agent metadata snapshot from Main at spawn. Only workers whose installed snapshot is isolated refresh that agent before execution/discovery; missing/read-failed refreshes preserve the snapshot, while malformed refreshed rules reject the current operation. Rule-only replacement on an unchanged isolation binding is therefore live under Worker placement without an I/O fail-open or per-call metadata reads for non-isolated workers, while isolation-node changes retain the existing ownership fence.

`create_agent` and `set_agent_isolated` accept optional full `toolRules` replacement, with `[]` as canonical clearing. When `set_agent_isolated` receives rules without `nodeId`, it preserves the current isolation binding; an explicit empty `nodeId` clears isolation. Agent listings and mutation results report a concise rule count. Existing metadata without `toolRules` remains readable unchanged.

### D-dispatch-shared-file-semantics

[2026-08-10] Master and node file tools share read/write/edit/patch semantics while retaining separate transport, path-resolution, and isolation wrappers. The shared semantic core depends only on a small target-local file contract covering stat, offset/count byte reads, directory-entry metadata, whole-file `w`/`wx` writes, mkdir, and remove. Local Main and CLI Node explicitly select the native implementation; authenticated remote Node calls continue executing the same composition inside the Node process rather than pulling file bytes through Main. Keep public tool names, schemas, error/output behavior, content-reference policy, patch partial-application behavior, and path/isolation checks above this seam. Do not turn this checkpoint into a public virtual-filesystem or generic plugin API.

### D-dispatch-output-boundary

Tool results remain structured through execution and are normalized/guarded exactly once before becoming model input. Recognized image payloads are promoted to structured image parts before the generic text/structured-output guard runs; the guard applies to the remaining response and must never turn image base64 into a text excerpt or truncation marker. Non-image content receives no multimodal exemption.

### D-dispatch-exec-parallel-segments

Phase-one batch concurrency is intentionally narrow: only adjacent direct calls whose tool name is exactly `exec` run concurrently, with an internal maximum concurrency of four. Every non-`exec` call—including unified `call_tool`, MCP, node-dynamic, ToolScript, file, session, and wait/control tools—flushes the previous exec segment and runs serially. Each exec segment snapshots session node/cwd routing once, settles all calls, then replays cwd changes in model-call order before the next barrier; the last model call therefore owns the resulting session cwd. Results, images, errors, and progress stay model-ordered and one failure does not discard siblings. A stop request waits for the active segment, skips later barriers, and does not claim to terminate already-started operating-system processes. This is an internal scheduler contract, not a public configuration or generalized resource-lock API.

### D-dispatch-mcp-live-configuration

[2026-08-01, updated 2026-08-19] The first managed/runtime MCP configuration read establishes one authoritative in-memory snapshot. Subsequent MCP listing, discovery, and calls read that snapshot rather than rereading the backing file. `mcp_config` mutations must persist successfully before replacing the live snapshot, become visible to subsequent MCP operations immediately, and require no Foxwarm restart. Manual backing-file edits do not alter the live snapshot; do not add file watching or an agent-facing manual reload path. Optional per-server `timeoutSeconds` is bounded to finite 1-3600 seconds and applies only to tool calls through SDK request options; zero canonically clears the field and omission preserves the SDK default.

### D-dispatch-node-environment-placement

[2026-08-05] Keep process-placement ownership separate from permission policy and model schemas. The registered node-environment builtins are exactly `read`, `write`, `edit`, `apply_patch`, `exec`, and `browse_*`: they execute directly in the selected local environment when `currentNode=master` and use the authenticated node connection when a remote current node is selected. Unified builtin calls use the same placement boundary. Explicit dynamic `source=node,nodeId=master` calls and master Node discovery are allowed only for this exact canonical set; they invoke the existing local named handler without RPC and cannot turn Main/session/MCP tools into Node calls. `delete_file` is removed from definitions, runtime exports, permissions, and advertised master capabilities without an alias; structured `apply_patch` deletion and explicit `exec` remain available. Compound file/channel/image operations and agent-memory tools are not node-environment primitives merely because they may touch files.

### D-dispatch-worker-exact-owner

[2026-08-06, updated 2026-08-16] Session-worker placement is identified only by a trusted in-process current-session-effects marker carried into direct and ToolScript-nested ToolContexts. Safe local builtins must retain the authoritative passed Session/persist hook through the canonical dispatcher and must never fall back to a same-ID child SessionManager or child Main singleton. Reachable operations with a closed Worker or reverse Main boundary use that exact owner/service; operations whose identity/admin, managed-session, or background-compaction boundary is intentionally unsupported remain visible but fail retryably before tool-start observability, concrete permissions, or raw handler initialization. Their guard normalization mirrors handler action/target semantics. Placement is not inferred from user arguments or Session-object presence. Existing current-agent vector recall remains supported from the exact owner's agent filter. Other-target deletion is closed through the fixed Main service and shared lifecycle orchestrator, while self/alias deletion remains rejected before effect.

## Canonical ownership

MCP result cleanup is canonical in [D-mcp-source-normalization](../units/src-mcp-client.md#d-mcp-source-normalization).
