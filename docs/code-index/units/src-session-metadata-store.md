# Unit: src-session-metadata-store

Files: src/session/metadataStore.ts, src/session/stateFile.ts, src/session/stateHydration.ts, src/session/stateValidation.ts, src/session/metadataStore.test.ts

## Purpose

Manages authoritative per-session JSON serialization/hydration and the compatibility readers used by the one-time legacy catalog migration. Active metadata snapshots and writes adapt to the Main-owned SQLite Session catalog; semantic history/frontier/queue state remains in individual Session files.

## Key Exports

- `serializeSessionHistoryPayload(session)` — writes `sessionStateVersion:1` plus authoritative history and semantic fields, including raw model/effort settings, stats/meta wait/managed state, queue, `contextFrontier`, prompt/cache state, and `lastAppliedMailboxId`; catalog-only channel/sidebar state is excluded
- `captureSessionSemanticState()` / `restoreSessionSemanticState()` / `replaceSessionSemanticState()` — one shared semantic-field owner for exact rollback and current-format replace/default behavior
- `prepareSessionSemanticStateForHydration()` — distinguishes current v1 from unversioned legacy state and seeds only historically catalog-only stats/meta/vector values during the one-time upgrade
- `normalizeAndValidateSessionAuthorityPayload()` — side-effect-free shared
  current/unversioned authority shape boundary used by hydration and catalog
  migration preflight
- `getSessionHistoryFilePath(sessionId)` — resolves the disk path for a session's history file
- `getSessionHistoryStore(sessionId)` — returns a cached `DiskJsonData` instance for a session's history
- `readSessionHistorySnapshot(sessionId)` — reads a session's history from disk
- `writeSessionHistoryAtomically(sessionId, data)` — atomically writes session history
- `writeAuthoritativeSessionState(session)` — worker-safe per-session state write with image canonicalization; never writes the shared Main catalog
- `hydrateAuthoritativeSessionState(target, raw)` — reuses current queue/frontier/image compatibility behavior when loading the authoritative file into a catalog stub
- `sessionsMetadataStore` — legacy candidate reader retained for one-time migration/tests
- `loadSessionsMetadataSnapshot()` — returns the active SQLite catalog snapshot after catalog initialization
- `writeSessionsMetadataAtomically(data)` — full-replacement recovery adapter over the SQLite catalog; not a normal save path
- `withSessionsMetadataWriteLock(operation)` — process-local serialization for legacy/recovery helpers
- `rebuildSessionsMetadataFromHistoryFiles()` — reconstructs the metadata index by scanning history files
- `buildRecoveredSessionMetadata(sessionId, historyData, history)` — derives metadata for a single session from its history
- `collectSessionHistoryFiles(dir)` — recursively finds all `.json` history files, excluding legacy `*.frontier.json`
- `deriveSessionIdFromHistoryFile(historyFilePath)` — converts a file path back to a session ID
- `inferSessionLastMessageTime(history, historyFilePath)` — determines last activity timestamp
- `createSessionHistoryStore(filePath)` / `createSessionsMetadataStore(filePath)` — factory functions

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `pickDefinedFields(source, fields)` | ~60 | Picks only defined keys from an object given a field list |
| `serializeSessionHistoryPayload(session)` | ~68 | Serializes session history and state fields for disk |
| `captureSessionSemanticState()` / `restoreSessionSemanticState()` | ~110 | Captures/restores exact semantic property presence and values for rollback |
| `prepareSessionSemanticStateForHydration()` / `replaceSessionSemanticState()` | ~130 | Performs version-aware legacy upgrade or exact current-state replacement with defaults |
| `normalizeAndValidateSessionAuthorityPayload()` | stateValidation.ts | Normalizes established unversioned shapes and strictly validates v1 authority. |
| `getSessionsMetadataBackupPath(index)` | ~89 | Returns numbered backup path for sessions file |
| `getSessionHistoryFilePath(sessionId)` | ~93 | Builds file path from session ID |
| `normalizeSessionHistoryPayload(raw, filePath)` | ~97 | Validates and normalizes raw history JSON |
| `createSessionHistoryStore(filePath)` | ~105 | Creates a DiskJsonData instance without backups |
| `getSessionHistoryStore(sessionId)` | ~112 | Returns or creates a cached history store instance |
| `readSessionHistorySnapshot(sessionId)` | ~121 | Reads session history from its store |
| `writeSessionHistoryAtomically(sessionId, data)` | ~125 | Writes session history atomically |
| `getSessionsMetadataCandidatePaths()` | ~129 | Lists all candidate paths for metadata recovery |
| `normalizeSessionsMetadataSnapshot(raw, filePath)` | ~133 | Validates and wraps legacy metadata formats |
| `createSessionsMetadataStore(filePath)` | ~145 | Creates the metadata DiskJsonData with backup rotation |
| `readSessionsMetadataSnapshotFromFile(filePath)` | ~163 | Reads metadata from a specific file path |
| `collectSessionHistoryFiles(dir)` | ~167 | Recursively collects session history JSON files while excluding `*.frontier.json` |
| `deriveSessionIdFromHistoryFile(historyFilePath)` | ~182 | Converts file path to session ID string |
| `inferSessionLastMessageTime(history, historyFilePath)` | ~186 | Finds last timestamp from history or file mtime |
| `buildRecoveredSessionMetadata(sessionId, historyData, history)` | ~199 | Constructs full metadata record from history data |
| `rebuildSessionsMetadataFromHistoryFiles()` | ~228 | Scans all history files to rebuild the metadata index |
| `loadSessionsMetadataSnapshot()` | ~245 | Reads the initialized SQLite catalog into the transition snapshot shape |
| `writeSessionsMetadataAtomically(data)` | ~253 | Replaces the complete SQLite Session catalog for explicit recovery only |

