# Module: tools and permissions

## Responsibility

This module owns model-facing tool definitions, builtin tool implementations, unified builtin/MCP/node discovery and dispatch, isolation enforcement, file and memory operations, persistent command execution, browser automation, image handling, and structured patch application.

## Key units

- [src-tools](../units/src-tools.md) — registry, schemas, builtin implementations, and unified discovery/dispatch.
- [src-tools-session-agent](../units/src-tools-session-agent.md) — session, agent, timer, skill, recall, goal, channel, and wait tools.
- [src-tool-utils](../units/src-tool-utils.md) — argument serialization, output guards, and image normalization.
- [src-permissions](../units/src-permissions.md) — first-match permission evaluator and isolated-session rule construction.
- [src-isolated-check](../units/src-isolated-check.md) — current isolated-session tool, path, channel, timer, and archive checks.
- [src-apply-patch](../units/src-apply-patch.md) — structured patch parsing and application.
- [src-browser](../units/src-browser.md) — Puppeteer browser manager.
- [src-exec-manager](../units/src-exec-manager.md) — persistent command execution integration.

## Public interfaces

- `definitions` and `modelFacingDefinitions` — builtin tool registry and default model schema.
- `callTool(toolName, args, context)` — builtin dispatch entry.
- `search_tools` and `call_tool` — unified discovery and invocation across builtin, MCP, and node sources.
- `checkToolPermission` and `checkPathAccess` — current isolation checks.
- `evaluatePermission` and `buildIsolatedToolRules` — permission rule evaluation.
- Shared file, memory, image, browser, patch, exec, and output-guard helpers.

## Invariants

- Isolated sessions are evaluated through the current isolated permission rules before restricted operations execute.
- On the master, an isolated agent may access only its own agent directory. On its bound/current node, it may use the node capabilities permitted by the isolated rule set.
- Non-isolated file operations may use absolute, home-relative, or session-cwd-relative paths.
- Master and node read/write wrappers share `packages/shared/src/fileToolCore.ts` after their own context and permission handling.
- `write` does not create missing parent directories unless `createDirs=true` is explicit.
- Exact edit requires exactly one match; ambiguous edits fail.
- Pending write references are scoped, bounded, and expire.
- Oversized tool results are saved and replaced with a bounded line-aware excerpt before entering model context.
- Image results receive stable IDs before model serialization.
- Timer builtins remain discoverable but are not injected into the default model schema.
- Patch application preserves the source line-ending convention.

## Canonical cross-module flow

Tool resolution across builtin, MCP, and remote-node sources is documented in [tool dispatch](../threads/tool-dispatch.md).

## Compatibility

- Free-form object arguments may provide JSON-string fallbacks where provider schemas cannot express arbitrary nested objects reliably.
- `read` and `read_memory` treat optional `startLine`/`endLine` values of `0` as omitted.
- Persisted or external compatibility aliases are retained only where source readers still support them. Removed internal tool names are not documented as active interfaces.

## Design decisions

### D-tools-unified-discovery

Less frequently used builtins, MCP tools, and node tools are discovered through `search_tools` and invoked through `call_tool`. The wrapper resolves a concrete target before normal execution checks.

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

## Canonical ownership

Shared master/node file semantics are canonical in [D-dispatch-shared-file-semantics](../threads/tool-dispatch.md#d-dispatch-shared-file-semantics).
