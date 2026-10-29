# Behavior: Channels and replies

For developers and Agents changing messaging adapters, conversation bindings, triggers, or reply delivery. A Channel translates platform input/output; a Session owns conversation processing. The Session does not choose a single reply destination from the message that started its turn. Use the linked technical owners for protocol and configuration details rather than treating this page as a platform setup guide.

## Which identity or binding should I change?

**Governing identity distinction; directly selected as channels gained multiple connections and bindings.** Protocol type, configured instance, platform conversation and attached Session are different identities. Routing/configuration designs below must preserve the intended target instead of inferring it from a similarly named field.

| Identity | Meaning |
| --- | --- |
| Channel type | Adapter/platform family, such as Telegram, Matrix, QQ Bot, Weixin, or WeWork. |
| Configured Channel instance | One registered instance, with its own configuration and adapter-local delivery context. Several instances can share a type. |
| Conversation | The room/chat/direct target within that instance. It is not necessarily the sending user. |
| Sender | The actual inbound user identity used for authorization where available. Display names are not identity. |
| Channel target | `<channel-instance-id>:<conversation-id>` for an explicit send. Conversation IDs may themselves contain colons. |
| Session attachment | The persisted binding from one instance/conversation to a Session, with attachment mode/access options. |

One instance/conversation has one current Session binding; one Session can have several attachments. Rebinding changes where later ingress goes and which Session automatically delivers to that target. It does not move old conversation history or create a parent/child relation. A registered adapter and a persisted attachment are different: an attachment does not prove that the configured adapter is online or able to send.

