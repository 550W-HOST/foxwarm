# Unit: src-session-metadata-store

Files: src/session/metadataStore.ts, src/session/stateFile.ts, src/session/stateHydration.ts, src/session/metadataStore.test.ts

## Purpose

Manages persistence of session metadata and history as separate JSON files on disk. Provides atomic read/write operations with backup rotation for the sessions metadata index, lightweight storage for individual session history files, embedded `contextFrontier` persistence, and recovery logic to rebuild metadata from history files when the primary index is corrupted or missing.

## Key Exports

- `serializeSessionHistoryPayload(session)` — writes `sessionStateVersion:1` plus authoritative history and semantic fields, including stats/meta wait/managed state, queue, `contextFrontier`, prompt/cache state, and `lastAppliedMailboxId`; catalog-only channel/sidebar state is excluded
- `captureSessionSemanticState()` / `restoreSessionSemanticState()` / `replaceSessionSemanticState()` — one shared semantic-field owner for exact rollback and current-format replace/default behavior
- `prepareSessionSemanticStateForHydration()` — distinguishes current v1 from unversioned legacy state and seeds only historically catalog-only stats/meta/vector values during the one-time upgrade
- `stripSessionMetadataForSave(session)` — picks metadata-only fields from a session for the index file
- `getSessionHistoryFilePath(sessionId)` — resolves the disk path for a session's history file
- `getSessionHistoryStore(sessionId)` — returns a cached `DiskJsonData` instance for a session's history
- `readSessionHistorySnapshot(sessionId)` — reads a session's history from disk
- `writeSessionHistoryAtomically(sessionId, data)` — atomically writes session history
- `writeAuthoritativeSessionState(session)` — worker-safe per-session state write with image canonicalization; never writes shared `sessions.json`
- `hydrateAuthoritativeSessionState(target, raw)` — reuses current queue/frontier/image compatibility behavior when loading the authoritative file into a catalog stub
- `sessionsMetadataStore` — singleton `DiskJsonData` instance for the sessions index
- `loadSessionsMetadataSnapshot()` — loads metadata from primary/backups or rebuilds from history files
- `writeSessionsMetadataAtomically(data)` — atomically writes the sessions metadata index
- `withSessionsMetadataWriteLock(operation)` — process-local main-writer serialization shared by ordinary local saves and bounded worker catalog projection merges
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
| `stripSessionMetadataForSave(session)` | ~85 | Extracts metadata-only fields for the index file |
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
| `loadSessionsMetadataSnapshot()` | ~245 | Loads metadata with fallback to backup candidates then rebuild |
| `writeSessionsMetadataAtomically(data)` | ~253 | Writes metadata index atomically with backup rotation |

## Dependencies

- `../types` — `Message`, `Session`, and current queue-record validation
- `../common` — `logger`
- `../config` — `SESSIONS_DIR`, `SESSIONS_FILE`
- `../utils/diskJsonData` — `DiskJsonData`, `getNumberedBackupPath`

## Behavior

- Separates session data into two tiers: a main-owned shared metadata index (`sessions.json`) with backup rotation (5 numbered + legacy `.bak`), and authoritative full semantic per-session state files (no backups). Local save writes state then catalog; a future worker writes state only and main consumes a bounded projection.
- `sidebarOrder` and `pinned` are WebUI/session-list metadata fields saved in the shared metadata index only. They are excluded from per-session history serialization/application so reorder/pin operations do not touch or risk stale rewrites of history JSON files.
- Uses an in-memory `Map` cache for history store instances to avoid recreating them.
- Normalization hooks handle legacy metadata wrappers; authoritative session-state version/type validation is explicit and fails closed for malformed current payloads.
- Per-session history normalization accepts embedded `contextFrontier` only when it is an array; invalid frontier payloads are ignored rather than corrupting session state.
- Legacy goal-state end-turn flags remain readable, but history and metadata serializers omit them from current writes. The canonical goal contract is [D-goal-direct-safe-boundary](src-session-goal.md#d-goal-direct-safe-boundary).
- Recovery path: if the metadata index and all backups are unreadable, rebuilds from individual history files by scanning `SESSIONS_DIR` recursively.
- Metadata recovery deliberately ignores legacy `*.frontier.json` files so they are not mistaken for sessions named `*.frontier`.
- Current semantic replacement defaults `currentNode` to `master`, normalizes queue through the current `isQueueItem` boundary, and restores exact pre-apply property presence if an authoritative write fails.
- Missing/invalid legacy `lastAppliedMailboxId` normalizes to zero. Unversioned files may seed stats, semantic `meta`, and vector position from the catalog stub before durable v1 rewrite; fields present in the file win. Current v1 hydration clears the complete semantic set first, so omitted fields use current defaults instead of stale stub data. Catalog-only `meta.lastChannel`, pin/archive/sidebar state, and broadcast remain outside replacement.
- `buildRecoveredSessionMetadata` infers agent name from session ID path segments and computes `nextMessageSeq` from message history when not stored.

## Design Decisions

- [2026-06-17] Store structured `contextFrontier` in the per-session history JSON as the active persistence path; keep legacy `*.frontier.json` only for startup migration, and exclude those legacy files from metadata recovery scans.
- [2026-07-09] WebUI sidebar ordering belongs to the sessions metadata index, not per-session history JSON. Losing/rebuilding the metadata index may lose manual sidebar order, which is acceptable compared with risking stale history/queue/context overwrites during drag reorder.
- [2026-07-10] WebUI session pin state follows the same metadata-only boundary as `sidebarOrder`: normal reload reads it from `sessions.json`, while a metadata rebuild from history may lose it because current history payloads intentionally never contain `pinned`.

## Integration

- Used by the session management layer to persist and restore session state across restarts.
- Relies on `DiskJsonData` for atomic writes (temp file + rename) and ordered candidate loading.
- The metadata index is the source of truth for listing sessions, while history files are the source of truth for conversation content.
- The per-session history file is also the active source for structured context frontier state; standalone frontier files are migration artifacts only, not runtime fallback inputs.
- Recovery logic allows the system to self-heal when the metadata index is corrupted, making it resilient to crashes during writes.