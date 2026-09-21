# Unit: src-channels-wework

Files: src/channels/weworkChannel.ts, src/channels/weworkStreamAggregator.ts, src/channels/weworkChannel.test.ts, src/channels/weworkChannelMediaSend.test.ts, src/channels/weworkStreamAggregator.test.ts

## Purpose

Implements a WeChat Work (Enterprise WeChat) channel that supports legacy group bot webhooks, intelligent-bot callback handling, opt-in stream-card aggregation, and optional intelligent-bot WebSocket long-connection mode. The channel can aggregate assistant/model broadcasts plus structured LLM/tool progress into one WeWork stream reply when `aibot.stream` is configured, while preserving old webhook behavior by default.

## Key Exports

- `WeWorkWebhookChannel` — class implementing the `Channel` interface for WeChat Work.
- `WeWorkWebhookConfig` — alias of the canonical `WeWorkConfig` type from `src/config.ts`; includes optional legacy/group `webhookUrl`, callback `token`/`encodingAESKey`/listen settings, `selfName` for command mention stripping, `aibot.stream`, and optional `aibot.websocket` credentials.
- `isWeWorkChannelConfigReady()` — readiness helper accepting any of: legacy group webhook URL, intelligent-bot short callback listener + crypto config, or WebSocket botId/secret.
- `WeWorkStreamAggregator` — channel-local helper that owns stream-card text/tool-progress block state keyed by stream id and latest conversation, wraps process content in the `<think>` fold with the answer body after it, renders WeWork `msgtype: stream` responses, clamps content to WeWork limits, and TTL-cleans old state.
- `buildWeWorkStreamResponse()` / `truncateUtf8()` — helper exports for stream response rendering and byte-limit enforcement.
- `stripWeWorkThinkTags()` / `normalizeWeWorkThinkFrameStyle()` — exported fold helpers: tag removal for content that leaves the passive card, and the one place that resolves the configured frame style.

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
| `WeWorkWebhookChannel.handleAIBotStreamRefresh(body)` | mid | Handles short-connection `msgtype=stream` refresh polls by stream id, refreshing an unfinished card's TTL on each poll |
| `WeWorkWebhookChannel.buildInboundMessageParts(body, channelUserId, webhookUrl, opts)` | mid | Converts inbound text/image/file/mixed/voice messages into `MessagePart[]` |
| `WeWorkWebhookChannel.downloadInboundMedia(options)` | mid | Downloads direct-url or media_id assets and decrypts with per-resource `aeskey` or callback EncodingAESKey |
| `WeWorkWebhookChannel.sendMessage(userId, text, options)` | late | Sends through explicit stream aggregation, WebSocket proactive send, or legacy webhook depending on config/options |
| `WeWorkWebhookChannel.maybeAggregateStreamMessage(userId, text, options)` | late | Applies ordinary text or progress to the latest active card in the attachment conversation |
| `WeWorkWebhookChannel.normalizeChannelTurnProgress(value)` | late | Validates generic runner progress payloads before passing them to the stream aggregator |
| `WeWorkWebhookChannel.handleTurnLifecycle(userId, options)` | late | Closes an active card for a terminal empty delivery and leaves it open for a suspended turn |
| `WeWorkWebhookChannel.pushWebSocketStream(snapshot)` | late | Pushes stream updates through `aibot_respond_msg` in long-connection mode |
| `WeWorkWebhookChannel.postWebhookPayload(webhookUrl, payload, userId, meta)` | late | Posts legacy/group webhook payloads with retry/error logging |
| `WeWorkWebhookChannel.uploadMedia(webhookUrl, file)` | late | Uploads a file to legacy/group webhook media API and returns media_id |
| `WeWorkWebhookChannel.uploadWebSocketMedia(file)` | late | Validates, hashes, and sequentially uploads bounded image/file chunks through AIBot WebSocket init/chunk/finish commands |
| `WeWorkWebhookChannel.sendFile(userId, file, options)` | late | Selects explicit legacy override, configured AIBot WebSocket media delivery, or legacy-only image/file delivery |
| `WeWorkWebhookChannel.sendMarkdown()` / `sendTextWithMentions()` / `sendImage()` / `sendNews()` | late | Convenience send helpers for legacy/group webhook messages |
| `WeWorkStreamAggregator.begin(conversationId, delivery, streamId?)` | helper | Starts a new stream and makes it the latest card for the conversation |
| `WeWorkStreamAggregator.supersedeActive(conversationId)` | helper | Removes transient tool/thinking blocks from the prior active card, preserves substantive text as its visible body, and finishes it |
| `WeWorkStreamAggregator.appendByStreamId(streamId, text, options)` | helper | Adds a model/tool section to the turn-bound stream, optionally marking the appended section as the answer body that closes the fold |
| `WeWorkStreamAggregator.applyProgressByStreamId(streamId, progress)` | helper | Updates the stream tool status line for LLM-start, tool-call-start, and batch tool-call-finish events |
| `WeWorkStreamAggregator.getByStreamId(streamId)` | helper | Looks up the latest stream snapshot for WeWork refresh callbacks |
| `WeWorkStreamAggregator.touchByStreamId(streamId, now?)` | helper | Restarts an unfinished card's TTL window so in-flight polling cannot expire it |
| `WeWorkStreamAggregator.cleanupExpired(now?)` | helper | TTL cleanup for old stream states to prevent unbounded maps |

