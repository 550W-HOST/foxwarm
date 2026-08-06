# Thread: message processing pipeline

## Overview

The interactive turn flow from channel input through authorization, queueing, provider/tool iterations, retries, final delivery, and automatic compaction.

## Flow

1. A platform adapter converts native input to `ChannelContext` plus `ChannelMessage` and calls `MessageRouter.handleIncomingMessage`.
2. Router performs channel authorization, normalizes source metadata/mentions, handles slash commands where applicable, and resolves the attached session.
3. Ordinary input enters the session queue through the session-manager façade.
4. The registered trigger invokes `MessageRouter.processSessionQueue`. `tryClaimSession` provides per-session exclusion and `continueWithQueuedWork` selects/merges a legal turn source.
5. `llm.chat(parts, session, iteration, options)` builds the current model-visible history/prompt/tool schema, resolves concrete or virtual routing, streams progress, records the actual concrete provider-qualified model ID, and appends the model result. Virtual attempt semantics are canonical in [model routing](./model-routing.md).
6. Retry callbacks create/update display-only notices and broadcast concise progress; terminal request exhaustion throws `LlmRequestError`.
7. Model stream deltas become `model-stream-update` events for WebUI/channel progress.
8. When function calls exist, router publishes structured progress and calls `llm.executeTools`; normal dispatch resolves builtin, MCP, or node tools through permission-aware tool infrastructure.
9. Tool results append to history and the loop returns to the provider. Mergeable queued follow-ups may join before the next call only when turn/source boundaries permit.
   A successful `waitAfterHandoff` handoff instead appends the complete tool result, arms the existing generic wait once, and stops recursion before another provider request.
10. A result with no further tool calls is sent through direct source reply/session broadcast with `turnFinal:true`.
11. Router releases active state, may continue queued work, and calls `checkAndCompactIfNeeded` with final usage.

`src/sessionManager.ts` stores/queues/triggers work but does not implement this loop.

## Modules and units

- [message routing](../modules/message-routing.md) / [src-message-router](../units/src-message-router.md)
- [channels](../modules/channels.md)
- [session core](../modules/session-core.md)
- [LLM](../modules/llm.md)
- [tools and permissions](../modules/tools-and-permissions.md)
- [session context](../modules/session-context.md)

## Queue and source behavior

- Busy-time ordinary input is queued without an obsolete automatic queue acknowledgement.
- Follow-ups can merge into an active tool loop only when the router's queue-item/source policy allows it.
- Platform turn identifiers such as WeWork stream IDs are hard merge/final-delivery boundaries.
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
- Final broadcasts use generic turn metadata; router does not call platform-specific finish hooks.

## Design decisions

### D-pipeline-stable-tool-schema

Provider schema compatibility belongs in shared model-facing definitions/tests, not per-turn provider-specific mutation.

### D-pipeline-model-attribution

Persist the canonical provider-qualified model key on model messages so mixed-model history is unambiguous.

### D-pipeline-source-boundary

Queued follow-up merge and progress/final delivery respect explicit platform turn/source identifiers. Different or unbound sources remain separate turns.

### D-pipeline-canonical-queue-item-boundaries

Each logical queued input or event is appended as its own canonical `Message` in queue order, including `parts` items and structured `message` items. A compatible batch may still be consumed before one provider request so tool-loop follow-ups affect that request, but router storage never concatenates queue-item parts. Ready compact commits and platform stream/source boundaries remain queue boundaries. Provider-specific serializers, not persisted history, normalize adjacent same-role messages when a protocol requires it.

### D-pipeline-busy-queue-silence

Busy-time input queues silently; UI/channel queue state is presented by current surfaces rather than an automatic acknowledgement message.

### D-pipeline-display-only-retries

Retries are observable but not model-visible. One updatable display-only notice plus channel snippets is the preferred presentation.

### D-pipeline-provider-usage-components

