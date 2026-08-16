# Unit: src-session-archive-store

Files: src/session/archiveStore.ts, src/session/archiveBootstrapImport.test.ts, src/session/archiveImportState.test.ts, src/session/archiveLineageStore.test.ts, src/session/archivePureReads.test.ts
Secondary files: src/session/sessionIdAllocation.test.ts

## Purpose

Implements the SQLite/WAL authority for raw messages, summary blocks, branch lineage, moved-ID reservations, and vector checkpoints. Legacy JSONL import exists only behind the one-time startup migration; current writes and reads are SQLite-only.

## Key exports

- Archive branch/effective-record/checkpoint/backfill types.
- `initArchiveStore()` — open schema and await one startup bootstrap pass.
- `initArchiveStoreSync()` — open schema without awaiting bootstrap.
- `hasArchivedSessionId` — reports whether bootstrap/current branch metadata reserves an internal session ID.
- `commitSessionIdRename` — commits an old-to-current alias after the live move has durably succeeded.
- `resolveArchivedSessionId` — resolves a historical alias chain to its current archive identity.
- `rollbackUncommittedSessionArchive` — removes branch/record/import artifacts for a known failed new lifetime.
- `ensureSessionBranch`, `getSessionBranch` — branch and fork-point records.
- `writeArchiveMessages`, `writeArchiveBlocks` — batched immutable SQLite inserts; exact replay is idempotent and same-key conflicting payloads fail closed.
- `rollbackUncommittedArchiveMessages`, `rollbackUncommittedArchiveBlocks` — exact-payload cleanup for rows newly inserted by a larger active-authority commit that then failed before publication; pre-existing replay rows are never eligible.
- `readLocalArchiveMessages`, `readLocalArchiveBlocks` — current-branch rows only.
- `readEffectiveArchiveMessages`, `readEffectiveArchiveBlocks` — lineage-bounded inherited plus local rows.
- `getVectorCheckpoint`, `getVectorCheckpointSync`, `setVectorCheckpointSync` — vector progress.
- `getVectorSearchLineage`, `listSessionsNeedingVectorBackfill` — vector scope/backfill inputs.
- `renameSessionArchiveStore` — bootstrapped transactional ID/parent/checkpoint/import-state rename.
- `renameSessionArchiveStoreForRecovery` — startup-journal rollback variant that updates existing SQLite rows before normal bootstrap can infer a duplicate branch.
- `migrateLegacySessionArchivesToSqlite` — migration-only strict import/verification inventory for active legacy message/block JSONLs.
- `exportSessionArchivesJsonl` — bounded, snapshot-consistent SQLite-backed compatibility export that exactly replaces its destination tree.

## Internal sections

| Stable symbol/section | Responsibility |
|---|---|
| `streamJsonlLines` | File-path adapter over the shared stateful UTF-8 LF/CRLF JSONL reader |
| `parseLegacyMessageLine` | Strict canonical parser plus the single migration-only matching torn-prefix/suffix recovery shape |
| reservation-ledger load/persist/canonical-resolution helpers | Validate committed alias graphs, rebuild exact moved-ID reservations, and map proven historical aliases |
| message/block import functions | Batched parse/upsert and per-source import-state updates |
| `bootstrapArchiveStoreFromLegacy` / `ensureBootstrapped` | Migration-only streaming import of legacy JSONL before strict verification and backup movement |
| `buildLineage` | Parent walk with cumulative message/block fork caps |
| local/effective readers | SQL range query and inherited-source annotation |

## Schema

- `archive_branches` — session, optional parent, message/block fork points.
- `archive_store_metadata` — durable SQLite-authority migration marker plus idempotent torn-message recovery audit markers; marker-backed retries require the stored row to still match, and a completed migration with a missing authority marker fails startup.
- Runtime message/block write batches are single-Session only. Immutable identity allows exact replay and rejects conflicts. Block-backed records may preserve decreasing/nonconsecutive source endpoint order only through a valid ordered `sourceBlockIds`; message-backed ranges stay ascending, including strict export/reimport migration validation.
- `archive_session_id_reservations` — exact committed historical ID to current canonical-ID mappings mirrored by the durable ledger.
- `archive_messages` — session-local sequence records and serialized message JSON.
- `archive_blocks` — block level/source/range/summary records plus optional serialized normalized memory facts.
- `archive_checkpoints` — raw tail and block vector-index progress.

