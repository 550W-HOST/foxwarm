# Unit: src-http-server

Files: src/httpServer.ts, src/httpServerAuth.test.ts

## Purpose

Provides a unified HTTP server with Express, WebSocket support, and instance-token authentication via cookie or Bearer header. It serves as the shared HTTP infrastructure for all channels in the system. WebUI may install a scoped access-identity verifier; unrelated routes remain administrator-only by default.

## Key Exports

- `HttpServer` — class encapsulating Express app, HTTP server, WebSocket server, routing, and auth
- `httpServer` — singleton instance variable (initialized externally)
- `setHttpServer(instance)` — sets the singleton instance
- `HttpServerOptions` — interface for server configuration
- `RouteHandler` — interface describing a route definition; `auth: "webui"` opts selected routes into administrator/scoped WebUI identity access
- `WebSocketHandler` — interface describing a WebSocket endpoint

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `HttpServer.constructor(port, token)` | ~43–56 | Initializes Express app, HTTP server, and WebSocket server |
| `setupMiddleware()` | ~58–80 | Configures compression, JSON parsing, and cookie parsing |
| `checkToken(req)` | ~100 | Validates the administrator instance token from an Express request |
| `checkIncomingToken(req)` | ~105 | Validates the administrator instance token from a raw HTTP incoming message |
| `checkAdminTokenFromHeaders(cookieHeader, authHeader)` | ~130 | Checks administrator credentials in either the current cookie or a Bearer token |
| `getAuthContext(req)` / `getIncomingAuthContext(req)` | ~112 | Resolves administrator or verified scoped WebUI identity from request headers
| `parseCookieToken(cookieHeader)` | ~155 | Parses cookie text and extracts `foxwarm_token` |
| `addRoute(route)` | ~120 | Registers an Express route with optional auth middleware and error handling |
| `authMiddleware(req, res, next)` | ~140 | Rejects requests without the instance token with 401 |
| `addWebSocket(path, handler)` | ~150 | Registers a WebSocket handler for a given path |
| `setupWebSocketHandlers()` | ~155 | Handles HTTP upgrade events and routes them by exact path |
| `start()` | ~175 | Starts the HTTP server |
| `stop()` | ~185 | Gracefully shuts down the HTTP server |
| `setHttpServer(instance)` | ~200 | Sets or clears the module-level singleton |
| `withServer(fn)` (test) | ~5–13 | Test helper that creates, starts, and tears down a server |

## Dependencies

- `./common` — `logger` for structured logging

## Behavior

- Token auth checks the `foxwarm_token` cookie and the `Authorization: Bearer` header against the stored instance secret.
- Route registration supports GET, POST, PUT, PATCH and DELETE.
- Routes can opt out of auth via `noAuth: true`.
- Authenticated route middleware returns 401 for missing or invalid auth, and 403 when a scoped WebUI identity reaches an administrator-only route. The default route mode remains administrator-only; scoped WebUI authorization is explicit per WebUI route.
- `getAuthContext` and `getIncomingAuthContext` resolve the current cookie or Bearer token to an administrator or verified scoped WebUI identity context. The removed cookie alias stays unsupported. The standalone MCP authentication path remains independent and unaffected.
- WebSocket upgrade requests are matched by path; unmatched connections are destroyed.
- Compression is enabled for all responses except streaming endpoints (`/stream`).
- Compression also excludes the inbound MCP endpoint `/mcp`, which uses the SDK's GET SSE response stream and JSON POST responses. The shared JSON and cookie parsers skip `/mcp`, allowing the dedicated inbound Bearer check to precede its bounded parser; all other routes keep their prior middleware. Request-level Bearer authentication and Session-ID ownership for `/mcp` belong to [src-mcp-inbound-http](./src-mcp-inbound-http.md); its `noAuth: true` route only bypasses the unrelated instance-token middleware.
- Route handlers are wrapped in try/catch, returning 500 on unhandled errors.

## Design Decisions

### D-http-auth-cookie-name

[2026-08-06] Authenticated browser requests use only the `foxwarm_token` cookie. Bearer-token authentication is unchanged. Removed predecessor cookie aliases are not accepted as compatibility inputs.

## Integration

- Designed as a singleton (`httpServer` / `setHttpServer`) initialized in the application entry point (`index.ts`).
- Other modules register routes and WebSocket handlers via `addRoute` and `addWebSocket`, making this the central HTTP surface for web UI, triggers, and any other channel that needs HTTP/WS access.