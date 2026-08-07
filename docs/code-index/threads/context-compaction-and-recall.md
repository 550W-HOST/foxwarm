# Thread: context compaction and recall

## Overview

This thread owns the end-to-end contract that keeps long sessions within model limits without losing traceable history. It spans session history/frontier code, the compact-plan tool, prompt/provider calls, the SQLite archive, vector indexing, recall tools, and WebUI CTX-BLOCK expansion.

## Flow

### 1. Trigger and snapshot

- `checkAndCompactIfNeeded()` compares final usage with the effective compact threshold. The default is 80% of the resolved model context window; a positive per-session threshold overrides it.
- Explicit compact requests enter `processSessionCompactionRequest()`.
- The default compact request keeps the newest 30% of rendered history (`llm.compactPercent`, default `0.3`).
- Async and awaited modes use the same snapshot/job/result path. Planning mutates a transient session clone; live state changes only during a compatible commit.
- For async-capable models, an explicit request starts snapshot planning immediately even while the live session is busy; planning is not a session queue item. Only the ready `compact-commit` enters the router queue for safe application. A busy explicit request on a model with `asyncCompact:false` reports background compaction unavailable instead of storing hidden deferred work; idle explicit and normal end-of-turn awaited compaction remain supported.

### 2. Candidate policy and planning

- Raw-message candidates require more than 2,000 estimated tokens and, when eligible, must replace at least 20% of eligible raw tokens by default.
- Each block source level below 3,000 summary tokens is ineligible. At or above 3,000, only the oldest floor(40%) is exposed. At or above 5,000, the plan must cover 20% of source blocks, clamped to feasible legal multi-block segments.
- Prior compact-completed notices are transparent candidate noise: they neither enter summaries nor split legal ranges. Other protected lifecycle items, preserved raw items, missing records, and non-candidate blocks are hard range barriers. Display-only messages are transparent and excluded from quota denominators.
- The planning request keeps the normal model-facing tool schema for prompt-cache stability, but compact runtime gating accepts only one `submit_compact_plan` call. Plain text, missing calls, invalid calls, and invalid plans receive bounded retry feedback within 15 total planning rounds.
- The plan may create layered summary blocks, preserve a small set of exact raw messages, remove previously preserved frontier entries, and attach optional durable memory facts to each created block.

Configuration defaults: `compactBlockLevelMinTokens=3000`, `compactBlockLevelForceTokens=5000`, `compactBlockCandidateFraction=0.4`, `compactBlockForceCompactFraction=0.2`, and `compactMessageForceCompactFraction=0.2`.

### 3. Commit and continuation

- A successful job replaces only the consumed compatible frontier prefix, writes blocks, updates history/frontier state, and rotates `promptCacheKey` because the model-facing prefix changed.
- A stale/incompatible snapshot, exhausted invalid plan, or terminal `LlmRequestError` aborts without rewriting live history/frontier.
- Block-associated durable memory facts are rendered into stored block summaries and indexed after commit on a best-effort basis; malformed facts or index failure never roll back compaction.
- The main session receives one current compact-completion session-boundary marker and continues normal work. A successful commit removes older pure compact-completion notices from the whole active frontier, including the force-kept tail, while their archive records remain immutable and recallable.

### 4. Durable archive and lineage

- Raw messages and summary blocks commit to `archive-store.sqlite` before active frontier replacement.
- SQLite uses durable WAL/FULL transactions, archive branches, lineage-bounded effective reads, and vector checkpoints.
- A one-time startup migration strictly imports and verifies every legacy active JSONL before moving it under `state/migration-backup/sqlite-only-large-archives-v1/`. Runtime does not dual-write or lazy-import JSONL.
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
- Legacy archive JSONL remains supported only as a fail-closed startup migration input. Explicit CLI export recreates compatibility JSONL from SQLite.
- Existing supported `recall` target selectors remain readable. Removed ambiguous legacy tool names/arguments are not documented as active aliases.

## Design decisions

### D-context-compact-completion

Compact completion is a single self-closing `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` marker. Additional continuation text and compacted-skill guidance are escaped into its `hint` attribute. There is no tag body, separate payload part, or leading `Compaction completed.` line.

Only the newest pure compact-completion notice remains in active model-visible history after a later successful compact. Older current/legacy completion notices are transparent to planning, never become summary text, and are removed from the complete compatible frontier at commit time (including force-kept tail items); durable archive records are never rewritten. Other session-boundary events and messages containing real user/tool/content remain protected. Failed or non-committing compaction leaves the frontier unchanged.

Canonical implementation: `formatCompactionCompletionMarker()` in [src-session-history](../units/src-session-history.md).

