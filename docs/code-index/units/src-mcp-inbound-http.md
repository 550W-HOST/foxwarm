# Unit: src-mcp-inbound-http

Files: `src/mcpInboundHttp.ts`, `src/mcpInboundHttp.test.ts`, `src/mcpInboundStartup.test.ts`
Secondary files: `src/index.ts`, `src/httpServer.ts`, `src/config.ts`, `src/mcpInboundConfig.ts`, `src/mcpInboundCatalog.ts`, `src/mcpInboundIntegration.test.ts`

## Purpose

Owns inbound MCP Streamable HTTP lifecycle on the existing Main HTTP listener. It authenticates each request, binds a random transport ID to one verified external principal and one ephemeral execution context, and dispatches SDK discovery/calls to an injected trusted catalog. It does not construct a Foxwarm Agent or internal Session; supported capabilities are owned by the concrete catalog.

## Key exports

- `McpInboundHttpService.register(httpServer)` — registers `/mcp` POST/GET/DELETE. The shared JSON parser skips this path: an inbound Bearer check precedes a dedicated 8 MiB JSON parser. Errors are sanitized without request bytes. These routes bypass only the instance-token middleware and perform their own mandatory request-level Bearer check.
- `McpInboundHttpService.stop()` — fences requests and closes SDK transports and SSE streams. It cannot reverse a remote tool effect or restore results after restart.
- `ExternalExecutionContext` — per-transport immutable generated ID/external identity and mutable selected Node (`master` initially), cwd (`null` initially) and selection generation. Disposal synchronously marks the live context unavailable before awaiting catalog cleanup; only its lifetime retains the set of Nodes used by external exec. The Node catalog changes placement/cwd only after exact authorized actions and generation-checked completions.
- `McpInboundCatalog` — trusted process-local adapter; receives the verified HTTP principal separately from the execution context, plus SDK cancellation signal on calls. Its optional `releaseContext` hook drops live result authority at context disposal. The production implementation is [src-mcp-inbound-catalog](./src-mcp-inbound-catalog.md).
- `McpInboundSafeError` — only trusted adapters may mark a bounded diagnostic as safe to return as MCP `isError` text; arbitrary exceptions return an unknown-outcome message.

## Request lifecycle

1. Authenticate exactly one Authorization header on each POST/GET/DELETE. ClientInfo, tool arguments, cookies and the instance token cannot identify a caller. Ambiguous headers, foreign Origin, or unknown/cross-identity MCP session IDs fail before SDK dispatch.
2. Initialize without a session header. The server allocates a random UUID/context and connects SDK v1.27.1 `Server` and `StreamableHTTPServerTransport`; subsequent requests use the same owner. A new initialization creates a different context. The same Bearer token plus existing opaque ID supports reconnect; no separate device secret is asserted.
3. The SDK validates JSON-RPC, protocol version, Content-Type and Accept, and provides JSON POST responses and one GET SSE per transport. Compression excludes `/mcp`. No EventStore/resumption is advertised.
4. Bounds: 32 live contexts, four concurrent HTTP requests per context, 15-minute inactivity timeout (does not evict an active POST; its completion resets inactivity), 8 MiB POST body, 256 KiB *registered wrapper catalog*, 16 MiB single tool result (including inline images), 64 registered tools and a 65-minute absolute POST deadline to accommodate managed MCP SDK tool timeouts up to one hour. Output over limit after tool invocation returns `isError` explaining the effect may have completed; it is not retried. The catalog independently limits discovery output. The HTTP deadline reports unknown outcome; it closes an uninitialized context, but a live initialized context remains available for reconnect/result inspection.
5. Server shutdown, DELETE or idle expiry releases the initialized transport and its Node result authority. Prematurely disconnected individual POSTs and request deadlines cancel only that SDK handler best-effort without discarding an initialized context or killing started Node commands; an uninitialized request failure is disposed. Active SSE closes on disconnect/expiry. SDK request-handler controllers and response close listeners are released on completion; repeated real POST integration checks bound listener counts. Context IDs and results are memory-only, with no restart recovery.

## Tests

Pinned SDK clients cover owner isolation, request-level authentication, SSE reconnect/expiry, allowed 70 KiB tool output, larger result rejection without a second invocation, 8 MiB body cap, timeout/abort and 32-context capacity. An actual Main startup fixture checks headless `/mcp`, Node bootstrap/WS, five registered inbound wrappers and graceful process exit. [Inbound integration](./src-mcp-inbound-catalog.md) uses a real second SDK server and 20 repeated POSTs; it verifies response listeners do not accumulate.

## Design decisions

### D-mcp-inbound-http-transport

[2026-09-19] Use the repository-pinned TypeScript MCP SDK's stateful Streamable HTTP transport on the existing listener. Authenticate each HTTP request, fence transport handles to verified external identity and retain an ephemeral external context; neither ClientInfo nor the session header conveys internal Agent or Session authority. Start HTTP/Node bootstrap/WS if WebUI, Trigger or inbound MCP is enabled; create WebUIChannel only for WebUI/Trigger. The transport is bounded and in-memory, not a durable operation platform. The approved callable outbound MCP surface is owned by [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge).
