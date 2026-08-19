# Module: tools and permissions

## Responsibility

This module owns model-facing tool definitions, builtin tool implementations, unified builtin/MCP/node discovery and dispatch, isolation enforcement, file and memory operations, persistent command execution, browser automation, image handling, and structured patch application.

## Key units

- [src-tools](../units/src-tools.md) — registry, schemas, builtin implementations, and unified discovery/dispatch.
- [src-main-management-tools](../units/src-main-management-tools.md) — closed versioned local RPC service for inter-session text/channel delivery, agent listing, and timer CRUD.
- [src-file-delivery](../units/src-file-delivery.md) — fixed Main-owned file preparation and channel/session delivery boundary for trusted local Session workers.
- [src-tools-session-agent](../units/src-tools-session-agent.md) — session, agent, timer, skill, recall, goal, channel, and wait tools.
- [src-tool-utils](../units/src-tool-utils.md) — argument serialization, output guards, and image normalization.
- [src-permissions](../units/src-permissions.md) — exact persisted agent tool-rule validation/matching and default isolated fallback behavior.
- [src-isolated-check](../units/src-isolated-check.md) — current isolated-session tool, path, channel, timer, and archive checks.
- [src-apply-patch](../units/src-apply-patch.md) — structured patch parsing and application.
- [src-browser](../units/src-browser.md) — Puppeteer browser manager.
- [src-exec-manager](../units/src-exec-manager.md) — persistent command execution integration.

## Public interfaces

- `definitions` and `modelFacingDefinitions` — builtin tool registry and default model schema.
- `BUILTIN_TOOL_PLACEMENTS` and `resolveBuiltinToolPlacement` — exhaustive process-ownership metadata and current-node routing, independent of permission policy.
- `mainManagementToolServiceDescriptor` and `executeMainManagementTool` — current local-only RPC boundary for the first closed main-management allowlist.
- `fileDeliveryServiceDescriptor` and `deliverFile` — bounded operation-specific file-delivery boundary with no file bytes on reverse RPC.
- `callTool(toolName, args, context)` — builtin dispatch entry.
- `search_tools` and `call_tool` — unified discovery and invocation across builtin, MCP, and node sources.
- `checkToolPermission` and `checkPathAccess` — current isolation checks.
- `normalizeAgentToolRules`, `findExactAgentToolRule`, and `isDefaultIsolatedCapabilityAllowed` — exact persisted rule and fallback evaluation.
- Shared file, memory, image, browser, patch, exec, and output-guard helpers.

## Invariants

- Optional exact agent-level `toolRules` are inert for non-isolated agents. For isolated agents, exact deny overrides the default allow behavior and exact allow may add a capability without bypassing structural, service, path, or relationship guards.
- On the master, an isolated agent may access only its own agent directory. On its bound/current node, it may use default or exactly allowed capabilities subject to the authenticated advertised-tool boundary.
- Non-isolated file operations may use absolute, home-relative, or session-cwd-relative paths.
- Master and node read/write wrappers share `packages/shared/src/fileToolCore.ts` after their own context and permission handling.
- Only `read`, `write`, `edit`, `apply_patch`, `exec`, and `browse_*` are registered node-environment builtins. The removed `delete_file` surface has no compatibility alias; use structured `apply_patch` delete operations or an explicit shell command when appropriate.
- `write` does not create missing parent directories unless `createDirs=true` is explicit.
- Exact edit requires exactly one match; ambiguous edits fail.
- Pending write references are scoped, bounded, expire, and may reuse their cached payload at any independently authorized write target in the same session and agent.
- Oversized tool results are saved and replaced with a bounded line-aware excerpt before entering model context.
- Image results receive stable IDs before model serialization.
- Timer builtins remain discoverable but are not injected into the default model schema.
- MCP server configuration/listing builtins remain discoverable but are not injected into the default model schema.
- Patch application preserves the source line-ending convention.
- Master and node patch results use the shared per-file add/update count formatter; the exact contract is canonical in [D-apply-patch-change-counts](../units/shared-apply-patch.md#d-apply-patch-change-counts).

## Canonical cross-module flow

Tool resolution across builtin, MCP, and generic Node sources is documented in [tool dispatch](../threads/tool-dispatch.md).

## Compatibility

- Free-form object arguments may provide JSON-string fallbacks where provider schemas cannot express arbitrary nested objects reliably.
- `read` and `read_memory` treat optional `startLine`/`endLine` values of `0` as omitted.
- Persisted or external compatibility aliases are retained only where source readers still support them. Removed internal tool names are not documented as active interfaces.

## Design decisions

### D-tools-unified-discovery

Less frequently used builtins, MCP tools, and node tools are discovered through `search_tools` and invoked through `call_tool`. Direct provider calls, unified calls, and ToolScript nested calls share the canonical resolved-operation boundary in [D-dispatch-resolved-target](../threads/tool-dispatch.md#d-dispatch-resolved-target).

Agent-level authorization and filtered discovery are canonical in [D-dispatch-exact-agent-tool-rules](../threads/tool-dispatch.md#d-dispatch-exact-agent-tool-rules).

### D-tools-write-parent-policy

Normal writes attempt the real filesystem operation first. Missing/non-directory parent diagnostics are fallback error enrichment, preserving normal symlink behavior while requiring explicit directory creation.

### D-tools-structured-output-guard

Output guarding preserves the structured function-response envelope. It replaces only oversized payload content and records where the full result is stored.

### D-tools-exec-timeout

Master and node execution use one timeout resolver. Finite values above the effective maximum are clamped with a warning kept outside truncatable command output; invalid and below-minimum values fail.

### D-tools-control-results

Control and handoff tools return minimal success signals rather than echoing arguments or full message bodies that are already visible in the call.

### D-tools-schema-validity

Default model-facing tool properties have concrete schema shapes accepted by strict providers. Runtime validation handles argument alternatives that JSON Schema cannot express cleanly.

### D-tools-resource-action-consolidation

[2026-08-01, updated 2026-08-03] Keep the default model-facing namespace compact by grouping closely related operations under singular resource tools: `session` owns status/list/update-display-name, `skill` owns list/load, and `node` owns list/select. The display-name action is exactly `update-display-name`; the earlier `rename` action and removed standalone tool name are not retained as aliases. Keep action-specific arguments flat in the shared schema. A successful display-name update reports both the previous and resulting values, using `unset` for no display name and an explicit unchanged result for no-op calls. `start_toolscript_run` is the narrow exception to removed-name handling: it remains hidden and callable only for documented user-ToolScript compatibility, while current guidance uses `run_script({ mode: "background" })`. MCP configuration/listing is discoverable through `search_tools`/`call_tool` rather than injected by default.

Node-environment ownership and the removed deletion surface are canonical in [D-dispatch-node-environment-placement](../threads/tool-dispatch.md#d-dispatch-node-environment-placement).

## Canonical ownership

Shared master/node file semantics are canonical in [D-dispatch-shared-file-semantics](../threads/tool-dispatch.md#d-dispatch-shared-file-semantics).
