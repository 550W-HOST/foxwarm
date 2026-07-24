# Unit: src-session-layered-context

Files: src/session/layeredContext.ts, src/session/layeredContext.test.ts

## Purpose

Manages the current layered context frontier for sessions: an ordered list of raw message refs and summarized CTX-BLOCK refs. It creates archive block records, renders the frontier back into model-consumable messages, and attaches structured metadata used by WebUI/API consumers.

## Key Exports

- `ArchiveBlockRecord` — interface for a persisted summary block with metadata
- `CreateArchiveBlockInput` — interface for creating new archive blocks
- `isIgnoredCompactLifecycleSystemText(text)` / `isCompactCompletionSystemText(text)` — distinguish general compact lifecycle noise from a removable prior completion notice
- `shouldIgnoreMessageInCompactCandidates(message)` / `shouldRemoveOldCompactCompletionMessage(message)` — distinguish compact candidate exclusion from safe old-completion frontier removal
- `ensureContextFrontier(session)` — initializes frontier from current history message seq metadata if not present
- `appendMessagesToContextFrontier(session, messages)` — adds new message seq refs to an existing frontier
- `appendBlocksToArchive(session, blocks)` — creates and writes archive block records
- `readLocalArchiveBlocks(sessionId)` / `readLocalArchiveBlocksByIdRange(sessionId, startId, endId)` — local block reads
- `readArchiveBlocksByIdRange(sessionId, startId, endId)` — lineage-aware block reads
- `buildContextBlockMessageMeta(record)` — builds the stable `__meta.contextBlock` object for rendered CTX-BLOCK messages
- `annotateHistoryWithContextFrontierMetadata(sessionId, history, frontier, options?)` — attaches structured frontier/block/preserved metadata to existing rendered history
- `renderBlockMessage(record)` — converts a block record into a Message with CTX-BLOCK text and structured metadata
- `renderHistoryFromFrontier(session, overrideFrontier?)` — materializes the full frontier as messages
- `cloneSessionFrontier(session)` — deep-clones the session's frontier
- `formatArchiveBlockTimeRange(record)` — formats the time range string for a block
- `formatArchiveBlockContextText(record)` — formats the full context text for a block

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `isIgnoredCompactLifecycleSystemText(text)` | ~55 | Checks if text starts with a known compaction prefix |
| `shouldIgnoreMessageInCompactCandidates(message)` | ~60 | Determines if a message is purely lifecycle noise |
| `cloneFrontier(frontier)` | ~95 | Deep-clones a frontier array |
| `ensureContextFrontier(session)` | ~110 | Initializes frontier from session history if empty |
| `appendMessagesToContextFrontier(session, messages)` | ~125 | Appends message seq entries to the frontier |
| `buildArchiveBlockRecords(session, blocks)` | ~145 | Constructs full ArchiveBlockRecord objects with timestamps |
| `appendBlocksToArchive(session, blocks)` | ~170 | Writes block records to JSONL and SQLite archive store |
| `readArchiveBlocksByIdRange(sessionId, startId, endId)` | ~190 | Filters lineage-aware blocks by ID range |
| `readLocalArchiveBlocks(sessionId)` | ~195 | Reads all local block records from the archive store |
| `readLocalArchiveBlocksByIdRange(sessionId, startId, endId)` | ~199 | Reads local block records by ID range |
| `formatArchiveBlockTimeRange(record)` | ~225 | Formats local time range string for block display |
| `formatArchiveBlockContextText(record)` | ~240 | Builds the bracketed context text for a block summary |
| `buildContextBlockMessageMeta(record)` | ~250 | Builds stable CTX-BLOCK metadata for message `__meta` |
| `annotateHistoryWithContextFrontierMetadata(...)` | ~320 | Adds structured frontier metadata to rendered history and reports match warnings |
| `renderBlockMessage(record)` | ~405 | Converts a block record into a model Message with CTX-BLOCK text and metadata |
| `renderHistoryFromFrontier(session, overrideFrontier?)` | ~425 | Materializes frontier items into an array of Messages |
| `cloneSessionFrontier(session)` | ~470 | Returns a deep clone of the session's frontier |

