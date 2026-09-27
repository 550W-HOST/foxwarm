# Unit: src-channels-misc

Files: src/channels/matrixChannel.ts, src/channels/telegramChannel.ts, src/channels/weixinChannel.ts

## Purpose

Implements three messaging platform channels (Matrix, Telegram, Weixin) that conform to the `Channel` interface, handling inbound message reception (text, images, files), outbound message/file sending, and platform-specific concerns like retry logic, typing indicators, and command routing.

## Key Exports

- `MatrixChannel` — Channel implementation for Matrix protocol using matrix-js-sdk
- `TelegramChannel` — Channel implementation for Telegram using Telegraf
- `WeixinChannel` — Channel implementation for Tencent Weixin using long-polling
- `WeixinChannelOptions` — Alias of the canonical `WeixinConfig` type from `src/config.ts`

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `MatrixChannel.constructor(config, name?)` | ~25–30 | Initializes Matrix client config and state from the canonical channel config object |
| `MatrixChannel.start()` | ~35–130 | Creates SDK client, registers timeline/membership handlers, starts sync |
| `MatrixChannel.stop()` | ~131–136 | Stops the Matrix client |
| `MatrixChannel.makeChannelContext(...)` | ~138–165 | Builds a ChannelContext with reply/sendTyping bound to a room |
| `MatrixChannel.markdownToHtml(...)` | ~167–174 | Basic markdown-to-HTML conversion for bold, italic, code, newlines |
| `MatrixChannel.sendMessage(...)` | ~176–190 | Sends a text message to a Matrix room |
| `MatrixChannel.sendFile(...)` | ~192–222 | Uploads and sends a file/image to a Matrix room |
| `MatrixChannel.sendTyping(...)` | ~224–226 | Sends typing indicator to a Matrix room |
| `MatrixChannel.onMessage(...)` | ~228–230 | Registers the inbound message handler |
| `MatrixChannel.getClient()` | ~232–234 | Returns the underlying matrix-js-sdk client |
| `sleep(ms)` | ~14 | Promise-based delay helper |
| `tgRetry(fn)` | ~16–30 | Retries Telegram API calls with backoff, skipping 400 errors |
| `TelegramChannel.constructor(config, name?)` | ~38–43 | Creates Telegraf bot instance from the canonical channel config object and sets up handlers |
| `TelegramChannel.setupHandlers()` | ~45–145 | Registers text, photo, and document handlers on the bot |
| `TelegramChannel.makeChannelContext(...)` | ~147–185 | Builds ChannelContext with Markdown-fallback reply logic |
| `TelegramChannel.start()` | ~187–210 | Registers bot commands and launches polling |
| `TelegramChannel.stop()` | ~212–215 | Stops the Telegraf bot |
| `TelegramChannel.sendMessage(...)` | ~217–235 | Sends text with Markdown fallback to plain text |
| `TelegramChannel.sendFile(...)` | ~237–272 | Sends photo or document with caption and parse mode fallback |
| `TelegramChannel.sendTyping(...)` | ~274–276 | Sends typing chat action |
| `TelegramChannel.onMessage(...)` | ~278–280 | Registers the inbound message handler |
| `TelegramChannel.onCommand(...)` | ~282–284 | Registers the command handler |
| `TelegramChannel.getBot()` | ~286–288 | Returns the Telegraf instance |
| `generateClientId()` | ~17 | Creates a random hex client ID for Weixin messages |
| `WeixinChannel.constructor(options, name?)` | ~30–38 | Stores canonical Weixin channel config options, applying runtime defaults |
| `WeixinChannel.start()` | ~40–51 | Validates token and starts the poll loop |
| `WeixinChannel.stop()` | ~53–64 | Aborts the poll loop |
| `WeixinChannel.sendMessage(...)` | ~66–84 | Sends a text message via Weixin API using cached context token |
| `WeixinChannel.sendTyping(...)` | ~86–104 | Sends typing indicator via Weixin API |
| `WeixinChannel.onMessage(...)` | ~106–108 | Registers the inbound message handler |
| `WeixinChannel.handleInboundMessage(...)` | ~110–143 | Parses inbound message, caches context token, dispatches to handler |
| `WeixinChannel.pollLoop(...)` | ~145–185 | Long-poll loop with error backoff and session expiry detection |

## Dependencies

- `../channel` — `Channel`, `ChannelContext`, `ChannelFile`, `ChannelMessage`, `ChannelSendFileOptions` interfaces
- `../channelFiles` — `buildSavedFileText`, `saveInboundChannelFile` for persisting inbound media
- `../types` — `MessagePart` type
- `../common` — `logger`
- `../commands` — `COMMANDS` registry (Telegram only, for bot command registration)
- `../weixin/api` — `getWeixinUpdates`, `sendWeixinMessage`, `sendWeixinTyping`, `SESSION_EXPIRED_ERRCODE`
- `../weixin/inbound` — `buildWeixinMessageParts`, `getWeixinContextToken`, `setWeixinContextToken`
- `../weixin/types` — `WeixinMessageState`, `WeixinMessageType`

## Behavior

- All three channels implement the same `Channel` interface: `start`, `stop`, `sendMessage`, `sendTyping`, `onMessage`.
- Constructors accept their platform's canonical config object from `src/config.ts` plus an optional channel instance id/name. Runtime/factory code should pass the config through instead of re-spelling individual fields, so new channel config keys do not need duplicated constructor plumbing.
- Matrix: uses matrix-js-sdk with event-based timeline listener; auto-joins rooms on invite; deduplicates events via a capped Set; skips events older than channel start time.
- Telegram: uses Telegraf polling; retries API calls up to 3 times with exponential backoff; falls back from Markdown to plain text on parse errors; registers slash commands from the shared `COMMANDS` registry; supports a separate `onCommand` handler.
- Weixin: uses HTTP long-polling in a loop; caches per-user context tokens required for replies; handles session expiry by throwing a fatal error; backs off on consecutive failures (2s then 30s).
- Inbound images/files are saved to disk via `saveInboundChannelFile` and converted to `MessagePart` arrays with inline base64 data (Matrix, Telegram).

## Integration

- Each channel is instantiated and managed by the application's channel orchestration layer, which calls `start()`/`stop()` and registers a unified `onMessage` handler to route messages into the conversation/agent system.
- The `ChannelContext.reply` and `sendTyping` closures allow downstream logic to respond without knowing platform specifics.
- Telegram's `onCommand` hook integrates with the shared command dispatch system (`../commands`).
- Weixin relies on a separate `../weixin/` module layer for API communication and message parsing, keeping protocol details out of the channel class itself.