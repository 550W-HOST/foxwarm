# Thread: message processing pipeline

## Overview

The interactive turn flow from channel input through authorization, queueing, provider/tool iterations, retries, final delivery, and automatic compaction.

## Flow

1. A platform adapter converts native input to `ChannelContext` plus `ChannelMessage` and calls `MessageRouter.handleIncomingMessage`.
2. Router performs channel authorization, normalizes source metadata/mentions, handles slash commands where applicable, and resolves the attached session.
3. Ordinary input enters the session queue through the session-manager façade.
4. The registered trigger invokes `MessageRouter.processSessionQueue`, which directly delegates to its `SessionTurnRunner`. One bound local turn-effects owner carries the exact Session through save, canonical append, busy/wait, and runtime/history events. One outer processor acquires the reentry guard and rollback-safe persisted busy claim once, then iteratively selects the next owned action: requested retry, leading compact commit, or one source-compatible queued turn batch. It performs the ordinary busy release once after the selected actions drain. Only a successfully completed processor may trigger the finish-window trailing handoff; failure in that intentionally spawned processor is logged once without retrying or consuming its durable queue.
5. Each selected queued turn invokes `runSessionTurn` once and creates one ephemeral turn identity for only that source turn's complete provider/tool loop. `llm.chat(parts, session, iteration, options)` carries that identity into each request while building the current model-visible history/prompt/tool schema, resolving concrete or virtual routing, streaming progress, recording the actual concrete provider-qualified model ID, and appending the model result. Model `extraFields` and `extraHeaders` may expand `${TURN_ID}` alongside `${SESSION_CACHE_KEY}`. Compatible input consumed inside the same invocation keeps the identity; a source-incompatible later outer turn gets a fresh one without recursively calling the queue processor. Virtual attempt semantics are canonical in [model routing](./model-routing.md).
6. Retry callbacks create/update display-only notices and broadcast concise progress; terminal request exhaustion throws `LlmRequestError`.
7. Model stream deltas become `model-stream-update` events for WebUI/channel progress.
8. After each provider result's model row is persisted/published, the Worker host ingests newly durable mailbox input and the runner peeks the compatible leading queue prefix to update the latest source. The iteration computes `willContinue = hasTools || hasCompatibleInput` and performs exactly one model-text delivery: intermediate when true, committed final when false. Empty terminal results still close an active WeWork stream; WebUI stream presentation remains separate.
9. When function calls exist, the runner publishes structured progress and calls `llm.executeTools`; normal dispatch resolves builtin, MCP, or node tools through permission-aware tool infrastructure. The complete tool row is appended before any compatible queued user rows, so a function call/result pair is never split. A successful `waitAfterHandoff` handoff arms the existing activity wait only after that row is canonical.
10. Compatible queued rows append after the provider text decision and, when tools exist, after the tool row. Tool wait/Stop/managed/tool-stop terminals close active WeWork aggregation when needed without resending model text. Continuing iterations retain the existing compaction and goal-reminder safe points.
11. The same turn invocation performs post-final child-reminder maintenance and calls `checkAndCompactIfNeeded` with final usage, then returns to the outer action loop. A reminder queue/persist failure after a terminal provider final is logged without creating a synthetic error model row or a second external final; pre-final and error-path reminder behavior is unchanged. Ordinary active-state release and later queued actions belong only to the outer processor; narrow Stop/fenced cleanup owns its exact release attempt, and the outer processor does not retry it after failure restores busy authority.

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
- `/stop` cancels only the current main run, then commits queued message/event inputs to canonical history without running another provider turn. It never cancels compact planning. `/stop compact` independently cancels active/pending compaction without setting `stopping`, aborting the ordinary provider request, or consuming ordinary queue rows. If `/stop` is issued while a live main turn awaits synchronous automatic compaction, that compact finishes before normal Stop finalization; if the Session is busy only for an idle-started standalone awaited compact, `/stop` reports that no main run was stopped and leaves the next input unpoisoned.
- `/dequeue` stops current work if needed and immediately resumes queued items. Under Session-worker placement, one typed exact-owner control counts the hot queue plus already-durable pending Worker ingress, signals `stopping`/`runQueuedAfterStop` and aborts an active provider without waiting behind the turn, then ingests pending input at the stop-override safe point so the same outer action loop continues it. Idle queued work uses that same canonical runner; no dequeue mailbox record or second runner exists.
- `/continue` enters the ordinary turn loop directly with `parts:null` only for a derived interrupted idle turn. The public `/retry` command is removed; internal SessionRuntime/RPC retry names remain implementation details. Exact-owner history validation prevents continuation after a completed answer. Under Session-worker placement, slash and WebUI callers ensure the exact Worker owner and invoke that same canonical entry with serialized source/finality metadata; no Main stub mutation, mailbox row, or second queue exists. If the Worker response is lost after invocation, the caller reports an unknown outcome that may already be committed/delivered and tells the user to inspect history; it never labels that state a definite failure or runs it automatically again. Compatible input arriving after the claim joins at normal safe points.

