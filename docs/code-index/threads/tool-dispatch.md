# Thread: tool dispatch

## Overview

The unified execution flow resolves model tool calls to builtin handlers, MCP servers, or authenticated remote nodes. Current isolation checks are applied at the concrete execution boundary.

## Steps

1. The LLM returns one or more tool calls in a `ChatResult`.
2. The message-processing loop calls the builtin dispatcher with the tool name, arguments, and session context.
3. Direct builtins resolve their effective execution node and run the current isolated-session permission checks.
4. Master-only builtins execute on the master after their tool-local and isolation guards pass.
5. `search_tools` discovers non-default builtins, MCP tools, and tools advertised by the selected node.
6. `call_tool` parses a `toolId` or explicit source descriptor and resolves one concrete builtin, MCP, or node target.
7. MCP calls run through `mcpClient.callTool`; safe text cleanup and MCP image-content promotion occur at that client boundary while non-image content remains structured.
8. Node calls are sent through `nodesManager` over the authenticated node connection. A node-side approval interceptor may still reject the call.
9. Master and node file wrappers use the shared file-tool core after their own path, context, and isolation handling.
10. Recognized image payloads are promoted to image parts and receive stable IDs before the remaining text/structured response passes through the oversized-output guard. Successful master/node patch results already carry shared per-file change-count summaries from [D-apply-patch-change-counts](../units/shared-apply-patch.md#d-apply-patch-change-counts).
11. ToolScript nested calls use the same registered tool surfaces and appear as subcalls of the outer run.

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
- [src-nodes-manager](../units/src-nodes-manager.md)
- [shared-node-tools](../units/shared-node-tools.md)
- [src-toolscript](../units/src-toolscript.md)

## Invariants

- Isolation is enforced against the resolved execution node and tool arguments.
- An isolated session cannot use master file paths outside its own agent directory.
- Unified wrappers do not bypass the concrete target's existing guards.
- Tool output is bounded before it enters model context.
- Recognized image bytes stay in structured image parts rather than entering text excerpts; non-image text, JSON, audio, resource, and blob content remain subject to the normal output budget.
- MCP and node credentials remain transport/runtime state and are not exposed to the model through tool summaries.

## Compatibility

- Free-form object arguments may use documented JSON-string fallbacks.
- Removed internal wrappers are not retained merely as model-facing aliases; persisted or external readers are documented only when they still exist in source.

## Design decisions

### D-dispatch-resolved-target

Unified discovery and invocation resolve a concrete target before execution. Permissions and tool-local validation apply to that resolved operation rather than to discovery metadata alone.

### D-dispatch-shared-file-semantics

Master and node file tools share read/write semantics while retaining separate transport, path-resolution, and isolation wrappers.

### D-dispatch-output-boundary

Tool results remain structured through execution and are normalized/guarded exactly once before becoming model input. Recognized image payloads are promoted to structured image parts before the generic text/structured-output guard runs; the guard applies to the remaining response and must never turn image base64 into a text excerpt or truncation marker. Non-image content receives no multimodal exemption.

## Canonical ownership

MCP result cleanup is canonical in [D-mcp-source-normalization](../units/src-mcp-client.md#d-mcp-source-normalization).
