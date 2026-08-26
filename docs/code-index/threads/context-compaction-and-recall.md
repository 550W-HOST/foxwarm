# Thread: context compaction and recall

## Overview

This thread owns the end-to-end contract that keeps long sessions within model limits without losing traceable history. It spans session history transformation code, the compact-plan tool, prompt/provider calls, the SQLite archive, vector indexing, recall tools, and WebUI CTX-BLOCK expansion.

## Flow

### 1. Trigger and snapshot

- `checkAndCompactIfNeeded()` compares final usage with the effective compact threshold. The default is `llm.compactThresholdPercent` (85%) of the resolved model context window; a positive per-session threshold overrides it.
- At that automatic trigger, Foxwarm first dry-runs one historical function-response pruning pass against the complete authoritative history. It uses the ordinary oldest/compactable split and atomic tool boundary, keeps recent/current activity untouched, and never prunes function-call arguments.
- Explicit compact requests enter `processSessionCompactionRequest()`.
- The default compact request keeps the newest 30% of rendered history (`llm.compactKeepPercent`, default `0.3`).
- Async and awaited modes use the same snapshot/job/result path. Planning mutates a transient session clone; live state changes only during a compatible commit.
- For async-capable models, an explicit request starts snapshot planning immediately even while the live session is busy; planning is not a session queue item. Only the ready `compact-commit` enters the router queue for safe application. A busy explicit request on a model with `asyncCompact:false` reports background compaction unavailable instead of storing hidden deferred work; idle explicit and normal end-of-turn awaited compaction remain supported.

### 2. Candidate policy and planning

- Raw-message candidates require more than 2,000 estimated tokens and, when eligible, must replace at least 20% of eligible raw tokens by default.
- Each block source level below 3,000 summary tokens is ineligible. At or above 3,000, only the oldest floor(40%) is exposed. At or above 5,000, the plan must cover 20% of source blocks, clamped to feasible legal multi-block segments.
- Prior compact-completed notices are transparent candidate noise: they neither enter summaries nor split legal ranges. Other protected lifecycle items, preserved raw items, missing/duplicate/nonmonotonic active sequence structure, and non-candidate blocks are hard range barriers. A present immediately consecutive active raw call/tool-response run is atomic; a call with no following tool-response row is an ordinary single-message candidate. Display-only messages are transparent and excluded from quota denominators.
- The compact tool remains in the normal model-facing tool set, while compact runtime gating accepts only one `submit_compact_plan` call. Its required `replaceAsBlocks` argument intentionally supports either the preferred direct block array or a JSON string encoding the same array; obsolete top-level `createBlocksJson` and `createBlocks` names are rejected. Plain text, missing calls, invalid calls, and invalid plans receive bounded retry feedback within 15 total planning rounds.
- The plan may create layered summary blocks, preserve a small set of exact raw messages, remove previously preserved active-history entries, and attach optional durable memory facts to each created block.

Configuration defaults: `compactBlockLevelMinTokens=3000`, `compactBlockLevelForceTokens=5000`, `compactBlockCandidateFraction=0.4`, `compactBlockForceCompactFraction=0.2`, and `compactMessageForceCompactFraction=0.2`.

### 3. Commit and continuation

