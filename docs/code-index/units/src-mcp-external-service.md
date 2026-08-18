# Unit: src-mcp-external-service

Files: src/mcpExternalService.ts
Secondary files: src/mcpExternalService.test.ts, src/tools/resolvedTools.ts, src/tools/mcpTools.ts, src/tools/unifiedSearch.ts, src/index.ts

## Purpose

Provides the single versioned RPC owner through which direct, unified, ToolScript, and Session-worker MCP operations reach the authoritative Main MCP client. Main-local callers use local transport; a Session worker borrows its one reverse transport without owning an independent live configuration snapshot or connection pool.

## Key exports

- `mcpExternalServiceDescriptor` — fixed `mcp-external@1` methods for redacted server list, optional-server tool list, named call, and tagged managed configuration update.
- `listMcpServers()`, `listMcpTools()`, `callMcpTool()`, `configureMcpServer()` — local client facade used by production callers.
- `initializeMcpExternalService()`, `shutdownMcpExternalService()` — owned-local or borrowed-reverse initialization and terminal fencing.
- `resetMcpExternalServiceForTests()` — explicit test-only reopening after a completed shutdown.

## Runtime behavior

- Every request carries one source session ID. A per-worker reverse handler rejects source mismatch before lookup, permission, or effect; the handler then rejects stale sources and applies the existing concrete MCP tool permission/isolation check before invoking `mcpClient`.
- Requests and results pass through local RPC structured cloning. Every envelope/tag has an exact key set; envelopes, config, args, env, and headers must be plain records, while nested call args must be finite JSON values. JSON/config arrays must be dense and may contain only canonical in-range index keys. No arbitrary builtin registry, Date/Map/Set value, or live Session object crosses the boundary. Call permission checks receive the complete nested tool args.
- Server-list responses contain only `McpServerSummary`. Raw configuration is never returned. Connection/config error handling scans secret-bearing values from every current server plus the incoming upsert. Any match yields one stable generic message rather than substring replacement; wrapped `RpcError` code/retryability survive while unsafe details are omitted.
- Managed upsert and enabled-toggle calls retain `mcpClient`'s mutation queue and persist-before-publish live snapshot semantics. Existing hidden tool formatting and config argument parsing stay in `tools/mcpTools.ts` rather than being duplicated here.
- Initialization is bound to one exact local/borrowed transport so a conflicting concurrent placement cannot silently join. Production shutdown is one-way: initialization and new calls are fenced, accepted local calls drain, and later callers cannot lazily reopen the service. Borrowed worker clients clear without draining/closing the channel-wide reverse transport. Stdio pool lifetime remains owned by the existing MCP client.

## Integration

- `src/tools/mcpTools.ts` retains compatibility list/search/call/config handlers; call invocation delegates to the resolved-tool executor.
- `src/tools/resolvedTools.ts` routes direct, unified, ToolScript, and retained compatibility MCP invocation through this facade; discovery remains in `src/tools/unifiedSearch.ts`.
- `src/index.ts` initializes and terminally drains the service.
- The authoritative live-configuration and safe-summary decisions remain canonical in [tool dispatch](../threads/tool-dispatch.md#d-dispatch-mcp-live-configuration) and [MCP client](src-mcp-client.md#d-mcp-safe-summary).

## Design decisions

No unit-local product decision. MCP configuration and summary behavior remain canonical at the links above; placement remains canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).