[2026-07-28] Persist provider usage on each generated model message as `__meta.usage`. `outputTokens` always remains the provider's complete output/completion count. A separately exposed `reasoningTokens` value is optional and is a component of that output, never an additive total; aggregate/context accounting remains `cached + input + output`. Map a reasoning component only from the selected provider protocol's documented response field, and leave it absent for protocols that do not expose one. `/status` and `session({ action: "status" })` must use their shared `src/sessionStatus` formatter to display the component without changing the total.

### D-pipeline-control-commands

[2026-07-29, updated 2026-08-01] `/retry` retries a failed/pending LLM turn from current history by directly and atomically claiming the idle session, then running the ordinary turn loop with `parts:null`. It adds no synthetic model-visible marker and never persists retry intent in `Session.queue`; compatible ordinary and structured inputs arriving after the claim join at normal safe points. A genuine `/stop` completion passively commits queued message/event inputs as separate canonical history rows without another provider request, making them visible and removable through ordinary history controls. The Stop boundary stays active through finalization so content queued while persistence is in flight is included in queue order; it closes atomically with the final queue scan, and later input is a new turn. A ready `compact-commit` encountered during Stop finalization is applied at that safe boundary. `QueueItem` exposes only current content/event kinds plus `compact-commit`; unrecognized persisted records are generically discarded without execution or migration. `/dequeue` retains its explicit stop-then-run override and bypasses the passive content-commit path.

### D-pipeline-dispatched-parts-ownership

`runSessionTurn` retains `parts` only until a successful `llm.chat(parts, ...)` returns, because that call has appended non-null parts to canonical history. The router clears dispatched parts immediately after that return. A compaction boundary before a provider call therefore keeps unsent input for the subsequent call, while a compact commit between tool iterations cannot replay already-persisted input or merge it into later queued input.

### D-pipeline-input-time

Model-visible inbound and lifecycle wrappers receive a stable local `time` attribute when their source builds or normalizes them, before queue/history storage; queues remain opaque to wrapper syntax. The router does not synthesize an idle-gap time marker at request time. A tool batch persists the successful preceding LLM request timing on only its first function response, and provider serializers render one leading `kind="time"` marker from that response without inspecting prior history or altering the tool's business payload. The duration is measured from the first provider send to the usable successful response, including retry/failover wall time and excluding tool execution.

### D-pipeline-handoff-wait

`send_to_session` and `create_child_session` accept an exact optional `waitAfterHandoff` boolean; the former `waitForReply` name is not read as an alias. After a successful delivery (and, for child creation, a required non-empty initial message whose send is awaited), the handler emits only a hidden post-batch request. The router first appends the complete tool-result message and finishes tool progress, then reuses the existing persisted generic `startSessionWait` state once and stops LLM recursion. Replies are delivered normally whether the option is true or false; the option only controls whether the successful handoff ends the current turn in a generic any-event wait. The wait is not target-filtered and is not a completion promise. Fast replies already queued before arming are consumed immediately after the handoff turn stops. Multiple successful requests coalesce; a failed handoff requests no wait; a successful flagged handoff still waits when a sibling tool fails. The older explicit `wait` pattern remains supported. If an ordinary explicit wait loses its stop signal because a sibling tool failed, it clears only the wait token it created so no stale wait remains.

### D-pipeline-event-driven-wait

[2026-08-06] Model-facing guidance treats `wait` as event-driven completion of an otherwise-finished turn, not as a polling primitive. Supported inbound user/inter-agent messages and session/system wake events automatically wake an idle waiting session. Compatible work that arrives while the session is generating or executing tools queues and joins at normal provider/tool-loop safe points, subject to the existing source boundaries. Agents do not need short timeout waits to retrieve input; a positive timeout is only a one-shot wake fallback/deadline, while an omitted or zero timeout waits indefinitely.

## Canonical ownership

Terminal provider/request error ownership: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
