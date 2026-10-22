# Behavior: messages and turns

For developers and Agents changing input admission, queued steering, or model-request scheduling. This page explains when an input becomes conversation history, when it can affect a request, and why a visible message is not necessarily a completed turn. History retrieval and mutation remain in [conversation and history](./conversation-and-history.md); process lifetime, Stop, Continue, and waits remain in [execution and waiting](./execution-and-waiting.md).

## Which boundary am I observing?

| Boundary | Observable meaning | Not implied |
| --- | --- | --- |
| Channel ingress | An adapter has accepted native input and passed a normalized message to routing. Platform trigger and authorization checks can still prevent Session input. | A model request or committed history row. |
| Accepted queued input | Work is addressed to a Session and retained by its queue/admission path. A busy Session can have several pending inputs. | The running request has seen it, or Chat has a committed message for it. |
| Canonical message append | One logical input becomes one ordered history message with its own sequence and any client identity. | A separate turn or provider request for that message. |
| Session turn | One invocation of the provider/tool loop. It can consume multiple inputs, make several requests, and execute several tool batches. | One human send, one output bubble, or one shell-process lifetime. |
| Logical model request | A particular provider-neutral input and request identity; it can have retry/failover attempts. | One physical provider send or an entire Session turn. |
| Physical attempt | One selected concrete-provider attempt within the bounded request/retry path. | Successful generation, tool execution, or final delivery. |

One owned queue processor serializes a Session's work. Its busy window may cover later turn invocations; busy is not a durable business-task status. The current requesting-model/running-tool/waiting/idle presentation and exact ownership live in [runtime state](../units/src-session-runtime-state.md) and [the turn runner](../units/src-session-turn-runner.md).