### D-context-one-compact-engine

Async and awaited compaction share one snapshot/job/commit engine. Planning never mutates the live session, and commit replaces only a compatible consumed prefix.

### D-context-compact-scheduling-boundary

[2026-08-01] Compact planning is not ordinary queued session work. An async-capable explicit request snapshots and starts planning immediately, including while a normal turn is active; only the resulting `compact-commit` is queued so live prefix replacement occurs at a router safe point. `asyncCompact:false` remains a provider boundary: idle explicit compaction and normal end-of-turn awaited compaction may block that owner, but a busy explicit request fails clearly rather than enqueueing or persisting a deferred plan. No planning-control queue type or migration exists; generic queue validation discards unrecognized records, and automatic threshold checks can request planning again on a later turn.

Session-worker placement starts with synchronous compaction only. Automatic runner safe points and an idle explicit runtime request force the shared engine's awaited mode inside the exact Worker owner; they never create pending compact jobs or `compact-commit` records. A busy model `compact_session` call reports that background compaction is unavailable instead of changing the frontier inside a tool batch. Main may select/admit the exact idle generation and await its fixed forward operation, but it never hydrates or mutates the Worker Session. Transient planning progress and background planning remain deferred. Pre-final automatic maintenance may continue only after successful exact resync; unrecovered/poisoned state stops before another provider request and produces the one error final without another semantic append. Post-final maintenance failure is swallowed after its resync attempt so an already delivered successful final is never followed by a second terminal delivery, while any remaining poison continues to fence mutation.

### D-context-compact-runtime-gate

During the dedicated compact phase, runtime accepts only `submit_compact_plan` and returns bounded feedback for other calls. Shared schema stability is canonical in [D-llm-stable-tool-schema](../modules/llm.md#d-llm-stable-tool-schema).

### D-context-hard-candidate-policy

Raw and block candidate quotas are computed after visibility, atomic grouping, and protection barriers. A plan may accumulate coverage across legal segments but one operation cannot cross a segment.

### D-context-block-associated-memory-facts

Durable compact facts belong only in the `memoryFacts` array of their matching `createBlocksJson` entry.

- The planner does not submit a top-level fact payload or repeat facts in summary prose.
- Normalized facts remain optional archive-block data. The framework appends a deterministic Markdown `Memory facts` section to the stored summary, so later layered compaction sees prior facts in source summaries.
- Total fact caps and text deduplication apply across the whole plan, not once per block. The SQLite reader tolerates migrated historical blocks without this field.
- Best-effort vector rows retain each creating block's identity, level, and raw source range; failures never undo the durable compact commit.
- Fork-lineage semantic search admits a fact-bearing inherited block only through its block cap. Legacy fact rows without block identity must end at or before the message fork cap; crossing facts are discarded, never range-clipped for recall.

### D-context-preserved-raw

`preserveMessages` keeps exact raw wording immediately after a new summary block. `removePreservedMessages` removes only those marked working-frontier entries; archive messages and blocks remain immutable.

### D-context-sqlite-archive-authority

[2026-08-03] `archive-store.sqlite` is the sole runtime authority for raw messages, summary blocks, lineage, and vector checkpoints. Runtime commits use WAL with `synchronous=FULL` and do not dual-write JSONL. The startup migration must strictly import and verify all legacy active JSONL before moving sources to a path-preserving migration backup; unverifiable sources fail closed and remain retryable. Compatibility JSONL is explicit export output, not live storage.

The sole malformed-line recovery exception is migration-only and evidence-bound: a physical message line may begin with a canonical legacy message header, contain a prefix torn inside a JSON string, and end with exactly one complete canonical message record whose `sessionId` and `seq` match that prefix. Ordinary legacy bootstrap skips the physical line; after structural validation, migration-only lineage inference may count a copied recovered parent record for a new fork cap, while only the dedicated migration transaction may insert the suffix, atomically with its durable recovery marker. Duplicate copied sources must agree byte-semantically after canonicalization, and the unchanged raw file plus recovery audit move to migration backup. Blocks, identity mismatches, multiple viable suffixes, complete-object concatenation, other invalid-prefix grammars, and all other malformed shapes remain fail-closed.

### D-context-recall-vocabulary

Exact selection (`target`), semantic location (`vector_query`), and literal post-filtering (`contentFilter`) are separate inputs. The preview renderer owns output budgets, regex filters, tool folding, and exclusion notices.

### D-context-source-backed-recall

Vector hits locate archive sources; recall presents reloaded source messages/blocks through the shared renderer rather than exposing embedding chunks as authoritative history.
