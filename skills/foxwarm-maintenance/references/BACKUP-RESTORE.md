# Backup and Restore

Use this guide for Foxwarm data-root backup and recovery. The bundled SQLite
chunk helper is one component primitive; it does not create a complete Foxwarm
backup by itself.

## Define the restore set first

Resolve the data root as described in `../SKILL.md`, then keep one complete
restore set containing at least:

- `state/archive-store.sqlite`, `state/llm-request-journal.sqlite`, and
  `state/catalog.sqlite`, captured as SQLite-consistent snapshots;
- live per-session JSON and the one-time
  `state/sessions.json.pre-catalog-sqlite-v1.bak` migration evidence when
  present;
- `state/session-id-reservations.jsonl` and any
  `state/session-id-move-pending.json`;
- image/blob data;
- `state/db/` LanceDB/vector data;
- configuration, agent memory, and other user-owned files needed by the
  installation.

Do not treat separately created SQLite snapshots as one cross-store
transaction. They are individually consistent, but they may describe different
moments relative to each other and to session metadata or LanceDB. For a
logically coordinated full backup, quiesce Foxwarm or use a verified
operator-level snapshot procedure for the whole data root.

## SQLite chunk helper

The Python standard-library helper creates a Git-friendly, fixed-size chunk
representation of one SQLite database:

```bash
HELPER=/path/to/foxwarm/skills/foxwarm-maintenance/scripts/sqlite-chunks.py
python3 "$HELPER" create SOURCE.sqlite NEW-SNAPSHOT-DIRECTORY
python3 "$HELPER" verify SNAPSHOT-DIRECTORY
python3 "$HELPER" restore SNAPSHOT-DIRECTORY NEW.sqlite
```

`create` uses `sqlite3.Connection.backup()` so each source database is captured
consistently while WAL writers may be active. It defaults to 1 MiB chunks and
writes only the versioned `foxwarm-sqlite-chunks-v1` format:

```text
SNAPSHOT-DIRECTORY/
├── manifest.json
└── chunks/
    ├── chunk-00000000
    └── ...
```

The manifest records the format, complete SQLite byte size, chunk size/count,
and whole-file SHA-256. Creation stages on the destination filesystem, verifies
the complete representation, and publishes it only when the destination does
not already exist. Newly created snapshot directories and files are owner-only
at creation time. An optional smaller chunk size may be selected with
`--chunk-size BYTES`; the maximum is 1 MiB.

`verify` rejects unknown manifest keys, malformed numeric/hash fields,
non-contiguous or extra chunks, extra snapshot entries, and symlink/non-file
payloads. It reconstructs the database in a temporary directory, checks its
size and SHA-256, then runs SQLite `PRAGMA integrity_check` and
`PRAGMA foreign_key_check`.

`restore` accepts both v1 snapshots and the read-only legacy layout described
below. It reconstructs and verifies into a staging file beside the requested
output, fsyncs it, and renames it into place. The output path must not exist; the
helper never replaces a live database.

### Legacy read compatibility

`verify` and `restore` accept the persisted unversioned legacy representation:

```text
SNAPSHOT-DIRECTORY/
├── size
├── chunk-size
├── sha256
└── chunks/chunk-00000000 ...
```

Legacy metadata must be one strict line per file, and chunks must form one
contiguous zero-based sequence. `create` never writes this unversioned format.
There is no migration command: a successfully restored legacy database can be
captured later as a new v1 snapshot.

## Safe full recovery

1. Preserve the damaged/current data root as evidence when practical.
2. Stop or isolate Foxwarm before replacing any live database or restore set.
3. Restore components into new paths and verify them before switching paths.
4. Restore the complete coordinated data-root set, not only one SQLite file.
5. Keep ownership and permissions appropriate for the Foxwarm process.
6. Start Foxwarm only after the intended set is in place, then inspect logs and
   application health.

A missing authoritative SQLite database after SQLite-only migration is a fatal
restore problem; do not create an empty replacement and expect legacy JSONL to
rebuild it.

## Security and storage properties

- SHA-256 detects accidental content changes; it does not authenticate who made
  a snapshot and is not a signature.
- Chunking is not encryption or access control. The chunks contain plaintext
  user, agent, tool, and LLM data. Protect backup storage, transport, and Git
  history accordingly.
- The helper does not upload, compress, encrypt, commit, push, rotate, or prune
  backups. Keep repository/remote/retention policy in a separate operator-owned
  procedure.
- Test restore and verification periodically. A successful upload or Git commit
  alone does not prove recoverability.
