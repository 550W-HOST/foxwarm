# Unit: src-mcp-client

Files: src/mcpClient.ts, src/mcpClient.test.ts, src/mcpResultNormalization.test.ts

## Purpose

Owns persisted MCP server configuration, safe summaries, transport connection lifecycle, tool discovery/invocation, and result normalization at the MCP boundary.

## Key exports

- `McpTransport`, `McpServerConfig`, `McpConfig`, `McpServerSummary`.
- `MIN_MCP_TOOL_TIMEOUT_SECONDS`, `MAX_MCP_TOOL_TIMEOUT_SECONDS` — managed per-server tool-call timeout bounds (1-3600 seconds; zero is accepted only as a clearing input).
- `createMcpConfigStore(filePath?)`, `setMcpConfigStoreForTests(store)`.
- `summarizeServerConfig(name, server)`, `summarizeServers(servers)`.
- `listTools(serverName?, signal?, owner?)`.
- `callTool(serverName, tool, args?, options?)` — optional trusted connection owner and inbound AbortSignal/raw SDK result; normal internal calls retain canonical normalization.
- `upsertServer(name, server)`, `setServerEnabled(name, enable)`.
- `normalizeManagedMcpServerConfig(server)` — canonical semantic validation of a fully merged managed update before persistence/publication.
- `getServers()` — raw configured server record for trusted runtime callers.
- `listServers()` — sorted redacted summaries.
- `normalizeMcpToolResult(result)` — canonical result cleanup.
- `buildMcpHttpHeaders(config)` — canonical HTTP headers for calls and notification receivers.
- `setMcpSdkForTests(sdk)`, `resetMcpConnectionsForTests()` — focused test seams for SDK request options and connection cleanup.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| config normalization | Current `transport` plus legacy `type` reader and validated persisted server shapes |
| live config snapshot | First-load cache, store-reset invalidation, and persist-before-publish managed updates |
| server summary | Names/counts only for secret-bearing args/env/header fields |
| caller-owned HTTP connection | Streamable HTTP, SSE, and `auto` lifecycle shared with opt-in notification reception |
| stdio pool | Config-signature keyed reuse with idle cleanup |
| `listTools` / `callTool` | Resolve enabled server, acquire caller connection, invoke once, and update idle state |
| `normalizeMcpImageContent` | Promote valid MCP image blocks to Foxwarm inline-data items while preserving other content blocks |
| `normalizeMcpToolResult` | Unwrap safe single-text results at the source boundary |

## Transport behavior

