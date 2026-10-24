# Unit: Official QQ Bot gateway and media

Files: `dotnet/Foxwarm/Channels/QQBotChannel.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Gateway.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Inbound.cs`, `dotnet/Foxwarm/Channels/QQBotChannel.Delivery.cs`, `dotnet/Foxwarm/Channels/QQBotMedia.cs`, `dotnet/Foxwarm/Channels/QQBotRaster.cs`, `dotnet/Foxwarm/Channels/QQBotUpload.cs`

Secondary/integration files: `dotnet/Foxwarm/Channels/ManagedChannels.cs`, `dotnet/Foxwarm/Channels/ExternalChannelContext.cs`, `dotnet/Foxwarm/Channels/ChannelRegistry.cs`, `dotnet/Foxwarm/MessageRouter.External.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ChannelFilePaths.cs`, `dotnet/Foxwarm/Sessions/SessionManager.ChannelTurns.cs`, `dotnet/Foxwarm/Tools/FileToolWrite.cs`, `src/channels/qqbotChannel.ts`, `src/channels/qqbotMedia.ts`, `src/channels/qqbotMediaUpload.ts`

## Purpose and integration

Implements the official AppID/client-secret QQ Bot adapter in the existing managed channel runtime. Configuration, authorization, guest allocation, exact Session resolution, attachments, ordinary broadcast/progress, direct/unified/native file tools, generated images and Setup reload use the [shared external-channel owners](./dotnet-external-channels.md). There is no credential service, second registry, upload service, durable passive state, outbox or reply ledger.

