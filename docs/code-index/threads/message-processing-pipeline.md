# Thread: message processing pipeline

## Overview

The interactive turn flow from channel input through authorization, queueing, provider/tool iterations, retries, final delivery, and automatic compaction.

## Flow

1. A platform adapter converts native input to `ChannelContext` plus `ChannelMessage` and calls `MessageRouter.handleIncomingMessage`.
2. Router performs channel authorization, normalizes source metadata/mentions, handles slash commands where applicable, and resolves the attached session.
3. Ordinary input enters the session queue through the session-manager façade.
4. The registered trigger invokes `MessageRouter.processSessionQueue`, which directly delegates to its `SessionTurnRunner`. One bound local turn-effects owner carries the exact Session through save, canonical append, busy/wait, and runtime/history events; the runner awaits the rollback-safe persisted busy claim before later turn work, and `continueWithQueuedWork` selects/merges a legal turn source. Only a successfully completed processor may trigger the finish-window trailing handoff; failure in that intentionally spawned processor is logged once without retrying or consuming its durable queue.
5. `runSessionTurn` creates one ephemeral turn identity for its complete provider/tool loop. `llm.chat(parts, session, iteration, options)` carries that identity into each request while building the current model-visible history/prompt/tool schema, resolving concrete or virtual routing, streaming progress, recording the actual concrete provider-qualified model ID, and appending the model result. Model `extraFields` and `extraHeaders` may expand `${TURN_ID}` alongside `${SESSION_CACHE_KEY}`. A queue item consumed inside the same runner invocation keeps the identity; a later `runSessionTurn` invocation gets a new one. Virtual attempt semantics are canonical in [model routing](./model-routing.md).
6. Retry callbacks create/update display-only notices and broadcast concise progress; terminal request exhaustion throws `LlmRequestError`.
7. Model stream deltas become `model-stream-update` events for WebUI/channel progress.
8. After each provider result's model row is persisted/published, the Worker host ingests newly durable mailbox input and the runner peeks the compatible leading queue prefix to update the latest source. The iteration computes `willContinue = hasTools || hasCompatibleInput` and performs exactly one model-text delivery: intermediate when true, committed final when false. Empty terminal results still close an active WeWork stream; WebUI stream presentation remains separate.
9. When function calls exist, the runner publishes structured progress and calls `llm.executeTools`; normal dispatch resolves builtin, MCP, or node tools through permission-aware tool infrastructure. The complete tool row is appended before any compatible queued user rows, so a function call/result pair is never split. A successful `waitAfterHandoff` handoff arms the existing generic wait only after that row is canonical.
10. Compatible queued rows append after the provider text decision and, when tools exist, after the tool row. Tool wait/Stop/managed/tool-stop terminals close active WeWork aggregation when needed without resending model text. Continuing iterations retain the existing compaction and goal-reminder safe points.
11. The same runner performs post-final child-reminder maintenance, releases active state, may continue queued work, and calls `checkAndCompactIfNeeded` with final usage. A reminder queue/persist failure after a terminal provider final is logged without creating a synthetic error model row or a second external final; pre-final and error-path reminder behavior is unchanged.

`src/sessionManager.ts` stores/queues/triggers work but does not implement this loop. The implementation owner is `src/sessionTurnRunner.ts`; `MessageRouter` owns channel ingress and delegates the real local execution path.

An implemented Worker ingress alternative accepts one already-normalized ordinary QueueItem, registers its exact live source context only in Main memory, ensures or spawns an inactive exact Worker generation, appends one durable mailbox intent, and invokes that Worker's same canonical runner. It does not merge/provider-normalize at Main ingress or fall back to local execution after Worker selection. `MessageRouter` selects it for ordinary busy/idle channel input when Session-worker placement injects its submit handler, and every Main-side enqueue producer (timer, wait-timeout, ONBOOT, node events, RPC enqueue, inter-session delivery) shares the same durable boundary through the session-manager sink; managed sessions fail closed retryably at that boundary.

## Modules and units

- [message routing](../modules/message-routing.md) / [src-message-router](../units/src-message-router.md)
- [channels](../modules/channels.md)
- [session core](../modules/session-core.md)
- [LLM](../modules/llm.md)
- [tools and permissions](../modules/tools-and-permissions.md)
- [session context](../modules/session-context.md)

## Queue and source behavior

