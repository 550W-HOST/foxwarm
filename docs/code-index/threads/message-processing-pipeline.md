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
- `/stop` cancels the current run and leaves queued work pending.
- `/dequeue` stops current work if needed and immediately resumes queued items.
- `/retry` inserts an internal retry item using current model-visible history and `parts:null`; it does not regenerate a completed answer or add a model-facing retry marker.

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

### D-pipeline-busy-queue-silence

Busy-time input queues silently; UI/channel queue state is presented by current surfaces rather than an automatic acknowledgement message.

### D-pipeline-display-only-retries

Retries are observable but not model-visible. One updatable display-only notice plus channel snippets is the preferred presentation.

### D-pipeline-control-commands

`/retry` retries a failed/pending LLM turn from current history. `/stop` preserves queued work; `/dequeue` proceeds with it.

## Canonical ownership

Terminal provider/request error ownership: [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).
