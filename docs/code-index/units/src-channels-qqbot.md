# Unit: src-channels-qqbot

Files: src/channels/qqbotChannel.ts, src/channels/qqbotChannel.test.ts, src/channels/qqbotChannelMediaSend.test.ts, src/channels/qqbotMedia.ts, src/channels/qqbotMedia.test.ts, src/channels/qqbotMediaUpload.ts, src/channels/qqbotMediaUpload.test.ts

## Purpose

Implements the official QQ Bot gateway adapter with direct AppID/client-secret
configuration. It uses the QQ access-token endpoint, gateway WebSocket, and
official REST message endpoints without depending on an unlicensed QR
credential-provisioning package. C2C and group ingress also accepts bounded
image/file/video/voice attachments through a deferred, authorization-gated materializer,
and C2C/group `Channel.sendFile` uses the official local chunk-upload flow.

## Key exports

- `QQBotChannel` — managed `Channel` implementation for official QQ Bot text
  ingress, bounded C2C/group media ingress, and text delivery.
- `parseQQBotConversationId()` — validates the scoped outbound target format.
- `isQQBotChannelConfigReady()` — validates the two required credentials for
  runtime factory/status handling.
- `buildQQBotAttachmentPreviewParts()` — creates URL-free metadata parts for
  attachment ingress before authorization and materialization.
- `materializeQQBotAttachments()` — streams allowlisted HTTPS media into a
  bounded spool, saves generic descriptors, and emits transient image parts
  after a best-effort supported-raster format probe. Main-hosted sessions use
  the path-based atomic saver; isolated/bound-node sessions use the existing
  whole-buffer saver only up to a fixed 10 MiB transfer cap.
- `uploadQQBotFile()` — validates a prepared local `ChannelFile`, streams hashes
  and bounded part bodies through the C2C/group upload flow, enforces the
  Tencent-compatible 100 MiB local-send cap, and returns one opaque `file_info`
  token without caching it.

## Function Index

| Function | Description |
| --- | --- |
| `QQBotChannel.start()` / `stop()` | Obtains a token, opens or closes the gateway, and fences reconnect/heartbeat callbacks by connection generation. |
| `QQBotChannel.handleGatewayMessage()` | Identifies or resumes after `HELLO`, retains dispatch sequence/session state, handles gateway control frames, and accepts supported message events. |
| `QQBotChannel.routeInboundMessage()` | Deduplicates supported events, creates scoped identity, keeps C2C/group attachment metadata URL-free, and attaches an ephemeral media materializer. |
| `QQBotChannel.sendMessage()` | Routes C2C, group, guild-channel, and guild-DM text to their official REST endpoint. |
| `QQBotChannel.sendFile()` | Sends C2C/group images or generic files through destination-specific chunk upload and one rich-media message; rejects guild/DM media. |
| `QQBotChannel.sendTyping()` | Uses the official C2C input-notify message with the latest conversation-local inbound message ID when available. |
| `QQBotChannel.apiRequest()` / `getAccessToken()` | Performs authenticated API requests with a bounded 401 token refresh. |

## Identity and supported surface

- One configured adapter instance owns its configured channel ID. Its QQ
  conversations are scoped as `c2c:<openid>`, `group:<group-openid>`,
  `guild:<channel-id>`, and `dm:<guild-id>`.
- `senderId` is the actual QQ identity: C2C `author.user_openid`, group
  `author.member_openid`, or guild/DM `author.id`. This lets shared channel
  authorization use `allowedUsers` normally rather than treating a group or
  channel target as its sender.
- The adapter accepts `content` plus attachments from `C2C_MESSAGE_CREATE`,
  `GROUP_AT_MESSAGE_CREATE`, and (when `requireMention: false`) ordinary
  `GROUP_MESSAGE_CREATE` events. Attachment-only C2C/group events are retained as
  safe filename/MIME/size metadata and can be materialized only after the
  canonical router has already authorized the sender. Supported raster images
  become transient inline parts and other direct files (including video/voice)
  become saved descriptors; the router's durable image boundary replaces image
  bytes with references. Voice prefers an allowlisted WAV URL and preserves
  bounded ASR reference text. Guild channel/DM media remains unsupported, and
  empty guild/DM events are ignored; nested attachments remain deferred.
- Attachment materialization uses HTTPS-only allowlisted hosts, manually
  revalidates each redirect, forwards no bot authorization/cookies, streams to
  a bounded temporary file with a timeout, enforces per-file/total/count
  bounds, sanitizes names, and uses a best-effort supported-raster format probe;
  declared MIME and filenames remain hints and non-raster bytes stay generic.
  Default local limits are 20 MiB safe inline-image cap, 50 MiB generic-file
  cap, 200 MiB total, and eight attachments; isolated/bound-node transfers
  additionally cap each downloaded attachment at a fixed 10 MiB before the
  whole-buffer node write. The image setting cannot exceed
  the safe 20 MiB inline cap while the generic-file setting cannot exceed 200
  MiB. Images above the inline cap become generic file descriptors without
  inline bytes. Master inbound file writes use a unique temporary path
  followed by atomic rename and cleanup.
