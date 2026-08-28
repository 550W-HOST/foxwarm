# Unit: src-vector

Files: src/vector.ts, src/vectorRuntime.ts, src/vectorMaintenance.ts, src/vectorService.ts, src/vectorServiceDescriptor.ts, src/vectorFacadeProxy.ts, src/vectorServiceManager.ts, src/vectorWorker.ts, src/vector.blockRows.test.ts, src/vector.embeddingSanitize.test.ts, src/vector.indexFailure.test.ts, src/vector.lineage.test.ts, src/vector.maxLatency.test.ts, src/vector.memoryFacts.test.ts, src/vector.rawRebuildProgress.test.ts, src/vector.searchFilters.test.ts, src/vector.searchQuality.test.ts, src/vector.segmentBuilder.test.ts, src/vector.upsert.test.ts, src/vectorMaintenance.test.ts, src/vectorMaintenanceRuntime.test.ts, src/vectorService.smoke.test.ts, src/vectorServiceManager.test.ts, src/vectorExternalPlacement.test.ts, src/vectorPlacementConcurrency.test.ts
Secondary files: src/workerConfig.test.ts

## Purpose

Provides one asynchronous, optionally disabled vector facade with local and supervised-child placement. When enabled, the selected owner indexes archived raw-message segments, summary blocks, and compact-extracted facts in LanceDB and returns metadata-rich semantic locations. Model-facing `recall({ vector_query })` reloads authoritative archive sources from those locations before rendering them.

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

### D-vector-max-latency-and-lag-status

[2026-08-28] Preserve the existing message/token/block thresholds but bound ordinary raw-index lag with one transient, non-sliding five-minute timer per Session. Only the active Vector owner holds the unref'd timer; firing enters the canonical serialized index path, while immediate/forced/lifecycle cleanup cancels it. Status reads the archive/checkpoint SQLite authority directly and reports local message/block maxima, pending counts, and the armed deadline without hydrating Session authority.

### D-vector-owner-maintenance

[2026-08-11] Automatic LanceDB maintenance is enabled by default and belongs only to the selected exact vector owner in both local and child placement. Startup, bounded mutation-volume, and periodic checks coalesce inside that owner; no external cron or second direct LanceDB handle performs optimization. The first mutation-threshold request establishes one fixed, non-sliding 60-second deadline: later mutations and periodic requests may coalesce into that run but cannot move its timer. Failed checks use a separate one-hour retry-not-before boundary. A fair exclusive barrier drains complete in-flight table reads and write/checkpoint sequences before maintenance and prevents later table operations from bypassing it. Maintenance compacts and prunes versions older than the configured positive whole-hour retention window, which defaults to 24 hours, without enabling deletion of unverified recent files. Failures remain best-effort, observable, and retryable without rolling back archive authority or crashing the owner.

## Canonical ownership

Source-backed recall is canonical in [D-context-source-backed-recall](../threads/context-compaction-and-recall.md#d-context-source-backed-recall). Index lag/durability is canonical in [D-session-context-best-effort-index](../modules/session-context.md#d-session-context-best-effort-index).
Process placement and failure behavior are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#vector-placement).
Optional/default-disabled behavior and re-enable backfill are canonical in [D-context-optional-vector](../threads/context-compaction-and-recall.md#d-context-optional-vector).