## Dependencies

- `../types` — `Message`, `Session`, and current queue-record validation
- `../common` — `logger`
- `../config` — `SESSIONS_DIR`, `SESSIONS_FILE`
- `../utils/diskJsonData` — `DiskJsonData`, `getNumberedBackupPath`

## Behavior

- Separates session data into a Main-owned `catalog.sqlite` identity/topology/list projection and authoritative full semantic per-session state files. Current local save writes authority then one catalog row; Session-worker placement keeps Main as the sole catalog writer and updates it from explicit catalog mutations plus bounded Worker projections.
- `sidebarOrder` and `pinned` are WebUI/session-list metadata fields saved in the shared metadata index only. They are excluded from per-session history serialization/application so reorder/pin operations do not touch or risk stale rewrites of history JSON files.
- Uses an in-memory `Map` cache for history store instances to avoid recreating them.
- The real per-session file reader applies tolerant history/frontier shape normalization only to unversioned legacy payloads. Versioned payloads pass the shared strict history/queue/frontier/version validator before hydration, so malformed v1 data and unknown versions fail closed without an empty-history rewrite.
- Per-session history normalization accepts embedded `contextFrontier` only when it is an array; invalid frontier payloads are ignored rather than corrupting session state.
- Legacy goal-state end-turn flags remain readable, but current history serialization removes the obsolete flag and the catalog projection omits goal bodies entirely. The canonical goal contract is [D-goal-direct-safe-boundary](src-session-goal.md#d-goal-direct-safe-boundary).
- History-scan rebuild helpers remain available for explicit repair/recovery composition, but normal startup does not silently replace a missing SQLite catalog from authority files because catalog-only topology/presentation fields are not recoverable.
- Metadata recovery deliberately ignores legacy `*.frontier.json` files so they are not mistaken for sessions named `*.frontier`.
- Current semantic replacement defaults `currentNode` to `master`, normalizes queue through the current `isQueueItem` boundary, and restores exact pre-apply property presence if an authoritative write fails.
- Current and legacy validation accepts only canonical effort values; omitted `effort` and `childEffortDefault` remain absent on hydration rather than receiving configured model defaults.
- Main/catalog-stub hydration preserves catalog-owned agent, aliases, parent,
  and display-name presence while replacing all authority-owned semantics from
  JSON. Worker hydration receives those fields from its detached catalog stub;
  the existing unnamed-session display-name adoption exception remains.
- Missing/invalid legacy `lastAppliedMailboxId` normalizes to zero. Unversioned files may seed stats, semantic `meta`, and vector position from the catalog stub before durable v1 rewrite; fields present in the file win. Current v1 hydration clears the complete semantic set first, so omitted fields use current defaults instead of stale stub data. Normal catalog projections omit queue/managed-inbox bodies and retain only indexed counts; catalog-only `meta.lastChannel`, pin/archive/sidebar state, and broadcast remain outside replacement.
- `buildRecoveredSessionMetadata` infers agent name from session ID path segments and computes `nextMessageSeq` from message history when not stored.

## Design Decisions

- [2026-06-17] Store structured `contextFrontier` in the per-session history JSON as the active persistence path; keep legacy `*.frontier.json` only for startup migration, and exclude those legacy files from metadata recovery scans.
- [2026-07-09] WebUI sidebar ordering belongs to the Main catalog, not per-session history JSON; drag reorder must not risk stale semantic history/queue/context rewrites.
- [2026-07-10] WebUI session pin state follows the same catalog-only boundary as `sidebarOrder`; current history payloads intentionally never contain `pinned`.

## Integration

- Used by the session management layer to persist and restore session state across restarts.
- Relies on `DiskJsonData` for per-session authority writes and legacy ordered-candidate readers; active catalog access delegates to `SessionCatalogStore`.
- The SQLite catalog is the source of truth for listing/session identity projections, while per-session JSON is the sole semantic authority. Canonical boundary: [D-main-catalog-indexed-boundary](../threads/main-catalog-storage-and-indexed-queries.md#d-main-catalog-indexed-boundary).
- The per-session history file is also the active source for structured context frontier state; standalone frontier files are migration artifacts only, not runtime fallback inputs.
- Legacy JSON candidate/rebuild helpers exist for controlled migration or explicit repair; normal SQLite catalog loss fails closed rather than discarding catalog-only state.