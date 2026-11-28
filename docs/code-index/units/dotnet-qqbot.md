# Unit: Official QQ Bot gateway and media

Files: `dotnet/Foxwarm/Channels/QQBotChannel.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Gateway.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Inbound.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Delivery.cs`, `dotnet/Foxwarm/Channels/QQBotMedia.cs`, `dotnet/Foxwarm/Channels/QQBotRaster.cs`, `dotnet/Foxwarm/Channels/QQBotUpload.cs`

Secondary/integration files: `dotnet/Foxwarm/Channels/ManagedChannels.cs`, `dotnet/Foxwarm/Channels/ExternalChannelContext.cs`, `dotnet/Foxwarm/Channels/ChannelRegistry.cs`, `dotnet/Foxwarm/MessageRouter.External.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ChannelFilePaths.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ChannelTurns.cs`, `dotnet/Foxwarm/Tools/FileToolWrite.cs`

## Purpose and integration

Implements the official AppID/client-secret QQ Bot adapter in the existing managed channel runtime. Configuration, authorization, guest allocation, exact Session resolution, attachments, ordinary broadcast/progress, direct/unified/native file tools, generated images and Setup reload use the [shared external-channel owners](./dotnet-external-channels.md). There is no credential service, second registry, upload service, durable passive state, outbox or reply ledger.

