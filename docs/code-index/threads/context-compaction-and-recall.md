# Thread: context compaction and recall

## Overview

This thread owns the end-to-end contract that keeps long sessions within model limits without losing traceable history. It spans session history/frontier code, the compact-plan tool, prompt/provider calls, JSONL and SQLite archives, vector indexing, recall tools, and WebUI CTX-BLOCK expansion.

## Flow

### 1. Trigger and snapshot

- `checkAndCompactIfNeeded()` compares final usage with the effective compact threshold. The default is 80% of the resolved model context window; a positive per-session threshold overrides it.
- Explicit compact requests enter `processSessionCompactionRequest()`.
- The default compact request keeps the newest 30% of rendered history (`llm.compactPercent`, default `0.3`).
- Async and awaited modes use the same snapshot/job/result path. Planning mutates a transient session clone; live state changes only during a compatible commit.

### 2. Candidate policy and planning

- Raw-message candidates require more than 2,000 estimated tokens and, when eligible, must replace at least 20% of eligible raw tokens by default.
- Each block source level below 3,000 summary tokens is ineligible. At or above 3,000, only the oldest floor(40%) is exposed. At or above 5,000, the plan must cover 20% of source blocks, clamped to feasible legal multi-block segments.
- Prior compact-completed notices are transparent candidate noise: they neither enter summaries nor split legal ranges. Other protected lifecycle items, preserved raw items, missing records, and non-candidate blocks are hard range barriers. Display-only messages are transparent and excluded from quota denominators.
- The planning request keeps the normal model-facing tool schema for prompt-cache stability, but compact runtime gating accepts only one `submit_compact_plan` call. Plain text, missing calls, invalid calls, and invalid plans receive bounded retry feedback within 15 total planning rounds.
- The plan may create layered summary blocks, preserve a small set of exact raw messages, remove previously preserved frontier entries, and submit optional durable memory facts.

Configuration defaults: `compactBlockLevelMinTokens=3000`, `compactBlockLevelForceTokens=5000`, `compactBlockCandidateFraction=0.4`, `compactBlockForceCompactFraction=0.2`, and `compactMessageForceCompactFraction=0.2`.

### 3. Commit and continuation

- A successful job replaces only the consumed compatible frontier prefix, writes blocks, updates history/frontier state, and rotates `promptCacheKey` because the model-facing prefix changed.
- A stale/incompatible snapshot, exhausted invalid plan, or terminal `LlmRequestError` aborts without rewriting live history/frontier.
- Optional memory facts are indexed after commit on a best-effort basis; malformed facts or index failure never roll back compaction.
- The main session receives one current compact-completion session-boundary marker and continues normal work. A successful commit removes older pure compact-completion notices from the whole active frontier, including the force-kept tail, while their archive records remain immutable and recallable.

### 4. Durable archive and lineage

- Raw messages and summary blocks are appended to JSONL logs and written to the SQLite archive store.
- SQLite uses WAL, archive branches, lineage-bounded effective reads, vector checkpoints, and persisted JSONL import-state metadata.
- Startup bootstrap imports known JSONL logs in streaming batches; per-session lazy import remains a fallback for sessions missed during bootstrap. Current JSONL logs therefore remain an active durable/import source, not merely deleted legacy data.
- Fork branches inherit only parent messages/blocks at or before their fork points.

### 5. Vector location and source reload

- `scheduleSessionArchiveIndex()` batches archive indexing at 50 pending messages or 8,000 estimated tokens.
- LanceDB `messages_v7` stores raw segments, block rows, and compact-extracted fact rows. Startup backfill uses SQLite checkpoints and can continue after the service becomes ready.
- `vector.search(query, limit, format, options)` returns metadata-rich locations. Model-facing recall reloads original archive messages/blocks from those locations before rendering; vector chunks are not the final quoted history.

### 6. Recall and preview

