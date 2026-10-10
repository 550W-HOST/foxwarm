# Unit: src-mcp-caller-connections

Files: `src/mcpCallerConnections.ts`, `src/mcpCallerConnections.test.ts`, `src/mcpNotifications.test.ts`, `src/mcpNotificationsTestMain.ts`
Secondary files: `src/mcpClient.ts`, `src/mcpExternalService.ts`, `src/mcpInboundHttp.ts`, `src/mcpInboundCatalog.ts`, `src/channel.ts`, `src/sessionManager.ts`

## Purpose

Owns the single caller/server HTTP connection lifecycle shared by ordinary MCP discovery/calls and opt-in Session notifications. The canonical cross-module contract is [D-dispatch-mcp-explicit-notifications](../threads/tool-dispatch.md#d-dispatch-mcp-explicit-notifications). The bundled mcp-management outbound and explicit-reply references document its user-facing lifecycle.

## Stable symbols

| Symbol | Responsibility |
| --- | --- |
| `McpConnectionOwner` | Trusted internal Session or verified inbound context identity plus lifetime predicate |
| `withMcpCallerConnection` | Coalesce setup, invoke once, track in-flight calls and release idle/anonymous connections |
| `closeMcpCallerConnections` | Fence and close by owner, configured server, notification producer or Main lifetime |
| `MCP_NOTIFICATION_CAPABILITY` | Existing experimental `foxwarm/session-notifications` version-1 support |
| `MCP_SESSION_MESSAGE_METHOD` | Custom `notifications/foxwarm/session_message` text notification |
| `MAX_MCP_NOTIFICATION_BYTES` | Text bound leaving room for ordinary Worker ingress provenance |
| `startMcpNotifications` | Enable reception on the owner's existing connection after peer/GET verification |
| `getMcpNotificationStatus` | Current reception state, distinct from ordinary connection reuse |
| `stopMcpNotifications` | Fence reception and terminate the entire caller/server context |

## Behavior

- Main stores one in-memory connection per owner kind, owner ID and configured server. The production facade derives owners from exact Sessions or verified inbound context objects, not remote tool arguments. Anonymous low-level HTTP operations are not pooled. Stdio retains its existing pool.
- Streamable HTTP, legacy SSE and auto discovery/calls share this owner map. A failed auto HTTP initialization is cleaned up before trying SSE. Concurrent requests share setup; active requests prevent ordinary idle cleanup, and late failed/closed setup cannot publish a usable connection.
- Ordinary connections terminate after 15 minutes idle. Successful managed server changes/disable, source deletion, inbound external-context disposal and Main shutdown close affected entries. Streamable HTTP uses SDK `terminateSession()` before close with a five-second DELETE cleanup timeout; unsupported DELETE is ignored during best-effort cleanup. SSE is closed without HTTP DELETE.
- Session-owned connections advertise version-1 support from initialization but do not deliver notifications until explicit start. External-context owners have no internal receiving Session and do not advertise that capability. A preinstalled fallback hook accepts only the custom bounded text/endpoint schema; logs, progress and resource events are not model input.
- Start resolves its configured server name exactly (missing or disabled names fail without ordinary-call fallback) and requires Streamable HTTP, peer support and an actual receiving GET. The SDK launches GET asynchronously after initialized; start does not treat POST completion as readiness. It enables the current connection without discarding previously selected remote Node/cwd/exec state. Unsupported reception leaves an otherwise usable ordinary context intact.
- The canonical call path refuses an advertised Foxwarm peer's `foxwarm_session` send with `reply:true` before invocation when local reception is disabled or no longer permitted. It does not intercept an unrelated third-party same-name tool without the capability. No new reception-control RPC or protocol version is introduced.
- Enabled reception uses a standard five-minute ping and is excluded from ordinary idle collection. Start, receive, official-reply preflight and ping await the canonical complete tool permission check, including legacy isolated exact rules. The connection binding is rechecked after asynchronous authorization; ordinary synchronous source/generic-policy fences remain at final local/Worker input admission. Inactive owners, including pre-move Session IDs, are terminated at the existing next-ping boundary rather than retained indefinitely. Main first fences this external input producer before tearing down Session owners; ordinary calls drain separately before final connection cleanup.
- GET closure updates reception status independently of POST/tool failures. SDK same-context reconnect does not provide replay. A closed/404 connection is not automatically retried; later calls may create a new context with default remote state. Stop closes the whole context and invalidates old reply targets.

## Tests

Two independent Main service processes use separate data roots, ports and real SDK HTTP transports. Local and real Worker owners cover POST-completed explicit replies, delayed GET readiness, separate receivers, existing send authorization/isolation, notification filtering and stop/disable/delete/shutdown fencing. Worker turns use the existing deterministic fixture without a model service.

The same fixtures prove more than 32 ordinary calls/discoveries use one context, distinct callers remain separate, normal-to-start preserves synthetic Node/cwd/exec state, unstarted official reply requests never reach the remote Session, and external forwarded calls retain their real inbound context owner. They count actual remote contexts after owner/config/disposal/shutdown cleanup and after more than 32 anonymous short-lived calls, and verify failure/404 does not replay an effect. SDK fakes separately cover coalesced setup/in-flight idle protection, closed setup, auto/SSE cleanup and non-Foxwarm same-name tools.

Regression fixtures use real create_agent/set_agent_isolated and move_session entry points to verify legacy reception revocation prevents remote admission, old moved owners DELETE at the next ping, and a missing notification server cannot bypass a real server's deny rule through fallback.
