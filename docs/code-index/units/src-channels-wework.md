# Unit: src-channels-wework

Files: src/channels/weworkChannel.ts, src/channels/weworkStreamAggregator.ts, src/channels/weworkChannel.test.ts, src/channels/weworkStreamAggregator.test.ts

## Purpose

Implements a WeChat Work (Enterprise WeChat) channel that supports legacy group bot webhooks, intelligent-bot callback handling, opt-in stream-card aggregation, and optional intelligent-bot WebSocket long-connection mode. The channel can aggregate assistant/model broadcasts plus structured LLM/tool progress into one WeWork stream reply when `aibot.stream` is configured, while preserving old webhook behavior by default.

## Key Exports

- `WeWorkWebhookChannel` — class implementing the `Channel` interface for WeChat Work.
- `WeWorkWebhookConfig` — alias of the canonical `WeWorkConfig` type from `src/config.ts`; includes optional legacy/group `webhookUrl`, callback `token`/`encodingAESKey`/listen settings, `selfName` for command mention stripping, `aibot.stream`, and optional `aibot.websocket` credentials.
- `isWeWorkChannelConfigReady()` — readiness helper accepting any of: legacy group webhook URL, intelligent-bot short callback listener + crypto config, or WebSocket botId/secret.
- `WeWorkStreamAggregator` — channel-local helper that owns stream-card text/tool-progress block state keyed by stream id and latest conversation, renders WeWork `msgtype: stream` responses, clamps content to WeWork limits, and TTL-cleans old state.
- `buildWeWorkStreamResponse()` / `truncateUtf8()` — helper exports for stream response rendering and byte-limit enforcement.

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `WeWorkCrypto.constructor(token, encodingAESKey)` | early | Initializes AES key from base64 EncodingAESKey |
| `WeWorkCrypto.decryptCallbackMessage(encryptedMsg)` | early | Decrypts encrypted callback payload and extracts plaintext JSON/XML |
| `WeWorkCrypto.decryptAttachment(buffer)` | early | Decrypts encrypted webhook-mode attachments with callback EncodingAESKey |
| `WeWorkCrypto.encryptCallbackMessage(plaintext, timestamp, nonce)` | early | Encrypts passive callback replies for intelligent-bot short-connection mode |
| `WeWorkCrypto.verifySignature(signature, timestamp, nonce, encryptedMsg)` | early | Verifies SHA1 callback signatures |
| `isWeWorkChannelConfigReady(config)` | early | Runtime/config gating for webhook, pure callback, or WebSocket mode |
| `WeWorkWebhookChannel.constructor(config, name?)` | early | Initializes webhook URL, crypto, stream aggregator, WebSocket config, and optional HTTP listener from the canonical channel config object |
| `WeWorkWebhookChannel.setupWebhookListener(port, path)` | early/mid | Creates Express GET verification and POST callback handlers |
| `WeWorkWebhookChannel.connectWebSocket()` | mid | Opens optional intelligent-bot long connection and subscribes with botId/secret |
| `WeWorkWebhookChannel.sendWebSocketCommand(...)` | mid | Sends WebSocket commands, waits for same-`req_id` ack, serializes repeated callback-req-id stream updates, and rejects on errcode/timeout/close |
| `WeWorkWebhookChannel.handleWebSocketMessage(data)` | mid | Routes `aibot_msg_callback` / event callbacks and command acks |
| `WeWorkWebhookChannel.normalizeInboundBody(req)` | mid | Parses XML or JSON callback bodies, decrypting if needed |
| `WeWorkWebhookChannel.processInboundBody(body, delivery, isAIBot)` | mid | Converts webhook/long-connection callbacks into channel messages, deduplicates msgid, and starts a stream when configured |
| `WeWorkWebhookChannel.handleAIBotStreamRefresh(body)` | mid | Handles short-connection `msgtype=stream` refresh polls by stream id |
| `WeWorkWebhookChannel.buildInboundMessageParts(body, channelUserId, webhookUrl, opts)` | mid | Converts inbound text/image/file/mixed/voice messages into `MessagePart[]` |
| `WeWorkWebhookChannel.downloadInboundMedia(options)` | mid | Downloads direct-url or media_id assets and decrypts with per-resource `aeskey` or callback EncodingAESKey |
| `WeWorkWebhookChannel.sendMessage(userId, text, options)` | late | Sends through explicit stream aggregation, WebSocket proactive send, or legacy webhook depending on config/options |
| `WeWorkWebhookChannel.maybeAggregateStreamMessage(userId, text, options)` | late | Applies broadcast text or progress to the latest card in the target conversation, using `options.weworkStreamId` only as a missing-state fallback |
| `WeWorkWebhookChannel.normalizeChannelTurnProgress(value)` | late | Validates generic router progress payloads before passing them to the stream aggregator |
| `WeWorkWebhookChannel.pushWebSocketStream(snapshot)` | late | Pushes stream updates through `aibot_respond_msg` in long-connection mode |
| `WeWorkWebhookChannel.postWebhookPayload(webhookUrl, payload, userId, meta)` | late | Posts legacy/group webhook payloads with retry/error logging |
| `WeWorkWebhookChannel.uploadMedia(webhookUrl, file)` | late | Uploads a file to legacy/group webhook media API and returns media_id |
| `WeWorkWebhookChannel.sendFile(userId, file, options)` | late | Sends image/file via legacy/group webhook APIs |
| `WeWorkWebhookChannel.sendMarkdown()` / `sendTextWithMentions()` / `sendImage()` / `sendNews()` | late | Convenience send helpers for legacy/group webhook messages |
| `WeWorkStreamAggregator.begin(conversationId, delivery, streamId?)` | helper | Starts a new stream and makes it the latest card for the conversation |
| `WeWorkStreamAggregator.supersedeActive(conversationId)` | helper | Removes transient tool/thinking blocks from the prior active card, preserves substantive text, and finishes it |
| `WeWorkStreamAggregator.appendByStreamId(streamId, text, options)` | helper | Adds a model/tool section to the turn-bound stream and optionally marks it finished |
| `WeWorkStreamAggregator.applyProgressByStreamId(streamId, progress)` | helper | Updates the stream tool status line for LLM-start, tool-call-start, and batch tool-call-finish events |
| `WeWorkStreamAggregator.getByStreamId(streamId)` | helper | Looks up the latest stream snapshot for WeWork refresh callbacks |
| `WeWorkStreamAggregator.cleanupExpired(now?)` | helper | TTL cleanup for old stream states to prevent unbounded maps |

