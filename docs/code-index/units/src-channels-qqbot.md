# Unit: src-channels-qqbot

Files: src/channels/qqbotChannel.ts, src/channels/qqbotChannel.test.ts

## Purpose

Implements the official QQ Bot gateway adapter with direct AppID/client-secret
configuration. It uses the QQ access-token endpoint, gateway WebSocket, and
official REST message endpoints without depending on an unlicensed QR
credential-provisioning package.

## Key exports

- `QQBotChannel` — managed `Channel` implementation for official QQ Bot text
  ingress and text delivery.
- `parseQQBotConversationId()` — validates the scoped outbound target format.
- `isQQBotChannelConfigReady()` — validates the two required credentials for
  runtime factory/status handling.

## Function Index

| Function | Description |
| --- | --- |
| `QQBotChannel.start()` / `stop()` | Obtains a token, opens or closes the gateway, and fences reconnect/heartbeat callbacks by connection generation. |
| `QQBotChannel.handleGatewayMessage()` | Identifies or resumes after `HELLO`, retains dispatch sequence/session state, handles gateway control frames, and accepts supported message events. |
| `QQBotChannel.routeInboundMessage()` | Ignores non-text payloads and creates the Foxwarm context/message with scoped identity. |
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
- The adapter accepts text only from `C2C_MESSAGE_CREATE`,
  `GROUP_AT_MESSAGE_CREATE`, `AT_MESSAGE_CREATE`, and
  `DIRECT_MESSAGE_CREATE`. It intentionally ignores attachment-only payloads
  and unmentioned group traffic instead of guessing a media or group-history
  contract.
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
  `allowedUsers`, and `allowAllUsers`.
- `src/channelRuntime.ts` constructs, starts, stops, reloads, and reports each
  configured `qqbot` instance alongside the other managed adapters.
- Startup uses the managed runtime after normal router authorization is
  initialized. Multiple QQ Bot instances therefore have independent registry
  IDs, credentials, and attachment namespaces.

## Tests

`src/channels/qqbotChannel.test.ts` uses mocked token/gateway/REST calls and
a fake WebSocket. It covers scoped target validation, C2C inbound identity,
deduplication, passive reply and C2C typing identifiers, gateway identify and
resume control flow, non-text rejection, group/guild/DM outbound routes, and
shutdown/reconnect fencing.

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

## Canonical ownership

Shared channel type/instance/conversation identity and managed reload rules
remain canonical in [channels module](../modules/channels.md#design-decisions).