# Module: session context

## Responsibility

Session context owns model-context budgeting, layered compaction, the active context frontier, durable message/block archives, archive lineage, vector indexing, and exact/semantic recall. The end-to-end contract is canonical in [context compaction and recall](../threads/context-compaction-and-recall.md).

## Units

- [src-session-history](../units/src-session-history.md) — threshold checks, snapshot jobs, planning rounds, compatible commit, completion, and manual history operations.
- [src-session-compact-plan](../units/src-session-compact-plan.md) — plan schema, candidate prompt, quota calculations, and validation.
- [src-session-layered-context](../units/src-session-layered-context.md) — embedded frontier, archive blocks, CTX-BLOCK rendering, and metadata annotation.
- [src-session-archive-store](../units/src-session-archive-store.md) — SQLite/WAL archive, lineage, JSONL bootstrap/lazy import, and vector checkpoints.
- [src-vector](../units/src-vector.md) — LanceDB indexing, startup backfill, semantic location, and compact facts.
- [src-token-count](../units/src-token-count.md) — message/session token estimates with image-payload exclusion.
- [src-migrations](../units/src-migrations.md) — one-shot persisted-data migrations, including standalone frontier import.

## Public interfaces

- `getDefaultCompactThresholdTokens`, `getEffectiveCompactThresholdTokens`, `checkAndCompactIfNeeded`, `processSessionCompactionRequest`, `applyCompletedCompactJob`.
- `COMPACT_PLAN_TOOL_DEFINITION`, `buildCompactPromptText`, and `validateCompactPlanArgs`.
- `ensureContextFrontier`, `appendMessagesToContextFrontier`, `renderHistoryFromFrontier`, and CTX-BLOCK formatting/annotation helpers.
- `initArchiveStore`, `ensureSessionBranch`, `readEffectiveArchiveMessages`, `readEffectiveArchiveBlocks`, and vector checkpoint APIs.
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

- Archive writes precede active frontier replacement.
- The embedded frontier is the model-visible prefix source of truth and must render into valid messages.
- A compaction job applies only to a compatible live prefix snapshot.
- Lineage caps prevent post-fork parent content from reaching a child.
- Optional memory facts and startup vector backfill are best-effort and never block a compact commit or service readiness.
- Display-only messages are excluded from model context, candidate quota denominators, and embeddings.
- Read-only recall/expansion may update archive import caches but never live history/frontier/queue.

## Compatibility

- Active `contextFrontier` is stored in the per-session history snapshot. The startup migration is the only reader for legacy standalone frontier files.
- JSONL message/block archives remain valid bootstrap/lazy-import sources and are still written alongside SQLite.
- The compact-completion wire shape is owned by [D-context-compact-completion](../threads/context-compaction-and-recall.md#d-context-compact-completion).

## Design decisions

### D-session-context-thread-owner

Cross-module compact, archive, vector, recall, and WebUI-expansion contracts live in the context thread. This module keeps only subsystem boundaries, defaults, and links rather than a second decision log.

### D-session-context-embedded-frontier

The current frontier is embedded in the authoritative per-session history snapshot. Standalone frontier files are migration inputs, not runtime fallback state.

### D-session-context-best-effort-index

Archive durability does not depend on vector availability. Backfill and compact-fact embedding may lag or fail without pretending that source archive data was lost.

## Open questions

- None recorded for the current module boundary. Product changes to quotas or recall semantics belong in the canonical context thread.
