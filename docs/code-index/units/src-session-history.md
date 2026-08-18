# Unit: src-session-history

Files: src/session/history.ts, src/session/history.test.ts, src/session/historyArchiveRange.test.ts, src/session/historyCompactRanges.test.ts, src/session/historyCompactPlanRetry.test.ts

## Purpose

Owns session-history mutation and compaction orchestration. It computes thresholds, creates transient compact jobs, runs the bounded plan loop, validates compatible-prefix commits, formats completion markers, applies manual clear/delete/historical-response-pruning operations, and delegates archive/vector work to their domain modules.

Canonical end-to-end contract: [context compaction and recall](../threads/context-compaction-and-recall.md).

## Key exports

### Threshold and job state

- `getDefaultCompactThresholdTokens(session)` — 80% of the resolved model context window.
- `getEffectiveCompactThresholdTokens(session)` — positive session override or default.
- `isAsyncCompactEnabled(session)` — true unless the resolved model explicitly sets `asyncCompact:false`.
- `hasPendingCompactWork`, `discardPendingCompactWork`, `applyCompletedCompactJob` — compact-job lifecycle.

### Candidate and commit helpers

- `resolveCompactionSplitIndex` — recent-tail split that keeps tool-call/response group boundaries.
- `buildLayeredCompactCandidateEntries` — active-history-only raw/block candidate construction with structural barriers and token policies.
- `isSingleBlockCompactionStrandedBetweenHigherLevelBlocks` — narrow single-block lift exception.
- `resolveCreateBlockRanges` — materializes history/archive operation metadata from validator-resolved candidate ranges without re-walking source endpoints.
- `buildCreatedBlockHistoryWithPreservedMessages`, `removePreservedMessages` — exact raw-message preservation/removal in authoritative history.
- `formatCompactionCompletionMarker` — canonical compact-completion formatter.

### Operations

- `compactHistory`, `compactHistoryWithSummary` — explicit compaction façades.
- `checkAndCompactIfNeeded`, `processSessionCompactionRequest` — automatic/explicit orchestration.
- `buildToolResponsePrunePlan`, `commitToolResponsePrunePlan` — pure dry-run and exact compatible-prefix commit for historical response-only pruning.
- `compactToolMessages` — manual provider-free façade over the shared response-only pruning primitive.
- `deleteMessages`, `clearSession` — destructive history operations with archive coordination.
- `getArchivedMessages` — sequence-range archive query result.
- `forceIndexSession`, `getUsageTotalTokens` — index and provider-usage helpers.

## Internal sections

- **Snapshot creation:** captures exact active history, prompt/cache context, request options, and a transient session clone; automatic tool-response pruning uses the same complete-history snapshot discipline.
- **Candidate construction:** consumes only the cloned authoritative active history. It applies visibility, positive unique/ordered raw sequence structure, semantic block metadata and raw coverage, protected/noncandidate barriers, preserved-raw rules, atomic grouping for present consecutive call/tool-response runs, recent-tail keep, and raw/block policies without reading or repairing from Archive. A valid call with no following tool row remains an ordinary single-message candidate. Active pruned responses and edited wording are summarized exactly as active history presents them.
- **Planning loop:** calls the model, accepts only `submit_compact_plan`, parses/normalizes/resolves each successful plan once, appends actionable feedback, and stops after `COMPACT_FLOW_MAX_ROUNDS`.
- **Result construction:** maps validator-resolved candidate ranges to active-history indices, raw ranges, and timestamps, then creates block archive records and replacement history messages without touching the live session.
- **Compatible commit:** verifies the consumed snapshot prefix, writes archive/block state, replaces only that prefix while retaining appended suffixes and preserving the prompt-cache key, persists, and emits completion/reminder events.
- **Background mode:** stores pending job state and later commits through the same compatibility path as awaited mode.

## Dependencies

- `src/session/compactPlan.ts` owns prompt/schema/quota validation.
- `src/session/layeredContext.ts` owns block rendering and immutable block append operations.
- `src/session/archive.ts` and `archiveStore.ts` own durable source history.
- `src/vector.ts` owns archive and compact-fact indexing.
- `src/llm.ts` owns provider requests and `LlmRequestError`.
- `src/session/goal.ts` owns independent goal-reminder formatting.

## Behavior

Transient compact-job Session clones preserve raw `effort`, `childModelDefault`, and `childEffortDefault` alongside the selected model so compaction requests use the same provider-neutral request setting without mutating the live owner.

- The planning model uses the live prompt-cache key on a clone because the pre-commit prefix/schema lineage is unchanged; canonical ownership is [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Each transient compact-planning provider call is journaled with purpose `compact-plan`; its canonical prompt/messages and normalized result remain reconstructable without adding temporary planning rows to session history.
- Async, awaited, and auto modes use one engine. A terminal provider error, exhausted plan loop, or stale prefix leaves live history unchanged.
- Session-worker callers bind exact-owner dependencies and force awaited mode at canonical runner safe points or an idle explicit operation; omitting the enqueue dependency structurally prevents background commit records.
- Async planning may start from a compatible snapshot while the live session is busy. Planning itself is not queued; background completion enqueues only `compact-commit` for safe live application. Canonical scheduling: [D-context-compact-scheduling-boundary](../threads/context-compaction-and-recall.md#d-context-compact-scheduling-boundary).
- Successful compaction preserves `promptCacheKey`; `/clear` remains the lineage rotation boundary.
- At the automatic usage trigger, response-only pruning dry-runs first. It retains Unicode-safe line-aware 500/500 response excerpts plus exact recall guidance, commits only when the complete estimated Session falls to at most 50% of model context, and otherwise leaves history untouched for layered planning. Manual `/compact tools` uses the same primitive without that recovery gate and performs no save/version increment on no-op.
- Historical response pruning alone proves exact Archive identity for its recall footer. A committed pruned response then becomes ordinary active-history input to layered compaction; layered planning does not repeat that Archive proof.
- Protected lifecycle/history items are segment barriers; display-only messages are transparent and not summarized. Prior pure compact-completion notices are the narrow exception: they are transparent to candidate ranges and removed from the entire compatible active history only on successful commit, before one current notice is appended. Canonical contract: [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion).
- Each created block carries its normalized facts through archive append; its facts are indexed only after success with that block identity/level/raw range, and indexing is best-effort.
- Goal reminders remain separate system parts from compact-completion metadata.
- Compaction scans consumed history for current `skill({ action: "load" })` calls and persisted legacy `load_skill` calls, then emits only current `skill` reload guidance when loaded instructions were compacted away.
- Temporary compact progress may be broadcast without becoming authoritative final history.

## Compatibility

- `compactHistoryWithSummary` remains an exported manual façade over the current compact engine.
- `getArchivedMessages` uses the SQLite archive authority; legacy JSONL compatibility is owned only by the startup migration.
- `getArchivedMessages` derives the complete effective `availableRange` from archive statistics and reads selected records through the bounded sequence-range query. Point/range requests therefore do not materialize unrelated archive message payloads; result ordering/count/error semantics are unchanged.
- Compact completion follows [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion); this unit does not define a second wire contract.

## Design decisions

### D-history-compatible-prefix-commit

A compact job may replace only the live history snapshot prefix that still matches its snapshot. Concurrent incompatible change converts the result into a safe non-commit.

### D-history-failed-planning-noncommit

A failed planning request cannot submit or partially apply a compact plan. Provider request error semantics are canonical in [D-llm-request-errors](../modules/llm.md#d-llm-request-errors).

### D-history-independent-goal-reminder

A compact completion and a goal reminder remain separate structured system parts so each keeps its own lifecycle meaning.
