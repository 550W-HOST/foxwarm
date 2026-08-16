# Module: session context

## Responsibility

Session context owns model-context budgeting, layered compaction and direct active-history transformation, durable message/block archives, archive lineage, vector indexing, and exact/semantic recall. The end-to-end contract is canonical in [context compaction and recall](../threads/context-compaction-and-recall.md).

## Units

- [src-session-history](../units/src-session-history.md) — threshold checks, snapshot jobs, planning rounds, compatible commit, completion, and manual history operations.
- [src-session-compact-plan](../units/src-session-compact-plan.md) — plan schema, candidate prompt, quota calculations, and validation.
- [src-session-layered-context](../units/src-session-layered-context.md) — archive blocks, CTX-BLOCK rendering, and provenance metadata.
- [src-session-archive-store](../units/src-session-archive-store.md) — SQLite/WAL authority, lineage, legacy migration, export, and vector checkpoints.
- [src-vector](../units/src-vector.md) — LanceDB indexing, startup backfill, semantic location, and compact facts.
- [src-token-count](../units/src-token-count.md) — message/session token estimates with image-payload exclusion.
- [src-migrations](../units/src-migrations.md) — one-shot persisted-data migrations, including standalone frontier retirement.

## Public interfaces

- `getDefaultCompactThresholdTokens`, `getEffectiveCompactThresholdTokens`, `checkAndCompactIfNeeded`, `processSessionCompactionRequest`, `applyCompletedCompactJob`.
- `COMPACT_PLAN_TOOL_DEFINITION`, `buildCompactPromptText`, and `validateCompactPlanArgs`.
- Direct history compaction helpers, CTX-BLOCK formatting/rendering, and structured provenance helpers.
- `initArchiveStore`, `hasArchivedSessionId`, `ensureSessionBranch`, effective/local archive message stats and bounded readers, `readEffectiveArchiveBlocks`, and vector checkpoint APIs.
- `vector.search`, archive indexing/backfill APIs, and compact-fact indexing.
- Tool-layer `recall` and `get_session_messages` retrieval/preview paths.

## Current defaults

- Automatic compact threshold: 80% of the resolved model context window.
- Recent rendered history kept by default: 30% (`llm.compactPercent`, default `0.3`).
- Raw eligibility: more than 2,000 estimated tokens; default required replacement: 20%.
- Block level eligibility: 3,000 summary tokens; high-backlog force threshold: 5,000.
- Candidate block window: oldest 40%; default high-backlog required source-block coverage: 20%.
- Planning budget: 15 total rounds, including invalid-tool and plan-fix feedback.
- Archive-index batch threshold: 50 pending messages or 8,000 estimated tokens.

## Invariants

- Archive writes precede active-history replacement.
- The persisted history array is the unconditional model-visible source of truth.
- A compaction job applies only to a compatible live prefix snapshot.
- Lineage caps prevent post-fork parent content from reaching a child.
- Vector is an optional derived layer that defaults disabled. Optional memory facts and startup vector backfill are best-effort and never block a compact commit or service readiness; raw messages and full block summaries archived while disabled remain pending for later checkpoint-based backfill. Dedicated fact rows are not reconstructed, though fact text remains in block summaries.
- Display-only messages are excluded from model context, candidate quota denominators, and embeddings.
- Ordinary archive, recall, expansion, image-source, and vector-lineage reads are pure with respect to archive branches and session-ID reservations; explicit lifecycle/write/migration paths alone establish branch ownership. Canonical semantics: [D-archive-read-purity](../units/src-session-archive-store.md#d-archive-read-purity).
- Exact range retrieval and incremental vector indexing use covering archive stats plus bounded SQLite source reads; they do not materialize unrelated message prefixes merely to discover counts or maxima.
- Retained branch/log discovery plus the committed moved-ID alias ledger supplies the archive side of exact internal session-ID reservation and canonical historical reads; lifecycle semantics are canonical in [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).

## Compatibility

- Obsolete `contextFrontier` is ignored on read and omitted on write. The startup migration only retires standalone frontier files.
- Legacy JSONL message/block archives are migration-only inputs; current runtime is SQLite-only and explicit export provides compatibility JSONL. Their stream framing is shared with [src-jsonl](../units/src-jsonl.md).
- The compact-completion wire shape is owned by [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion).

## Design decisions

### D-session-context-thread-owner

Cross-module compact, archive, vector, recall, and WebUI-expansion contracts live in the context thread. This module keeps only subsystem boundaries, defaults, and links rather than a second decision log.

Active history authority is canonical in [D-context-active-history-authority](../threads/context-compaction-and-recall.md#d-context-active-history-authority); this module does not duplicate that decision.

### D-session-context-best-effort-index

Archive durability does not depend on vector availability. Backfill and compact-fact embedding may be disabled, lag, or fail without pretending that source archive data was lost. Optional/default-disabled behavior is canonical in [D-context-optional-vector](../threads/context-compaction-and-recall.md#d-context-optional-vector).

## Open questions

- None recorded for the current module boundary. Product changes to quotas or recall semantics belong in the canonical context thread.
