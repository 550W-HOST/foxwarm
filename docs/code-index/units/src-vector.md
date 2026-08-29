# Unit: src-vector

Files: src/vector.ts, src/vectorRuntime.ts, src/vectorLexicalRuntime.ts, src/vectorLexicalRuntime.test.ts, src/vectorLexicalRuntime.disabled.test.ts, src/vectorLexicalPlacement.test.ts, src/vectorLexicalLifecycle.test.ts, src/vectorLexicalRebuild.test.ts, src/vectorLexicalResetDuringRebuild.test.ts, src/vectorLexicalPreinitGenerations.test.ts, src/vectorHybridFusion.ts, src/vectorHybridFusion.test.ts, src/vectorHybridRuntime.test.ts, src/vectorMaintenance.ts, src/vectorService.ts, src/vectorServiceDescriptor.ts, src/vectorFacadeProxy.ts, src/vectorServiceManager.ts, src/vectorWorker.ts, src/archiveSearchIndex.ts, src/archiveSearchIndex.test.ts, src/vector.blockRows.test.ts, src/vector.embeddingSanitize.test.ts, src/vector.indexFailure.test.ts, src/vector.lineage.test.ts, src/vector.maxLatency.test.ts, src/vector.memoryFacts.test.ts, src/vector.rawRebuildProgress.test.ts, src/vector.searchFilters.test.ts, src/vector.searchQuality.test.ts, src/vector.segmentBuilder.test.ts, src/vector.upsert.test.ts, src/vectorMaintenance.test.ts, src/vectorMaintenanceRuntime.test.ts, src/vectorService.smoke.test.ts, src/vectorServiceManager.test.ts, src/vectorExternalPlacement.test.ts, src/vectorPlacementConcurrency.test.ts
Secondary files: src/workerConfig.test.ts

## Purpose

Provides one asynchronous, optionally disabled vector facade with local and supervised-child placement. When enabled, the selected owner indexes archived raw-message segments, summary blocks, and compact-extracted facts in LanceDB and returns metadata-rich semantic locations. Model-facing `recall({ vector_query })` reloads authoritative archive sources from those locations before rendering them. The unit also contains a dark, path-explicit derived SQLite FTS5 core for a future exact-owner hybrid index; Slice 2B-1 does not initialize, backfill, query, or wire that core into runtime behavior.

## Key exports

- `init({ enabled, useWorker | transport })`, `shutdown()` — enter explicit disabled mode, start/drain the owned local/child vector owner, or bind/clear one borrowed external client; production Main passes normalized Vector enablement and `dbWorkers` placement.
- `setVectorServiceManagerFactoryForTests()` — narrow test-only delayed-manager factory seam for placement-race coverage; production retains dynamic manager import.
- `getVectorServiceStatus()` — report local/worker readiness and worker generation/PID for diagnostics.
- `search(query, limit=5, format=true, options?)` — instruction-aware Qwen3 vector query with session/agent/lineage scope, optional regex candidate filters, source-family grouping/diversification, and weak block preference for semantic ties.
- `indexSessionArchive(sessionId, latestSeqHint?, latestBlockIdHint?)` — index one archive.
- `scheduleSessionArchiveIndex(sessionId, latestSeqHint?, latestMessageTokenEstimate?, latestBlockIdHint?)` — threshold/block scheduler with a fixed five-minute raw-content deadline.
- `waitForStartupArchiveVectorBackfill()` — waits for the real checkpoint-selected startup backfill. There is no disconnected global reindex RPC/facade surface.
- `indexMemoryFactsFromCompaction(input)` — best-effort fact upsert.
- `renameSessionArchiveIndex`, `copySessionArchiveIndexCheckpoint`, `getArchiveIndexStatus`, `getArchiveIndexBatchDecision` — lifecycle/checkpoint helpers; status includes durable local maxima, pending counts, and an armed deadline.
- Segment/row construction, token estimation, overlap, and embedding-sanitization helpers exported for tests and callers.
- `indexNewMessages(sessionId, history, lastIndexedPosition?)` — retained history-index compatibility wrapper that delegates to archive indexing.
- `ArchiveSearchIndex.open(path, options)`, document preparation/normalization/query compilation helpers — dark path-explicit SQLite FTS5 core with no module-global connection or runtime caller.

## Current constants and storage

