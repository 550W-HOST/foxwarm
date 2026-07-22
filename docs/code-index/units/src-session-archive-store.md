# Unit: src-session-archive-store

Files: src/session/archiveStore.ts, src/session/archiveBootstrapImport.test.ts, src/session/archiveImportState.test.ts, src/session/archiveLineageStore.test.ts
Secondary files: src/session/sessionIdAllocation.test.ts

## Purpose

Implements the SQLite/WAL archive index for raw messages, summary blocks, branch lineage, JSONL import state, and vector checkpoints. It complements active JSONL appends: current archive writes go to JSONL and SQLite, while this unit can bootstrap or lazily recover SQLite rows from existing JSONL sources.

## Key exports

- Archive branch/effective-record/checkpoint/backfill types.
- `initArchiveStore()` — open schema and await one startup bootstrap pass.
- `initArchiveStoreSync()` — open schema without awaiting bootstrap.
- `hasArchivedSessionId` — reports whether bootstrap/current branch metadata reserves an internal session ID.
- `ensureSessionBranch`, `getSessionBranch` — branch and fork-point records.
- `writeArchiveMessages`, `writeArchiveBlocks` — batched SQLite upserts for current archive appends/import.
- `readLocalArchiveMessages`, `readLocalArchiveBlocks` — current-branch rows only.
- `readEffectiveArchiveMessages`, `readEffectiveArchiveBlocks` — lineage-bounded inherited plus local rows.
- `refreshSessionArchiveImportState` — persist the current JSONL size/mtime after an append/import.
- `getVectorCheckpoint`, `getVectorCheckpointSync`, `setVectorCheckpointSync` — vector progress.
- `getVectorSearchLineage`, `listSessionsNeedingVectorBackfill` — vector scope/backfill inputs.
- `renameSessionArchiveStore` — transactional ID/parent/checkpoint/import-state rename.

## Internal sections

| Stable symbol/section | Responsibility |
|---|---|
| `streamJsonlLines` | Streaming line reader with explicit event-loop yields |
| message/block import functions | Batched parse/upsert and per-source import-state updates |
| `bootstrapArchiveStoreFromLegacy` / `ensureBootstrapped` | Import metadata-known legacy JSONL sources once per process and reset the shared promise after failure |
| `ensureImported` | Per-session lazy import fallback when bootstrap missed or source changed |
| `buildLineage` | Parent walk with cumulative message/block fork caps |
| local/effective readers | SQL range query and inherited-source annotation |

## Schema

- `archive_branches` — session, optional parent, message/block fork points.
- `archive_messages` — session-local sequence records and serialized message JSON.
- `archive_blocks` — block level/source/range/summary records.
- `archive_checkpoints` — raw tail and block vector-index progress.
- `archive_import_state` — message/block JSONL size and mtime per session.

## Behavior

- `initArchiveStore()` opens the database and starts one bootstrap promise. Known sessions come from the metadata snapshot.
- Import reads JSONL line-by-line, writes bounded transactions, and yields between batches.
- Persisted file size/mtime avoids reparsing unchanged sources after restart. Current appends refresh the same state.
- Effective reads walk current session then ancestors, cap each ancestor at cumulative fork points, annotate `sourceSessionId`/`inherited`, and sort by source sequence or block ID.
- Child branch creation seeds vector checkpoints at its fork boundaries.
- Backfill candidates are sessions whose latest local message/block exceeds the checkpoint.
- Reservation lookup waits for bootstrap, so retained JSONL paths can reconstruct branch rows after SQLite loss before a new lifetime is allocated.

## Compatibility

JSONL message and block logs remain active durable/import sources. Startup bootstrap and lazy import are current recovery behavior; they are not removed aliases. The standalone frontier migration is separate and owned by `src/migrations/`.

## Integration

- `src/session/archive.ts` and `layeredContext.ts` append JSONL, upsert SQLite, and refresh import state.
- Compaction and recall use effective lineage reads.
- `src/vector.ts` uses checkpoint, lineage, and backfill APIs.
- Session fork/rename operations update branch state here.

## Canonical ownership

Current JSONL/SQLite write and import-state behavior follows the canonical [dual-archive decision](../threads/context-compaction-and-recall.md#d-context-dual-archive).

Internal session-ID lifetime reservation is canonical in [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Design decisions

### D-archive-lineage-caps

Archive inheritance is resolved at read time and capped at each fork boundary; a child never copies or sees post-fork parent rows.
