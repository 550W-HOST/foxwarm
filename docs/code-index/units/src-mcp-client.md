# Unit: src-mcp-client

Files: src/mcpClient.ts, src/mcpClient.test.ts

## Purpose

Owns persisted MCP server configuration, safe summaries, transport connection lifecycle, tool discovery/invocation, and result normalization at the MCP boundary.

## Key exports

- `McpTransport`, `McpServerConfig`, `McpConfig`, `McpServerSummary`.
- `createMcpConfigStore(filePath?)`, `setMcpConfigStoreForTests(store)`.
- `summarizeServerConfig(name, server)`, `summarizeServers(servers)`.
- `listTools(serverName?)`.
- `callTool(serverName, tool, args?)`.
- `upsertServer(name, server)`, `setServerEnabled(name, enable)`.
- `getServers()` — raw configured server record for trusted runtime callers.
- `listServers()` — sorted redacted summaries.
- `normalizeMcpToolResult(result)` — canonical result cleanup.
- `buildMcpHttpHeadersForTests(config)` — exported test seam for the shared HTTP-header builder.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| config normalization | Current `transport` plus legacy `type` reader and validated persisted server shapes |
| live config snapshot | First-load cache, store-reset invalidation, and persist-before-publish managed updates |
| server summary | Names/counts only for secret-bearing args/env/header fields |
| standard transport connection | Streamable HTTP, SSE, and `auto` fallback lifecycle |
| stdio pool | Config-signature keyed reuse with idle cleanup |
| `listTools` / `callTool` | Resolve enabled server, connect, invoke, and close/release |
| `normalizeMcpImageContent` | Promote valid MCP image blocks to Foxwarm inline-data items while preserving other content blocks |
| `normalizeMcpToolResult` | Unwrap safe single-text results at the source boundary |

## Transport behavior

- The first runtime read loads and normalizes the durable configuration (including fallback recovery) into one live snapshot. Later list/discovery/call reads use that snapshot; manual file edits remain invisible until process/store reinitialization. Managed writes publish a cloned snapshot only after durable persistence succeeds. Canonical contract: [D-dispatch-mcp-live-configuration](../threads/tool-dispatch.md#d-dispatch-mcp-live-configuration).
- `stdio` requires a command and uses a pooled client keyed by server name plus command/args/env/cwd/stderr signature. A config change selects a new key for later calls; the old keyed entry is not synchronously invalidated and closes through its idle TTL or transport `onclose` path.
- `streamable-http` and `sse` require a URL and use short-lived standard connections.
- `auto` tries streamable HTTP and falls back to SSE.
- For HTTP transports, `token` supplies default `Authorization: Bearer <token>`. Configured custom headers are applied afterward; a custom `Authorization` key in any casing removes the generated default and wins with its configured casing/value.
- Streamable HTTP, SSE, and both `auto` attempts use the same header builder.
- `stdio` applies no HTTP token/headers. Its pool signature includes only server name plus command/args/env/cwd/stderr, so token/header-only edits neither change its key nor restart the process.
- Disabled or unknown servers fail before invocation.

## Result normalization

- A single plain text content block with no preservable result metadata becomes a string.
- Text that looks like a JSON object or array is parsed to that object/array.
- JSON primitives remain strings.
- Valid MCP `image` content blocks with `image/*` MIME types become `inlineDataItems`; per-image annotations and `_meta` remain attached, and pure, mixed, and multiple-image results share the normal Foxwarm image pipeline.
- Non-image content blocks retain their original order and shape. Text, audio, resource/blob, malformed image, `isError`, `structuredContent`, `_meta`, annotations, and other metadata are not misclassified as images.
- Multimodal promotion precedes output guarding as defined by [D-dispatch-output-boundary](../threads/tool-dispatch.md#d-dispatch-output-boundary).

## Compatibility

- Config accepts legacy `type` as a reader and writes current `transport`.
- The hidden runtime `call_mcp`/`search_mcp_tools` tools still exist for compatibility. They are not default model recommendations; agents should discover through `search_tools` and invoke through `call_tool`. Both paths call this same client.

## Integration

- `src/tools/mcpTools.ts` implements the hidden compatibility tools and MCP configuration/list tools.
- `src/tools/unifiedSearch.ts` implements recommended unified discovery/invocation.
- ToolScript calls the unified `call_tool` wrapper and receives this client's normalized result.
- `MCP_CONFIG_PATH` and durable JSON behavior come from config/utilities.

## Design decisions

### D-mcp-source-normalization

Normalize safe single-text results immediately after MCP invocation so every caller receives the same value and no dispatch layer needs MCP-specific parsing.

### D-mcp-safe-summary

Model/admin summaries expose configuration shape, names, and counts, never token/header/env values or command argument content.

### D-mcp-compatibility-tools

Keep direct MCP runtime handlers as hidden compatibility paths while current model guidance uses unified discovery and dispatch.

### D-mcp-http-header-precedence

For HTTP transports, the token is a default Bearer Authorization header and explicit custom headers apply afterward. Authorization matching is case-insensitive, so a custom authorization header in any casing always overrides the generated default. Stdio ignores HTTP token/header fields and excludes them from its process-pool signature.