The canonical behavioral reference and decisions are [the QQ unit](./dotnet-qqbot.md), [current group-trigger metadata](./dotnet-external-channels.md#d-channel-current-group-trigger-metadata) and [conversation-latest passive context](./dotnet-external-channels.md#d-channel-conversation-latest-passive-context). Normal Session/tool paths do not produce QQ reply IDs. Existing persisted source metadata remains readable without making it a current delivery producer.

## Stable symbols

| Symbol | Responsibility |
| --- | --- |
| `QQBotChannel.StartAsync` / `StopAsync` | Managed discovery/open and nonjoining ingress retirement; stop clears bounded input/passive state while reconnect preserves group buffers. |
| `GetTokenAsync` / `ApiAsync` | Coalesced expiry-aware token acquisition and one authenticated 401 refresh; structured API errors retain their numeric code and bounded message. |
| `GatewayLoopAsync` / `HandleFrameAsync` | Connection ownership, complete fragmented binary/text input, identify/resume, dispatch sequence, READY state and gateway control. |
| `RouteInboundAsync` / `DispatchAsync` | Actual C2C/group/guild/DM identity, business dedup, group policy and current-trigger-only Router dispatch. |
| `SendTextAsync` / `SendFinalAsync` / `EnqueueReplyAsync` | Caller-specific passive selection, per-ID serialization, success quota and structured-expiration fallback. |
| `AllocateSequence` | One process-lifetime random-seeded nonzero uint32 sequence shared by all QQ instances/text/media/typing, wrapping to one. |
| `QQBotMedia.Preview` / `MaterializeAsync` | URL-free metadata and deferred current-media acquisition after original Router authorization. |
| `QQBotRaster.Probe` / `OfficialImage` | Stream/path-based supported-raster metadata and strict coherently sized uncompressed BMP fallback. |
| `QQBotUpload.UploadAsync` | Safe local C2C/group direct-small or ordered streamed-large upload returning one uncached opaque token. |

## Gateway and .NET lifetime

The default intent mask and official token/API endpoints are the documented QQ Bot defaults. Tokens refresh with a one-minute safety window and bounded 401 retry. Coalesced token acquisition is canceled by the adapter lifetime during stop, allowing the existing managed initializer cleanup to settle even while the token peer is pending. Bot authorization is request-local: asset/COS requests have no bot headers or cookies, use a nonredirecting transport, and cannot inherit API credentials. The HTTP client explicitly has no application-level whole-request timeout for token/API calls, avoiding the CLR's unrelated default 100-second budget. Token acquisition retains adapter-lifetime cancellation, and API headers/body reads retain their caller tokens. This does not promise unlimited network lifetime: transport defaults and the independent media/part-upload budgets still apply. The dependency seam is test transport injection, not an endpoint/validation option in user configuration.

Gateway state is in memory. HELLO identifies or resumes from READY session ID and dispatch sequence; heartbeat ACK/missed ACK, RECONNECT, resumable/nonresumable INVALID_SESSION, normal/fatal/intents/rate-limit/auth/invalid-session close classes and reconnect delays follow the used reference path. Reconnect requests, invalid-session reconnects, missed heartbeat ACKs, receive-loop socket errors and resumable closes (4006–4009, 49xx other than 4914/4915, and abnormal closes) are log-only: the loop reconnects by itself. Status errors under the [channel status contract](./dotnet-external-channels.md#channel-status-errors) are the terminal closes (1000, 4914/4915), closes that reject the bot (4001–4004, 4010–4014), a failed discovery/connect/token request after the first connection, and the exhausted reconnect limit, all under the path "QQ Bot gateway". That path clears on READY or RESUMED, not on socket open. A failed first connection is a start failure. Final text and media sends (path "QQ Bot sending") clear on a delivered message. Close codes and fixed operation stages are retained; vendor close reasons and response bodies are not. Status errors do not redefine registry-based `running` as account health. Complete messages use the installed ws default 100 MiB decoded-message bound. Business-event identity is independent of the transport sequence.

Each .NET connection owns its `ClientWebSocket`, one sender semaphore and retirement/heartbeat lifetime. As with ws's queued `send`, control handling and heartbeat cadence do not await a non-reading peer's writer drain. A missed ACK can retire that connection and open a successor whose sender is independent; stale queued writers cannot target the replacement. A retired connection may finish its close handshake while discovery/reconnect proceeds. Close is nonjoining and aborts its exact old socket after 30 seconds, matching the installed ws default close lifetime. No replay or general recovery machinery is introduced.

## Input and group policy

Targets retain `c2c:`, `group:`, `guild:` and `dm:` scopes; sender identity comes from the corresponding actual author field. C2C/group attachment-only input is supported, while empty guild/DM input and their unsupported media do not enter materialization.

Ordered bounded maps preserve insertion/eviction semantics across .NET removals. Group AT/ordinary representations share business identity, including bounded normalized `msg_seq` and `message_scene.ext` index input. A buffered ordinary message can upgrade to its later AT representation without suppressing the trigger. Dedup is bounded process memory, not exactly-once delivery.

Mention-required groups retain bounded untrusted local context until a reliable native/structured self-mention. All-message mode uses a fixed non-sliding window; zero means immediate input. Mention/current media flush immediately. Slash triggers clear/bypass aggregation before Router command detection. Current event alone owns sender, authorization, passive ID, metadata and deferred media; prior attachments are URL-free previews. Local context takes precedence over bounded platform-history fallback; unavailable platform sender/time is not invented. Context expires five minutes after local arrival, holds at most 50 configurable entries per group, and at most 1,000 group accumulators are kept. Batches detach before any Router await; gateway reconnect preserves them and stop/reload clears them.

The generic ephemeral message hook is used only by QQ. Router captures authorization before guest provisioning, resolves the actual owner, then materializes only originally authorized current media. First guest and denied input fetch/save nothing. Reliable group metadata is placed inside the existing User wrapper after slash detection, survives materialization/history/provider formatting, and creates no parallel persisted mention flag. Other adapters retain their existing eager media order.

## Media bounds and delivery

Inbound assets require allowlisted HTTPS hosts, no userinfo/abnormal port and per-hop redirect validation. Downloads stream into an owned temporary spool with bounded timeout/count/per-file/total and controlled errors/cleanup. Defaults and hard caps: 20 MiB safe inline raster, 50 MiB generic default, 200 MiB generic hard/total default, eight/default and sixteen/maximum attachments. Main saves by shared atomic path copy. Raster blobs become canonical references before durable queue/history; original saved bytes and animations are not rewritten. Non-raster/oversized images and direct video/voice remain generic files. Voice uses an allowed WAV helper or valid primary fallback with bounded ASR reference; nested/ambient/guild/DM media stays outside this materializer.

Automatic typing/progress/intermediate/final text resolves each attached conversation's latest ID. Explicit request replies retain their own ingress ID. Generic direct text is proactive; file delivery separately prefers latest context. Generic presentation turn IDs are transient and contain no QQ identity. C2C typing needs a latest ID and does not spend passive quota. Successful passive text/media alone spends the four-success/three-minute per-ID quota. Structured code 40034005 permits one proactive final attempt with the same sequence; arbitrary HTTP/auth/rate/network/permission errors do not infer expiration. Media fallback reuses the just-uploaded `file_info` without re-upload. Automatic final failures are diagnostic-only.

Local outbound files require regular safe prepared sources and have a separate 100 MiB hard cap. Actual JPEG/PNG/GIF/WebP bytes or strict BMP fallback within the image threshold use image type; hints alone cannot classify bytes. Under 5 MiB uses bounded direct Base64 `/files` with `srv_send_msg:false`; at/above uses streamed MD5/SHA1 and the exact first 10,002,432-byte MD5 prefix, prepare, ordered presigned part PUTs, part-finish and completion. Prepare/direct/completion responses, part indexes/ranges and opaque tokens are bounded. HTTPS COS sends have no credential forwarding, redirects or upload retry/cross-flow fallback. Generation checks fence reads, every request stage and final delivery. Caption, ordering and partial effects remain the existing caller's transport outcomes.

## Design decisions

### D-qqbot-passive-reply-fallback

**Mixed provenance under [adapter-owned passive context](./dotnet-external-channels.md#d-channel-conversation-latest-passive-context).** The three-minute local age check and recognized-error proactive fallback were directly selected. The four-success local budget is an engineering mechanism, not a universal QQ quota; current server responses retain their own meaning.

Passive reply handling combines a local age/count budget with a single proactive
fallback for recognized server expiry. The three-minute age policy and error-code
fallback serve late replies; the retained four-success budget is a local adapter
choice, not a claim about a universal server quota. From the inbound/first-seen `msg_id`, at
most four **successful passive text/image/file replies** are sent in three
minutes. The next reply after that count or age boundary makes exactly one
proactive attempt to the same scoped conversation. A per-`msg_id` in-process
chain serializes the decision, HTTP result, and successful-count update, so
concurrent replies do not spend speculative quota; unrelated IDs remain
concurrent. Each queued operation is fenced to the adapter run generation
before it begins I/O; stop or reload clears state, and stale old-generation
chains cannot affect a new run. Typing uses the shared outbound sequence but
does not consume the four passive replies. The limiter is per adapter instance,
bounded and in-memory only; the outbound sequence allocator is module-scoped
and survives adapter lifecycle changes.

When a passive C2C/group text or media final/intermediate delivery receives
the structured QQ API error code `40034005` (`code` or `err_code`), the
adapter marks that `msg_id` expired and makes exactly one proactive retry.
Text retries omit `msg_id`; media retries reuse the just-uploaded same-target
`file_info` without re-uploading. The passive attempt and proactive fallback
reuse the outgoing message's allocated `msg_seq`. Future
operations for that ID remain proactive. No other API failure, generic HTTP
failure, network/auth/rate-limit failure, or proactive failure triggers a
fallback loop or retry; an automatic text final delivery logs and completes
rather than making the runner send another error through the same passive context.

### D-qqbot-inbound-media-boundary

[2026-08-08] Stage 1 supports inbound C2C/group direct attachments. The adapter
exposes URL-free metadata first; only a source that passed
canonical Router authorization at ingress may invoke the ephemeral materializer
to fetch and save media. First guest and unauthorized messages remain
metadata-only, while later authorized messages may materialize. Direct video and
voice are saved as generic bounded files; voice prefers an allowlisted
`voice_wav_url` and includes bounded `asr_refer_text` metadata. Declared MIME
and filename are hints only. A raster probe (the [isolated worker](./hosted-image-decoder.md) for hosted tenants) detects PNG/JPEG/GIF/WebP
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

`QQBotConfig.requireMention` defaults to `true`. One configured adapter owns a
bounded in-memory accumulator per scoped group so the same implementation works
with QQ platform delivery configured as AT-only, AT plus previous group
messages, or all group messages. QQ's AT-plus-history mode may deliver exactly
one `GROUP_AT_MESSAGE_CREATE` whose `msg_elements[*].content` contains the
previous-message bundle instead of replaying ordinary gateway frames.

When mention is required, group events not classified as a current mention are
untrusted context only. The adapter keeps the latest `groupContextLimit`
entries and flushes them with one later mention trigger as exactly one
`ChannelMessage` and one Router call. When no local context exists, the adapter
may instead parse the bounded platform history bundle from the AT event. These
records remain untrusted context and use `source="platform-history"` without
sender/time attributes because QQ does not provide that attribution in the
bundle; local sender-labelled context takes precedence to avoid duplicates.
When mention is not required, the first
ordinary event opens a fixed, non-sliding `groupBatchWindowMs` window; later
ordinary events join without moving the deadline. The latest event is the
current trigger, previous events are context, and a mention trigger or
current-message media flushes immediately. A zero window preserves immediate per-event routing.
Slash-command triggers bypass aggregation, clear pending context, and retain
the Router's existing command parser input.

The trigger/current event alone owns Router authorization, sender/source
metadata, the passive `msg_id`, and latest-message state. Prior context is
serialized inside the Router's outer direct-channel wrapper as
`<foxwarm-qqbot-context count="..." untrusted="true">` with escaped
sender-labelled items and a blank line before current text. Ambient attachment
metadata remains URL-free and is never materialized; only current-message media
uses the existing authorization-gated materializer. Context is bounded to 50
configurable entries, expires five minutes after local arrival, and the adapter
keeps at most 1,000 group accumulators. Stop/reload clears timers and buffers;
gateway reconnect/resume preserves them. A flush detaches state before awaiting
the Router, retains ordinary busy-queue behavior, and has no retry/outbox.

Mention and ordinary native forms share the existing canonical business dedup namespace.
The live buffer is checked first so an ordinary representation can be upgraded
in place by a later AT representation rather than appearing twice or suppressing
the trigger. A true proactive failure such as QQ `40034105` remains a platform
permission result.

### D-qqbot-outbound-media

[2026-08-10] QQ outbound media is limited to C2C and Group `Channel.sendFile` using an
already prepared safe local file. Tencent's current JPEG/PNG/GIF/WebP/BMP
image formats within the configured image threshold use QQ `file_type=1`;
other or oversized images use `file_type=4` when within the generic-file cap.
The adapter probes actual local bytes rather than trusting extension, MIME, or
`ChannelFile.isImage`: Sharp metadata identifies JPEG/PNG/GIF/WebP, while a
strict coherently sized common uncompressed BMP file/DIB-header check covers
deployments whose optional Sharp BMP loader is absent: CORE headers accept 24
bpp, while INFO-family headers accept 24/32 bpp. Indexed 1/4/8,
16-bpp, compressed, bitfield, and RLE BMP variants remain generic unless Sharp
itself recognizes them. SVG, ICO, malformed, pixel-truncated, palette-less,
mislabeled, and unknown bytes remain
generic. Probing never decodes/re-encodes the upload, so animated GIF/WebP and
all other accepted bytes are uploaded unchanged. Files smaller than 5 MiB use
the destination-specific `/files` direct-upload body with `srv_send_msg: false`
and bounded base64 `file_data`; generic direct uploads also include the
sanitized `file_name`. Files at or above 5 MiB use the existing
`upload_prepare` → presigned COS part PUT → `upload_part_finish` → `/files`
completion flow. The direct path may read one strictly sub-5 MiB file buffer;
the streamed path hashes and sends part bodies without whole-file buffering.
Neither path retries, caches `file_info`, falls back to the other protocol
after an error, or logs/persists direct `file_data`. The local send path is
hard-capped at 100 MiB even when inbound `fileMaxBytes` is set to the 200 MiB
inbound maximum. Upload URLs use HTTPS with no userinfo and normal ports, and
the QQ API response is the trust boundary; bot credentials are never sent to
the presigned host. Latest
conversation-local QQ message IDs share the existing four-success passive
limiter and module-scoped outbound `msg_seq`; age/count and the structured `40034005`
fallback are canonical in
[D-qqbot-passive-reply-fallback](#d-qqbot-passive-reply-fallback). Media final
fallback reuses the just-uploaded same-target `file_info` and does not upload
again; upload failures and non-expiration final failures do not infer a retry.
Generation checks fence the local read, each direct/chunk request stage, and
final delivery.
Guild/DM native media, remote URL send, and general upload-service abstractions
remain unsupported; video/audio files use ordinary generic `file_type=4` when
within the local cap.

## Verification and limits

`ChannelHttpPolicyTests` covers token headers/body, API headers/body, caller cancellation and token-body shutdown against owned HTTP peers, including an injected client with a shorter implicit budget. Independent short media and part-upload timeout regressions remain in the media/boundary tests. The large-upload failure theory applies its 75 ms injected part deadline only to the timeout case; the HTTP 500 case uses the ordinary production budget and must report that HTTP failure. The timeout fixture records the PUT at the injected transport boundary and holds it until cancellation, since the deadline can expire before a loopback peer reads the complete body. Both cases retain exact single-attempt and no-completion/no-final assertions.

`QQBotChannelTests`, `QQBotMediaTests`, `QQBotBoundaryTests`, `QQBotSocketLifetimeTests` and `QQBotHostTests` use owned loopback token/gateway/API/asset/COS/provider peers and the actual managed Router and tool paths. They cover authorization/first guest, trigger metadata/commands, dedup/group bounds/TTL, latest passive/quota/expiration, coalesced refresh, exact upload boundaries/hashes, byte probes, redirects/credentials/cleanup, failure fencing, fragmented Unicode and non-reading/silent-close lifetime. Gateway callbacks continue while earlier Router queue admissions are pending. A later command reply confirms that command's handling, so queue assertions separately await the expected admissions. The original frontend helper `dotnet/Foxwarm.Tests/Fixtures/qqbot-browser.mjs` can run inside the Main host test with `FOXWARM_QQBOT_BROWSER=1`; it checks canonical User/history rendering without changing frontend assets. Browser batches require their separate bounded test unit.

The real CLI Node test includes authorized QQ storage and over-cap rejection. The live MCP mixed-reload test includes all five managed adapters without converting temporary reply contexts into attachments. Unchanged storage/native/Windows/other-adapter evidence is not a live QQ qualification.

No real QQ account, entitlement, vendor network or delivery-to-person is qualified. Main TUI, remaining administration commands and the final default entry/service/production-container switch remain later work.
