# Unit: src-mcp-external-service

Files: src/mcpExternalService.ts
Secondary files: src/mcpExternalService.test.ts, src/tools/mcpTools.ts, src/tools/unifiedSearch.ts, src/index.ts

## Purpose

Provides the single versioned local RPC owner through which current direct, unified, and ToolScript MCP operations reach the authoritative MCP client. It prevents callers from owning independent live configuration snapshots or connection pools without introducing Session-worker reverse transport.

## Key exports

- `mcpExternalServiceDescriptor` — fixed `mcp-external@1` methods for redacted server list, optional-server tool list, named call, and tagged managed configuration update.
- `listMcpServers()`, `listMcpTools()`, `callMcpTool()`, `configureMcpServer()` — local client facade used by production callers.
- `initializeMcpExternalService()`, `shutdownMcpExternalService()` — lazy/startup initialization and terminally fenced accepted-call drain.
- `resetMcpExternalServiceForTests()` — explicit test-only reopening after a completed shutdown.

## Runtime behavior

- Every request carries one source session ID. The handler rejects stale sources and applies the existing concrete MCP tool permission/isolation check before invoking `mcpClient`.
- Requests and results pass through local RPC structured cloning. The fixed methods validate required strings, tagged config actions, booleans, and cloneable object arguments; no arbitrary builtin registry or live Session object crosses the boundary.
- Server-list responses contain only `McpServerSummary`. Raw configuration is never returned. Connection/config errors replace exact configured token, argument, environment, and header values before crossing the service boundary.
- Managed upsert and enabled-toggle calls retain `mcpClient`'s mutation queue and persist-before-publish live snapshot semantics. Existing hidden tool formatting and config argument parsing stay in `tools/mcpTools.ts` rather than being duplicated here.
- Production shutdown is one-way: initialization and new calls are fenced, accepted local calls drain, and later callers cannot lazily reopen the service. Stdio pool lifetime remains owned by the existing MCP client.

## Integration

- `src/tools/mcpTools.ts` routes hidden compatibility list/search/call/config handlers through this facade.
- `src/tools/unifiedSearch.ts` routes MCP discovery and invocation through this facade; ToolScript inherits the same path through nested `call_tool`.
- `src/index.ts` initializes and terminally drains the service.
- The authoritative live-configuration and safe-summary decisions remain canonical in [tool dispatch](../threads/tool-dispatch.md#d-dispatch-mcp-live-configuration) and [MCP client](src-mcp-client.md#d-mcp-safe-summary).

## Design decisions

No unit-local product decision. MCP configuration and summary behavior remain canonical at the links above; placement remains canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).