## Dependencies

- `../channel` — `Channel`, `ChannelContext`, `ChannelFile`, `ChannelMessage`, `ChannelSendFileOptions` interfaces.
- `../channelFiles` — `buildSavedFileText`, `saveInboundChannelFile` for persisting inbound files.
- `../common` — `logger` for structured logging.
- `../types` — `MessagePart` type.
- `ws` — optional intelligent-bot long-connection client.
- `./weworkStreamAggregator` — stream-card state and response rendering.

## Behavior

- Outbound messages are sent through an explicit stream binding, the latest unfinished WeWork card for ordinary text/progress in that conversation, the bounded adapter-local latest HTTP `response_url` for one non-stream terminal attachment delivery, WebSocket `aibot_send_msg`, or a configurable legacy/group webhook URL. Latest-card selection does not require turn/progress metadata: `turnFinal` only finishes the selected card, and `channelTurnProgress` only supplies structured progress content. A non-empty explicit `webhookUrl` suppresses automatic latest-card selection, but does not override an explicit stream ID carried by the request-level reply path. The adapter takes a terminal `response_url` before awaiting its send and does not cross-route after failure; ordinary proactive text and files prefer enabled WebSocket delivery unless the call supplies an explicit webhook override, which remains higher priority than the stored callback.
- The channel constructor accepts the canonical WeWork config object directly (plus optional instance id/name). Runtime startup should not manually copy fields into another per-channel config interface.
- Inbound messages are received through an optional Express server that handles WeWork encrypted XML/JSON callback protocol (AES-256-CBC decryption, SHA1 signature verification, and encrypted passive replies when needed).
- Inbound AIBot/webhook metadata is logged at info level without full message content or secrets: delivery mode, msg id/type, aibot id, chat/conversation id, chat type, sender userid, derived username, source of username, and response-url/stream flags. WebSocket command acks log req id, command, and errcode/errmsg.
- When `aibot.stream: true` and an intelligent-bot callback (`response_url`/`aibotid` or WebSocket callback) arrives, the channel cleanly supersedes the prior active card in that conversation and starts a latest card whose initial content is an empty fold (the `<think></think>` pair, or its unclosed form in the `open` frame style). The old card retains substantive model text as its visible body, drops transient thinking/tool status, and finishes with the existing legal non-empty completion fallback when otherwise empty. Subsequent automatic Session broadcasts resolve the latest card independently for each attached WeWork conversation. No serialized stream ID or source-targeted fallback is carried by the Session turn.
- Optional `selfName` is passed through `ChannelContext.selfName`, letting the message router strip a leading `@selfName` plus whitespace before slash-command parsing. This supports WeWork mentions with non-ASCII bot names without broadening the legacy ASCII mention regex.
- If the session is already busy, the inbound callback can still return a new passive stream card immediately. Any ordinary queued input may join the active tool loop at the next provider safe point, and ongoing progress/final delivery moves to that latest card.
- Ordinary input that arrives while a no-tool provider request is in flight is consumed at the runner's pre-final safe point. Non-final intermediate text and ordinary Session broadcasts update the latest unfinished card in the scoped WeWork conversation; after that card finishes or expires, text uses the existing proactive route.
- `channelTurnProgress` broadcast options from the runner update the same stream card in place: `llm-start` shows the running state, `tool-calls-start` adds running tools, and `tool-calls-finish` changes their statuses after `executeTools` returns. Within each tool block, entries with the same original tool name and status are counted in first-occurrence order (`☑️ exec ×3`), while a single call omits `×1`; status changes regroup the existing call IDs, and text blocks prevent aggregation across separate tool batches. `tool-calls-start` may include model text, allowing the stream aggregator to render model text and running tool status in one card snapshot before tool execution finishes. A tool block with no calls is only the transient placeholder and renders no card content, because the card's fold title already announces the thinking state; the live `🤔 thinking` marker remains inside a block that has real calls. No-op progress updates are not pushed again.
- The card body is separated from its process area: process text and tool lines stay inside the `<think>` fold, while the closing append for a terminal answer becomes the visible body after the closing tag. This presentation contract, including when a card stays open across a waiting turn, is [D-channel-wework-think-fold](../modules/channels.md#d-channel-wework-think-fold). A final frame with no folded process emits the answer alone, so a direct answer never renders under an empty fold, and a card closed without an answer keeps the legal non-empty completion fallback as its body.
- Folding has two frame styles, resolved once in `normalizeWeWorkThinkFrameStyle()` from `aibot.streamThinkFrame`: `closed` (the default and the requested frame shape) emits a complete pair in every frame, `open` closes the pair only in the final frame. Both keep the same process/body split. The documented label triggers make this one choice decide the card's title: a first frame with an unclosed `<think>` shows the running label, a later frame that introduces the closing tag shows the finished label, and a frame that already carries the complete pair shows the deep-thinking label instead, so the `closed` default deliberately trades the running-then-finished progression for the requested frame shape. Folded frames never place text before the opening tag, because the platform drops it.
- A card stays open across a turn that ends by waiting: `handleTurnLifecycle` ignores a suspended delivery (`turnSuspended`), so the resumed turn's progress and answer append to the same fold and the answer body closes it. Terminal endings still close it — a user Stop, an error, a retry-exhausted final, or an inbound turn superseding the card — so no card can be left permanently folded. A card whose state expires (or that a proactive downgrade bypasses) falls back to the existing proactive route.
- Content that leaves the passive card is tag-free: proactive markdown, WebSocket `aibot_send_msg`, and terminal `response_url` deliveries strip fold tags, because those routes render them literally.
- Frame assembly reserves room for the fold tags and a bounded answer body before truncating process content, so content-limit truncation can only cut inside the folded area or the answer tail and never drops the closing tag (which would leave the whole card permanently collapsed).
- Intelligent-bot short-connection callback streaming does not require `response_url`; a callback identified as AIBot can return the passive `msgtype: stream` response and serve later stream refresh polls by stream id.
- In webhook/short-connection mode, the initial callback returns a passive `msgtype: stream` payload and later `msgtype=stream` refresh callbacks pull snapshots by stream id, including the clean final retained for a superseded card. In WebSocket/long-connection mode, superseding best-effort pushes one clean old final with its saved callback `req_id`; failures are logged without retry/outbox, and ongoing updates use the latest card.
- Callback `msgid` values are deduplicated for a short TTL so WeWork retries do not enqueue duplicate turns or split duplicate stream cards. Stream state also has TTL cleanup, where each refresh poll restarts an unfinished card's TTL window, and content is clamped to WeWork’s 20480-byte stream limit.
- Optional `aibot.websocket.enabled` mode connects to `wss://openws.work.weixin.qq.com` (or configured URL), subscribes with botId/secret, handles heartbeats/reconnects, and routes `aibot_msg_callback` to the same channel pipeline without requiring a public webhook URL.
- In WebSocket mode, ordinary proactive text uses Markdown and file/image sends use bounded 512 KiB sequential temporary-media upload commands and proactive delivery to the same target; captions are separate same-route Markdown messages after upload. Dual configuration prefers WebSocket unless the call supplies an explicit `webhookUrl`, and selected WebSocket delivery never blindly retries through the webhook. See [D-channel-wework-aibot-proactive-delivery](../modules/channels.md#d-channel-wework-aibot-proactive-delivery).
- Supports multiple inbound message types: text, image, file, mixed, and voice. Intelligent-bot long-connection media uses per-resource `aeskey` when present instead of the callback EncodingAESKey.
- Uses `chatId` as the conversation identifier so each group chat or DM gets an independent channel context.
- New stream/WebSocket behavior is opt-in; without `aibot.stream` / `aibot.websocket` configuration, legacy WeWork sends and callbacks remain unchanged.

## Integration

- Implements the `Channel` interface, making it pluggable into the system's multi-channel message routing.
- Inbound messages are dispatched to the registered `messageHandler` callback (set via `onMessage`), which connects to the core conversation/agent pipeline.
- File handling integrates with the shared `channelFiles` module for consistent file storage across channels.
- The Channel exposes no stream-card reply receipt to `MessageRouter`, `QueueSource`, Worker RPC, or tool context. Stream IDs and non-stream `response_url` values remain adapter-local and are not serialized into Session/queue metadata. Automatic delivery is conversation-latest as defined by [D-channel-conversation-latest-passive-context](../modules/channels.md#d-channel-conversation-latest-passive-context).