The canonical behavioral reference and decisions are [the QQ unit](./src-channels-qqbot.md), [current group-trigger metadata](../modules/channels.md#d-channel-current-group-trigger-metadata) and [conversation-latest passive context](../modules/channels.md#d-channel-conversation-latest-passive-context). Normal Session/tool paths do not produce QQ reply IDs. Existing persisted source metadata remains readable without making it a current delivery producer.

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

The default intent mask and official token/API endpoints follow the reference adapter. Tokens refresh with a one-minute safety window and bounded 401 retry. Coalesced token acquisition is canceled by the adapter lifetime during stop, allowing the existing managed initializer cleanup to settle even while the token peer is pending. Bot authorization is request-local: asset/COS requests have no bot headers or cookies, use a nonredirecting transport, and cannot inherit API credentials. The dependency seam is test transport injection, not an endpoint/validation option in user configuration.

Gateway state is in memory. HELLO identifies or resumes from READY session ID and dispatch sequence; heartbeat ACK/missed ACK, RECONNECT, resumable/nonresumable INVALID_SESSION, normal/fatal/intents/rate-limit/auth/invalid-session close classes and reconnect delays follow the used reference path. Terminal close codes, including intents rejection 4914/4915, reconnect requests/attempts/socket-open outcomes and missed heartbeat ACKs report through the existing diagnostic/error owner. Close codes and fixed operation stages are retained; vendor close reasons and response bodies are not. Terminal errors update managed `lastError` without redefining registry-based `running` as account health. Complete messages use the installed ws default 100 MiB decoded-message bound. Business-event identity is independent of the transport sequence.

Each .NET connection owns its `ClientWebSocket`, one sender semaphore and retirement/heartbeat lifetime. As with ws's queued `send`, control handling and heartbeat cadence do not await a non-reading peer's writer drain. A missed ACK can retire that connection and open a successor whose sender is independent; stale queued writers cannot target the replacement. A retired connection may finish its close handshake while discovery/reconnect proceeds. Close is nonjoining and aborts its exact old socket after 30 seconds, matching the installed ws default close lifetime. No replay or general recovery machinery is introduced.

## Input and group policy

Targets retain `c2c:`, `group:`, `guild:` and `dm:` scopes; sender identity comes from the corresponding actual author field. C2C/group attachment-only input is supported, while empty guild/DM input and their unsupported media do not enter materialization.

Ordered bounded maps preserve insertion/eviction semantics across .NET removals. Group AT/ordinary representations share business identity, including bounded normalized `msg_seq` and `message_scene.ext` index input. A buffered ordinary message can upgrade to its later AT representation without suppressing the trigger. Dedup is bounded process memory, not exactly-once delivery.

Mention-required groups retain bounded untrusted local context until a reliable native/structured self-mention. All-message mode uses a fixed non-sliding window; zero means immediate input. Mention/current media flush immediately. Slash triggers clear/bypass aggregation before Router command detection. Current event alone owns sender, authorization, passive ID, metadata and deferred media; prior attachments are URL-free previews. Local context takes precedence over bounded platform-history fallback; unavailable platform sender/time is not invented. Arrival TTL, context limit and maximum group count match the reference. Batches detach before any Router await; gateway reconnect preserves them and stop/reload clears them.

The generic ephemeral message hook is used only by QQ. Router captures authorization before guest provisioning, resolves the actual owner, then materializes only originally authorized current media. First guest and denied input fetch/save nothing. Reliable group metadata is placed inside the existing User wrapper after slash detection, survives materialization/history/provider formatting, and creates no parallel persisted mention flag. Other adapters retain their existing eager media order.

## Media bounds and delivery

Inbound assets require allowlisted HTTPS hosts, no userinfo/abnormal port and per-hop redirect validation. Downloads stream into an owned temporary spool with bounded timeout/count/per-file/total and controlled errors/cleanup. Defaults and hard caps match the reference: 20 MiB safe inline raster, 50 MiB generic default, 200 MiB generic hard/total default, eight/default and sixteen/maximum attachments. Main saves by shared atomic path copy; effectively isolated Node transfers retain the fixed 10 MiB whole-buffer path. Raster blobs become canonical references before durable queue/history; original saved bytes and animations are not rewritten. Non-raster/oversized images and direct video/voice remain generic files. Voice uses an allowed WAV helper or valid primary fallback with bounded ASR reference; nested/ambient/guild/DM media stays outside this materializer.

Automatic typing/progress/intermediate/final text resolves each attached conversation's latest ID. Explicit request replies retain their own ingress ID. Generic direct text is proactive; file delivery separately prefers latest context. Generic presentation turn IDs are transient and contain no QQ identity. C2C typing needs a latest ID and does not spend passive quota. Successful passive text/media alone spends the four-success/three-minute per-ID quota. Structured code 40034005 permits one proactive final attempt with the same sequence; arbitrary HTTP/auth/rate/network/permission errors do not infer expiration. Media fallback reuses the just-uploaded `file_info` without re-upload. Automatic final failures are diagnostic-only.

Local outbound files require regular safe prepared sources and have a separate 100 MiB hard cap. Actual JPEG/PNG/GIF/WebP bytes or strict BMP fallback within the image threshold use image type; hints alone cannot classify bytes. Under 5 MiB uses bounded direct Base64 `/files` with `srv_send_msg:false`; at/above uses streamed MD5/SHA1 and the exact first 10,002,432-byte MD5 prefix, prepare, ordered presigned part PUTs, part-finish and completion. Prepare/direct/completion responses, part indexes/ranges and opaque tokens are bounded. HTTPS COS sends have no credential forwarding, redirects or upload retry/cross-flow fallback. Generation checks fence reads, every request stage and final delivery. Caption, ordering and partial effects remain the existing caller's transport outcomes.

## Verification and limits

`QQBotChannelTests`, `QQBotMediaTests`, `QQBotBoundaryTests`, `QQBotSocketLifetimeTests` and `QQBotHostTests` use owned loopback token/gateway/API/asset/COS/provider peers and the actual managed Router and tool paths. They cover authorization/first guest, trigger metadata/commands, dedup/group bounds/TTL, latest passive/quota/expiration, coalesced refresh, exact upload boundaries/hashes, byte probes, redirects/credentials/cleanup, failure fencing, fragmented Unicode and non-reading/silent-close lifetime. Gateway callbacks continue while earlier Router queue admissions are pending, matching the reference adapter. A later command reply confirms that command's handling, so queue assertions separately await the expected admissions. The original frontend helper `dotnet/qqbot-browser.mjs` can run inside the Main host test with `FOXWARM_QQBOT_BROWSER=1`; it checks canonical User/history rendering without changing frontend assets. Browser batches require their separate bounded test unit.

The real CLI Node test includes authorized QQ storage and over-cap rejection. The live MCP mixed-reload test includes all five managed adapters without converting temporary reply contexts into attachments. `dotnet/qqbot-fixture-ts.mjs` executes the actual retained Source adapter/uploader and installed ws client for group upgrade, caller-specific routing, same-sequence expiration, direct-small bytes, streamed wire prefix and default close lifetime. Unchanged storage/native/Windows/other-adapter evidence is not a live QQ qualification.

No real QQ account, entitlement, vendor network or delivery-to-person is qualified. Main TUI, remaining administration commands and the final default entry/service/production-container switch remain later work.