- A successful job validates the exact consumed active-history snapshot, writes immutable blocks, directly transforms that history prefix, retains only appended suffixes, and preserves `promptCacheKey`.
- Historical tool-response pruning is a provider-free direct-history rewrite. Eligibility first proves exactly one positive-seq active row and exactly one byte-semantically identical effective immutable archive row; missing, duplicate, conflicting, or offline-edited provenance is nonprunable, and archive reads remain validation-only. Each eligible oversized response formats the complete provider-visible response envelope, retains an approximately 500-character Unicode-safe, line-aware head and tail plus a deterministic exact `recall({ target: "msg#N" })` footer, preserves small top-level `output`/`content`/`error` siblings under their original keys, and keeps only a small fixed metadata allowlist beside the bounded carrier. Automatic pruning commits only when the complete resulting Session estimates at or below 50% of resolved model context; success satisfies that trigger and skips layered planning. A failed recovery gate leaves history unchanged and proceeds with ordinary layered compaction. Manual `/compact tools` uses the same response-only primitive without the 50% gate. Under Session-worker placement both paths serialize through the exact owner, persist authority, publish the complete projection, and expose the existing `historyVersion` mutation signal so an open Chat refreshes same-count rewritten rows.
- A stale/incompatible snapshot, exhausted invalid plan, or terminal `LlmRequestError` aborts without rewriting live history.
- `/stop compact` cancels only the current Session's transient compact operation. It aborts compact-plan provider work through a compact-specific signal, removes any ready `compact-commit` from the authoritative queue without disturbing ordinary items, and prevents every precommit result from rewriting live history. Cancellation is a normal no-op outcome rather than a compact failure; once the authoritative compact commit succeeds, cancellation reports completed/too-late and never rolls it back.
- Block-associated durable memory facts are rendered into stored block summaries and indexed after commit on a best-effort basis; malformed facts or index failure never roll back compaction.
- The main session receives one current compact-completion session-boundary marker and continues normal work. A successful commit removes older pure compact-completion notices from the whole active history, including the force-kept tail, while their archive records remain immutable and recallable.

### 4. Durable archive and lineage

- Raw messages and summary blocks commit to `archive-store.sqlite` before active-history replacement.
- SQLite uses durable WAL/FULL transactions, archive branches, lineage-bounded effective reads, and vector checkpoints.
- Effective/local message stats use covering SQLite count/min/max scans with the same alias, range, and cumulative lineage caps as content reads. Exact message retrieval keeps the complete effective available range while loading only the selected sequence range.
- A one-time startup migration strictly imports and verifies every legacy active JSONL before moving it under `state/migration-backup/sqlite-only-large-archives-v1/`. Shared stateful UTF-8 LF/CRLF framing preserves literal U+2028/U+2029 inside JSON strings. Runtime does not dual-write or lazy-import JSONL.
- Fork branches inherit only parent messages/blocks at or before their fork points.

### 5. Vector location and source reload

- Vector is optional and defaults disabled. Archive/compaction and exact recall remain fully functional without LanceDB; semantic requests fail with a stable disabled classification.
- `scheduleSessionArchiveIndex()` batches archive indexing at 50 pending messages or 8,000 estimated tokens.
- When enabled, LanceDB `messages_v7` stores raw segments, block rows, and compact-extracted fact rows. Startup backfill uses SQLite checkpoints and can continue after the service becomes ready. Each incremental flush reads message maxima through local stats, loads only the saved overlap tail/new-message range, and reads blocks only after the block checkpoint; a stale tail beyond the durable local range falls back to the local minimum. Raw messages and full block summaries accumulated while disabled remain pending and are discovered from archive maxima after a later enable/restart. Fact text embedded in those summaries is therefore searchable through block rows, but startup backfill does not reconstruct dedicated fact rows.
- `vector.search(query, limit, format, options)` returns metadata-rich locations. Model-facing recall reloads original archive messages/blocks from those locations before rendering. A tolerated legacy/stale compatibility fallback may render the stored vector text only when the referenced archive source cannot be reloaded; one bounded metadata-only warning records that fallback without logging query or user content.

### 6. Recall and preview

- `recall.target` performs exact overview/block/message selection.
- `recall.vector_query` performs semantic location.
- `contentFilter` is a literal case-insensitive post-filter on the selected/reloaded result set. `includeRegex` and `excludeRegex` are later post-filters.
- `previewLength` is one total output budget, clamped to 1,000–20,000. Tool details are folded unless explicitly expanded.
- Filtering notices remain visible when every item is excluded or the preview is truncated.
- `get_session_messages` uses the same preview renderer and filter vocabulary for selected session-history messages.