## Dependencies

- `../types` — `Message`, `Session`, `ContextFrontierItem`, `ContextBlockMessageMeta`
- `../config` — `getSessionBlockArchiveLogPath`
- `../utils/localTime` — `formatLocalTimeRange`
- `./archive` — `ArchiveMessageRecord`, `readArchiveMessagesBySeqRange`
- `./archiveStore` — `ensureSessionBranch`, `refreshSessionArchiveImportState`, `readEffectiveArchiveBlocks`, `readLocalArchiveBlocks`, `writeArchiveBlocks`
- `./messageVisibility` — `isModelVisibleMessage`
- `./history` — `formatCompactionCompletionMarker` (test only)

## Behavior

- Maintains a "context frontier" — an ordered list of `{ kind: 'message', seq, preservedFromBlockId? }` and `{ kind: 'block', id, level, rawStartSeq, rawEndSeq }` items representing what the model sees. `preservedFromBlockId` marks raw messages intentionally kept verbatim after a summary block that already covers them.
- Block IDs are monotonically allocated per session via `nextBlockId`.
- Active frontier persistence is embedded in per-session history JSON via `contextFrontier`; this unit no longer reads or writes standalone `.frontier.json` files.
- When rendering the frontier, messages are fetched from the archive by seq range and blocks are rendered as model messages with text like `[CTX-BLOCK L1 B#3 raw#10-#12 time ...]`; rendered block messages carry `__meta.contextBlock`, and rendered raw preserved messages carry `__meta.preservedFromBlockId` plus `__meta.contextFrontierItem`.
- `annotateHistoryWithContextFrontierMetadata` is used by runtime load and migrations to ensure existing rendered messages have the same structured metadata as freshly rendered frontier messages; it never parses legacy frontier files.
- Compaction lifecycle messages are excluded from compact summary content. Prior pure current/legacy compact-completion notices are additionally transparent to candidate ranges and are removable from the active frontier at a later successful commit; other lifecycle/session-boundary events remain barriers. Continuation text inside the wrapper body, or legacy following `systemPayload` text such as “You can continue working now”, is treated as lifecycle/system payload rather than real user content. Canonical retention contract: [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion).
- Block records include raw timestamp ranges resolved from the archive at creation time.

## Design Decisions

- [2026-06-15] Preserved raw messages are tracked in the working frontier with `preservedFromBlockId` rather than by editing archive/block records. This lets future compaction remove the active raw message from the frontier with `removePreservedMessages` while leaving archive recall and summary block provenance intact.
- [2026-06-17] CTX-BLOCK rendering must include structured block metadata in message `__meta.contextBlock` (not only parseable text), and active frontier persistence should be embedded in per-session history JSON rather than relying on standalone `*.frontier.json` files.
- [2026-06-17] Legacy `*.frontier.json` payload parsing/loading belongs only in `src/migrations/`; current layered-context runtime should operate solely on in-memory/embedded `contextFrontier` data.
- [2026-07-06] Compact/lifecycle filtering remains backward-compatible with old bold/`[SYSTEM:]` text while accepting new `<foxwarm-system ...>` metadata tags; do not migrate archived/frontier text just to change wrapper syntax.

## Integration

- Used by the compaction system to replace ranges of messages with summarized blocks in the context frontier.
- `renderHistoryFromFrontier` provides the materialized working history sent to the model, combining archived messages and block summaries; LLM request construction strips `__meta` before provider calls.
- `sessionManager` loads embedded `contextFrontier` from per-session history JSON via `metadataStore`, then uses this unit to render or annotate the current working history.
- Relies on the archive system (`./archive`, `./archiveStore`) for reading/writing raw message and block records.