## Retry/error behavior

- Intermediate/final notices are display-only and preferably update one visible record.
- Ordinary non-WebUI channels receive concise retry snippets without requiring a channel edit API.
- Terminal provider failures are exceptions caught at the session turn boundary; fake model-visible `Error:` assistant history is forbidden.

## Invariants

- Only one queue processor claims a session at a time.
- Ordinary queued continuation is iterative under that one processor claim; a source turn never recursively invokes a later source turn.
- Tool schemas remain stable across normal/side/compact requests when their prefix/schema contract is shared.
- Display-only retry/progress messages never enter provider input, compaction candidates, or embeddings.
- Persisted model messages record the actual provider-qualified model key used for the request.
- `${TURN_ID}` is an ephemeral UUID created at the `runSessionTurn` boundary. It is not persisted as session state, remains stable across retries and tool-loop provider calls in that invocation, and changes when a later invocation starts.
- Final broadcasts use generic turn metadata; the runner does not call platform-specific finish hooks.

## Design decisions

### D-pipeline-stable-tool-schema

Provider schema compatibility belongs in shared model-facing definitions/tests, not per-turn provider-specific mutation.

### D-pipeline-owned-session-action-loop

[2026-08-10] One owned-session processor acquires the reentry guard and awaited busy claim once, then iteratively selects requested retry, leading compact commit, or one source-compatible queued turn batch. `runSessionTurn` processes exactly one selected source turn and never recursively continues later outer work. Separate source turns receive fresh `${TURN_ID}` values even when they share one owned busy window. A compact already trailing a selected source batch remains the next outer action; compaction that becomes ready during that source's provider/tool loop still uses the established in-turn safe points. A newly activated managed step runs until `lastStepResult.stepId` matches its exact `currentStep.stepId`; that matching yield then suppresses later outer selection and automatic finish-window handoff while the controller consumes it. The outer processor performs the ordinary busy release once. Stop finalization and fenced maintenance instead own their exact turn-level release attempt; after that ownership transfers, a restored-busy failure propagates without a generic outer retry. The established Worker effect may still perform its one explicitly authorized resynchronization retry inside that single layer call. At most one fresh processor is scheduled for ordinary finish-window work after removing the guard.

### D-pipeline-model-attribution

Persist the canonical provider-qualified model key on model messages so mixed-model history is unambiguous.

### D-pipeline-source-boundary

