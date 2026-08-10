# Unit: src-session-catalog-store

Files: src/session/catalogStore.ts, src/session/catalogStore.test.ts

## Purpose

Owns the Session tables in the always-Main-owned `state/catalog.sqlite`
database: strict one-time `sessions.json` migration, typed list/topology
projections, ambiguity-preserving aliases, maintained counts, indexed queries,
bounded row/batch transactions, and consistent online backup.

The cross-module admission and scaling policy is canonical in
[D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).

## Key exports

- `SessionCatalogStore` — explicit repository over one catalog database.
- `buildSessionCatalogProjection()` — validates and builds the one narrow
  allowlisted projection used by migration and every normal row write.
- `sessionCatalogStore` — Main process singleton.
- `initialize()` — strict migrate-or-open bootstrap.
- `get()` / `resolveId()` — primary-key and ambiguity-preserving alias lookup.
- `list()` — indexed recent/keyset or compatibility-offset page query.
- `listByAgent()` / `listByCurrentNode()` / `listRoots()` /
  `listChildren()` / `listRecoveryCandidates()` — fixed indexed query surfaces.
- `count()` — maintained global/per-agent/per-parent counts and bounded filtered
  fallback.
- `upsertMany()` / `deleteMany()` / `replaceAll()` — bounded normal
  transactions; `replaceAll()` is reserved for migration/recovery.
- `backupTo()` — SQLite online backup to a new verified destination.
- `readLegacyChannelAttachmentsFromCatalogMigrationEvidence()` — temporary
  compatibility reader from the immutable migration evidence; it does not add
  channel tables to the catalog.

## Schema and indexes

- `session_catalog` stores typed identity, raw and canonical parent, agent,
  presentation/list, activity/recovery, node, and bounded summary projection
  columns plus bounded metadata projection JSON. Queue/managed-inbox, history,
  frontier, prompt-cache, mailbox, goal, prompt-file, and indexing bodies are
  never admitted; only indexed counts and narrowly validated stats, list-meta,
  vector-position, and sanitized wait-presentation summaries remain. Wait
  presentation is capped to 128 wait-ID characters, 500 reason characters, 64 wait-all/exec targets,
  512 characters per Session ID, and 256 per exec ID; it never contains
  `deferredQueue`, QueueItems, message bodies, or timer payloads.
- `session_alias` uses composite `(alias, session_id)` identity, preserving
  duplicate-owner ambiguity.
- maintained count tables cover global Session, per-agent, and per-canonical
  parent/root counts.
- recent/keyset, agent, canonical parent/root, raw parent-reference,
  current-node, alias, and partial busy/queued/managed-recovery indexes cover
  the repository's current fixed queries.

Canonical parent normalization resolves exact IDs first, then one unique alias.
Missing, self, or ambiguous references project to `NULL` while the raw reference
remains preserved. There is intentionally no parent foreign key.

## Migration

The first open reads `sessions.json`, numbered candidates, then legacy `.bak`.
It strictly validates IDs and row/value shapes. Every selected per-session
authority passes the shared version-aware validator: legacy normalization is
tolerant only for the established unversioned history/frontier shapes, while
v1 history/queue/frontier and version boundaries are strict. Missing, malformed,
or unreadable cataloged authority fails closed without trying a stale catalog
backup; orphan authority files are not imported. Before catalog retirement,
unversioned authority files are durably staged/upgraded to v1 and absorb any
legacy-catalog-only semantic fields when authority does not already contain
them. Each migration row then projects semantics from that exact validated v1
or staged upgrade, overlaying only catalog-owned ID/agent/aliases/parent and
display/archive/pin/sidebar/last-channel state. The reconciled narrow rows are
inserted into a temporary database, normalized, integrity-checked,
checkpointed, fsynced, and atomically published. A partial authority-upgrade
retry is monotonic because the already-written v1 payload becomes the exact
next preflight input.
One exact
`state/sessions.json.pre-catalog-sqlite-v1.bak` evidence file remains; legacy
catalog candidates are removed only after publication.

Fresh installations may create an empty catalog only when neither migration
candidates nor authority files exist.

## Invariants

- Only Main opens the live catalog. Session workers skip catalog writes and
  publish bounded projections for Main handback.
- Normal writes name exact changed/deleted IDs; they never serialize or rewrite
  the complete catalog.
- Alias lookup reads at most two owners. Exact IDs always win.
- Global and scoped list pages use concrete order indexes; supported keyset
  pages seek by `(recent_rank, session_id)`.
- Per-session JSON remains semantic authority. Catalog metadata JSON is only a
  bounded projection, never a second history/queue/frontier authority.
- Live backup uses SQLite's online backup API; copying only the main file while
  WAL is active is unsupported.
