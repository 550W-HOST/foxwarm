# Unit: src-http-server

Files: src/httpServer.ts, src/httpServerAuth.test.ts

## Purpose

Provides a unified HTTP server with Express, WebSocket support, and token-based authentication (via cookie or Bearer header). Serves as the shared HTTP infrastructure for all channels in the system. It distinguishes admin auth (the instance token) from WebUI guest auth contexts supplied by a guest-token verifier.

## Key Exports

- `HttpServer` — class encapsulating Express app, HTTP server, WebSocket server, routing, and auth
- `HttpAuthContext` — discriminated auth context (`admin` or `guest` with bound `sessionIds`) exposed to WebUI route handlers
- `GuestTokenVerifier` — callback type used by WebUI to plug hashed guest-token verification into the shared server
- `httpServer` — singleton instance variable (initialized externally)
- `setHttpServer(instance)` — sets the singleton instance
- `HttpServerOptions` — interface for server configuration
- `RouteHandler` — interface describing a route definition
- `WebSocketHandler` — interface describing a WebSocket endpoint

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `HttpServer.constructor(port, token)` | ~43–56 | Initializes Express app, HTTP server, and WebSocket server |
| `setupMiddleware()` | ~58–80 | Configures compression, JSON parsing, and cookie parsing |
| `checkToken(req)` | ~90 | Validates the admin token from an Express request |
| `checkIncomingToken(req)` | ~95 | Validates the admin token from a raw HTTP incoming message |
| `setGuestTokenVerifier(verifier)` | ~100 | Installs/removes the async guest-token verifier used by WebUI |
| `getAuthContext(req)` / `getIncomingAuthContext(req)` | ~105 | Resolves admin or guest auth context from cookies/Bearer headers |
| `extractTokenFromHeaders(cookieHeader, authHeader)` | ~120 | Extracts `foxwarm_token`/legacy cookie or Bearer token before admin/guest classification |
| `parseCookieToken(cookieHeader)` | ~105–115 | Parses cookie string and extracts foxwarm_token or alphabot_token |
| `addRoute(route)` | ~117–133 | Registers an Express route with optional auth middleware and error handling |
| `authMiddleware(req, res, next)` | ~135–139 | Express middleware that rejects unauthorized requests with 401 |
| `addWebSocket(path, handler)` | ~141–144 | Registers a WebSocket handler for a given path |
| `setupWebSocketHandlers()` | ~146–165 | Handles HTTP upgrade events, routing to registered WebSocket handlers |
| `start()` | ~167–173 | Starts the HTTP server on the configured port |
| `stop()` | ~175–183 | Gracefully shuts down the HTTP server |
| `setHttpServer(instance)` | ~188 | Sets the module-level singleton |
| `withServer(fn)` (test) | ~5–13 | Test helper that creates, starts, and tears down a server |

## Dependencies

- `./common` — `logger` for structured logging

## Behavior

- Token auth checks cookies (`foxwarm_token`, `alphabot_token`) and `Authorization: Bearer` header. Admin routes require the stored instance secret; `auth: 'webui'` routes allow either admin or a guest context returned by the installed verifier.
- Routes can opt out of auth via `noAuth: true`.
- Admin-route middleware returns 403 for a valid guest token and 401 for missing/invalid auth; WebUI-route middleware returns 401 for missing/invalid auth.
- WebSocket upgrade requests are matched by path; unmatched connections are destroyed.
- Compression is enabled for all responses except streaming endpoints (`/stream`).
- Route handlers are wrapped in try/catch, returning 500 on unhandled errors.

## Integration

- Designed as a singleton (`httpServer` / `setHttpServer`) initialized in the application entry point (`index.ts`).
- Other modules register routes and WebSocket handlers via `addRoute` and `addWebSocket`, making this the central HTTP surface for web UI, triggers, and any other channel that needs HTTP/WS access.