### 7. WebUI expansion

The WebUI block endpoint expands exactly one layer into structured timeline messages. A block backed by lower-level blocks returns child CTX-BLOCK messages; a message-backed/L1 block returns raw archive messages. Parent and immediate source records are loaded once and shared by structured output plus the compatible text formatter. Expansion is local read-only UI state and never changes history, queue, or broadcasts.

## Modules and units

- [session context](../modules/session-context.md)
- [session core](../modules/session-core.md)
- [LLM](../modules/llm.md)
- [WebUI](../modules/webui.md)
- [src-session-history](../units/src-session-history.md)
- [src-session-compact-plan](../units/src-session-compact-plan.md)
- [src-session-layered-context](../units/src-session-layered-context.md)
- [src-session-archive-store](../units/src-session-archive-store.md)
- [src-jsonl](../units/src-jsonl.md)
- [src-vector](../units/src-vector.md)
- [src-tools-session-agent](../units/src-tools-session-agent.md)

## Invariants

- Raw content is archived before its active history entries are replaced.
- Compaction ranges never cross a protected candidate segment boundary.
- A child cannot recall parent archive content created after its fork point.
- Display-only messages do not enter model context, compact summaries, or embeddings.
- WebUI expansion and recall preview are read-only with respect to live session state.

## Compatibility

- Persisted `history` is the sole active timeline. Obsolete embedded or standalone frontiers are ignored; the startup migration only retires standalone files and current saves drop the old embedded field.
- Legacy archive JSONL remains supported only as a fail-closed startup migration input. Explicit CLI export recreates compatibility JSONL from SQLite.
- Existing supported `recall` target selectors remain readable. Removed ambiguous legacy tool names/arguments are not documented as active aliases.

## Design decisions

### D-context-active-history-authority

[2026-08-13, updated 2026-08-18] `state/sessions/<id>.json` `history` is the sole active and model-visible timeline in local and Session-worker placement. Archive rows remain immutable recall/audit/lineage sources and never reconstruct, reorder, overwrite, or resurrect active history. Obsolete standalone/top-level `contextFrontier` and per-message `__meta.contextFrontierItem` data are tolerated and ignored on read and omitted on every current save; `__meta.contextBlock` remains semantic and is preserved.

Layered compaction plans and builds its result solely from an exact cloned active-history snapshot. It does not read Archive to admit or reject raw/block candidates, compare active bytes, revalidate source identity, recover timestamps, or reconstruct summary input. Active pruned tool responses and offline-edited wording are therefore ordinary layered input exactly as stored in `history`. Candidate construction retains active-only structural guards: positive unique raw sequence identity, ordered raw continuity, semantic `contextBlock` metadata, nonoverlapping block raw coverage in active order, preserved-raw rules, lifecycle barriers, visibility, and atomic grouping of a present immediately consecutive call/tool-response run. A structurally valid call without following tool rows remains an ordinary single-message candidate. A malformed tool row is a local hard barrier: it starts a new segment without invalidating an already valid immediately preceding call/response prefix, and later structurally valid rows may form candidates in that new segment. Other invalid active structure and every nontransparent active row omitted from the final candidate set remain hard barriers; valid blocks reset raw-message continuity across raw→block→raw history. Raw timestamps come from active raw metadata, and block timestamps come from active block metadata.

Commit requires deep equality of the complete consumed active snapshot while allowing only an appended live suffix; it directly replaces selected history ranges with rendered CTX-BLOCK messages, copies requested exact raw messages with `preservedFromBlockId`, removes display-only consumed rows and old pure completion notices, retains the compatible appended suffix, and appends one current completion marker. The layered engine emits newly generated immutable Archive blocks before replacing active authority, but Archive is output only for this operation. It never repairs or resurrects active history from Archive. Successful compact preserves `promptCacheKey`; `/clear` remains the rotation boundary.

