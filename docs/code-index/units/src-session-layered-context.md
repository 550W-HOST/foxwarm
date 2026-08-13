# Unit: src-session-layered-context

Files: src/session/layeredContext.ts, src/session/layeredContext.test.ts

## Purpose

Owns immutable archive block construction, CTX-BLOCK rendering, structured `__meta.contextBlock` provenance, preserved-raw metadata formatting, and compact lifecycle filtering. It does not own or reconstruct active Session history.

## Key exports

- `ArchiveBlockRecord` / `CreateArchiveBlockInput` — durable block shapes.
- `appendBlocksToArchive` and block range readers — immutable block persistence and recall access.
- `renderBlockMessage` / `buildContextBlockMessageMeta` — one newly created or recalled block to a model-visible message with structured provenance.
- `formatArchiveBlockContextText`, time-range, summary, and memory-fact formatters.
- `shouldIgnoreMessageInCompactCandidates` / `shouldRemoveOldCompactCompletionMessage` — lifecycle candidate and completion-retention policy.

## Behavior

- Active CTX-BLOCK messages are ordinary entries in authoritative Session `history` and carry `__meta.contextBlock`.
- Exact preserved raw messages remain ordinary history entries carrying `__meta.seq` plus `__meta.preservedFromBlockId`.
- New block IDs are allocated from `nextBlockId`, with current history block metadata as the fallback maximum.
- Block raw timestamp ranges may consult the immutable archive, but archive reads never materialize or repair active history.
- Legacy standalone or embedded frontier handling belongs only to tolerant migration/authority readers and is not a runtime layered-context responsibility.

## Design Decisions

Canonical active-history/archive/compaction authority is [D-context-active-history-authority](../threads/context-compaction-and-recall.md#d-context-active-history-authority). This unit keeps only block rendering and immutable archive responsibilities.
