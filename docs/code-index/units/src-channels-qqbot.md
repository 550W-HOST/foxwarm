# Unit: src-channels-qqbot

Files: src/channels/qqbotChannel.ts, src/channels/qqbotChannel.test.ts, src/channels/qqbotMedia.ts, src/channels/qqbotMedia.test.ts

## Purpose

Implements the official QQ Bot gateway adapter with direct AppID/client-secret
configuration. It uses the QQ access-token endpoint, gateway WebSocket, and
official REST message endpoints without depending on an unlicensed QR
credential-provisioning package. C2C and group ingress also accepts bounded
image/file attachments through a deferred, authorization-gated materializer.

## Key exports

- `QQBotChannel` — managed `Channel` implementation for official QQ Bot text
  ingress, bounded C2C/group media ingress, and text delivery.
- `parseQQBotConversationId()` — validates the scoped outbound target format.
- `isQQBotChannelConfigReady()` — validates the two required credentials for
  runtime factory/status handling.
- `buildQQBotAttachmentPreviewParts()` — creates URL-free metadata parts for
  attachment ingress before authorization and materialization.
- `materializeQQBotAttachments()` — streams allowlisted HTTPS media, validates
  bounded files/raster bytes, saves descriptors, and emits transient image
  parts for the canonical image-blob boundary.

## Function Index

| Function | Description |
| --- | --- |
| `QQBotChannel.start()` / `stop()` | Obtains a token, opens or closes the gateway, and fences reconnect/heartbeat callbacks by connection generation. |
| `QQBotChannel.handleGatewayMessage()` | Identifies or resumes after `HELLO`, retains dispatch sequence/session state, handles gateway control frames, and accepts supported message events. |
| `QQBotChannel.routeInboundMessage()` | Deduplicates supported events, creates scoped identity, keeps C2C/group attachment metadata URL-free, and attaches an ephemeral media materializer. |
| `QQBotChannel.sendMessage()` | Routes C2C, group, guild-channel, and guild-DM text to their official REST endpoint. |
| `QQBotChannel.sendTyping()` | Uses the official C2C input-notify message only when an inbound C2C message ID is available. |
| `QQBotChannel.apiRequest()` / `getAccessToken()` | Performs authenticated API requests with a bounded 401 token refresh. |

## Identity and supported surface

- One configured adapter instance owns its configured channel ID. Its QQ
  conversations are scoped as `c2c:<openid>`, `group:<group-openid>`,
  `guild:<channel-id>`, and `dm:<guild-id>`.
- `senderId` is the actual QQ identity: C2C `author.user_openid`, group
  `author.member_openid`, or guild/DM `author.id`. This lets shared channel
  authorization use `allowedUsers` normally rather than treating a group or
  channel target as its sender.
- The adapter accepts `content` plus attachments from `C2C_MESSAGE_CREATE` and
  `GROUP_AT_MESSAGE_CREATE`. Attachment-only C2C/group events are retained as
  safe filename/MIME/size metadata and can be materialized only after the
  canonical router has already authorized the sender. Supported raster images
  become transient inline parts and generic files become saved descriptors;
  the router's durable image boundary replaces image bytes with references.
  Guild channel/DM media remains unsupported, and empty guild/DM events are
  ignored. The adapter does not infer unmentioned group traffic or an
  unsupported media contract.
- Attachment materialization uses HTTPS-only allowlisted hosts, manually
  revalidates each redirect, forwards no bot authorization/cookies, streams to
  a bounded temporary file with a timeout, enforces per-file/total/count
  bounds, sanitizes names, and validates supported raster MIME/magic pairs.
  Default local limits are 20 MiB safe inline-image cap, 50 MiB generic-file
  cap, 200 MiB total, and eight attachments; the image setting cannot exceed
  the safe 20 MiB inline cap while the generic-file setting cannot exceed 200
  MiB. Images above the inline cap become generic file descriptors without
  inline bytes. Master inbound file writes use a unique temporary path
  followed by atomic rename and cleanup.
- Attachment metadata is built before any media fetch. A message's ephemeral
  `ChannelMessage.materializeParts(sessionId)` hook is invoked by
  `MessageRouter` only when authorization was true at ingress; unauthorized
  and first guest messages therefore perform zero media fetch/write operations.
  The hook is never persisted or copied to a queue item.
- An inbound context preserves its QQ `msg_id` in the serializable queue source.
  The matching configured instance consumes that ID as a passive reply for the
  source turn, while other session attachments retain ordinary delivery.
