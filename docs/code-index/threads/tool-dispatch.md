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
7. MCP calls run through `mcpClient.callTool`; MCP result normalization occurs at that client boundary.
8. Node calls are sent through `nodesManager` over the authenticated node connection. A node-side approval interceptor may still reject the call.
9. Master and node file wrappers use the shared file-tool core after their own path, context, and isolation handling.
10. Results are normalized, image parts receive stable IDs, and oversized output is guarded before the next model iteration.
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

Tool results remain structured through execution and are normalized/guarded exactly once before becoming model input.

## Canonical ownership

MCP result cleanup is canonical in [D-mcp-source-normalization](../units/src-mcp-client.md#d-mcp-source-normalization).