- Attachment metadata is built before any media fetch. A message's ephemeral
  `ChannelMessage.materializeParts(sessionId)` hook is invoked by
  `MessageRouter` only when authorization was true at ingress; unauthorized
  and first guest messages therefore perform zero media fetch/write operations.
  The hook is never persisted or copied to a queue item.
- An inbound context preserves its QQ `msg_id` in the serializable queue source
  as a restart/missing-map fallback. The adapter also retains a bounded latest
  message ID per scoped conversation; normal source-bound typing/progress/final
  delivery uses that live ID for the matching configured instance and
  conversation, while other session attachments retain ordinary delivery.
  When a compatible follow-up arrives during a no-tool provider request, the
  Router's pre-final safe point continues the turn before this latest ID is
  used for the one visible final.
- The gateway retains the latest dispatch sequence and READY session ID in
  memory. HELLO resumes only when both are present; RECONNECT, resumable and
  non-resumable INVALID_SESSION frames, documented close classes, heartbeat
  ACKs, and stop/reconnect generation fencing are handled without persisting a
  session claim.
- A bounded in-process event-identity map drops duplicate supported gateway
  deliveries before they reach MessageRouter. AT and ordinary group event
  types share one canonical business-event namespace, so the same message is
  not enqueued twice when QQ delivers both forms. Its identity uses event type,
  `msg_id`, and normalized business `msg_seq` and/or official
  `message_scene.ext` `msg_idx=<value>` array entry when supplied; gateway
  dispatch `s` is transport resume state, never business dedup identity.
  Bounded malformed/ambiguous ext input falls back to a valid `msg_seq` or
  id-only identity. A separate bounded per-`msg_id`
  counter allocates C2C/group outbound `msg_seq` values monotonically across
  typing and passive replies.
- QQ offers typing through C2C input-notify messages, so this adapter sends
  typing only for a C2C conversation with a current latest inbound message ID.
- C2C/group `sendFile` reuses a latest conversation-local message ID when
  available, or a matching persisted ID supplied by the generic file-delivery
  boundary after restart. It uploads locally prepared files through the
  destination-specific official chunk flow, sends images only for format-probed
  PNG/JPEG bytes within the image cap, and downgrades other images to generic
  files within the file cap. Outbound local files are hard-capped at 100 MiB;
  this is lower than the 200 MiB inbound configuration hard cap.
- `MessageRouter` carries only the current turn's QQ source metadata through
  the in-process tool context to `send_file`. An explicit target receives that
  fallback metadata only when its exact instance/conversation matches; a
  mismatched target is therefore proactive, while session broadcast still
  relies on the adapter's exact-match check.

## Runtime and configuration

- `QQBotConfig` in `src/config.ts` accepts `appId`, `clientSecret`, `enabled`,
  `requireMention` (default `true`), `allowedUsers`, `allowAllUsers`, and bounded `media` limits
  (`imageMaxBytes` safe inline-image cap, `fileMaxBytes`, `maxTotalBytes`,
  `maxAttachments`). Main-hosted materialization uses the path saver; isolated
  or bound-node QQ media uses the existing whole-buffer saver only for files up
  to the fixed 10 MiB transfer cap. Outbound
  C2C/group media uses the image/file settings subject to the separate 100 MiB
  local-send hard cap and the official local upload flow.
- `src/channelRuntime.ts` constructs, starts, stops, reloads, and reports each
  configured `qqbot` instance alongside the other managed adapters.
- Startup uses the managed runtime after normal router authorization is
  initialized. Multiple QQ Bot instances therefore have independent registry
  IDs, credentials, and attachment namespaces.

## Tests

`src/channels/qqbotChannel.test.ts` and `src/channels/qqbotChannelMediaSend.test.ts` use mocked token/gateway/REST/COS calls and
a fake WebSocket. It covers scoped target validation, C2C/group inbound
identity and attachment ordering, deduplication before media fetch, passive
reply and C2C typing identifiers, gateway identify and resume control flow,
guild/DM media rejection, group/guild/DM outbound routes, and
shutdown/reconnect fencing. Outbound tests cover destination-specific
upload routes, streamed hash/chunk order, passive IDs/counts/sequences,
caption/cap handling, permission failures, generation fences, and the
`send_file` target path, including current-turn restart fallback metadata and
mismatched-target proactive delivery. `src/channels/qqbotMediaUpload.test.ts` covers safe
regular-file validation, the 100 MiB sparse-file preflight, HTTPS/userinfo/port
checks, bounded prepare responses, part hashing, bounded PUT
cancellation/timeouts, no whole-file buffering, and opaque completion tokens.
`src/channels/qqbotMedia.test.ts` covers safe
previews, direct video/voice generic saves and nested deferral, Main-hosted preflight,
streamed spool/total/timeout bounds and cleanup, allowlisted redirect
validation, safe generic-file storage, safe-inline-cap image fallback, best-effort
raster format probing, controlled error categories/path scrubbing, and
  transient image data crossing into a canonical blob reference, isolated
  whole-buffer saves, and the fixed isolated transfer cap. Channel tests also
  cover ordinary group events, default mention gating, AT/non-AT business
  deduplication, and passive replies retaining the inbound `msg_id`.

