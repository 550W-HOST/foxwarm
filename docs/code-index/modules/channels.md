# Module: channels

> Current .NET common channel and Telegram behavior is mapped in [external channels](../units/dotnet-external-channels.md); [Matrix/Weixin](../units/dotnet-matrix-weixin.md) and [WeWork](../units/dotnet-wework.md) have transport-specific maps; [QQ Bot](../units/dotnet-qqbot.md) maps gateway and media execution.
>
> TypeScript Main compatibility/reference map. The active .NET Main architecture is mapped in the [overview](../overview.md); these contracts do not by themselves establish .NET runtime support.

## Responsibility

Owns the platform-neutral channel contract/registry/authorization/runtime plus Matrix, Telegram, QQ Bot, Weixin, WeChat Work, TUI, and WebUI adapters. Each adapter converts native input into `ChannelContext`/`ChannelMessage` and sends replies without exposing platform details to the router.

## Units

- [src-channel-core](../units/src-channel-core.md) — contract, registry, authorization, inbound file storage, and managed lifecycle.
- [src-channels-misc](../units/src-channels-misc.md) — Matrix, Telegram, and Weixin adapter classes.
- [src-channels-tui](../units/src-channels-tui.md) — blessed terminal channel.
- [src-channels-webui](../units/src-channels-webui.md) — authenticated HTTP/SSE/upload/setup/terminal WebUI surface.
- [src-channels-wework](../units/src-channels-wework.md) — WeChat Work webhook/callback/WebSocket modes and opt-in conversation-latest stream cards.
- [src-channels-qqbot](../units/src-channels-qqbot.md) — official QQ Bot gateway, group policy, deferred ingress media and REST/upload delivery.
- [src-weixin](../units/src-weixin.md) — Weixin polling/send/QR-login protocol helpers.

Observable bindings, triggers, reply selection, progress and adapter limits are owned by [Channels and replies](../behaviors/channels-and-replies.md). Persisted conversation attachments and broadcast selection are implemented by [session channels](../units/src-session-channels.md).

## Public interfaces

- `Channel`, `ChannelContext`, `ChannelMessage`, `ChannelFile`, `MessageSource`.
- `registerChannel`, `unregisterChannel`, `getChannelInstance`, `listRegisteredChannels`.
- `getChannelId`, `getChannelType`, `getConversationId`.
- authorization inspection/formatting functions.
- inbound channel/session file save and descriptor functions.
- `initializeChannelRuntime`, per-channel start/stop/restart, `reloadManagedChannels`, and status queries.
- WebUI settings and Weixin QR-login helpers.

## Identity vocabulary