Required archive appends are synchronous and fail closed for the affected Session mutation. Before-authority failure restores the in-memory semantic snapshot and removes only exact rows newly inserted by that operation. After authoritative JSON replacement, catalog/projection failure is explicitly postcommit: archive rows and JSON remain aligned, the exact owner reloads/resynchronizes from authority, and Worker publication poison keeps later mutation fenced until the existing resync boundary succeeds. A required archive error at the turn boundary receives at most one presentation-only final error attempt and never recursively appends another semantic error row through the failed archive. Archive message/block same-key replay is idempotent only when the stored row is byte-semantically identical; conflicting content fails instead of overwriting immutable history. Runtime write batches contain exactly one Session ID. Block-source archive records may use decreasing/nonconsecutive endpoints only when ordered `sourceBlockIds` explicitly starts/ends at those identities; message-source ranges remain ascending.

### D-context-historical-tool-response-pruning

[2026-08-13, clarified 2026-08-16] At the existing provider-usage automatic compaction trigger, dry-run one coherent response-only pruning pass over the complete active-history snapshot. Eligibility is limited to oversized historical function responses wholly inside the ordinary oldest/compactable region; never prune function-call arguments, split an atomic call/response group, or touch the protected recent/current tail. Before exposing a recall footer, prove exactly one positive-seq row in the complete active snapshot, exactly one effective immutable archive record at that seq, and byte-semantic equality after the approved transient-provenance normalization; missing, duplicate, conflicting, inherited-identity-conflicting, or offline-edited provenance is nonprunable. Revalidate those exact archive identities at commit. Archive reads validate only and never reconstruct active history. Each rewritten response uses the complete provider-visible `formatToolResponsePayload` envelope and keeps an approximately 500-character Unicode-safe, line-aware head and tail. Prefer an existing non-small top-level `output`, `content`, or `error` key as the bounded excerpt carrier, preserve the other small meaningful siblings under their original keys, and use `output` only when no suitable carrier exists. Also retain the function-response identity and only small fixed path/node/run/status/hash/location-style metadata. Its deterministic footer names the exact `msg#N` recall target and tool identity. Once committed, the pruned projection is ordinary authoritative active history and remains eligible for later layered compaction without another Archive comparison; only the pruning operation owns the Archive proof that makes its recall footer truthful.

Commit automatic pruning only when the estimated complete resulting Session is at or below 50% of the resolved concrete/virtual model context maximum. Success satisfies that trigger and does not immediately layer-compact; failure leaves the original history unchanged and proceeds with ordinary layered compaction. Commit uses exact-prefix compatibility with appended-suffix retention and the existing authority persistence/resync failure boundary; it adds no revision, cooldown, pass counter, override map, sidecar, or repeated loop. Manual `/compact tools` uses the same response-only primitive without the 50% recovery gate, avoids persistence/history-version changes on true no-op, and returns inspected/touched/pruned/token-saving estimates. Successful manual or automatic pruning preserves `promptCacheKey`; `/clear` remains the rotation boundary.


### D-context-compact-completion

Compact completion is a single self-closing `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` marker. Additional continuation text and compacted-skill guidance are escaped into its `hint` attribute. There is no tag body, separate payload part, or leading `Compaction completed.` line.

Only the newest pure compact-completion notice remains in active model-visible history after a later successful compact. Older current/legacy completion notices are transparent to planning, never become summary text, and are removed from the complete compatible active history at commit time (including force-kept tail items); durable archive records are never rewritten. Other session-boundary events and messages containing real user/tool/content remain protected. Failed or non-committing compaction leaves active history unchanged.

Canonical implementation: `formatCompactionCompletionMarker()` in [src-session-history](../units/src-session-history.md).

### D-context-one-compact-engine

Async and awaited compaction share one snapshot/job/commit engine. Planning never mutates the live session, and commit replaces only a compatible consumed prefix.

### D-context-compact-cancellation

