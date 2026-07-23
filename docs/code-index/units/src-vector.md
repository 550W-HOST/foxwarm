# Unit: src-vector

Files: src/vector.ts, src/vector.blockRows.test.ts, src/vector.embeddingSanitize.test.ts, src/vector.lineage.test.ts, src/vector.rawRebuildProgress.test.ts, src/vector.searchFilters.test.ts, src/vector.segmentBuilder.test.ts

## Purpose

Indexes archived raw-message segments, summary blocks, and compact-extracted facts in LanceDB and returns metadata-rich semantic locations. Model-facing `recall({ vector_query })` reloads authoritative archive sources from those locations before rendering them.

## Key exports

- `init()` — open/create `messages_v7` and start non-blocking archive backfill.
- `search(query, limit=5, format=true, options?)` — vector query with session/agent/lineage scope, optional regex candidate filters, and block preference.
- `getContextAround(timestamp, limit=10)` — raw rows overlapping a 30-minute window around a timestamp.
- `indexSessionArchive(sessionId, latestSeqHint?, latestBlockIdHint?)` — index one archive.
- `scheduleSessionArchiveIndex(sessionId, latestSeqHint?, latestMessageTokenEstimate?, latestBlockIdHint?)` — pending-threshold scheduler.
- `indexAllSessionArchives(sessionIds?)`, `waitForStartupArchiveVectorBackfill()` — backfill controls.
- `indexMemoryFactsFromCompaction(input)` — best-effort fact upsert.
- `renameSessionArchiveIndex`, `copySessionArchiveIndexCheckpoint`, `getArchiveIndexStatus`, `getArchiveIndexBatchDecision` — lifecycle/checkpoint helpers.
- Segment/row construction, token estimation, overlap, and embedding-sanitization helpers exported for tests and callers.
- `indexNewMessages(sessionId, history, lastIndexedPosition?)` — retained history-index compatibility wrapper that delegates to archive indexing.

## Current constants and storage

- Table: `messages_v7`.
- Embedding model: `qwen3-embedding:0.6b`; vector dimension: 1024.
- Embedding input cap: 1,500 estimated tokens.
- Raw segment target: about 1,200 tokens with about 400 tokens of overlap.
- Schedule threshold: 50 pending messages or 8,000 pending estimated tokens.
- Raw rebuild batch size is selectable through the documented vector rebuild environment override.

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
- Compact facts use deterministic normalized-text IDs inside the session and encode fact kind/attribution/source range in existing columns.
- Raw rebuild writes bounded batches and advances a safe checkpoint after each completed batch.
- Startup backfill is asynchronous. Search can be temporarily incomplete while checkpoints show pending archive content.
- Concurrent index requests for one session are coalesced/scheduled rather than running duplicate rebuilds.
- Lone UTF-16 surrogates are replaced before embedding calls.
- Display-only messages are not indexed.

## Dependencies

- `src/session/archiveStore.ts` for lineage, checkpoints, and backfill candidates.
- `src/session/archive.ts` and `layeredContext.ts` for local source records.
- `src/session/messageVisibility.ts` for model-visible filtering.
- `src/tokenCount.ts`, model formatting helpers, Ollama embeddings, and LanceDB.

## Compatibility

`indexNewMessages` remains a runtime compatibility entry that now indexes authoritative archives. It does not restore the former history-position index model.

## Design decisions

### D-vector-fact-same-table

Compact facts share the current table and carry source ranges so ordinary lineage clipping applies without a second fact store.

## Canonical ownership

Source-backed recall is canonical in [D-context-source-backed-recall](../threads/context-compaction-and-recall.md#d-context-source-backed-recall). Index lag/durability is canonical in [D-session-context-best-effort-index](../modules/session-context.md#d-session-context-best-effort-index).
