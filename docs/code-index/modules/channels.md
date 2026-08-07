# Module: channels

## Responsibility

Owns the platform-neutral channel contract/registry/authorization/runtime plus Matrix, Telegram, QQ Bot, Weixin, WeChat Work, TUI, and WebUI adapters. Each adapter converts native input into `ChannelContext`/`ChannelMessage` and sends replies without exposing platform details to the router.

## Units

- [src-channel-core](../units/src-channel-core.md) — contract, registry, authorization, inbound file storage, and managed lifecycle.
- [src-channels-misc](../units/src-channels-misc.md) — Matrix, Telegram, and Weixin adapter classes.
- [src-channels-tui](../units/src-channels-tui.md) — blessed terminal channel.
- [src-channels-webui](../units/src-channels-webui.md) — authenticated HTTP/SSE/upload/setup/terminal WebUI surface.
- [src-channels-wework](../units/src-channels-wework.md) — WeChat Work webhook/callback/WebSocket modes and opt-in turn-bound stream cards.
- [src-channels-qqbot](../units/src-channels-qqbot.md) — official QQ Bot gateway text ingress and REST delivery.
- [src-weixin](../units/src-weixin.md) — Weixin polling/send/QR-login protocol helpers.

Persisted conversation attachments and broadcast selection are owned by [session channels](../units/src-session-channels.md).

## Public interfaces

- `Channel`, `ChannelContext`, `ChannelMessage`, `ChannelFile`, `MessageSource`.
- `registerChannel`, `unregisterChannel`, `getChannelInstance`, `listRegisteredChannels`.
- `getChannelId`, `getChannelType`, `getConversationId`.
- authorization inspection/formatting functions.
- inbound channel/session file save and descriptor functions.
- `initializeChannelRuntime`, per-channel start/stop/restart, `reloadManagedChannels`, and status queries.
- WebUI settings and Weixin QR-login helpers.

## Identity vocabulary

- `channelType` — adapter/platform type such as `telegram` or `weixin`.
- `channelInstanceId` / configured channel ID — one registered configured instance.
- `conversationId` — room/chat/direct target inside that instance.
- `senderId` — actual sending user where available.
- `channelTargetId` — direct-send string `<channel-instance-id>:<conversation-id>`.

`platform` and `channelUserId` remain narrow interface/history compatibility fields; new code should not confuse the latter with sender identity.

## Runtime behavior

- Normalized config permits multiple instances per type and passes each adapter its canonical config object plus instance ID.
- `reloadManagedChannels` stops all current managed Telegram/Matrix/WeWork/Weixin/QQ Bot instances, rebuilds factories from config, and starts every enabled/configured instance.
- Registry IDs are unique across adapter types.
- Internal WebUI/TUI pass channel authorization; external sources require allowlist or explicit per-attachment allow-all-users.
- Inbound files go to the agent's master `.temp/channel-files` area unless an isolated session targets its bound remote node. Descriptors report node and path without prescribing a file tool.
- Session broadcast is fire-and-forget; platform send failures are logged. `turnFinal` is a generic completion option that platform adapters may consume.

## Adapter-specific invariants

- WeWork stream aggregation is opt-in and keyed by explicit turn `weworkStreamId`; concurrent queued turns cannot steal another card. WebSocket mode is separately configured.
- Weixin context tokens are in-memory per user; a new inbound message is required after token loss. QR login sessions expire after five minutes.
- WebUI `sendFile` is intentionally a no-op because the browser uses authenticated downloads/tool metadata.
- QQ Bot C2C/group attachments use an authorization-gated, bounded inbound
  spool/materializer on the Main host; guild/DM media and outbound media
  remain outside the adapter's current supported surface. Isolated/bound-node
  QQ media is deferred and explicitly rejected until a streaming node
  transfer boundary exists.

## Compatibility

- Stored `push-only` attachment mode reads as current `send-only`; current writes use `send-only`.
- Stored allow-all-group-members reads as current allow-all-users; no runtime getter/setter alias exists.
- Supported source-history wrappers and `platform`/`channelUserId` remain readers for existing persisted messages/integrations.

## Design decisions

### D-channel-identity-vocabulary

Keep adapter type, configured instance, conversation target, and actual sender as separate concepts. Direct delivery accepts one `channelTargetId` rather than ambiguous legacy argument names.

### D-channel-multiple-instances

One adapter type may have multiple configured instances. Runtime constructs each from the canonical config object plus instance ID.

### D-channel-managed-reload

Configuration reload restarts the complete managed channel set; it is not a field-level unchanged-instance diff.

### D-channel-fire-and-forget-broadcast

Session broadcast has no aggregate failure promise. It dispatches to eligible channels, logs asynchronous errors, and carries generic turn metadata.

### D-channel-turn-bound-wework-stream

WeWork progress/final updates require the explicit inbound turn stream ID. Latest-conversation state is advisory and never authority for a concurrent turn.

### D-channel-file-descriptor

Inbound file context reports node plus path and does not instruct the agent to use a specific tool or assume every file is text.

## Canonical ownership

Persisted attachment read-old/write-current behavior is canonical in [D-session-channels-read-old-write-current](../units/src-session-channels.md#d-session-channels-read-old-write-current).