[2026-08-26] One transient per-Session compact-operation registry owns mode/phase identity, a compact-specific abort controller, and canonical completion for local background, local standalone awaited, in-turn awaited, and Worker-awaited planning. `/stop compact` is the sole user control for that registry. Ordinary `/stop` never aborts or deletes compact work: a real main turn may remain marked to stop after synchronous compact returns, while a standalone idle-started awaited compact is not a main turn and therefore cannot set or retain `stopping`. Local background production distinguishes provider planning, in-flight commit enqueue, durably ready, and committing phases; cancellation during enqueue awaits producer completion plus durable queue filtering before it reports success. Commit cancellation checkpoints run after every awaited pre-authority boundary (including prompt-snapshot rebuild and completion-message Archive append) and immediately before authority save, so cancellation rolls back inserted block/completion rows through the existing failure path. Once authoritative save is in progress/succeeds, cancellation reports completed/too-late and never rolls it back.

### D-context-compact-scheduling-boundary

[2026-08-01] Compact planning is not ordinary queued session work. An async-capable explicit request snapshots and starts planning immediately, including while a normal turn is active; only the resulting `compact-commit` is queued so live prefix replacement occurs at a router safe point. `asyncCompact:false` remains a provider boundary: idle explicit compaction and normal end-of-turn awaited compaction may block that owner, but a busy explicit request fails clearly rather than enqueueing or persisting a deferred plan. No planning-control queue type or migration exists; generic queue validation discards unrecognized records, and automatic threshold checks can request planning again on a later turn.

Session-worker placement starts with synchronous compaction only. Automatic runner safe points and an idle explicit runtime request force the shared engine's awaited mode inside the exact Worker owner; they never create pending compact jobs or `compact-commit` records. A busy model `compact_session` call reports that background compaction is unavailable instead of changing active history inside a tool batch. Main may select/admit the exact idle generation and await its fixed forward operation, but it never hydrates or mutates the Worker Session. Transient planning progress and background planning remain deferred. Pre-final automatic maintenance may continue only after successful exact resync; unrecovered/poisoned state stops before another provider request and produces the one error final for an exact direct source without another semantic append. That direct invocation releases busy and preserves any queued work but suppresses its own finish-window trailing handoff; a later explicit trigger may consume the queue. A source-less fenced turn skips all generic history/reminder/send branches and surfaces the fixed fatal after its release attempt. Post-final maintenance failure is swallowed after its resync attempt so an already delivered successful final is never followed by a second terminal delivery, while any remaining poison continues to fence mutation. Busy release may retry exactly once only when the fixed resync-retry result proves its first attempt successfully reloaded authority; it never retries provider/tool/compact/final-delivery work.

The synchronous-only limitation applies to layered planning, not `/compact tools`. Historical response pruning uses the existing provider-free typed serialized exact-owner history operation, with the same empty-history classification and result surface as local placement. It never enters the planning scheduler or creates a compact queue record.

### D-context-compact-runtime-gate