[Channel identities](../behaviors/channels-and-replies.md#which-identity-or-binding-should-i-change) distinguish adapter type, configured instance, conversation, sender, and explicit target. The source/API contract uses `channelType`, `channelInstanceId`, `conversationId`, `senderId`, and `<channel-instance-id>:<conversation-id>` targets. `platform` and `channelUserId` remain narrow compatibility fields; the latter is not a sender identity.

## Runtime behavior

- Normalized config permits multiple instances per type and passes each adapter its canonical config object plus instance ID.
- `reloadManagedChannels` stops all current managed Telegram/Matrix/WeWork/Weixin/QQ Bot instances, rebuilds factories from config, and starts every enabled/configured instance.
- Registry IDs are unique across adapter types.
- Internal WebUI/TUI pass channel authorization; external sources require allowlist or explicit per-attachment allow-all-users.
- `/whoami` is the source-only discovery exception, available without authorization or an attachment; see [D-pipeline-channel-identity-query](../threads/message-processing-pipeline.md#d-pipeline-channel-identity-query).
- Inbound files go to the agent's master `.temp/channel-files` area unless an isolated session targets its bound remote node. Descriptors report node and path without prescribing a file tool.
- Session broadcast is fire-and-forget; platform send failures are logged. `turnFinal` is a generic completion option that platform adapters may consume.
- Managed ordinary-text channel instances may opt into bounded in-memory tool progress with `channelProgress.intervalMs`; WebUI and the active WeWork stream-card target are excluded.

## Adapter-specific invariants

- WeWork stream aggregation is opt-in and routes ongoing progress/final delivery to the latest card in one configured instance and conversation. WebSocket mode is separately configured.
- WeWork proactive text and file delivery prefer configured AIBot WebSocket over a configured legacy webhook, while an explicit per-call webhook URL remains a deliberate legacy-route override.
- Conversation-latest passive context advances at valid adapter ingress before Router authorization. In a shared multi-sender conversation, a rejected inbound may therefore advance the passive reply/card association even though its content does not enter the session queue or model history; no per-sender card recovery state is maintained.
- Weixin context tokens are in-memory per user; a new inbound message is required after token loss. QR login sessions expire after five minutes.
- WebUI `sendFile` is intentionally a no-op because the browser uses authenticated downloads/tool metadata.
- QQ Bot C2C/group attachments use an authorization-gated, bounded inbound
  spool/materializer. Main-hosted saves use the path boundary; isolated or
  bound-node saves reuse the existing whole-buffer node boundary only up to a
  fixed 10 MiB attachment cap. Direct video/voice are generic saved
  descriptors and nested attachments remain deferred. C2C/group `sendFile`
  uses the destination-specific direct-small or streamed-large official upload
  flow. C2C/group text, media, and typing share one process-local outbound
  sequence allocator across configured instances; lifecycle changes do not
  reset it. Guild/DM media and remote URL send remain unsupported.

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

[2026-09-01, updated 2026-09-06] The observable enablement, cadence, target exclusions, silent wait and delivery consequences are owned by [Channel progress](../behaviors/channels-and-replies.md#is-progress-another-reply-or-another-model-input).

Main's transient coordinator is keyed by turn, configured instance and conversation. It consumes only provider-neutral top-level tool start/finish facts, storing bounded sanitized names/counts/running IDs. Sanitization preserves underscores while removing controls/Channel markup. Fixed non-sliding timers and independent target baselines determine standalone summaries versus prepends; terminal cleanup flushes only pending unreported activity and reload/TTL fences remove stale timers. It writes no Session history, Archive, catalog or recovery state. Delivery failure does not poison the semantic turn. Explicit tool-owned sends/files/typing bypass decoration; QQ/WeWork resolve passive context inside the adapter. The silent-tool matcher is the exact builtin `wait`, not an alias or suffix match. Detailed scheduled/in-flight cleanup races remain in [Channel core](../units/src-channel-core.md#runtime-behavior).

### D-channel-conversation-latest-passive-context

[2026-09-21] [Latest passive-context behavior](../behaviors/channels-and-replies.md#why-can-a-newer-inbound-message-change-where-a-passive-reply-appears) is adapter-local per instance/conversation; no Router, queue, Worker RPC or tool-context receipt fields select automatic replies.

QQ keeps a bounded in-memory latest-message map; normal Session/tool producers do not carry or persist QQ message IDs. Explicit request-level replies retain their original inbound ID, generic direct text is proactive unless real call options select passive delivery, and file sends independently prefer adapter-local latest context. WeWork keeps latest-card aggregation or a bounded latest `response_url` map. Superseding a card removes transient status while preserving substantive text; ordinary text uses the latest unfinished card without requiring turn metadata. `turnFinal` controls completion and structured progress controls progress content; card completion/expiry selects the existing proactive route. A terminal non-stream attachment delivery takes and removes its callback before awaiting send, so the older attempt cannot delete a newer inbound callback. Explicit webhook overrides/proactive sends retain their dedicated routes. These mechanisms add no persisted delivery state, ledger, outbox, or strategy registry.

### D-channel-wework-think-fold

[2026-09-21] A WeWork passive stream card presents its process and its answer as one folded card: process text and tool lines stay inside the `<think>` region and the final answer is the visible body after the closing tag. The adapter owns that split; the runner/delivery boundary only classifies how a turn ended.

A turn ending must say whether it is terminal or suspended. `deliverCommittedFinal` carries `suspended` (alongside `response`, `error`, and `empty-final`) for a turn that ends because it is waiting — an explicit `wait`, a handoff `waitForReply`, a deferred queued input, or a managed tool-step yield — and the adapter keeps the active card open for it, so the resumed turn appends to the same fold across canonical turns without any persisted card state or serialized stream ID. Every terminal ending still closes the card: a real answer closes it with that answer as the body, while a user Stop, a fenced terminal error, and retry exhaustion close it through the ordinary empty-final lifecycle and its legal non-empty fallback. A newer inbound turn supersedes and closes the previous card with its substantive text still visible. A card with no terminal ending is reclaimed by the adapter TTL, whose window each refresh poll restarts, or by the existing proactive route once its local state is gone.

Fold marking and tag stripping are one-way adapter concerns. Folded frames never exceed the platform byte limit, and frame assembly reserves room for both tags before truncating process content, because a truncated closing tag would leave the card permanently collapsed. Nothing is ever placed before the opening tag, because the platform drops it. Content that leaves the passive route — proactive Markdown, WebSocket `aibot_send_msg`, and terminal `response_url` — has fold tags stripped, since those routes render them literally. The frame shape itself (a complete pair in every frame versus a pair closed only by the final frame) is one adapter configuration choice, and it is the sole determinant of the card's folded label: the platform derives the running, finished, and deep-thinking titles from whether the first frame closes the pair and from the update that first introduces the closing tag. The default keeps the pair open until the final frame, because a closed first frame cannot produce the running label at all.

### D-channel-wework-aibot-proactive-delivery

[2026-09-08, updated 2026-09-21] When WeWork AIBot WebSocket mode is enabled, ordinary proactive
`sendMessage` and `sendFile` delivery use the existing long connection even if
the same channel also has a legacy group webhook URL. An explicit per-call
`webhookUrl` remains on the legacy text/image/file path, including inbound
replies already bound to a native webhook URL; legacy-only configuration is
unchanged. Without an explicit stream ID, that webhook override also bypasses
automatic latest-card selection; a request-level reply carrying both an explicit
stream ID and webhook URL retains its explicit stream binding. Adapter-local latest stream-card replies and terminal HTTP `response_url` replies
retain their dedicated routes before this proactive selection. A selected
WebSocket route never falls back to the webhook after an error, because timeout
and disconnect outcomes can be ambiguous. Proactive WebSocket text uses the
supported Markdown message body and preserves target/chat-type routing.

WebSocket media uses the official `aibot_upload_media_init` → zero-based
`aibot_upload_media_chunk` sequence → `aibot_upload_media_finish` commands,
with raw 512 KiB chunks and at most 100 chunks. Zero-based indices follow the
official SDK's executable upload loop; its contradictory type comment is not
the wire behavior used here. The adapter hashes and reads sequential chunks,
requires valid `upload_id` and `media_id` ACK fields, then sends the resulting
image/file through proactive `aibot_send_msg` to the resolved conversation.
An optional caption is a separate proactive Markdown message on that same route
after local validation/upload, never a generic text fallback or an update to
an existing callback stream card. There is no retry, outbox, resume, receipt,
or cross-route duplicate-delivery mechanism.

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