Queued QQ Bot and WeWork follow-ups are compatible when their configured channel instance and scoped conversation match. Different instances or conversations, and different optional `preferDirectReply:true` intents, remain hard boundaries. Platform `msg_id`/stream-card IDs remain in the immutable serializable source as restart/fallback delivery metadata but do not split an otherwise compatible provider turn. The same compatibility check runs after a no-tool provider result but before final delivery: matching input that arrived during that request causes the already canonical non-empty result to be published once as intermediate text, then continues the provider loop. Local intermediate delivery enables Markdown, excludes WebUI and the current WeWork stream, and resolves QQ against the latest matching conversation context; empty text is not sent. Before the next provider request, the same effective usage-threshold guard used after tool calls may request auto-compaction and the loop-top compact safe point applies it. Main channel adapters remain owners of the latest passive context for a conversation under [D-channel-conversation-latest-passive-context](../modules/channels.md#d-channel-conversation-latest-passive-context). Session-worker delivery carries the complete serialized source intent rather than a channel callback across the process boundary, using message/card IDs only as missing-live-context fallback metadata.

### D-pipeline-canonical-queue-item-boundaries

Each logical queued input or event is appended as its own canonical `Message` in queue order, including `parts` items and structured `message` items. A compatible batch may still be consumed before one provider request so tool-loop follow-ups affect that request, but the runner never concatenates queue-item parts. Ready compact commits and platform stream/source boundaries remain queue boundaries. Provider-specific serializers, not persisted history, normalize adjacent same-role messages when a protocol requires it.

### D-pipeline-busy-queue-silence

Busy-time input queues silently; UI/channel queue state is presented by current surfaces rather than an automatic acknowledgement message.

### D-pipeline-display-only-retries

Retries are observable but not model-visible. One updatable display-only notice plus channel snippets is the preferred presentation. Within one physical request, a consecutive retry with the same bounded status-and-reason descriptor renders `(same error)` in the display notice and channel snippet while retaining the actual event metadata. Ordinary channels receive only the first and terminal-failure snippets; an active WeWork stream-card target also receives intermediate-only snippets with its current exact target binding. WebUI remains history/SSE-only for this presentation.

### D-pipeline-worker-intermediate-model-text

Each canonical provider result decides its own text finality after persistence/publication and the compatible-input peek. A result that has tools or compatible queued input is published once as intermediate output; a terminal result uses committed-final delivery in the same iteration. Session-worker placement performs one fixed Main attachment-delivery attempt. The typed operation carries the serialized source so QQ uses its current/latest passive message ID and monotonic sequence; WebUI and active WeWork stream aggregation remain excluded from intermediate delivery, and `turnFinal` is not set. Delivery failure is logged without poisoning, rollback, retry, or outbox. Tool wait/Stop/managed/tool-stop terminals close active WeWork when needed and never resend that model text; no unified tail response or duplicate-suppression flag remains.

### D-pipeline-post-final-child-reminder-failure

After a terminal provider result has made its one final delivery attempt, automatic child-reminder queueing is post-final maintenance. If its real queue/persist/publication operation fails, Foxwarm retains that operation's existing persistence or resynchronization result, logs the failure, and continues ordinary busy release and post-final compaction. It does not append a synthetic error model row or make a second external final. Reminder behavior before final delivery and while presenting a real turn error is unchanged.

### D-pipeline-persisted-child-handoff-boundary

[2026-08-26] Child-reminder decisions for newly classified input use one optional boundary persisted in authoritative per-Session semantic JSON. Direct-user input replaces any older boundary with a no-report boundary. Inter-session input from the current direct child is transparent; input from the current parent or any other non-child establishes an unresolved report-required boundary. Maintenance/system activity is transparent. Main classifies the source relation at canonical inter-session ingress and carries the bounded optional classification through QueueItem/mailbox normalization so a Worker owner does not query Main topology at turn end.

Only a successful `send_to_session` whose resolved target equals the current Session's actual parent, or a terminal model response ending in `[NO_ACTION]`, resolves a report-required boundary. Failed calls, mere function-call presence, and successful sends elsewhere do not. Stop's passive queued-content commit applies meaningful boundaries in queue order and atomically persists the last resulting boundary with its bulk history append; a precommit failure restores the prior boundary, while an authority-postcommit failure retains the committed result. The existing reminder is queued only for an unresolved report-required boundary after the ordinary terminal/model-visible/error/empty-queue guards pass. Sessions without this state retain the existing backward scan exactly and are not seeded from it; they switch to the state path only when a later classified direct-user or non-child inter-session item is canonically consumed. Fork/new-session construction must not copy a stale boundary from another lifetime, while existing Session move/relation semantics preserve the same lifetime's state.

### D-pipeline-provider-usage-components

[2026-07-28] Persist provider usage on each generated model message as `__meta.usage`. `outputTokens` always remains the provider's complete output/completion count. A separately exposed `reasoningTokens` value is optional and is a component of that output, never an additive total; aggregate/context accounting remains `cached + input + output`. Map a reasoning component only from the selected provider protocol's documented response field, and leave it absent for protocols that do not expose one. `/status` and `session({ action: "status" })` must use their shared `src/sessionStatus` formatter to display the component without changing the total.

### D-pipeline-control-commands

[2026-07-29, updated 2026-08-15] The public continuation command is `/continue`; `/retry` is removed rather than retained as an alias. Continue means resume an interrupted current turn, not regenerate the previous answer. It may appear in WebUI only in the idle runtime-status bubble as `Turn interrupted`; LLM retry notices remain visible display-only history but have no inline action. Temporary/optimistic/streaming rows, queued previews, and nested/archive timelines never drive availability.

Availability is derived from committed current-session history without persisted turn state. Ignore trailing canonical `compact-completed` lifecycle markers, including the exact generated two-part completion row when `goalReminder:true` plus `goalReminderKind:'compact-completion'` identifies its paired canonical goal-reminder part, and ignore display-only notices except that `noticeType:'llm-retry'` is itself incomplete. Ordinary standalone/interval goal reminders, compact-completion metadata without the marker, and markers mixed with unrelated content remain non-compact system input. The effective last direct user or non-compact system message is incomplete. A final model row is complete only when it has nonempty ordinary text and no unresolved function call. Other dangling/empty model tool calls and ordinary tool-result rows are incomplete. For a trailing tool result, use only the nearest relevant preceding model tool-call batch: every call and response must form a unique one-to-one match by exact nonempty ID and tool name, with no missing, extra, duplicate, or mismatched member. Historical effective-bare `wait` calls remain classifier inputs for old history only; current calls are always explicitly sourced/parameterized. Successful `send_to_session`/`create_child_session` calls with `waitAfterHandoff:true` remain terminal completions. A current parameterized wait is suppressed by canonical waiting runtime state and becomes continuable only after that wait ends without a later complete model answer. Server and WebUI keep pure equivalent classifiers covered by the same fixture matrix.

Before running, the exact local or Worker Session owner revalidates current runtime/history and rejects completed or actively waiting sessions. Continue then directly and atomically claims the idle session and runs the ordinary turn loop with `parts:null`, a fresh `${TURN_ID}`, no synthetic model-visible marker, and no persisted queue/continuation intent. The existing internal SessionRuntime/RPC `retry` operation/error names may remain. Compatible ordinary and structured inputs arriving after the claim join at normal safe points. A lost Worker response is reported as an unknown outcome requiring history inspection, never a definite failure or automatic repeat.

A genuine `/stop` completion passively commits queued message/event inputs as separate canonical history rows without another provider request, making them visible and removable through ordinary history controls. Under Worker placement, Stop captures the exact durable mailbox boundary while holding ordinary ingress admission, signals/aborts immediately, and ingests through that boundary during finalization without a detached stale `stopping=true` rewrite. The RPC reports success only after the existing serialized turn lane has persisted that canonical finalization; a bounded deadline or lost response is outcome-unknown rather than false success, with no separate persisted marker or control queue. The boundary closes atomically with the final queue scan, and later input is a new turn. A ready `compact-commit` encountered during Stop finalization is applied at that safe boundary. `QueueItem` exposes only current content/event kinds plus `compact-commit`; unrecognized persisted records are generically discarded without execution or migration. `/dequeue` retains its explicit stop-then-run override and bypasses the passive content-commit path.

For a Worker-owned turn, ordinary input can already be durable in that exact owner's mailbox while a provider or tool phase is between ingestion safe points. The exact Worker dequeue operation includes that pending input in its decision without consulting a Main projection. Provider-time and post-tool ingestion-to-consume boundaries recheck the stop override before folding compatible rows into the current turn; post-tool rows remain queued. Turn finalization ingests any remaining durable prefix before clearing `runQueuedAfterStop`, allowing the existing outer action loop and busy claim to select the queued work. The control operation itself is never represented as a queue or mailbox item.

### D-pipeline-dispatched-parts-ownership

`runSessionTurn` retains `parts` only until a successful `llm.chat(parts, ...)` returns, because that call has appended non-null parts to canonical history. The runner clears dispatched parts immediately after that return. A compaction boundary before a provider call therefore keeps unsent input for the subsequent call, while a compact commit between tool iterations cannot replay already-persisted input or merge it into later queued input.

### D-pipeline-input-time

Model-visible inbound and lifecycle wrappers receive a stable local `time` attribute when their source builds or normalizes them, before queue/history storage; queues remain opaque to wrapper syntax. The runner does not synthesize an idle-gap time marker at request time. A tool batch persists the successful preceding LLM request timing on only its first function response, and provider serializers render one leading `kind="time"` marker from that response without inspecting prior history or altering the tool's business payload. The duration is measured monotonically from the first provider send to the usable successful response, including retry/failover wall time and excluding tool execution.

Every successfully persisted assistant message also carries `__meta.llmRequestTiming` with a wall-clock `startedAt`/`completedAt` pair and the monotonic `durationMs`; the successful journal result retains the same logical-request timing so recovery does not discard it. The WebUI usage badge labels that duration `API`. It derives `BETWEEN` from the previous timed model request's completion to the current request's start, leaving tool, queue, user, and local orchestration rows in the interval. This makes cache changes and the work performed between provider calls directly comparable. A model row with missing or invalid legacy timing breaks the chain rather than permitting an estimate across unknown history. Collapsed durations use at most two non-zero units; expanded details retain millisecond precision. A collapsed multi-call tool group sums its API durations and only the inter-request gaps after the group's first call, excluding work that preceded the group.

### D-pipeline-handoff-wait

`send_to_session` and `create_child_session` accept an exact optional `waitAfterHandoff` boolean; the former `waitForReply` name is not read as an alias. After a successful delivery (and, for child creation, a required non-empty initial message whose send is awaited), the handler emits only a hidden post-batch request. The runner first appends the complete tool-result message and finishes tool progress, then reuses the existing persisted `startSessionWait` state once and stops LLM recursion. Replies are delivered normally whether the option is true or false; the option only controls whether the successful handoff ends the current turn and waits for new session activity. The wait is not target-filtered and does not wait for task completion. Fast replies already queued before arming are consumed immediately after the handoff turn stops. Multiple successful requests coalesce; a failed handoff requests no wait; a successful flagged handoff still waits when a sibling tool fails. The older explicit `wait` pattern remains supported. If an ordinary explicit wait loses its stop signal because a sibling tool failed, it clears only the wait token it created so no stale wait remains.

### D-pipeline-activity-wait

[2026-08-06, updated 2026-08-20] Model-facing guidance describes `wait` as pausing an otherwise-finished turn until new session activity arrives. Supported user/inter-agent messages and session/system activity wake an idle waiting session. Compatible input received while the session is generating or executing tools queues and joins at normal provider/tool-loop safe points, subject to the existing source boundaries. Use `wait` only when no useful response or tool work remains; a positive timeout is a one-shot fallback wake rather than polling, while an omitted or zero timeout waits without a deadline.

`waitAllSessions` retains the all-report barrier and normalizes to at least two distinct accessible non-self Session IDs. `waitAnySessions` normalizes to at least one and records expected progress sources without filtering ordinary wake activity; the two Session modes are mutually exclusive. Current calls additionally may declare exact owned active/queued-completion `waitExecIds`, `waitForInput:true`, or a positive `wakeIfNoActivityAfterSeconds` fallback. At least one source/fallback is mandatory, and model-facing `timeoutSeconds` has no alias. Persisted legacy waits remain readable through their internal `timeoutSeconds` representation but do not acquire current declaration/quiescence semantics.

Main reconstructs a bounded reverse dependency index from catalog/runtime wait projections and updates it from existing Session state/queue/runtime transitions. Each affected dependency-only waiter receives a debounced grace/recheck; there is no global poller. Main traverses bounded immutable projections across declared dependencies; queued or active work, a finite fallback, an active exec source, explicit external input, or a transitive dependency reaching one of those is an observed progress path. A closed component without one receives at most one durable `wait-sources-quiescent` system event per unchanged graph fingerprint. The exact Session owner atomically checks the expected current wait ID, records the fingerprint in a separate bounded semantic receipt list, and admits the nudge through the ordinary queue transition; generic external-event receipt eviction cannot recreate the same nudge. Successful flagged handoff records the full deduplicated resolved flagged-target set as `waitAnySessions` while retaining non-filtering fast-reply behavior.

## Canonical ownership

Terminal provider/request error ownership: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