- Busy-time ordinary input is queued without an obsolete automatic queue acknowledgement.
- Follow-ups can merge into an active tool loop only when the runner's queue-item/source policy allows it.
- For QQ Bot and WeWork passive sources, configured channel instance plus scoped conversation is the merge boundary; platform message/card IDs remain fallback delivery metadata and do not split an otherwise compatible turn.
- `/stop` cancels the current run, then commits all queued message/event inputs to canonical history without running another provider turn. A ready `compact-commit` is applied at the Stop safe point; unrecognized queue records are discarded generically.
- `/dequeue` stops current work if needed and immediately resumes queued items.
- `/retry` atomically claims an idle session and enters the ordinary turn loop directly with `parts:null`; it does not persist queue state, regenerate a completed answer, or add a model-facing retry marker. Compatible input arriving after the claim joins at normal pre-provider and post-tool safe points.

## Retry/error behavior

- Intermediate/final notices are display-only and preferably update one visible record.
- Ordinary non-WebUI channels receive concise retry snippets without requiring a channel edit API.
- Terminal provider failures are exceptions caught at the session turn boundary; fake model-visible `Error:` assistant history is forbidden.

## Invariants

- Only one queue processor claims a session at a time.
- Tool schemas remain stable across normal/side/compact requests when their prefix/schema contract is shared.
- Display-only retry/progress messages never enter provider input, compaction candidates, or embeddings.
- Persisted model messages record the actual provider-qualified model key used for the request.
- `${TURN_ID}` is an ephemeral UUID created at the `runSessionTurn` boundary. It is not persisted as session state, remains stable across retries and tool-loop provider calls in that invocation, and changes when a later invocation starts.
- Final broadcasts use generic turn metadata; the runner does not call platform-specific finish hooks.

## Design decisions

### D-pipeline-stable-tool-schema

Provider schema compatibility belongs in shared model-facing definitions/tests, not per-turn provider-specific mutation.

### D-pipeline-model-attribution

Persist the canonical provider-qualified model key on model messages so mixed-model history is unambiguous.

### D-pipeline-source-boundary

