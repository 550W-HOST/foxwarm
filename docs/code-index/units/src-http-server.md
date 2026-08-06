# Unit: src-http-server

Files: src/httpServer.ts, src/httpServerAuth.test.ts

## Purpose

Provides a unified HTTP server with Express, WebSocket support, and instance-token authentication via cookie or Bearer header. It serves as the shared HTTP infrastructure for all channels in the system. The current `testing` implementation has no guest-token verifier or guest-auth context API.

## Key Exports

- `HttpServer` — class encapsulating Express app, HTTP server, WebSocket server, routing, and auth
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
| `checkToken(req)` | ~80 | Validates the instance token from an Express request |
| `checkIncomingToken(req)` | ~85 | Validates the instance token from a raw HTTP incoming message |
| `checkTokenFromHeaders(cookieHeader, authHeader)` | ~90 | Checks the current cookie and then a Bearer token against the instance token |
| `parseCookieToken(cookieHeader)` | ~110 | Parses cookie text and extracts `foxwarm_token` |
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
- Routes can opt out of auth via `noAuth: true`.
- Authenticated route middleware returns 401 for missing or invalid auth.
- WebSocket upgrade requests are matched by path; unmatched connections are destroyed.
- Compression is enabled for all responses except streaming endpoints (`/stream`).
- Route handlers are wrapped in try/catch, returning 500 on unhandled errors.

## Design Decisions

### D-http-auth-cookie-name

[2026-08-06] Authenticated browser requests use only the `foxwarm_token` cookie. Bearer-token authentication is unchanged. Removed predecessor cookie aliases are not accepted as compatibility inputs.

## Integration

- Designed as a singleton (`httpServer` / `setHttpServer`) initialized in the application entry point (`index.ts`).
- Other modules register routes and WebSocket handlers via `addRoute` and `addWebSocket`, making this the central HTTP surface for web UI, triggers, and any other channel that needs HTTP/WS access.