- `recall.target` performs exact overview/block/message selection.
- `recall.vector_query` performs semantic location.
- `contentFilter` is a literal case-insensitive post-filter on the selected/reloaded result set. `includeRegex` and `excludeRegex` are later post-filters.
- `previewLength` is one total output budget, clamped to 1,000–20,000. Tool details are folded unless explicitly expanded.
- Filtering notices remain visible when every item is excluded or the preview is truncated.
- `get_session_messages` uses the same preview renderer and filter vocabulary for selected session-history messages.

### 7. WebUI expansion

The WebUI block endpoint expands exactly one layer into structured timeline messages. A block backed by lower-level blocks returns child CTX-BLOCK messages; a message-backed/L1 block returns raw archive messages. Expansion is local read-only UI state and never changes history, frontier, queue, or broadcasts.

## Modules and units

- [session context](../modules/session-context.md)
- [session core](../modules/session-core.md)
- [LLM](../modules/llm.md)
- [WebUI](../modules/webui.md)
- [src-session-history](../units/src-session-history.md)
- [src-session-compact-plan](../units/src-session-compact-plan.md)
- [src-session-layered-context](../units/src-session-layered-context.md)
- [src-session-archive-store](../units/src-session-archive-store.md)
- [src-vector](../units/src-vector.md)
- [src-tools-session-agent](../units/src-tools-session-agent.md)

## Invariants

- Raw content is archived before its active frontier entries are replaced.
- Compaction ranges never cross a protected candidate segment boundary.
- A child cannot recall parent archive content created after its fork point.
- Display-only messages do not enter model context, compact summaries, or embeddings.
- WebUI expansion and recall preview are read-only with respect to live session state.

## Compatibility

- Current active frontiers are embedded in per-session history JSON. Startup migration reads legacy `*.frontier.json` once, records migration state, and moves migrated files; runtime hydration does not fallback-read them.
- Existing archive JSONL files are still imported and current archive appends continue writing JSONL plus SQLite.
- Existing supported `recall` target selectors remain readable. Removed ambiguous legacy tool names/arguments are not documented as active aliases.

## Design decisions

### D-context-compact-completion

Compact completion is a single self-closing `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` marker. Additional continuation text and compacted-skill guidance are escaped into its `hint` attribute. There is no tag body, separate payload part, or leading `Compaction completed.` line.

Only the newest pure compact-completion notice remains in active model-visible history after a later successful compact. Older current/legacy completion notices are transparent to planning, never become summary text, and are removed from the complete compatible frontier at commit time (including force-kept tail items); durable archive records are never rewritten. Other session-boundary events and messages containing real user/tool/content remain protected. Failed or non-committing compaction leaves the frontier unchanged.

Canonical implementation: `formatCompactionCompletionMarker()` in [src-session-history](../units/src-session-history.md).

### D-context-one-compact-engine

Async and awaited compaction share one snapshot/job/commit engine. Planning never mutates the live session, and commit replaces only a compatible consumed prefix.

### D-context-compact-runtime-gate

During the dedicated compact phase, runtime accepts only `submit_compact_plan` and returns bounded feedback for other calls. Shared schema stability is canonical in [D-llm-stable-tool-schema](../modules/llm.md#d-llm-stable-tool-schema).

### D-context-hard-candidate-policy

Raw and block candidate quotas are computed after visibility, atomic grouping, and protection barriers. A plan may accumulate coverage across legal segments but one operation cannot cross a segment.

### D-context-preserved-raw

`preserveMessages` keeps exact raw wording immediately after a new summary block. `removePreservedMessages` removes only those marked working-frontier entries; archive messages and blocks remain immutable.

### D-context-dual-archive

Current appends write JSONL and SQLite. Persisted import state and streaming bootstrap/lazy import make pre-existing JSONL recoverable without reparsing unchanged files on every restart.

### D-context-recall-vocabulary

Exact selection (`target`), semantic location (`vector_query`), and literal post-filtering (`contentFilter`) are separate inputs. The preview renderer owns output budgets, regex filters, tool folding, and exclusion notices.

### D-context-source-backed-recall

Vector hits locate archive sources; recall presents reloaded source messages/blocks through the shared renderer rather than exposing embedding chunks as authoritative history.