## Dependencies

- `../channel` — `Channel`, `ChannelContext`, `ChannelFile`, `ChannelMessage`, `ChannelSendFileOptions` interfaces.
- `../channelFiles` — `buildSavedFileText`, `saveInboundChannelFile` for persisting inbound files.
- `../common` — `logger` for structured logging.
- `../types` — `MessagePart` type.
- `ws` — optional intelligent-bot long-connection client.
- `./weworkStreamAggregator` — stream-card state and response rendering.

## Behavior

- Outbound messages are sent through the latest active WeWork card for a source-bound conversation, WebSocket `aibot_send_msg`, or a configurable legacy/group webhook URL.
- The channel constructor accepts the canonical WeWork config object directly (plus optional instance id/name). Runtime startup should not manually copy fields into another per-channel config interface.
- Inbound messages are received through an optional Express server that handles WeWork encrypted XML/JSON callback protocol (AES-256-CBC decryption, SHA1 signature verification, and encrypted passive replies when needed).
- Inbound AIBot/webhook metadata is logged at info level without full message content or secrets: delivery mode, msg id/type, aibot id, chat/conversation id, chat type, sender userid, derived username, source of username, and response-url/stream flags. WebSocket command acks log req id, command, and errcode/errmsg.
- When `aibot.stream: true` and an intelligent-bot callback (`response_url`/`aibotid` or WebSocket callback) arrives, the channel cleanly supersedes the prior active card in that conversation and starts a latest card whose initial content is `🤔 thinking`. The old card retains substantive model text, drops transient thinking/tool status, and finishes with the existing legal non-empty completion fallback when otherwise empty. Subsequent source-bound broadcasts resolve the latest card by conversation before using their serialized stream ID fallback. Broadcasts that target another WeWork conversation/channel are skipped instead of falling back to legacy webhook send.
- Optional `selfName` is passed through `ChannelContext.selfName`, letting the message router strip a leading `@selfName` plus whitespace before slash-command parsing. This supports WeWork mentions with non-ASCII bot names without broadening the legacy ASCII mention regex.
- If the session is already busy, the inbound callback can still return a new passive stream card immediately. Compatible same-conversation input may join the active tool loop at the next provider safe point, and ongoing progress/final delivery moves to that latest card.
- Compatible input that arrives while a no-tool provider request is in flight is consumed at Router's pre-final safe point. Router publishes non-empty text as a generic non-final intermediate to other eligible external attachments, but excludes the current WeWork stream just as it does for text preceding tool calls; the continued provider response owns this card's visible final.
- `channelTurnProgress` broadcast options from the router update the same stream card in place: `llm-start` shows `🤔 thinking`, `tool-calls-start` adds `⌛️ tool`, and `tool-calls-finish` changes tools to `☑️`/`❌` in batch after `executeTools` returns. `tool-calls-start` may include model text, allowing the stream aggregator to render model text and running tool status in one card snapshot before tool execution finishes. No-op progress updates (for example an initial `llm-start` when the card already says `🤔 thinking`) are not pushed again.
- Intelligent-bot short-connection callback streaming does not require `response_url`; a callback identified as AIBot can return the passive `msgtype: stream` response and serve later stream refresh polls by stream id.
- In webhook/short-connection mode, the initial callback returns a passive `msgtype: stream` payload and later `msgtype=stream` refresh callbacks pull snapshots by stream id, including the clean final retained for a superseded card. In WebSocket/long-connection mode, superseding best-effort pushes one clean old final with its saved callback `req_id`; failures are logged without retry/outbox, and ongoing updates use the latest card.
- Callback `msgid` values are deduplicated for a short TTL so WeWork retries do not enqueue duplicate turns or split duplicate stream cards. Stream state also has TTL cleanup and content is clamped to WeWork’s 20480-byte stream limit.
- Optional `aibot.websocket.enabled` mode connects to `wss://openws.work.weixin.qq.com` (or configured URL), subscribes with botId/secret, handles heartbeats/reconnects, and routes `aibot_msg_callback` to the same channel pipeline without requiring a public webhook URL.
- Supports multiple inbound message types: text, image, file, mixed, and voice. Intelligent-bot long-connection media uses per-resource `aeskey` when present instead of the callback EncodingAESKey.
- Uses `chatId` as the conversation identifier so each group chat or DM gets an independent channel context.
- New stream/WebSocket behavior is opt-in; without `aibot.stream` / `aibot.websocket` configuration, legacy WeWork sends and callbacks remain unchanged.

## Integration

- Implements the `Channel` interface, making it pluggable into the system's multi-channel message routing.
- Inbound messages are dispatched to the registered `messageHandler` callback (set via `onMessage`), which connects to the core conversation/agent pipeline.
- File handling integrates with the shared `channelFiles` module for consistent file storage across channels.
- The channel exposes `weworkStreamId` on `ChannelContext`; `MessageRouter` persists it in `QueueSource`, and `session/channels.createSessionBroadcast()` passes it back as a missing-state fallback. Live delivery is conversation-latest as defined by [D-channel-conversation-latest-passive-context](../modules/channels.md#d-channel-conversation-latest-passive-context).