A provider result can contain several ordered content items, and supported Responses commentary can commit before the response completes. Consequently, neither an assistant row nor a visible paragraph establishes a request or turn boundary. The canonical [streaming flow](../threads/streaming-pipeline.md#d-streaming-early-commentary-commit) owns the early-commit and retry details.

## What happens when input arrives while the Session is busy?

Ordinary input queues without an automatic busy acknowledgement. The current request is not rewritten in flight, and a running tool is not interrupted merely because input arrived. The runner admits the selected queued batch at its next supported safe point:

- Before a provider request, after any ready compaction work that must precede the append.
- After a provider result, before deciding whether another request is needed.
- After a complete tool-result row, before the next provider iteration.
- Before an eligible bounded retry, after its backoff and exact-owner preparation.

Every currently selected ordinary input remains a separate canonical message in queue order. They may all influence one subsequent request; the runner does not concatenate them into one history message. Provider serializers may normalize adjacent roles for their own protocol without changing these stored boundaries. The [model adoption rules](models-and-requests.md#switching-takes-effect-at-an-adoption-boundary) determine which settings the next attempt uses. A selected batch has a finite boundary: arrivals after selection belong to a later safe point rather than extending an unbounded drain.

The queue is **source-blind**. A different Channel type, configured instance, conversation, passive message ID, or card does not create a new consumption batch or choose an output destination. Source metadata describes provenance only. Real tool-call/result, compaction, Stop, wait, managed-control, authority/mailbox, and lifecycle boundaries still apply. The implementation contract is [source-blind routing](../threads/message-processing-pipeline.md#d-pipeline-source-blind-turn-routing), with [canonical input boundaries](../threads/message-processing-pipeline.md#d-pipeline-canonical-queue-item-boundaries).

While ordinary input waits, Chat shows a bounded body preview, including supported source-wrapped Channel input. The preview is a separate observable result, not another queue item or a committed row. On canonical append, Chat replaces it with the corresponding committed input rather than leaving both visible. [Queue-preview extraction](../units/src-channels-webui.md#d-webui-channel-queue-preview) owns wrapping/sanitization; [history reconciliation](../threads/streaming-pipeline.md#d-streaming-optimistic-message-identity) owns replacing previews with canonical rows.

### Example: a correction arrives during work

Suppose the model has called a tool, and a human sends a correction while that tool runs. The canonical order is the model's tool call, the complete tool-result row, then the correction. The next request can use the correction. It does not appear between the call and its response, and its eventual position does not prove that the human wrote it after seeing the tool result.

If input instead arrives during a request that returns text without tools, the runner checks the ordinary queue after persisting the provider result. With pending input, that result is delivered as intermediate text, the queued inputs append, and another provider iteration runs. Without pending input, it is a final result. Input arriving after the finality decision remains later work; it does not retroactively change an already delivered final.

Eligible retries can consume steering input without waiting for retry exhaustion. A changed committed prefix or already committed commentary can start a new logical request identity while preserving the same bounded physical-attempt budget. This is not a fresh retry budget or an automatic replay of external effects. See [retry input preparation](../threads/message-processing-pipeline.md#d-pipeline-retry-input-safe-point) and the [request journal](../threads/llm-request-journal.md).

## Does the order shown mean the input happened after the preceding output?

No. Canonical order records processing and append order, not a global occurrence clock. Source wrappers retain the source-built time. Inputs/events observed after provider execution or consumed at continuation/retry safe points can gain a separate `queueInputHint` on their existing outer wrapper, warning the model that they may predate preceding output.

This is processing guidance, not a claim that the sender is human, that the input answers the preceding output, or that its occurrence time is known. Initial input batches do not gain the hint merely because they traversed the queue. The body, original hint/time, attachments, client identity, and one-input/one-message boundary are preserved. Historical rows are not reconstructed, and WebUI gets no new hint banner. Details and exclusions remain in [queued-input guidance](../threads/message-processing-pipeline.md#d-pipeline-queued-input-hint).

A canonical `user` role alone does not identify a human sender: inter-session messages, task notifications, timer events, execution completions, and lifecycle inputs can use that role. Inspect trusted source metadata and the actual producer, not role or quoted body text alone.

## Which events wake the model, and which stay quiet?

Delivery, visibility, and triggering are separate properties:

| Operation or event | Expected consequence |
| --- | --- |
| Ordinary admitted user input, inter-session delivery, task assignment/completion, timer or background-exec completion | Uses the ordinary queue path. Idle work can start processing; busy work joins at supported safe points. Active waits follow their existing source/barrier rules. |
| Trusted passive previous-owner task transfer/release notice | Persists in the same queue/inbox without starting a turn or waking its managed owner/controller. It is wait-neutral: it neither clears a wait nor satisfies a listed all-Session source. |
| Internal ready-compaction wake | Lets the owner apply completed context maintenance; it is not an ordinary user instruction and does not clear an active wait. |
| Retry notice, temporary stream, runtime-status update | Presentation, not new model input. A display-only row is not replayed to the provider, summarized, or embedded merely because it is visible. |
| History, status, or task inspection | A read does not itself enqueue a new instruction. Agent tool results still enter the caller's ordinary tool-result path. |
| Manual-fork notice to its parent | An idle parent gets a durable history append without a model wake; a busy parent gets background queued input. A user-created fork is not a delegated assignment merely because it has a parent link. |
| Authorized slash command or channel-authorization reply | Uses the command/request reply path. It does not automatically become a model conversation input. Commands that intentionally enqueue work keep their own behavior. |

Passive means **do not start processing**, not hidden forever. A running turn can consume passive rows at its ordinary safe points, and later ordinary work can consume them in order. Explicit Run queued can process a passive-only queue; restart recovery does not promote passive-only input into model work. The passive flag is trusted internal admission control, not a model-facing argument that ordinary callers can smuggle into queue content. See [passive task notices](../threads/message-processing-pipeline.md#d-pipeline-passive-task-notification).

Wait declarations do not filter out all unrelated activity, and an all-Session barrier can defer matching reports. Reuse [explicit wait semantics](./execution-and-waiting.md#explicit-wait-ends-an-otherwise-finished-turn), rather than treating every queued event as an immediate model wake. Managed Sessions can route input into their manager's inbox instead of starting an independent turn; the current Channel path acknowledges that separately.

## What does a reply or completion signal prove?

A completed provider result is persisted before its ordinary intermediate/final delivery decision. Text with tools or pending ordinary input is intermediate; a terminal result uses final delivery. Each result's remaining text is delivered once on that path, excluding commentary already committed and delivered early. Tool wait, Stop, or a terminal handoff can then close/suspend native presentation without resending the same text.

A generic final lifecycle signal can exist without nonempty text. Only adapters that need lifecycle handling consume an empty final; ordinary text-only platforms do not receive a manufactured blank message. Suspension is distinct from a terminal answer. The delivery behavior owner is [Channels and replies](channels-and-replies.md#where-should-the-agents-ordinary-reply-go); ordering and adapter mechanics remain in [the pipeline](../threads/message-processing-pipeline.md) and [Channel contracts](../modules/channels.md).

An input-acceptance response proves admission at that surface, not model consumption or task success. Likewise, an idle status can coexist briefly with queued input before the runner claims it. WebUI completion notifications require their own armed active-to-idle, empty-queue transition; they are not acknowledgements for a newly submitted message. [Runtime presentation](../threads/session-runtime-presentation.md) and [Session-list notifications](../units/webui-session-list.md) own those observations.

## Change and test entry points

- [Router ingress](../units/src-message-router.md) locates command/authorization handling, source wrappers, media materialization, and busy enqueueing; `src/messageRouter.ts` is the source owner.
- [Turn runner](../units/src-session-turn-runner.md), `src/sessionTurnRunner.ts`, and `src/sessionManager.ts` locate safe-point selection, canonical append, wait transitions, and serial queue ownership. [Process topology](../threads/process-topology-and-rpc.md) owns placement/mailbox mechanics rather than a second set of input semantics.
- `src/sessionQueueBatch.test.ts` covers separate canonical rows, client identities, batch append, and queued-input hints. `src/sessionTurnRunnerDetachedOwner.test.ts` covers different-source batches, provider-time steering, retry/compaction boundaries, and append-failure behavior.
- `src/sessionQueueOptions.test.ts` and `src/sessionWorkerQueuePresentation.test.ts` cover passive ingress and observable queue state. Streaming/commentary and Continue tests are linked from their canonical pages; their rules are not duplicated here.
