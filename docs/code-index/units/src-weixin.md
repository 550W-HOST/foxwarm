# Unit: src-weixin

Files: src/weixin/api.ts, src/weixin/inbound.ts, src/weixin/types.ts
Secondary files: THIRD_PARTY_NOTICES.md

## Purpose

Implements a Weixin (WeChat) messaging channel client, providing API communication (long-polling for updates, sending messages, typing indicators, QR code login), inbound message parsing into the application's internal `MessagePart` format, and shared protocol type definitions.

## Key Exports

- `getWeixinUpdates` — long-polls the Weixin server for new messages
- `sendWeixinMessage` — sends a message via the Weixin bot API
- `sendWeixinTyping` — sends a typing indicator
- `startWeixinQrLogin` — initiates a QR code login flow, returns QR URL
- `waitForWeixinQrLogin` — polls until QR login is confirmed or times out
- `buildWeixinMessageParts` — converts a `WeixinMessage` into `MessagePart[]`
- `setWeixinContextToken` / `getWeixinContextToken` — per-user context token store
- `WeixinApiOptions` — configuration interface for the API client
- `DEFAULT_WEIXIN_BASE_URL`, `SESSION_EXPIRED_ERRCODE` — constants
- `WeixinMessage`, `WeixinGetUpdatesResponse`, `WeixinSendMessageRequest`, `WeixinTypingRequest` — protocol types
- `WeixinMessageItemType`, `WeixinMessageType`, `WeixinMessageState` — enum-like constants

## Function Index

| Function | Lines (approx) | Description |
|----------|---------------|-------------|
| `readChannelVersion()` | ~30 | Reads version from package.json for protocol headers |
| `buildBaseInfo()` | ~40 | Constructs base_info payload with channel version |
| `ensureTrailingSlash(url)` | ~44 | Normalizes URL to have trailing slash |
| `randomWechatUin()` | ~48 | Generates random base64-encoded UIN header value |
| `redactToken(token)` | ~53 | Partially masks a token for logging |
| `buildHeaders(opts)` | ~59 | Constructs HTTP headers including auth and routing |
| `apiFetch(params)` | ~72 | Core POST request helper with timeout and error handling |
| `getWeixinUpdates(params)` | ~97 | Long-polls for inbound messages, handles abort gracefully |
| `sendWeixinMessage(params)` | ~119 | Sends a chat message to a user |
| `sendWeixinTyping(params)` | ~132 | Sends a typing status indicator |
| `fetchQrCode(baseUrl, botType, routeTag)` | ~163 | Fetches a new QR code for login |
| `pollQrStatus(baseUrl, qrcode, routeTag)` | ~177 | Long-polls QR scan/confirm status |
| `isLoginFresh(login)` | ~155 | Checks if an active login session is within TTL |
| `purgeExpiredLogins()` | ~159 | Removes stale entries from activeLogins map |
| `startWeixinQrLogin(params)` | ~200 | Orchestrates QR login initiation with session management |
| `waitForWeixinQrLogin(params)` | ~225 | Polls until login confirmed, expired, or timed out |
| `contextTokenKey(userId)` | ~10 (inbound) | Returns map key for context token store |
| `setWeixinContextToken(userId, token)` | ~13 (inbound) | Stores a context token for a user |
| `getWeixinContextToken(userId)` | ~17 (inbound) | Retrieves a stored context token |
| `isMediaItem(item)` | ~21 (inbound) | Checks if a message item is a media type |
| `bodyFromItemList(itemList)` | ~28 (inbound) | Extracts text body from item list, handling refs and voice |
| `buildWeixinMessageParts(message)` | ~50 (inbound) | Converts Weixin message to internal MessagePart array |

## Dependencies

- `../common` — `logger`
- `../config` — `BASE_DIR`
- `../types` — `MessagePart`

## Behavior

- **Long-polling**: `getWeixinUpdates` uses a 35s timeout and returns an empty response on abort rather than throwing.
- **QR login state**: Managed via an in-memory `Map<string, ActiveLogin>` with a 5-minute TTL. Expired sessions are purged on each new login attempt.
- **Context tokens**: Stored in-memory per user ID; used to maintain conversation continuity across polling cycles.
- **Inbound parsing**: Extracts text from TEXT or VOICE items and prepends quoted/referenced message content with the literal Unicode prefix `[\u5f15\u7528: ...]`. Media-only messages produce placeholder strings indicating unsupported types.
- **Headers**: Every request includes a random `X-WECHAT-UIN`, optional Bearer auth, and optional `SKRouteTag` for routing.

## Integration

- Consumed by the channel/transport layer to poll for messages and send replies within the bot's message loop.
- `buildWeixinMessageParts` bridges Weixin's protocol into the shared `MessagePart` type used by the core message processing pipeline.
- Context tokens allow the polling layer to resume from the correct offset after reconnection or restart.
- QR login functions are exposed for CLI or admin commands (`/weixin login`, `/weixin wait`).
- Adapted portions retain the full MIT notice for `@tencent-weixin/openclaw-weixin` v1.0.2 in the root third-party notices file, which is included by default in repository and npm source distributions.