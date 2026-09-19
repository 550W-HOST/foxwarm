# Unit: src-mcp-inbound-http

Files: `src/mcpInboundHttp.ts`, `src/mcpInboundHttp.test.ts`, `src/mcpInboundStartup.test.ts`
Secondary files: `src/index.ts`, `src/httpServer.ts`, `src/config.ts`, `src/mcpInboundConfig.ts`

## Purpose

Owns inbound MCP Streamable HTTP lifecycle on the existing Main HTTP listener. It authenticates each request from configuration, binds an opaque server-generated transport ID to one verified external principal and one ephemeral external execution context, and hosts an explicitly unwired tool catalog. It does not construct a Foxwarm Agent or internal Session, invoke Node tools, forward outbound MCP, or access Session messages.

## Key exports

- `McpInboundHttpService.register(httpServer)` — registers only `/mcp` POST, GET and DELETE. The shared JSON parser skips `/mcp`: an exact-path inbound Bearer guard runs before a dedicated 64 KiB JSON parser. Parsing errors are sanitized without echoing request bytes, and the pinned MCP SDK receives parsed bodies. These routes bypass the *instance* token middleware to apply their own mandatory request-level inbound Bearer check instead.
- `McpInboundHttpService.stop()` — fences new requests and closes active SDK transports and SSE streams without claiming that any already-started external effect was reversed.
- `ExternalExecutionContext` — one per authenticated MCP transport; immutable generated ID/external identity, mutable selected Node (initially `master`) and cwd (initially `null` meaning no explicit cwd). The current transport/catalog has no Node operation that changes these fields; an injected test catalog can verify continuity.
- `McpInboundCatalog` — explicit trusted service injection point for future resolved, authorized tool adapters. The normal application deliberately provides no catalog: `tools/list` is empty and `tools/call` does not claim success. Test catalogs supply synthetic tools, not public Foxwarm Node/Session tool registrations.

## Request lifecycle

1. Authenticate one explicit Authorization header on every request. ClientInfo, arguments, cookies and the instance token cannot identify a caller; reject ambiguous headers, foreign Origin, or unknown/cross-identity MCP session IDs before giving requests to the SDK.
2. POST without session ID must initialize; the server allocates a random UUID and a context once for this transport, then connects a pinned SDK v1.27.1 `Server` and `StreamableHTTPServerTransport`. Subsequent requests reuse the exact transport/context; GET SSE and DELETE have the same identity fence. A fresh initialization gets a distinct ID, and another external identity cannot adopt an ID. A request carrying both the same identity token and an existing opaque session ID is treated as a legitimate reconnect; this transport does not provide a separate device-binding secret.
3. The SDK validates JSON-RPC, protocol version, Content-Type and Accept, provides JSON POST responses and one GET SSE stream per transport. The HTTP compression middleware excludes `/mcp` so SSE headers/data flush. Unbounded SSE is not used for POST responses. No EventStore/resumption is advertised.
4. Limits are 32 simultaneous live contexts including pending initialization, four concurrent requests per transport, 15-minute inactivity expiry plus a check before serving each request, 60-second POST deadline, 64 KiB parsed body and catalog/result output, and 64 returned tools. Expiry, DELETE, or process shutdown close transports; HTTP client disconnect alone does not cancel effects or imply a new context. Active GET SSE closes on socket disconnect or expiry.
5. Current context/transport state is in process memory only. After Main restart IDs are invalid and no background result recovery is promised. A later execution integration must preserve identity and result ownership without turning this into an Agent or internal Session.

## Tests

Real pinned SDK clients initialize, list an injected synthetic catalog, invoke synthetic tools, keep Node/cwd state on one transport, and demonstrate independent identities. Raw HTTP requests cover missing credentials, wrong-identity POST/GET/DELETE, hostile ClientInfo/args, instance cookie, Origin, owner-bound DELETE, GET SSE reconnect, idle expiry, malformed initialization, request/result caps, and abort on POST deadline. A full Main fixture with WebUI/Trigger disabled verifies `/mcp`, Node bootstrap files, authenticated Node WebSocket, absence of WebUI setup route and an empty production tool catalog.

## Design decisions

### D-mcp-inbound-http-transport

[2026-09-19] Use the repository-pinned TypeScript MCP SDK's stateful Streamable HTTP transport under a single existing Foxwarm HTTP listener. Every POST/GET/DELETE separately authenticates an inbound ID and fences the transport handle to that ID. One transport owns one server-generated external execution context; neither the client session header nor ClientInfo conveys Agent/Session authority. Start HTTP/Node bootstrap/Node WebSocket when WebUI, Trigger or MCP inbound is enabled; create WebUIChannel only for WebUI/Trigger. Register no real Foxwarm model-facing tools before concrete discovery, authorization, execution and result ownership are wired. The connection, SSE, request and output limits are intentionally bounded and ephemeral rather than a durable operation platform.
