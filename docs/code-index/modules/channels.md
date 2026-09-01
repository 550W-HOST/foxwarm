# Module: channels

## Responsibility

Owns the platform-neutral channel contract/registry/authorization/runtime plus Matrix, Telegram, QQ Bot, Weixin, WeChat Work, TUI, and WebUI adapters. Each adapter converts native input into `ChannelContext`/`ChannelMessage` and sends replies without exposing platform details to the router.

## Units

- [src-channel-core](../units/src-channel-core.md) — contract, registry, authorization, inbound file storage, and managed lifecycle.
- [src-channels-misc](../units/src-channels-misc.md) — Matrix, Telegram, and Weixin adapter classes.
- [src-channels-tui](../units/src-channels-tui.md) — blessed terminal channel.
- [src-channels-webui](../units/src-channels-webui.md) — authenticated HTTP/SSE/upload/setup/terminal WebUI surface.
- [src-channels-wework](../units/src-channels-wework.md) — WeChat Work webhook/callback/WebSocket modes and opt-in conversation-latest stream cards.
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
- Managed ordinary-text channel instances may opt into bounded in-memory tool progress with `channelProgress.intervalMs`; WebUI and the active WeWork stream-card target are excluded.

## Adapter-specific invariants

- WeWork stream aggregation is opt-in and routes ongoing progress/final delivery to the latest card in one configured instance and conversation. WebSocket mode is separately configured.
- Conversation-latest passive context advances at valid adapter ingress before Router authorization. In a shared multi-sender conversation, a rejected inbound may therefore advance the passive reply/card association even though its content does not enter the session queue or model history; no per-sender card recovery state is maintained.
- Weixin context tokens are in-memory per user; a new inbound message is required after token loss. QR login sessions expire after five minutes.
- WebUI `sendFile` is intentionally a no-op because the browser uses authenticated downloads/tool metadata.
- QQ Bot C2C/group attachments use an authorization-gated, bounded inbound
  spool/materializer. Main-hosted saves use the path boundary; isolated or
  bound-node saves reuse the existing whole-buffer node boundary only up to a
  fixed 10 MiB attachment cap. Direct video/voice are generic saved
  descriptors and nested attachments remain deferred. C2C/group `sendFile`
  uses the destination-specific direct-small or streamed-large official upload
  flow. Guild/DM media and remote URL send remain unsupported.

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

### D-channel-ordinary-text-progress

[2026-09-01] Ordinary-text tool progress is a generic per-channel-instance presentation option, configured as `channelProgress: { intervalMs }` with a 30,000–1,800,000 ms bound; omission or `false` disables it. Main owns one transient in-memory coordinator keyed by turn, channel instance, and conversation. It consumes only provider-neutral top-level tool start/finish facts, stores bounded sanitized names/counts/running call IDs, uses fixed non-sliding per-target timers, and never writes Session history, archives, catalog state, or recovery data.

Each target has an independent interval and report baseline. A due timer sends a best-effort standalone summary when starts are new or tools remain running. Before ordinary intermediate/final/stop/error text is delivered, that target's unreported summary is prepended and only its baseline is consumed; a terminal turn with pending activity and no ordinary text gets one final standalone flush. Delivery failure cannot poison the semantic turn, and reload/terminal cleanup plus a TTL fence remove stale timers. Explicit tool-owned channel sends, file delivery, typing, WebUI realtime/history, and canonical model content bypass decoration. Active WeWork stream-card delivery remains native and receives no duplicate text fallback; non-stream WeWork and other configured ordinary-text targets use the common path. Source-bound QQ delivery metadata remains attached to progress and decorated turn text.

The exact builtin tool name `wait` is presentation-silent for this fallback: its start/result is excluded from counts, running state, timers, heartbeats, prepends, and terminal flushes. This does not match aliases or suffixes and does not change the tool's Session wait semantics.

### D-channel-conversation-latest-passive-context

QQ Bot message IDs and WeWork stream-card IDs are adapter-local passive-delivery
context, not Router turn boundaries. Within one configured channel instance and
scoped conversation, the latest inbound context owns subsequent typing,
progress, and final delivery. QQ Bot keeps a bounded in-memory latest-message
map and uses the serialized source ID only when that live context is missing.
WeWork supersedes the previous active card, preserves its substantive model
text while removing transient thinking/tool status, and finishes it before
routing ongoing updates to the latest card. Different instances or
conversations never share passive context. This policy adds no delivery ledger,
outbox, or persisted adapter state.

### D-channel-file-descriptor

[2026-08-15] Current inbound attachment context uses one self-closing metadata line with ordered, XML-escaped attributes: images write `<foxwarm-image name="..." node="..." path="..." />`; generic files write `<foxwarm-file name="..." node="..." path="..." mime="..." />`. Every attribute uses the shared Foxwarm attribute normalization/escaping boundary, so quotes, ampersands, angle brackets, controls, and newlines cannot alter the tag grammar. A caption/body remains ordinary text before the descriptor with the existing blank-line separation. The descriptor reports node plus path without prescribing a tool or assuming every file is text. WebUI optimistic previews use the same tag formatter but omit node/path until canonical server reconciliation rather than exposing the temporary upload spool. Existing persisted bracket descriptors require no special handling: they remain ordinary message text and are neither parsed nor migrated.

### D-channel-current-group-trigger-metadata

[2026-08-16] A channel adapter may provide an ephemeral structured metadata
part when it has a reliable native signal about the **current** group trigger.
The Router detects slash commands from the original user text first, then
places the metadata part inside the canonical direct-channel
`<foxwarm-message>` wrapper so the tag survives queueing, Worker serialization,
history, provider formatting, and authorization-gated media materialization
without persisting a parallel flag. A command receives neither the metadata as
arguments nor a queued metadata row. Channels without a reliable signal emit
nothing and must not guess `false`.

QQ group ingress uses exactly:

- Mention trigger: `<foxwarm-metadata kind="group-message" mentioned="true" hint="The current group message explicitly mentioned this agent." />`
- Ordinary trigger: `<foxwarm-metadata kind="group-message" mentioned="false" hint="The current group message is ordinary group chat and did not mention this agent." />`

QQ treats the current trigger as mentioned only when the native event is
`GROUP_AT_MESSAGE_CREATE` or a bounded structured `mentions` entry has
`is_you === true`. The latter is authoritative for all-message mode, where QQ
can deliver a real self-mention as `GROUP_MESSAGE_CREATE`. `bot: true` alone,
content `<@...>` tokens, configured app IDs, READY identities, display names,
and learned/persisted IDs are not mention signals. Missing, malformed, or
false `is_you` remains an ordinary QQ group trigger.

The marker describes only the current trigger, never buffered/local/platform
history. It is lightweight direct-user metadata in WebUI, not a heavy system
card.

## Canonical ownership

Persisted attachment read-old/write-current behavior is canonical in [D-session-channels-read-old-write-current](../units/src-session-channels.md#d-session-channels-read-old-write-current).
