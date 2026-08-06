# SQLite Archive Store and Legacy Migration

Foxwarm uses two independent SQLite databases for its large durable archive domains:

- `state/archive-store.sqlite` — session messages, layered blocks, lineage, vector checkpoints, and the SQLite mirror of moved-session-ID reservations.
- `state/llm-request-journal.sqlite` — content-addressed provider-neutral LLM inputs, request manifests, and physical attempt provenance.

Both databases use WAL, `synchronous=FULL`, bounded busy waiting, and explicit writer transactions. They are separate so short-lived model CLI work cannot contend with normal session archive traffic.

## Runtime authority

Normal runtime is SQLite-only. It does not append or lazy-read:

- `state/logs/sessions/<session>.jsonl`
- `state/logs/sessions/<session>.blocks.jsonl`
- `state/llm-request-journal.jsonl`

Session archive commits precede active frontier/history replacement. LLM request manifests and attempt starts commit before the corresponding provider send. A failed post-response result write is reported but never causes a second provider generation.

## One-time legacy migration

Startup runs `sqlite-only-large-archives-v1` before session hydration. The same migration is run by the model CLI before a request when necessary.

The migration:

1. Acquires a data-directory migration lock.
2. Recursively discovers legacy session message/block JSONLs and the legacy LLM journal JSONL.
3. Streams their records into the appropriate SQLite database.
4. Strictly verifies record structure, identities, content/object hashes, primary-key equality, request delta chains, lineage graph invariants, and `PRAGMA integrity_check`.
5. Writes a durable manifest containing each source's relative path, SHA-256, record count, and movement state.
6. Moves every verified source to `state/migration-backup/sqlite-only-large-archives-v1/`, preserving its path relative to `state/`.
7. Records migration completion only after every move and destination-hash verification succeeds.

Malformed/torn or structurally invalid canonical records, conflicting newly imported duplicate identities, ambiguous ownership, missing SQLite rows, or integrity failures abort the migration. Unverifiable active sources are not moved and completion is not recorded. Structural validation happens before bootstrap mutates archive identity/lineage, so a repaired fork can retry cleanly. Existing SQLite rows and branches remain authoritative when stale legacy duplicates or later metadata heuristics disagree. If a crash interrupts file movement, the durable manifest restores already moved sources to the active tree before repeating import and verification.

Two historical message payload variants are accepted only by this legacy migration. Early message-level `providerMeta` records may contain record-valued `providerSpecificFields` without the later model-scoping `sourceModelId`; they are preserved but never attributed to a guessed model for provider replay. Early tool execution could persist any defined JSON value in `functionResponse.response`, so scalar, null, array, and object responses remain unchanged instead of being wrapped or normalized. Missing response fields, malformed provider metadata, non-object function-call arguments, and all record identity, role, duplicate, and lineage violations still fail closed. Current writers continue to use the current scoped provider metadata and object-shaped tool-response types.

One historical append-after-torn message shape is recoverable during migration only: the invalid physical line must start with the exact legacy message header, its prefix must be torn inside a JSON string, it must end with exactly one complete canonical message object, and the suffix `sessionId` plus `seq` must match the torn prefix header. Ordinary legacy bootstrap skips this malformed line and cannot insert a provisional suffix. After structural validation, migration-only lineage inference may count a copied recovered parent record when calculating a new fork cap, but the dedicated recovery transaction remains the sole row writer and inserts the suffix only with its durable marker. Duplicate copied logs must recover the same canonical payload. The original raw bytes remain unchanged in migration backup and the manifest records physical-prefix, unique-record, inserted-row, identity, and payload-hash audit fields. A durable recovery marker never overrides row content: retries require the stored row and marker to still match the recovered canonical payload. No block or general malformed recovery is attempted.

Legacy fork logs may contain copied parent rows. Migration uses proven session aliases and parent metadata only when creating a missing branch; an established SQLite branch remains authoritative even when later metadata heuristics disagree. A path/payload mismatch alone never proves an identity move.

## Compatibility export

Use:

```bash
foxwarm archive export-jsonl --output <directory>
```

The command first ensures migration completion, then exports SQLite-backed compatibility files:

- `<directory>/sessions/<session>.jsonl`
- `<directory>/sessions/<session>.blocks.jsonl`
- `<directory>/llm-request-journal.jsonl`

These files are export artifacts for training, inspection, or external tools. They are not runtime recovery sources.
Each database is exported from a read snapshot with bounded buffering. Existing destination files/directories are replaced as one exact export result, so stale files are not retained.

## Identity state that remains outside SQLite

`state/session-id-reservations.jsonl` remains the small authoritative ledger for committed old-to-current session-ID mappings. It can rebuild the SQLite mirror after archive database loss and prevents a retained archived lifetime from being reused. It is atomically rewritten and is not one of the removed large append-only archives.

`state/session-id-move-pending.json` also remains. It is a temporary fail-closed journal for a move spanning session metadata, history paths, channels, archive rows, vector data, and agent directories.

## Backup and restore

Back up the complete data directory as one restore set. For live databases, use a SQLite-consistent online backup or a quiesced checkpoint/copy procedure; copying only the main `.sqlite` file while WAL writers are active is not sufficient. Include:

- both authoritative SQLite databases and their consistent WAL state or snapshots;
- live session JSON and metadata;
- the session-ID reservation ledger and any pending move journal;
- image blobs and LanceDB/vector data.

After the migration is marked complete, a missing authoritative database is a fatal restore error rather than a signal to rebuild from removed JSONL.
Each database also stores its migration authority marker, so a newly recreated empty SQLite file is treated as missing authority rather than valid recovery.

For the bundled operational checklist and the fixed-size SQLite chunk
create/verify/restore helper, see
`skills/foxwarm-maintenance/references/BACKUP-RESTORE.md`.