- Table: `messages_v7`.
- Embedding model: `qwen3-embedding:0.6b`; vector dimension: 1024.
- Embeddings use the normalized exact OpenAI-compatible API root from `vector.baseUrl` and append only `/embeddings`.
- Embedding input cap: 1,500 estimated tokens.
- Raw segment target: about 1,200 tokens with about 400 tokens of overlap.
- Schedule threshold: 50 pending messages or 8,000 pending estimated tokens.
- Below threshold with no pending block, the first pending raw content arms one non-sliding, unref'd five-minute owner-local timer.
- Raw rebuild batch size is selectable through the documented vector rebuild environment override.
- Automatic LanceDB maintenance is enabled by default with 24-hour version retention. Raw configuration accepts the designated boolean/object toggle and normalizes before owner use; internal checks run at startup, after bounded mutation volume, and periodically; optimization starts only at the internal version/fragment thresholds. General toggle shape is canonical in [D-config-feature-toggle-shorthand](./src-config.md#d-config-feature-toggle-shorthand).
- Deterministic block and compact-fact rows use one atomic ID-keyed merge per hydrated batch, so crash retries update or insert without per-row delete versions. Raw-tail replacement keeps its separate range-delete and bounded-add checkpoint sequence.
- Dark lexical schema v1 is a separate caller-supplied SQLite DB: metadata versions, independent per-Session raw/block checkpoints, canonical documents, and an external-content FTS5 trigram index. It stores one derived row per raw message/block/fact and is not opened by current Vector initialization.

## Search behavior

1. Embed the query with one stable Qwen3 retrieval instruction; document/index embedding bytes remain unchanged.
2. Apply source-scope predicates.
3. Retrieve an expanded candidate set. If the ANN row window is saturated but source-family collapse/filtering leaves fewer non-deferred diverse sources than requested, double the row window deterministically up to 1,024 rows without re-embedding the query. At an unsaturated window or the hard cap, overlap-deferred families backfill the final result.
4. Clip raw/block/fact rows to archive lineage boundaries.
5. Apply internal include/exclude regex filters when supplied.
6. Collapse raw chunks with the same source range and combine a block with modern fact rows tied to that block. Preserve matched-fact metadata on the canonical family.
7. Rank source families primarily by semantic distance. Source-time recency, fact metadata, and `preferBlocks` break only effectively equal-distance ties.
8. Select a bounded diverse set so strongly overlapping raw ranges do not consume every result when distinct ranges are available.
9. Return formatted previews only when `format=true`; recall uses structured source-family hits (`format=false`) and reloads source archives.

Model-facing `contentFilter` and final preview filtering are owned by the shared context preview renderer, not by the vector table.

Exact/current-Session model-facing recall may supplement these dense families with the nonpersistent Archive identifier side-channel owned by `src/toolsSessionAgent/archiveLexicalRecall.ts`. That side-channel does not change this Vector runtime, table, embeddings, checkpoints, disabled behavior, or RPC descriptor.

`src/archiveSearchIndex.ts` is intentionally absent from this search path in Slice 2B-1. Its identifier/prose lane results and BM25 ranks are test-only library outputs until a later authorized owner-wiring and hybrid-fusion slice.

## Indexing behavior

- Raw archive records become overlapping segment rows; block summaries become one row per block.
- Block rows use deterministic IDs and one atomic ID-keyed merge per hydrated batch, so retrying after a Lance commit but before its SQLite checkpoint updates the same rows instead of creating duplicates.
- Compact facts use deterministic normalized-text IDs scoped to their creating block and encode fact kind/attribution, block identity/level, and that block's raw source range in existing columns.
- Query-only instruction formatting does not alter document rows or require a reindex.
- Inherited fact rows use the block fork cap. Legacy null-block facts require their entire raw range to precede the message fork cap and are discarded rather than clipped if they cross it.
- Raw rebuild queries local message stats first, then loads only the saved overlap tail/new-message range. A saved tail beyond the durable maximum safely falls back to the local minimum, preserving the prior rebuild behavior without materializing the checkpointed prefix. Block indexing reads only IDs after `lastIndexedBlockId`. Bounded batches and safe checkpoint advancement remain unchanged.
- Startup backfill is asynchronous. Search can be temporarily incomplete while checkpoints show pending archive content. Raw messages and full block summaries archived while Vector is disabled retain old checkpoints and are discovered after later enablement. Fact text remains inside the formatted block summary, but dedicated fact rows are not reconstructed for disabled-period compactions; see [D-context-optional-vector](../threads/context-compaction-and-recall.md#d-context-optional-vector).
- Concurrent index requests for one session are coalesced/scheduled rather than running duplicate rebuilds.
- Threshold/block/forced work cancels the pending deadline and runs immediately. Timer fire uses the same serialized per-Session index chain; suffixes arriving during an in-flight run retain a later fixed deadline until indexed. Timers are transient and cleared on resolution/rejection, rename takeover, and shutdown; restart backfill remains recovery.
- Per-session queue cleanup observes both fulfillment and rejection without creating an unhandled rejecting derivative. Direct forced indexing does not allocate an otherwise unconsumed batch waiter; it still rejects to its caller, while real scheduled/coalesced waiters retain one shared completion or rejection and clear state for retry.
- The RPC scheduling method acknowledges accepted hints immediately rather than holding a transport request open until a future indexing threshold flushes.
- Lone UTF-16 surrogates are replaced before embedding calls.
- Display-only messages are not indexed.

## Dependencies

- `src/session/archiveStore.ts` for lineage, checkpoints, and backfill candidates.
- `src/session/archive.ts` and `layeredContext.ts` for local source records.
- `src/session/messageVisibility.ts` for model-visible filtering.
- `src/tokenCount.ts`, model formatting helpers, Ollama embeddings, and LanceDB.
- `src/rpc/` for the placement-independent local/child service contract.

## Process placement

- `vector.ts` is the caller-facing asynchronous facade; compatibility indexing never sends the supplied full history over RPC. Explicit disabled mode creates no manager/client and makes best-effort scheduling/fact hooks no-ops while semantic/direct operations throw `VECTOR_DISABLED`. Main otherwise owns its selected local/worker manager. An enabled Session worker can borrow an external client over its shared reverse transport; disabled workers do not bind the reverse facade. Neither path imports the runtime, opens LanceDB, or falls back locally.
- `vectorFacadeProxy.ts` registers the same bounded vector descriptor on Main but delegates only through the already selected `vector.ts` facade, preserving `dbWorkers` ownership rather than calling `vectorRuntime` directly.
- Facade initialization serializes one exact placement identity across dynamic manager import/start: identical owned or borrowed placement joins, while local-vs-worker, owned-vs-borrowed, and different borrowed transports fail before another owner/client can publish. Shutdown waits for that initialization and preserves an already-published failed manager fence.
- `vectorRuntime.ts` owns LanceDB state and imports the native LanceDB module lazily, so the main process does not load it when `dbWorkers:true`.
- `archiveSearchIndex.ts` accepts one absolute caller-supplied DB path and owns only its returned instance connection. When `vector.lexicalIndex:true`, `vectorLexicalRuntime.ts` opens it only from the selected exact local/child Vector owner at `state/db/archive-search.sqlite`; borrowed facades never open it. Default-disabled startup performs no lexical file/open/schedule side effect.
- `vectorMaintenance.ts` supplies the fair shared/exclusive table-operation gate and coalesced owner-local scheduler. Maintenance drains complete reads and write/checkpoint sequences before `optimize`, and later table operations cannot bypass a pending exclusive run.
- `vectorService.ts` maps bounded request/response DTOs to the same runtime in either placement.
- `vectorServiceManager.ts` starts the child, waits until LanceDB is open, reports retryable unavailability while it is down, and restarts an unexpected exit with bounded backoff. It never opens a local fallback owner after a child failure.
- Graceful drain rejects new RPC requests, waits for accepted RPC and indexing/backfill work, closes LanceDB, and then disconnects the child. Supervisor shutdown retains ownership until exit is observed, escalating through bounded wait, SIGTERM, and SIGKILL; an unconfirmed exit is reported without releasing the fence.
- `vectorWorker.ts` is the child entry point. Archive and vector-checkpoint SQLite remain direct durable inputs; they are not moved behind the vector RPC service.

## Compatibility

`indexNewMessages` remains a runtime compatibility entry that now indexes authoritative archives. It does not restore the former history-position index model.

When top-level `vector` is absent, nonempty legacy `llm.ollamaBaseUrl` enables Vector and normalizes the historical server-root convention to an API root ending in `/v1`. Explicit top-level `vector` always wins.

## Design decisions

### D-vector-fact-same-table

Compact facts share the current table and carry source ranges so ordinary lineage clipping applies without a second fact store.

### D-vector-source-family-ranking

[2026-08-28] Semantic retrieval ranks canonical archive source families rather than individual embedding rows. Exact raw-range chunks collapse together; a block and its modern block-identified facts form one family with bounded matched-fact metadata; strongly overlapping raw families are deferred while distinct ranked ranges remain. Semantic distance is the primary ordering. Source-time recency and block/fact preferences may break only effectively equal-distance ties, so metadata cannot promote a clearly worse semantic match. The hardcoded Qwen3 model receives one stable query-only retrieval instruction, while all document/index embedding input remains unchanged. Candidate retrieval starts with the bounded normal row window and, only when that window is saturated and the pre-backfill diverse-family count remains below the request, doubles deterministically up to a hard 1,024-row cap; the same query vector, scope, lineage, filters, and owner-local maintenance gate are reused throughout. An unsaturated window or the hard cap returns the final selection with overlap-deferred families backfilled, so genuinely overlap-only corpora still fill available slots.

### D-archive-search-index-dark-core

[2026-08-29] Phase 2B Slice 1 adds only a dark derived lexical-index library. One explicit caller-owned SQLite connection stores schema/normalizer metadata, independent raw/block checkpoints, canonical source metadata, and an external-content FTS5 index using NFKC/lower trigram text plus bounded synthetic Han bigram tokens. Opening validates object types, canonical essential table/FTS clauses, required columns, and the unique document identity. The three derived synchronization triggers are defined once and sqlite_master SQL must equal those canonical normalized statements exactly, modulo case, whitespace, and terminal semicolons; extra side effects or reordered operations fail with rebuild-required before writes. Document/trigger/checkpoint changes share one lexical transaction; block replacement removes stale creating-block facts. Selective derived deletion resets the affected checkpoint axis, and block deletion removes its fact rows so authoritative reindex can repair the family. Safe query compilation classifies CamelCase from original bounded spelling before emitting normalized quoted MATCH text. Fork-capped lineage input deduplicates Session IDs and merges conflicting caps to the most restrictive effective values before enforcing the 64-Session bound. No current bootstrap, scheduler, RPC, recall, dense checkpoint, or model-facing behavior uses this library.

### D-vector-dark-lexical-owner-indexing

[2026-08-29] Phase 2B Slice 2 wires the derived lexical DB only as a disabled-by-default exact-Vector-owner indexing lane. `vector.lexicalIndex:true` opens `state/db/archive-search.sqlite`, runs independent bounded raw/block/fact startup backfill and one-writer transactions, and fans accepted Archive hints to independent threshold/block/force/five-minute scheduling without changing dense return/error contracts. Force without hints snapshots current durable local Archive maxima; force targets coalesce monotonically and survive an active run as an immediate serialized follow-up, while newer non-forced suffixes retain ordinary batching. Failed forced work rearms through the bounded deadline path rather than immediate retry looping. When that retry deadline fires, its target snapshot expands through all ordinary hints already pending at that instant, so those sources share the original maximum-latency boundary; only suffixes arriving after the retry run starts receive a later deadline. Lexical open/index/maintenance failure records bounded code/time status and does not fail Lance readiness, Archive commits, or dense checkpoints. Status is additive and remains dark to recall. Rename/copy disables the opted-in lane with a deferred-lifecycle code; hybrid reads, lifecycle migration, shadow swap, and Phase 2A retirement remain later rollout blockers.

### D-vector-persistent-hybrid-read-rollout

[2026-08-29] Phase 2B Slice 3 adds disabled-by-default `vector.hybridSearch`, normalized on only with enabled Vector plus lexical indexing. Dense embedding/search remains mandatory and keeps the Phase 1 query instruction; only after dense success may the exact Vector owner query FTS with the raw user query. RPC descriptor version 3 adds a detailed search result carrying bounded lexical readiness/coverage/use/error metadata while legacy `vector.search()` remains array-compatible. Shared family fusion gives identifier hits stronger bounded rescue weight, prose/CJK weaker weight, collapses block/fact and contained raw families, and preserves dense-only order when no lexical family contributes. Exact-session persistent search requires a complete pre-query fork-capped snapshot and a complete post-query snapshot with the identical authoritative scoped maxima/cap signature; an append during FTS forces `coverageComplete:false` even if lexical catches up before the post-check, so recall uses the bounded Phase 2A side-channel against current Archive authority. Current-agent persistent search may be partial but never performs the Archive-wide fallback. All presentation still reloads Archive authority; FTS text is never returned as preview authority.

[2026-08-29] Exact-session hybrid lookup may consume safe partial persistent FTS hits while ordinary coverage is incomplete; `coverageComplete` remains internal diagnostic/rebuild evidence rather than a normal recall correctness gate. Recall invokes bounded Phase 2A only when persistent lexical is disabled/unconfigured, unready/rebuilding, globally startup-backfilling, or query-errored—not solely for checkpoint lag or an exact pre/post authority change. Current-agent scope still performs no Archive fallback. Model-facing recall makes no status call solely for checkpoint lag and emits no `[vector lag]` notice. Titles distinguish persistent-only, bootstrap/error fallback-only, combined persistent-plus-fallback, and vector-only results.

### D-vector-lexical-lifecycle-and-shadow-recovery

[2026-08-29] Phase 2B Slice 4 keeps both rollout flags default false but completes the opted-in derived lifecycle. Exact-owner rename serializes behind the lexical writer and transactionally rewrites Session/source-family/checkpoint identity when unambiguous; conflict/failure clears only affected derived identities, seeds authoritative target backfill, and never rejects dense/Archive lifecycle success. Pre-placement move rollback/failed-lifetime reset inspects every existing local lexical generation (`main`, `.next`, `.bak`) without creating a missing DB, transactionally clears requested identities in each valid generation, and removes only rebuildable corrupt/incompatible derived generations so startup cannot restore stale lifetime rows; permission/path failures remain untouched and unavailable. Failed Session/fork creation uses internal v4 derived-reset RPC/facade semantics to clear lexical documents/checkpoint plus dense rows/checkpoint so reused IDs inherit no derived lifetime. A reset during shadow rebuild queues behind the exact `.next` writer, transactionally deletes that identity, and retains a pending fence across promotion; promotion/catch-up reapplies resets, removes only derived IDs with no durable Archive branch/reservation, and allows a newly recommitted lifetime to backfill only after the reset deletion. Startup canonicalizes stored derived Session IDs through committed read-only Archive reservations while retaining IDs unknown to Archive outside this shadow-orphan reconciliation. Normal fork creation awaits the committed target baseline before suffix append; both lexical and dense target checkpoints use exact branch message/block caps, and no parent documents are copied. Incompatible schema plus bounded rebuildable SQLite corruption stays unavailable while a one-writer `.next` build resumes from committed checkpoints; permission/path/read-only/open errors remain unavailable without destructive rebuild. Promotion uses at most one `.bak`, directory durability, post-promotion validation, rollback, and later cleanup. Missing-space, rebuild, promotion, and lifecycle diagnostics are bounded codes; rebuild status exposes only readiness/backfill/rebuild/generation metadata. Archive and Lance state are never deleted or mutated by lexical recovery.

### D-vector-max-latency-and-lag-status

[2026-08-28] Preserve the existing message/token/block thresholds but bound ordinary raw-index lag with one transient, non-sliding five-minute timer per Session. Only the active Vector owner holds the unref'd timer; firing enters the canonical serialized index path, while immediate/forced/lifecycle cleanup cancels it. Status reads the archive/checkpoint SQLite authority directly and reports local message/block maxima, pending counts, and the armed deadline without hydrating Session authority.

### D-vector-owner-maintenance

[2026-08-11] Automatic LanceDB maintenance is enabled by default and belongs only to the selected exact vector owner in both local and child placement. Startup, bounded mutation-volume, and periodic checks coalesce inside that owner; no external cron or second direct LanceDB handle performs optimization. The first mutation-threshold request establishes one fixed, non-sliding 60-second deadline: later mutations and periodic requests may coalesce into that run but cannot move its timer. Failed checks use a separate one-hour retry-not-before boundary. A fair exclusive barrier drains complete in-flight table reads and write/checkpoint sequences before maintenance and prevents later table operations from bypassing it. Maintenance compacts and prunes versions older than the configured positive whole-hour retention window, which defaults to 24 hours, without enabling deletion of unverified recent files. Failures remain best-effort, observable, and retryable without rolling back archive authority or crashing the owner.

## Canonical ownership

Source-backed recall is canonical in [D-context-source-backed-recall](../threads/context-compaction-and-recall.md#d-context-source-backed-recall). Index lag/durability is canonical in [D-session-context-best-effort-index](../modules/session-context.md#d-session-context-best-effort-index).
Process placement and failure behavior are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#vector-placement).
Optional/default-disabled behavior and re-enable backfill are canonical in [D-context-optional-vector](../threads/context-compaction-and-recall.md#d-context-optional-vector).