- The first runtime read loads and normalizes the durable configuration (including fallback recovery) into one live snapshot. Later list/discovery/call reads use that snapshot; manual file edits remain invisible until process/store reinitialization. Managed writes publish a cloned snapshot only after durable persistence succeeds. Canonical contract: [D-dispatch-mcp-live-configuration](../threads/tool-dispatch.md#d-dispatch-mcp-live-configuration).
- Managed upsert merges with the current named server and then runs one authoritative transport validator inside `mcpClient`: `stdio` requires a command, all HTTP/SSE/auto placements require a URL, and unknown transports fail before any durable write or live-snapshot publication. Tool wrappers retain argument parsing and user-facing success messages but do not duplicate these semantics.
- Optional `timeoutSeconds` controls only `client.callTool`. Omission sends no request override and retains the installed SDK default (currently 60 seconds); managed input accepts finite 1-3600 seconds, while zero removes the persisted field and restores that default. Invocation converts the override to milliseconds and passes it through the SDK call's third `RequestOptions` argument. Connection setup, tool listing, retry/progress policy, and pool keys are unchanged.
- The external inbound adapter can supply an SDK request AbortSignal to listing/calling and request the raw SDK result to preserve original text, structured content, images and `isError`. Internal callers supply a trusted Session owner and keep canonical normalization. When an external HTTP call is cancelled, the connection remains owned by its real external context and SDK cancellation retains its existing semantics; completion of a remote effect is not guaranteed to stop.
- `stdio` requires a command and uses a pooled client keyed by server name plus command/args/env/cwd/stderr signature. A config change selects a new key for later calls; the old keyed entry is not synchronously invalidated and closes through its idle TTL or transport `onclose` path.
- `streamable-http`, `sse` and `auto` require a URL and reuse one connection per trusted caller/server, whether reception is enabled or not. Owners are exact internal Sessions or real verified inbound contexts, never an anonymous shared identity. Unowned low-level calls are short-lived and terminate their remote Streamable HTTP session before closing. See [caller connections](./src-mcp-caller-connections.md).
- `auto` tries Streamable HTTP initialization and then SSE; an allocated failed HTTP attempt is terminated before fallback. Tool effects are never retried by transport fallback.
- For HTTP transports, `token` supplies default `Authorization: Bearer <token>`. Configured custom headers are applied afterward; a custom `Authorization` key in any casing removes the generated default and wins with its configured casing/value.
- Streamable HTTP, SSE, and both `auto` attempts use the same header builder.
- `stdio` applies no HTTP token/headers. Its pool signature includes only server name plus command/args/env/cwd/stderr, so token/header-only edits neither change its key nor restart the process.
- Ordinary discovery/calls retain their existing resolver: requested/default name when present, otherwise the first configured server; an empty configuration or disabled resolved server fails. Notification start has exact-name semantics instead. Successful managed updates close all HTTP caller connections for that server after durable publication.
- Safe server summaries expose `timeoutSeconds` as the configured override or `null` for the SDK default; no secret-bearing values are added.

- `startNotifications` resolves only the exact enabled server name, without ordinary discovery/call fallback, and uses the same caller-owned connection and preserves prior Node/cwd/exec state. For a peer advertising the Foxwarm extension, `foxwarm_session` send with `allowReply:true` fails locally before `client.callTool` unless that connection has enabled reception. Third-party same-name tools without the capability are unaffected.

## Result normalization

- A single plain text content block with no preservable result metadata becomes a string.
- Text that looks like a JSON object or array is parsed to that object/array.
- JSON primitives in ordinary single-text results remain strings.
- When `structuredContent` exists, pure text JSON blocks equal to that value are removed by parsed deep equality, ignoring object key order and whitespace. Blocks with additional metadata or different explanations remain.
- If only structured data remains, optional empty `content` and non-error `isError` do not prevent unwrapping to that value itself. Tool-owned fields inside it are not renamed or flattened. `isError:true`, `_meta`, multimodal blocks and other result metadata retain their necessary structure.
- Internal normal calls and ToolScript use this source normalization. `rawResult:true` external MCP passthrough bypasses it and retains the original protocol representations; server wire output and persisted history are unchanged.
- Valid MCP `image` content blocks with `image/*` MIME types become `inlineDataItems`; per-image annotations and `_meta` remain attached, and pure, mixed, and multiple-image results share the normal Foxwarm image pipeline.
- Non-image content blocks other than plain duplicate structured JSON retain their original order and shape. Text, audio, resource/blob, malformed image, `isError`, `structuredContent`, `_meta`, annotations, and other metadata are not misclassified as images.
- Multimodal promotion precedes output guarding as defined by [D-dispatch-output-boundary](../threads/tool-dispatch.md#d-dispatch-output-boundary).

## Compatibility

- Config accepts legacy `type` as a reader and writes current `transport`.

## Integration

- `src/mcpExternalService.ts` remains the sole production caller of raw list/discovery/call/config mutation exports. Its original exact-internal-Session RPC service and new Main-local authenticated external facade share this client's authoritative live snapshot, persistence, transports and pooling.
- `src/tools/mcpTools.ts` calls the MCP external service for configuration/server summaries, while `src/tools/unifiedSearch.ts` owns MCP discovery and unified invocation.
- ToolScript calls the unified `call_tool` wrapper and receives this client's normalized result through the same service.
- `MCP_CONFIG_PATH` and durable JSON behavior come from config/utilities.

## Design decisions

### D-mcp-source-normalization

Normalize internal results immediately after MCP invocation: remove plain JSON duplicates of structured data and unwrap structured-only or safe single-text results. Internal callers, including ToolScript, receive the real result fields without an added output wrapper. Preserve errors, explanatory/block metadata and multimodal information; raw external passthrough keeps wire compatibility. No dispatch layer reparses or independently unwraps MCP output.

### D-mcp-safe-summary

Model/admin summaries expose configuration shape, names, and counts, never token/header/env values or command argument content.

### D-mcp-unified-tools

[2026-08-18] MCP discovery and invocation use only `search_tools` and `call_tool`. Dedicated runtime wrappers are removed rather than retained as callable aliases; configuration and safe server summaries remain separate hidden builtins.

### D-mcp-http-header-precedence

For HTTP transports, the token is a default Bearer Authorization header and explicit custom headers apply afterward. Authorization matching is case-insensitive, so a custom authorization header in any casing always overrides the generated default. Stdio ignores HTTP token/header fields and excludes them from its process-pool signature.

### D-mcp-tool-call-timeout

[2026-08-19] A server may persist one optional `timeoutSeconds` override for MCP tool calls only. The runtime passes the converted millisecond value through the official SDK `RequestOptions`; it does not add a competing timer, change connection/listing timeouts, retry, reset on progress, or invalidate a pooled stdio connection solely because a request times out. Zero is a write-new clearing operation and omission keeps SDK behavior.