Normal initial starts of eligible external Channel instances are independent: one slow or failed adapter does not prevent the others from starting or hold up the rest of Main startup. Runtime reload instead follows its ordered stop/rebuild/start path. Readiness or failure must be observable for the relevant instance; an HTTP listener, adapter registration, or stored attachment alone is not evidence that its external transport initialized. Startup/retry entry points are in [Main bootstrap](../units/src-index.md#behavior), and reload/status mechanics in [Channel runtime](../units/src-channel-core.md#runtime-behavior).

Authorized first-message routing can create and attach a Session when no attachment exists. A configured attachment whose exact Session is missing fails rather than silently recreating that lifetime. Known failed, unpublished candidate creation uses the existing [creation compensation boundary](../threads/session-lifecycle.md#persistence-and-hydration), limited to resources owned by that invocation, not an existing lifetime adopted during routing. This is not rollback of committed child/Task creation after later notification failure, nor a promise to reverse every creation-related effect. Current first-message creation, guest provisioning, identity reservation, and durable attachment behavior remain in [Session lifecycle](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation) and [session channels](../units/src-session-channels.md).

### What does normal versus send-only mean here?

Normal attachments participate in automatic Session text delivery and session-wide file delivery. A `send-only` attachment still admits authorized inbound input but is excluded from that automatic output and session-file broadcast. The Agent must explicitly address the target when it intends to reply there. The name does not mean the Channel rejects inbound messages, and changing mode does not grant authorization.

The router includes source/mode guidance for the model. An explicit direct send bypasses automatic-attachment selection, not generic tool authorization or platform delivery requirements. Stored `push-only` bindings normalize to current `send-only`; [attachment compatibility](../units/src-session-channels.md#d-session-channels-read-old-write-current) owns read-old/write-current behavior.

## Which platform messages become Session input?

There are two gates: the adapter must admit a native event under its trigger policy, then routing must authorize the source and resolve the Session. Passing one does not imply passing the other. Channel buffer contents are not automatically Session input.

- Internal WebUI/TUI input is trusted at the Channel authorization boundary. External sources use configured authorization or explicit per-attachment allow-all-users behavior.
- The exact `/whoami` query is source-only discovery before authorization, guest provisioning, attachment resolution, queueing, model work, or deferred media materialization. It reveals the current sender/target identity, not credentials or arbitrary Session data. It still needs a native event that the adapter admits; it does not bypass group triggers.
- Other commands retain their authorization and protected-command handling. A user admitted only by an attachment's allow-all-users setting does not thereby gain direct management-command authority.
- Deferred media adapters such as QQ materialize current attachments only after the source was authorized at ingress and the Session was resolved. That is not a blanket claim that every adapter defers every media download: Telegram/Matrix have their existing earlier media preparation paths.

See [identity discovery](../threads/message-processing-pipeline.md#d-pipeline-channel-identity-query), [Channel authorization](../units/src-channel-core.md), and [Router ingress](../units/src-message-router.md).

### QQ group context is background until a trigger is dispatched

QQ provides the concrete adapter-owned buffering/batching path:

| Policy | Before routing to a Session |
| --- | --- |
| `requireMention:true` (default) | Ordinary group events accumulate bounded local context without triggering a turn. A reliable current self-mention consumes that context and dispatches one current input. |
| `requireMention:false` | Ordinary group events use a fixed, non-sliding batch window. The latest event is current; earlier events become context. A mention, current attachments, or a zero window dispatches immediately. |
| Eligible slash command | Clears pending group context and dispatches the current command immediately, without injecting context into command arguments. |

`groupContextLimit` defaults to 10 and accepts 0–50; zero disables preceding context, not the current trigger. The ordinary batch window defaults to five seconds, accepts zero or 250–30,000 ms, and matters only in always mode. Local context uses a five-minute arrival-time bound and bounded per-instance group state. Stop/reload clears that in-memory state; a gateway reconnect preserves it. None of these are persisted Session queues or historical-recall subscriptions.

One dispatched batch is one Channel input and one canonical message, not one input per ambient event. The current trigger alone supplies sender authorization, current media materialization, and passive reply identity. Earlier senders are not individually promoted to authorized directives. Context is escaped, labelled untrusted background; ambient media remains metadata, not downloaded trigger media. When local mention context is absent, the adapter can extract bounded native platform-history text without inventing sender/time facts or materializing nested media.

A reliable QQ mention is the native AT event or an ordinary group event with structured `mentions[].is_you === true`. Text resembling a mention, `bot:true`, display names, or learned/configured IDs are not substitutes. The current-group metadata describes only the current event, never the whole context bundle. Deduplication also handles ordinary/AT representations of the same event. Exact grammar and bounds remain in [QQ Bot](../units/src-channels-qqbot.md) and [current-trigger metadata](../modules/channels.md#d-channel-current-group-trigger-metadata).

### Other adapters do not inherit QQ's trigger policy

Telegram ignores bot-originated messages and normalizes commands addressed to its own bot username; it has no equivalent generic QQ group-context buffer. Matrix ignores its own messages, historical/pagination events and events predating adapter startup, and deduplicates admitted timeline events. Weixin accepts its supported inbound polling messages; WeWork admits supported callbacks/WebSocket messages with its own duplicate handling. Native platform subscription/privacy rules can further limit which events reach any adapter. Do not add a Router-wide mention or batching rule by inference. Source owners are [Telegram/Matrix/Weixin](../units/src-channels-misc.md) and [WeWork](../units/src-channels-wework.md).

## Where should the Agent's ordinary reply go?

Ordinary assistant output uses the Session's eligible attachments; it is not addressed only to the current input's origin. [Queued inputs](messages-and-turns.md#what-happens-when-input-arrives-while-the-session-is-busy) from several instances/conversations can influence the same request. A Channel source wrapper records provenance, not an output target or a queue boundary. This source-blind contract also applies to intermediate text, errors, and generic lifecycle finals; implementation details are in [the message pipeline](../threads/message-processing-pipeline.md#d-pipeline-source-blind-turn-routing).

| Intended output | Correct path and observable effect |
| --- | --- |
| Reply in the current normal conversation | Ordinary assistant text. No extra `send_to_channel` is needed; using both can send duplicate text. |
| Explicitly send to one other target or a send-only attachment | `send_to_channel` addresses that registered instance/conversation. It need not be attached, subject to caller authorization and isolated own-attachment restrictions. |
| Send a file to the current/selected Session's normal attachments | `send_file` with the default current Session or explicit Session selection. It reports delivered/skipped/failed targets; send-only or unsupported targets are skipped. |
| Send a file to one exact target | `send_file` with `channelTargetId`, not also `sessionId`. The adapter must support that delivery; [source-file preparation](files-images-and-attachments.md#preview-download-and-delivery-have-separate-authority) is separate. |
| Reply to a command or report authorization failure | Request-level `ChannelContext.reply`, which can retain the native request's reply context. It is not a source-targeted exception for automatic model output. |

Ordinary automatic broadcast is fire-and-forget, with adapter failures logged rather than one aggregate delivery promise. Worker committed-final delivery has a narrow awaited one-attempt attachment path, but failure still does not roll back canonical model output or automatically resend it. Direct explicit sends instead surface adapter failure to the caller. No generic reliable outbox, cross-route retry, or exactly-once delivery guarantee follows from any of these receipts; [unknown outcomes](persistence-and-recovery.md#unknown-outcomes-require-evidence-not-automatic-repetition) need evidence before repetition. Some adapters have their own bounded retry behavior.

WebUI displays committed history and model streams through its own authenticated realtime/history path; the runner excludes it from ordinary external intermediate/final text delivery to avoid duplicate rows. Explicit WebUI Channel text uses a temporary instant notification, not a new committed assistant row. Its `sendFile` is a successful no-op because browser downloads/Open actions use file/tool metadata, not a platform binary push. Keep those surfaces separate from the history authority described in [conversation and history](./conversation-and-history.md).

## Why can a newer inbound message change where a passive reply appears?

QQ and WeWork choose passive/proactive delivery **inside each adapter**, using bounded in-memory latest context per configured instance and conversation. That context is not a Session turn source, persisted reply ledger, or Worker/tool-context field.

- QQ automatic typing/progress/text uses the latest dispatched inbound message ID for that scoped conversation. Its C2C/group outbound sequence allocator is process-local and shared across instances; reload does not reset it, but restart does not promise global uniqueness. Passive expiry can use the adapter's supported proactive path; proactive platform permissions still matter.
- Opted-in WeWork stream cards follow the latest card in that conversation. A newer inbound supersedes the old card, removes transient thinking/tool status, and preserves substantive text before ongoing output goes to the new card. Without a card, a latest terminal `response_url` callback can be consumed once; otherwise configured proactive delivery applies.
- Valid adapter ingress updates passive association before Router authorization. Thus a rejected current inbound can advance QQ/WeWork automatic reply context even though that content does not become Session history. Untriggered QQ ambient context is still only buffered; it has not been dispatched as the current input.
- Different instances or conversations do not share that latest context. Request-level command/auth replies can remain explicitly bound to their own native request.

Losing adapter-local state on restart/reload does not justify reconstructing a Session reply target or replaying model output. The current route might instead require a fresh inbound or valid proactive permissions. Full policy and WeWork explicit webhook overrides remain at [conversation-latest context](../modules/channels.md#d-channel-conversation-latest-passive-context) and [proactive WeWork delivery](../modules/channels.md#d-channel-wework-aibot-proactive-delivery).

## Is progress another reply or another model input?

Temporary model streams, typing, tool summaries, and native cards are presentation, not incoming instructions or Task updates. Eligible ordinary-text instances can opt into `channelProgress.intervalMs` (30 seconds to 30 minutes). This creates bounded in-memory per-target tool summaries, not persisted conversation rows or a periodic model wake. Omission/false disables it. Native WebUI and active WeWork cards keep their own presentation instead of duplicate fallback text.

A target can receive a standalone progress summary or have pending progress prepended to its next ordinary intermediate/final/error text. Explicit tool-owned channel/file sends bypass that decoration. The exact builtin `wait` contributes no fallback progress. Sends are best-effort, target-local, and cleaned up at terminal/reload boundaries; neither timer cadence nor delivery implies the model is making progress. [Ordinary-text progress](../modules/channels.md#d-channel-ordinary-text-progress) owns the timer and failure mechanics.

A generic final signal can close native presentation without sending blank platform text. Suspension for a wait can leave an active WeWork folded card open across turns, whereas Stop, a terminal error, or a real answer closes it. A newer card or adapter expiry can end that continuity. It is not persisted continuity or evidence that a shell process stopped; see [WeWork folding](../modules/channels.md#d-channel-wework-think-fold) and [execution and waiting](./execution-and-waiting.md).

## Which current platform limits affect implementation choices?

The common Channel interface is not capability parity:

- **QQ Bot:** scoped C2C/group/guild/DM text targets differ. Current inbound/outbound media support is C2C/group, not guild/DM media or arbitrary remote-URL send. Typing is C2C-only with current passive context. Local outgoing files are capped at 100 MiB; bound/isolated-node inbound transfers have a separate 10 MiB cap. [QQ media and delivery](../units/src-channels-qqbot.md) owns format, upload, and configuration bounds.
- **WeWork:** stream aggregation is opt-in and bounded to the adapter's frame size/expiry; process text and answer use different folded regions. Proactive WebSocket media has bounded chunking. A selected WebSocket error does not trigger a webhook fallback because the outcome can be ambiguous. Follow [WeWork](../units/src-channels-wework.md), not a generic retry assumption.
- **Weixin:** replies require a cached per-user context token. It is in memory, so token loss requires a new inbound message before reply. Typing also needs a ticket. The adapter lacks generic `sendFile` support. [Weixin transport](../units/src-weixin.md) owns token/polling details.
- **Telegram/Matrix:** existing Markdown fallback, API retry, upload and media paths differ. There is no common long-text splitter or media capability guarantee merely because both implement `sendMessage`. Their [adapter unit](../units/src-channels-misc.md) is the change entry point.
- **WebUI/TUI:** internal presentation and file affordances are not external platform push contracts. In particular, WebUI's successful file no-op is not evidence that another platform supports files.

## Change and test entry points

- `src/channel.ts`, `src/channelAuth.ts`, [Channel core](../units/src-channel-core.md), and `src/messageRouter.ts` own identities, authorization, trigger handoff, and command/queue boundaries.
- `src/session/channels.ts` and [session channels](../units/src-session-channels.md) own attachments, normal/send-only selection, direct sends, broadcast, and file receipts. `src/session/channels.test.ts` covers those choices.
- `src/channels/qqbotChannel.test.ts` covers mention/always buffering, current-trigger metadata, platform context, dedup, and real Router queue behavior. Media tests are linked from [QQ Bot](../units/src-channels-qqbot.md).
- `src/channelProgress.test.ts` covers fallback cadence/decorations and silent wait; WeWork stream/proactive-route tests and Weixin tests are linked from their adapter owners. [Runtime presentation](../threads/session-runtime-presentation.md) owns WebUI progress/status rather than a parallel Channel transcript.