[2026-08-21] During the dedicated compact phase, runtime accepts only `submit_compact_plan` and returns bounded feedback for other calls. The tool requires `replaceAsBlocks`; it prefers a direct array with explicit nested block/fact schema but also accepts a nonempty JSON string that decodes to the same array. `replaceAsBlocks: []` and `replaceAsBlocks: "[]"` are valid only when another operation performs work. `preserveMessages` and `removePreservedMessages` remain direct number arrays. Obsolete top-level `createBlocksJson` and `createBlocks` inputs fail rather than receiving compatibility aliases. This intentional contract update supersedes the prior compact-plan argument shape; normal and compact phases still expose the same current tool definition as required by [D-llm-stable-tool-schema](../modules/llm.md#d-llm-stable-tool-schema).

### D-context-hard-candidate-policy

Raw and block candidate quotas are computed after visibility, atomic grouping, and protection barriers. A plan may accumulate coverage across legal segments but one operation cannot cross a segment.

### D-context-block-associated-memory-facts

Durable compact facts belong only in the `memoryFacts` array of their matching `replaceAsBlocks` entry.

- The planner does not submit a top-level fact payload or repeat facts in summary prose.
- Normalized facts remain optional archive-block data. The framework appends a deterministic Markdown `Memory facts` section to the stored summary, so later layered compaction sees prior facts in source summaries.
- Total fact caps and text deduplication apply across the whole plan, not once per block. The SQLite reader tolerates migrated historical blocks without this field.
- Best-effort vector rows retain each creating block's identity, level, and raw source range; failures never undo the durable compact commit.
- Fork-lineage semantic search admits a fact-bearing inherited block only through its block cap. Legacy fact rows without block identity must end at or before the message fork cap; crossing facts are discarded, never range-clipped for recall.

### D-context-preserved-raw

`preserveMessages` keeps exact raw wording immediately after a new summary block. `removePreservedMessages` removes only those marked active-history entries; archive messages and blocks remain immutable.

### D-context-sqlite-archive-authority

[2026-08-03] `archive-store.sqlite` is the sole runtime authority for raw messages, summary blocks, lineage, and vector checkpoints. Runtime commits use WAL with `synchronous=FULL` and do not dual-write JSONL. The startup migration must strictly import and verify all legacy active JSONL before moving sources to a path-preserving migration backup; unverifiable sources fail closed and remain retryable. Compatibility JSONL is explicit export output, not live storage.

The sole malformed-line recovery exception is migration-only and evidence-bound: a physical message line may begin with a canonical legacy message header, contain a prefix torn inside a JSON string, and end with exactly one complete canonical message record whose `sessionId` and `seq` match that prefix. Ordinary legacy bootstrap skips the physical line; after structural validation, migration-only lineage inference may count a copied recovered parent record for a new fork cap, while only the dedicated migration transaction may insert the suffix, atomically with its durable recovery marker. Duplicate copied sources must agree byte-semantically after canonicalization, and the unchanged raw file plus recovery audit move to migration backup. Blocks, identity mismatches, multiple viable suffixes, complete-object concatenation, other invalid-prefix grammars, and all other malformed shapes remain fail-closed.

### D-context-recall-vocabulary

Exact selection (`target`), semantic location (`vector_query`), and literal post-filtering (`contentFilter`) are separate inputs. The preview renderer owns output budgets, regex filters, tool folding, and exclusion notices.

### D-context-source-backed-recall

[2026-08-16] Vector hits locate archive sources; recall normally presents reloaded source messages/blocks through the shared renderer rather than treating embedding chunks as authoritative history. For legacy or stale rows whose referenced block/message source is unavailable, preserve the existing vector-text compatibility preview, but classify it as a non-authoritative fallback and emit exactly one structured warning per affected hit. Warning fields are limited to bounded source identity and kind/range metadata; query text, vector text/chunks, embeddings, credentials, and unbounded hit payloads must never be logged.

### D-context-optional-vector

[2026-08-12] Vector indexing and semantic recall are an optional derived layer and default disabled. The SQLite archive remains authoritative and continues receiving all raw messages, blocks, lineage, and checkpoints while Vector is off. Disabled startup must not load LanceDB, start a vector worker, run maintenance/backfill, or issue embeddings; best-effort indexing hooks become quiet no-ops, while direct semantic operations fail clearly as `VECTOR_DISABLED` and exact archive recall remains available. Enabling Vector later runs the existing checkpoint-based startup backfill for raw messages and full block summaries accumulated since the last checkpoint; it does not require an archive migration or a second backfill protocol. Fact text remains in its formatted block summary and is included in that block row.

## Open questions

- **Unconfirmed follow-up:** decide whether a future bounded backfill should reconstruct dedicated `memory_kind: fact` rows for compactions created while Vector was disabled. Current re-enable backfill intentionally restores raw/block coverage only, so fact-specific kind/attribution metadata and preference reranking may be incomplete even though the authoritative fact text is searchable in the block row.