## Behavior

- `initArchiveStore()` opens the database and validates/repairs the independent reservation ledger against its SQLite mirror. `sessionManager.loadSessions()` awaits it after startup migrations and before normal agent/channel/session loading; Session-worker initialization may idempotently join the same process-local promise.
- Ordinary legacy bootstrap accepts only whole-line canonical JSON and never inserts a torn-concatenated suffix. After structural validation, migration-only fork-cap inference may count the narrow recovered suffix as copied parent history without inserting it; the dedicated recovery transaction remains the sole row writer and atomically writes its durable audit marker. Raw files remain unchanged for backup audit.
- Migration-only message validation recognizes two proven historical writer variants without changing current writer types: message-level `providerMeta` may carry a record-valued `providerSpecificFields` without the later `sourceModelId`, and `functionResponse.response` may be any defined JSON value rather than only an object. SQLite preserves those payload values as written, unscoped provider fields are not replayed to a guessed model, and all outer record identity, role, tool-call identity, duplicate, and lineage checks remain strict.
- Migration import-state rows avoid reparsing unchanged legacy sources while a failed migration is being repaired and retried.
- Effective reads walk current session then ancestors, cap each ancestor at cumulative fork points, annotate `sourceSessionId`/`inherited`, and sort by source sequence or block ID.
- Ordinary local/effective readers, branch lookup, archived-ID lookup, and vector-lineage lookup open the SQLite schema and resolve committed aliases without creating branches or repairing/re-writing reservation state. Startup initialization and explicit lifecycle/write operations retain the repair/ownership path.
- Current message/block writes return only rows actually inserted by that call. The active-history commit path may delete those exact rows if authoritative JSON persistence fails, so a retry can reuse the same identity without overwriting or deleting an older immutable replay row.
- Child branch creation seeds vector checkpoints at its fork boundaries.
- Backfill candidates are sessions whose latest local message/block exceeds the checkpoint.
- Reservation lookup loads the independent ledger and SQLite mirror. The atomically rewritten `state/session-id-reservations.jsonl` ledger is explicit durable state: missing/syntactically malformed files self-heal from every nonconflicting SQLite mapping row, while SQLite loss rebuilds from the ledger. Conflicting valid mappings and cycles fail closed; live metadata aliases are proof for backfill.
- A path/payload mismatch alone never establishes an alias because copied legacy fork rows have the same shape. Both IDs are reserved independently and mismatched rows are skipped for that path. JSONL imports and archive reads resolve only proven multi-hop aliases. Known failed creation rollback removes partial SQLite branch artifacts; successful moves commit alias mappings only after all strict move persistence succeeds.

## Compatibility

Legacy JSONL message and block logs are migration-only inputs. Strictly verified sources move to migration backup; normal runtime never reads or writes them. Standalone frontier retirement is separate and owned by `src/migrations/`.

Legacy file framing delegates to [src-jsonl](./src-jsonl.md), so literal U+2028/U+2029 remain inside records and UTF-8 characters split across raw Buffer chunks decode statefully.

## Integration

- `src/session/archive.ts` and `layeredContext.ts` commit current archive rows only to SQLite.
- Compaction and recall use effective lineage reads.
- `src/vector.ts` uses checkpoint, lineage, and backfill APIs.
- Session fork/rename operations update branch state here.

## Canonical ownership

SQLite-only runtime and migration behavior follows the canonical [SQLite archive authority decision](../threads/context-compaction-and-recall.md#d-context-sqlite-archive-authority).

Internal session-ID lifetime reservation is canonical in [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Design decisions

### D-archive-lineage-caps

Archive inheritance is resolved at read time and capped at each fork boundary; a child never copies or sees post-fork parent rows.

Existing SQLite branches are authoritative during legacy cleanup. Parent metadata heuristics may infer a missing branch but never rewrite an established branch.

### D-archive-read-purity

[2026-08-16] Ordinary archive content, branch, reservation-status, and vector-lineage reads are pure with respect to archive identity state. Reading an unknown or mistyped Session ID returns the existing empty/not-found shape and must not insert `archive_branches`, rewrite the reservation ledger or SQLite mirror, or reserve that ID. Committed aliases already present in SQLite remain readable. Branch creation and reservation repair belong only to explicit Session create/fork/write/move paths and startup migration/recovery; a later legitimate owner may therefore create or write the previously unknown ID normally.
