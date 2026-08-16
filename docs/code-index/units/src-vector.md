# Unit: src-vector

Files: src/vector.ts, src/vectorRuntime.ts, src/vectorMaintenance.ts, src/vectorService.ts, src/vectorServiceDescriptor.ts, src/vectorFacadeProxy.ts, src/vectorServiceManager.ts, src/vectorWorker.ts, src/vector.blockRows.test.ts, src/vector.embeddingSanitize.test.ts, src/vector.indexFailure.test.ts, src/vector.lineage.test.ts, src/vector.memoryFacts.test.ts, src/vector.rawRebuildProgress.test.ts, src/vector.searchFilters.test.ts, src/vector.segmentBuilder.test.ts, src/vector.upsert.test.ts, src/vectorMaintenance.test.ts, src/vectorMaintenanceRuntime.test.ts, src/vectorService.smoke.test.ts, src/vectorServiceManager.test.ts, src/vectorExternalPlacement.test.ts, src/vectorPlacementConcurrency.test.ts
Secondary files: src/workerConfig.test.ts

## Purpose

Provides one asynchronous, optionally disabled vector facade with local and supervised-child placement. When enabled, the selected owner indexes archived raw-message segments, summary blocks, and compact-extracted facts in LanceDB and returns metadata-rich semantic locations. Model-facing `recall({ vector_query })` reloads authoritative archive sources from those locations before rendering them.

## Key exports

- `init({ enabled, useWorker | transport })`, `shutdown()` — enter explicit disabled mode, start/drain the owned local/child vector owner, or bind/clear one borrowed external client; production Main passes normalized Vector enablement and `dbWorkers` placement.
- `setVectorServiceManagerFactoryForTests()` — narrow test-only delayed-manager factory seam for placement-race coverage; production retains dynamic manager import.
- `getVectorServiceStatus()` — report local/worker readiness and worker generation/PID for diagnostics.
- `search(query, limit=5, format=true, options?)` — vector query with session/agent/lineage scope, optional regex candidate filters, and block preference.
- `indexSessionArchive(sessionId, latestSeqHint?, latestBlockIdHint?)` — index one archive.
- `scheduleSessionArchiveIndex(sessionId, latestSeqHint?, latestMessageTokenEstimate?, latestBlockIdHint?)` — pending-threshold scheduler.
- `waitForStartupArchiveVectorBackfill()` — waits for the real checkpoint-selected startup backfill. There is no disconnected global reindex RPC/facade surface.
- `indexMemoryFactsFromCompaction(input)` — best-effort fact upsert.
- `renameSessionArchiveIndex`, `copySessionArchiveIndexCheckpoint`, `getArchiveIndexStatus`, `getArchiveIndexBatchDecision` — lifecycle/checkpoint helpers.
- Segment/row construction, token estimation, overlap, and embedding-sanitization helpers exported for tests and callers.
- `indexNewMessages(sessionId, history, lastIndexedPosition?)` — retained history-index compatibility wrapper that delegates to archive indexing.

## Current constants and storage

- Table: `messages_v7`.
- Embedding model: `qwen3-embedding:0.6b`; vector dimension: 1024.
- Embeddings use the normalized exact OpenAI-compatible API root from `vector.baseUrl` and append only `/embeddings`.
- Embedding input cap: 1,500 estimated tokens.
- Raw segment target: about 1,200 tokens with about 400 tokens of overlap.
- Schedule threshold: 50 pending messages or 8,000 pending estimated tokens.
- Raw rebuild batch size is selectable through the documented vector rebuild environment override.
- Automatic LanceDB maintenance is enabled by default with 24-hour version retention. Raw configuration accepts the designated boolean/object toggle and normalizes before owner use; internal checks run at startup, after bounded mutation volume, and periodically; optimization starts only at the internal version/fragment thresholds. General toggle shape is canonical in [D-config-feature-toggle-shorthand](./src-config.md#d-config-feature-toggle-shorthand).
- Deterministic block and compact-fact rows use one atomic ID-keyed merge per hydrated batch, so crash retries update or insert without per-row delete versions. Raw-tail replacement keeps its separate range-delete and bounded-add checkpoint sequence.

## Search behavior

1. Embed the query.
2. Apply source-scope predicates.
3. Retrieve an expanded candidate set when regex/block preference is requested.
4. Clip raw/block/fact rows to archive lineage boundaries.
5. Apply internal include/exclude regex filters when supplied.
6. Apply recency and block/fact preference reranking and return `limit` rows.
7. Return formatted previews only when `format=true`; recall uses structured hits (`format=false`) and reloads source archives.

Model-facing `contentFilter` and final preview filtering are owned by the shared context preview renderer, not by the vector table.

## Indexing behavior

- Raw archive records become overlapping segment rows; block summaries become one row per block.
- Block rows use deterministic IDs and one atomic ID-keyed merge per hydrated batch, so retrying after a Lance commit but before its SQLite checkpoint updates the same rows instead of creating duplicates.
- Compact facts use deterministic normalized-text IDs scoped to their creating block and encode fact kind/attribution, block identity/level, and that block's raw source range in existing columns.
- Inherited fact rows use the block fork cap. Legacy null-block facts require their entire raw range to precede the message fork cap and are discarded rather than clipped if they cross it.
- Raw rebuild queries local message stats first, then loads only the saved overlap tail/new-message range. A saved tail beyond the durable maximum safely falls back to the local minimum, preserving the prior rebuild behavior without materializing the checkpointed prefix. Block indexing reads only IDs after `lastIndexedBlockId`. Bounded batches and safe checkpoint advancement remain unchanged.
- Startup backfill is asynchronous. Search can be temporarily incomplete while checkpoints show pending archive content. Raw messages and full block summaries archived while Vector is disabled retain old checkpoints and are discovered after later enablement. Fact text remains inside the formatted block summary, but dedicated fact rows are not reconstructed for disabled-period compactions; see [D-context-optional-vector](../threads/context-compaction-and-recall.md#d-context-optional-vector).
- Concurrent index requests for one session are coalesced/scheduled rather than running duplicate rebuilds.
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

### D-vector-owner-maintenance

[2026-08-11] Automatic LanceDB maintenance is enabled by default and belongs only to the selected exact vector owner in both local and child placement. Startup, bounded mutation-volume, and periodic checks coalesce inside that owner; no external cron or second direct LanceDB handle performs optimization. The first mutation-threshold request establishes one fixed, non-sliding 60-second deadline: later mutations and periodic requests may coalesce into that run but cannot move its timer. Failed checks use a separate one-hour retry-not-before boundary. A fair exclusive barrier drains complete in-flight table reads and write/checkpoint sequences before maintenance and prevents later table operations from bypassing it. Maintenance compacts and prunes versions older than the configured positive whole-hour retention window, which defaults to 24 hours, without enabling deletion of unverified recent files. Failures remain best-effort, observable, and retryable without rolling back archive authority or crashing the owner.

## Canonical ownership

Source-backed recall is canonical in [D-context-source-backed-recall](../threads/context-compaction-and-recall.md#d-context-source-backed-recall). Index lag/durability is canonical in [D-session-context-best-effort-index](../modules/session-context.md#d-session-context-best-effort-index).
Process placement and failure behavior are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#vector-placement).
Optional/default-disabled behavior and re-enable backfill are canonical in [D-context-optional-vector](../threads/context-compaction-and-recall.md#d-context-optional-vector).
