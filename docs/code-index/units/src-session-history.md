# Unit: src-session-history

Files: src/session/history.ts, src/session/history.test.ts, src/session/historyCompactRanges.test.ts, src/session/historyCompactPlanRetry.test.ts

## Purpose

Owns session-history mutation and compaction orchestration. It computes thresholds, creates transient compact jobs, runs the bounded plan loop, validates compatible-prefix commits, formats completion markers, applies manual clear/delete/tool-noise operations, and delegates archive/vector work to their domain modules.

Canonical end-to-end contract: [context compaction and recall](../threads/context-compaction-and-recall.md).

## Key exports

### Threshold and job state

- `getDefaultCompactThresholdTokens(session)` — 80% of the resolved model context window.
- `getEffectiveCompactThresholdTokens(session)` — positive session override or default.
- `isAsyncCompactEnabled(session)` — true unless the resolved model explicitly sets `asyncCompact:false`.
- `hasPendingCompactWork`, `discardPendingCompactWork`, `applyCompletedCompactJob` — compact-job lifecycle.

### Candidate and commit helpers

- `resolveCompactionSplitIndex` — recent-tail split that keeps tool-call/response group boundaries.
- `isSingleBlockCompactionStrandedBetweenHigherLevelBlocks` — narrow single-block lift exception.
- `resolveCreateBlockRanges` — validated candidate-to-frontier mapping.
- `buildCreatedBlockFrontierItemsWithPreservedMessages`, `removePreservedMessageFrontierItems` — exact raw-message preservation/removal.
- `formatCompactionCompletionMarker` — canonical compact-completion formatter.

### Operations

- `compactHistory`, `compactHistoryWithSummary` — explicit compaction façades.
- `checkAndCompactIfNeeded`, `processSessionCompactionRequest` — automatic/explicit orchestration.
- `compactToolMessages` — bounded replacement of oversized tool call/response payloads.
- `deleteMessages`, `clearSession` — destructive history operations with frontier/archive coordination.
- `getArchivedMessages` — sequence-range archive query result.
- `forceIndexSession`, `getUsageTotalTokens` — index and provider-usage helpers.

## Internal sections

- **Snapshot creation:** captures rendered history, frontier, prompt/cache context, request options, and a transient session clone.
- **Candidate construction:** applies visibility, protected barriers, atomic tool grouping, recent-tail keep, and raw/block policies.
- **Planning loop:** calls the model, accepts only `submit_compact_plan`, appends actionable feedback, and stops after `COMPACT_FLOW_MAX_ROUNDS`.
- **Result construction:** creates block archive records and replacement frontier items without touching the live session.
- **Compatible commit:** verifies the consumed snapshot prefix, writes archive/block state, replaces only that prefix, rotates the prompt-cache key, persists, and emits completion/reminder events.
- **Background mode:** stores pending job state and later commits through the same compatibility path as awaited mode.

## Dependencies

- `src/session/compactPlan.ts` owns prompt/schema/quota validation.
- `src/session/layeredContext.ts` owns frontier and block operations.
- `src/session/archive.ts` and `archiveStore.ts` own durable source history.
- `src/vector.ts` owns archive and compact-fact indexing.
- `src/llm.ts` owns provider requests and `LlmRequestError`.
- `src/session/goal.ts` owns independent goal-reminder formatting.

## Behavior

- The planning model uses the live prompt-cache key on a clone because the pre-commit prefix/schema lineage is unchanged; canonical ownership is [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Async, awaited, and auto modes use one engine. A terminal provider error, exhausted plan loop, or stale prefix leaves live history/frontier unchanged.
- Async planning may start from a compatible snapshot while the live session is busy. Planning itself is not queued; background completion enqueues only `compact-commit` for safe live application. Canonical scheduling: [D-context-compact-scheduling-boundary](../threads/context-compaction-and-recall.md#d-context-compact-scheduling-boundary).
- Successful prefix replacement rotates `promptCacheKey`.
- Protected lifecycle/frontier items are segment barriers; display-only messages are transparent and not summarized. Prior pure compact-completion notices are the narrow exception: they are transparent to candidate ranges and removed from the entire compatible active frontier only on successful commit, before one current notice is appended. Canonical contract: [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion).
- Each created block carries its normalized facts through archive append; its facts are indexed only after success with that block identity/level/raw range, and indexing is best-effort.
- Goal reminders remain separate system parts from compact-completion metadata.
- Temporary compact progress may be broadcast without becoming authoritative final history.

## Compatibility

- `compactHistoryWithSummary` remains an exported manual façade over the current compact engine.
- `getArchivedMessages` uses the current archive store while JSONL bootstrap/import compatibility remains owned by `archiveStore`.
- Compact completion follows [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion); this unit does not define a second wire contract.

## Design decisions

### D-history-compatible-prefix-commit

A compact job may replace only the live frontier prefix that still matches its snapshot. Concurrent incompatible change converts the result into a safe non-commit.

### D-history-failed-planning-noncommit

A failed planning request cannot submit or partially apply a compact plan. Provider request error semantics are canonical in [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).

### D-history-independent-goal-reminder

A compact completion and a goal reminder remain separate structured system parts so each keeps its own lifecycle meaning.
