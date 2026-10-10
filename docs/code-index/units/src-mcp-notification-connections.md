# Unit: src-mcp-notification-connections

Files: `src/mcpNotificationConnections.ts`, `src/mcpNotifications.test.ts`, `src/mcpNotificationsTestMain.ts`
Secondary files: `src/mcpClient.ts`, `src/mcpExternalService.ts`, `src/mcpInboundHttp.ts`, `src/mcpInboundSessionService.ts`, `src/channel.ts`, `src/sessionManager.ts`

## Purpose

Owns online, source-Session-scoped outbound MCP notification connections. The canonical cross-module contract is [D-dispatch-mcp-explicit-notifications](../threads/tool-dispatch.md#d-dispatch-mcp-explicit-notifications).

The bundled mcp-management explicit-reply reference (`skills/mcp-management/references/instance-replies.md`) documents setup, current-Session start, remote `reply: true`, explicit channel sends, and status/stop. It links authorization to `access-control` without changing this unit's online-only contract.

## Stable symbols

| Symbol | Responsibility |
| --- | --- |
| `MCP_NOTIFICATION_CAPABILITY` | Experimental `foxwarm/session-notifications` version-1 negotiation |
| `MCP_SESSION_MESSAGE_METHOD` | Custom `notifications/foxwarm/session_message` text notification |
| `MAX_MCP_NOTIFICATION_BYTES` | Text bound leaving room for ordinary Worker ingress provenance |
| `startMcpNotifications` | Deduplicated source/server connection setup, real GET readiness, extension filtering and standard ping keepalive |
| `getMcpNotificationStatus` | Receiving, disconnected, unavailable or stopped state from the current binding |
| `getMcpReceivingClient` | Reuse the source/server client for subsequent internal discovery and tool calls |
| `stopMcpNotifications` | Synchronous admission fence followed by best-effort DELETE and close |
| `closeMcpNotificationReceivers` | Close by source, configured server or Main lifetime |

## Behavior

- Main creates one in-memory binding per trusted source Session and configured server. Only explicit Streamable HTTP is supported. The caller supplies source liveness/permission checks and awaited ordinary input admission using the existing lightweight `external-input` provenance tag with configured server and endpoint; this module does not resolve a target from remote arguments.
- The installed SDK opens GET asynchronously after `notifications/initialized`. Start observes a successful GET response and verifies server extension support before enabling input or returning. GET body closure/error updates status independently of POST errors. A standard ping every five minutes retains the inbound service's existing 15-minute idle contract.
- The SDK's public fallback notification hook processes only the custom method, bounded text and endpoint fields. Standard logs, progress and resource events never become Session input. It does not replace SDK progress/cancellation handlers.
- Subsequent internal calls reuse the bound client without closing it. Calls with no trusted internal source retain existing short-lived HTTP/SSE or pooled stdio behavior. A failed/closed receiver does not silently recreate a context or repeat a tool effect.
- The SDK may reconnect the same GET context within its retry bounds. No EventStore or notification replay is added. Explicit start can replace a disconnected or unavailable context; old reply destinations are not carried over. Stop fences before asynchronous transport cleanup, and DELETE has a bounded cleanup timeout.
- Managed server changes, disable, source deletion and Main shutdown close bindings. Incoming input rechecks the live binding and source permission at the exact local/Worker admission boundary.

## Tests

Two independent Main service processes use separate data roots, ports and authentication with real SDK transports. Local and real supervised Worker owners exercise a completed JSON POST followed by explicit `send_to_channel`, a deliberately delayed GET readiness barrier, separate receiving Sessions, ignored unrelated/remote-target-spoof notifications, existing generic/manual-send and isolated own-attachment denial, unsubscribed reply rejection, stop/disable/deletion cleanup, the terminal Main receiver fence and stale destination rejection. Worker turns use the existing deterministic local fixture, not a model service. Ordinary remote assistant output is not forwarded, and Main's Worker catalog remains history-free.