## Design Decisions

### D-qqbot-passive-reply-fallback

For a source-bound QQ reply, Foxwarm follows the Tencent/OpenClaw local policy
instead of inferring a server error: from the inbound/first-seen `msg_id`, at
most four **successful passive text/image/file replies** are sent in one hour.
The next reply after that count or age boundary makes exactly one proactive
attempt to the same scoped conversation. A per-`msg_id` in-process chain
serializes the decision, HTTP result, and successful-count update, so concurrent
replies do not spend speculative quota; unrelated IDs remain concurrent. Each
queued operation is fenced to the adapter run generation before it begins I/O;
stop or reload clears state, and stale old-generation chains cannot affect a new
run. Typing receives
its own monotonic `msg_seq` but does not consume the four passive replies. The
limiter is per adapter instance, bounded and in-memory only. Unknown API failures, generic HTTP failures,
network/auth/rate-limit failures, and a failed proactive attempt never trigger
a fallback or retry; a source-bound final delivery logs and completes rather
than making Router send another error through the same passive context.

### D-qqbot-inbound-media-boundary

[2026-08-08] Stage 1 supports inbound C2C/group direct attachments. The adapter
exposes URL-free metadata first; only a source that passed
canonical Router authorization at ingress may invoke the ephemeral materializer
to fetch and save media. First guest and unauthorized messages remain
metadata-only, while later authorized messages may materialize. Direct video and
voice are saved as generic bounded files; voice prefers an allowlisted
`voice_wav_url` and includes bounded `asr_refer_text` metadata. Declared MIME
and filename are hints only. A best-effort Sharp probe detects PNG/JPEG/GIF/WebP
for optional inline image data under the safe cap; all other bytes stay generic.
Inline image bytes remain transient until the shared
content-addressed image-blob conversion runs before durable queue/history
storage; generic files remain saved node/path descriptors. Images above the
safe inline cap are generic file descriptors, not inline data. Guild/DM media,
nested attachments, retries/outbox, and remote URL send are deferred.
Main-hosted materialization uses the bounded spool path saver. For an
isolated/bound-node destination, the adapter reuses the existing WeCom-style
whole-buffer `saveInboundSessionFile`/node transfer only up to a fixed 10 MiB
per-attachment cap; larger attachments return the ordinary bounded
too-large result before a Buffer/Base64 transfer. This is deliberately a
small fallback, not a claim that the node API is a streaming boundary, and
introduces no new node protocol or configuration.

### D-qqbot-group-mention-policy

`QQBotConfig.requireMention` defaults to `true` to preserve the original
AT-only behavior. When explicitly `false`, the adapter accepts both
`GROUP_AT_MESSAGE_CREATE` and `GROUP_MESSAGE_CREATE` through the same group
identity, authorization, attachment, source metadata, and latest-message
context path. Replies keep the inbound `msg_id` and therefore remain passive
when the QQ passive window permits it. The two event types share one canonical
business dedup key so a duplicate delivery does not enqueue twice. This first
version has no per-group policy matrix, history-buffer changes, special slash
command policy, or proactive-send changes; a true proactive failure such as
QQ `40034105` remains a platform permission result.

### D-qqbot-outbound-media

[2026-08-08] QQ outbound media is limited to C2C and Group `Channel.sendFile`
using an already prepared safe local file. Supported PNG/JPEG files within the
configured image threshold use QQ `file_type=1`; other or oversized images use
`file_type=4` when within the generic-file cap. The adapter performs the
destination-specific `upload_prepare` → presigned COS part PUT →
`upload_part_finish` → `/files` flow and sends one `msg_type=7` message with
opaque `media.file_info`. Hashes and part bodies are streamed, upload URLs use
HTTPS with no userinfo and normal ports, and the QQ API response is the trust
boundary; bot credentials are never sent to the presigned host. The local send path is hard-capped at 100 MiB even when inbound
`fileMaxBytes` is set to the 200 MiB inbound maximum. The file-info token is
never cached or reused across target or adapter instances. Latest
conversation-local QQ message IDs share the existing four-success passive
limiter and monotonic `msg_seq`; after the limit one proactive attempt is made
with `msg_seq: 1`, while upload/final failures do not infer fallback or retry.
Generation checks occur before reading, each upload stage, and final delivery.
Guild/DM native media, remote URL send, and general upload-service abstractions
remain unsupported; video/audio files use ordinary generic `file_type=4` when
within the local cap.

## Canonical ownership

Shared channel type/instance/conversation identity and managed reload rules
remain canonical in [channels module](../modules/channels.md#design-decisions).
Conversation-local passive-delivery ownership is canonical in
[D-channel-conversation-latest-passive-context](../modules/channels.md#d-channel-conversation-latest-passive-context).