- The gateway retains the latest dispatch sequence and READY session ID in
  memory. HELLO resumes only when both are present; RECONNECT, resumable and
  non-resumable INVALID_SESSION frames, documented close classes, heartbeat
  ACKs, and stop/reconnect generation fencing are handled without persisting a
  session claim.
- A bounded in-process event-identity map drops duplicate supported gateway
  deliveries before they reach MessageRouter. Its identity uses event type,
  `msg_id`, and normalized business `msg_seq` and/or official
  `message_scene.ext` `msg_idx=<value>` array entry when supplied; gateway
  dispatch `s` is transport resume state, never business dedup identity.
  Bounded malformed/ambiguous ext input falls back to a valid `msg_seq` or
  id-only identity. A separate bounded per-`msg_id`
  counter allocates C2C/group outbound `msg_seq` values monotonically across
  typing and passive replies.
- QQ offers typing through C2C input-notify messages, so this adapter sends
  typing only for a C2C conversation with a current inbound message ID.

## Runtime and configuration

- `QQBotConfig` in `src/config.ts` accepts `appId`, `clientSecret`, `enabled`,
  `allowedUsers`, `allowAllUsers`, and bounded `media` limits
  (`imageMaxBytes` safe inline-image cap, `fileMaxBytes`, `maxTotalBytes`,
  `maxAttachments`). Isolated-node QQ media currently returns a bounded
  unsupported descriptor because the existing node transfer is whole-buffer,
  not a streaming boundary.
- `src/channelRuntime.ts` constructs, starts, stops, reloads, and reports each
  configured `qqbot` instance alongside the other managed adapters.
- Startup uses the managed runtime after normal router authorization is
  initialized. Multiple QQ Bot instances therefore have independent registry
  IDs, credentials, and attachment namespaces.

## Tests

`src/channels/qqbotChannel.test.ts` uses mocked token/gateway/REST calls and
a fake WebSocket. It covers scoped target validation, C2C/group inbound
identity and attachment ordering, deduplication before media fetch, passive
reply and C2C typing identifiers, gateway identify and resume control flow,
guild/DM media rejection, group/guild/DM outbound routes, and
shutdown/reconnect fencing. `src/channels/qqbotMedia.test.ts` covers safe
previews, official video/voice/nested deferral, streamed spool/total/timeout
bounds and cleanup, allowlisted redirect validation, safe generic-file storage,
safe-inline-cap image fallback, raster MIME/magic validation, and transient
image data crossing into a canonical blob reference.

## Design Decisions

### D-qqbot-passive-reply-fallback

For a source-bound QQ reply, Foxwarm follows the Tencent/OpenClaw local policy
instead of inferring a server error: from the inbound/first-seen `msg_id`, at
most four **successful passive text replies** are sent in one hour. The next
reply after that count or age boundary makes exactly one proactive text attempt
to the same scoped conversation. A per-`msg_id` in-process chain serializes the
decision, HTTP result, and successful-count update, so concurrent replies do
not spend speculative quota; unrelated IDs remain concurrent. Each queued
operation is fenced to the adapter run generation before it begins I/O; stop or
reload clears state, and stale old-generation chains cannot affect a new run.
Typing receives
its own monotonic `msg_seq` but does not consume the four text replies. The
limiter is per adapter instance, bounded and in-memory only. Unknown API failures, generic HTTP failures,
network/auth/rate-limit failures, and a failed proactive attempt never trigger
a fallback or retry; a source-bound final delivery logs and completes rather
than making Router send another error through the same passive context.

### D-qqbot-inbound-media-boundary

[2026-08-08] Stage 1 supports only inbound C2C/group images and generic files.
The adapter exposes URL-free metadata first; only a source that passed
canonical Router authorization at ingress may invoke the ephemeral materializer
to fetch and save media. First guest and unauthorized messages remain
metadata-only, while later authorized messages may materialize. Images are
validated supported raster bytes and remain transient until the shared
content-addressed image-blob conversion runs before durable queue/history
storage; generic files remain saved node/path descriptors. Images above the
safe inline cap are generic file descriptors, not inline data. Guild/DM media,
outbound media, video/voice, nested attachments, retries/outbox, and remote URL
send are deferred. Isolated-node media is rejected with a bounded descriptor
until a genuinely streaming node transfer boundary exists; Stage 1 does not
pretend the current whole-buffer node API supports the configured master caps.

## Canonical ownership

Shared channel type/instance/conversation identity and managed reload rules
remain canonical in [channels module](../modules/channels.md#design-decisions).