Queued QQ Bot and WeWork follow-ups are compatible when their configured channel instance and scoped conversation match. Different instances or conversations, and different optional `preferDirectReply:true` intents, remain hard boundaries. Platform `msg_id`/stream-card IDs remain in the immutable serializable source as restart/fallback delivery metadata but do not split an otherwise compatible provider turn. The same compatibility check runs after a no-tool provider result but before final delivery: matching input that arrived during that request causes the already canonical non-empty result to be published once as intermediate text, then continues the provider loop. Local intermediate delivery enables Markdown, excludes WebUI and the current WeWork stream, and resolves QQ against the latest matching conversation context; empty text is not sent. Before the next provider request, the same effective usage-threshold guard used after tool calls may request auto-compaction and the loop-top compact safe point applies it. Main channel adapters remain owners of the latest passive context for a conversation under [D-channel-conversation-latest-passive-context](../modules/channels.md#d-channel-conversation-latest-passive-context). Session-worker delivery carries the complete serialized source intent rather than a channel callback across the process boundary, using message/card IDs only as missing-live-context fallback metadata.

### D-pipeline-canonical-queue-item-boundaries

Each logical queued input or event is appended as its own canonical `Message` in queue order, including `parts` items and structured `message` items. A compatible batch may still be consumed before one provider request so tool-loop follow-ups affect that request, but the runner never concatenates queue-item parts. Ready compact commits and platform stream/source boundaries remain queue boundaries. Provider-specific serializers, not persisted history, normalize adjacent same-role messages when a protocol requires it.

### D-pipeline-busy-queue-silence

Busy-time input queues silently; UI/channel queue state is presented by current surfaces rather than an automatic acknowledgement message.

### D-pipeline-display-only-retries

Retries are observable but not model-visible. One updatable display-only notice plus channel snippets is the preferred presentation.

### D-pipeline-worker-intermediate-model-text

Each canonical provider result decides its own text finality after persistence/publication and the compatible-input peek. A result that has tools or compatible queued input is published once as intermediate output; a terminal result uses committed-final delivery in the same iteration. Session-worker placement performs one fixed Main attachment-delivery attempt. The typed operation carries the serialized source so QQ uses its current/latest passive message ID and monotonic sequence; WebUI and active WeWork stream aggregation remain excluded from intermediate delivery, and `turnFinal` is not set. Delivery failure is logged without poisoning, rollback, retry, or outbox. Tool wait/Stop/managed/tool-stop terminals close active WeWork when needed and never resend that model text; no unified tail response or duplicate-suppression flag remains.

### D-pipeline-post-final-child-reminder-failure

After a terminal provider result has made its one final delivery attempt, automatic child-reminder queueing is post-final maintenance. If its real queue/persist/publication operation fails, Foxwarm retains that operation's existing persistence or resynchronization result, logs the failure, and continues ordinary busy release and post-final compaction. It does not append a synthetic error model row or make a second external final. Reminder behavior before final delivery and while presenting a real turn error is unchanged.

### D-pipeline-provider-usage-components

[2026-07-28] Persist provider usage on each generated model message as `__meta.usage`. `outputTokens` always remains the provider's complete output/completion count. A separately exposed `reasoningTokens` value is optional and is a component of that output, never an additive total; aggregate/context accounting remains `cached + input + output`. Map a reasoning component only from the selected provider protocol's documented response field, and leave it absent for protocols that do not expose one. `/status` and `session({ action: "status" })` must use their shared `src/sessionStatus` formatter to display the component without changing the total.

### D-pipeline-control-commands

[2026-07-29, updated 2026-08-01] `/retry` retries a failed/pending LLM turn from current history by directly and atomically claiming the idle session, then running the ordinary turn loop with `parts:null`. It adds no synthetic model-visible marker and never persists retry intent in `Session.queue`; compatible ordinary and structured inputs arriving after the claim join at normal safe points. A genuine `/stop` completion passively commits queued message/event inputs as separate canonical history rows without another provider request, making them visible and removable through ordinary history controls. The Stop boundary stays active through finalization so content queued while persistence is in flight is included in queue order; it closes atomically with the final queue scan, and later input is a new turn. A ready `compact-commit` encountered during Stop finalization is applied at that safe boundary. `QueueItem` exposes only current content/event kinds plus `compact-commit`; unrecognized persisted records are generically discarded without execution or migration. `/dequeue` retains its explicit stop-then-run override and bypasses the passive content-commit path.

### D-pipeline-dispatched-parts-ownership

`runSessionTurn` retains `parts` only until a successful `llm.chat(parts, ...)` returns, because that call has appended non-null parts to canonical history. The runner clears dispatched parts immediately after that return. A compaction boundary before a provider call therefore keeps unsent input for the subsequent call, while a compact commit between tool iterations cannot replay already-persisted input or merge it into later queued input.

### D-pipeline-input-time

Model-visible inbound and lifecycle wrappers receive a stable local `time` attribute when their source builds or normalizes them, before queue/history storage; queues remain opaque to wrapper syntax. The runner does not synthesize an idle-gap time marker at request time. A tool batch persists the successful preceding LLM request timing on only its first function response, and provider serializers render one leading `kind="time"` marker from that response without inspecting prior history or altering the tool's business payload. The duration is measured from the first provider send to the usable successful response, including retry/failover wall time and excluding tool execution.

### D-pipeline-handoff-wait

`send_to_session` and `create_child_session` accept an exact optional `waitAfterHandoff` boolean; the former `waitForReply` name is not read as an alias. After a successful delivery (and, for child creation, a required non-empty initial message whose send is awaited), the handler emits only a hidden post-batch request. The runner first appends the complete tool-result message and finishes tool progress, then reuses the existing persisted generic `startSessionWait` state once and stops LLM recursion. Replies are delivered normally whether the option is true or false; the option only controls whether the successful handoff ends the current turn in a generic any-event wait. The wait is not target-filtered and is not a completion promise. Fast replies already queued before arming are consumed immediately after the handoff turn stops. Multiple successful requests coalesce; a failed handoff requests no wait; a successful flagged handoff still waits when a sibling tool fails. The older explicit `wait` pattern remains supported. If an ordinary explicit wait loses its stop signal because a sibling tool failed, it clears only the wait token it created so no stale wait remains.

### D-pipeline-event-driven-wait

[2026-08-06] Model-facing guidance treats `wait` as event-driven completion of an otherwise-finished turn, not as a polling primitive. Supported inbound user/inter-agent messages and session/system wake events automatically wake an idle waiting session. Compatible work that arrives while the session is generating or executing tools queues and joins at normal provider/tool-loop safe points, subject to the existing source boundaries. Agents do not need short timeout waits to retrieve input; a positive timeout is only a one-shot wake fallback/deadline, while an omitted or zero timeout waits indefinitely.

## Canonical ownership

Terminal provider/request error ownership: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
