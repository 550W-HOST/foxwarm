# Thread: archive and recall

## Overview

Owns durable raw-message and block archives, lineage, the optional Vector derived layer, exact and semantic recall, and read-only WebUI history inspection. Archive rows are immutable recall, audit, and lineage sources; they never reconstruct active history, which is owned by the parent [thread](./context-compaction-and-recall.md#d-context-active-history-authority). Planning and commit behavior are in [context compaction](./context-compaction.md).

## Archive storage and lineage

- SQLite uses durable WAL/FULL transactions, archive branches, lineage-bounded effective reads, and vector checkpoints.
- Effective/local message stats use covering SQLite count/min/max scans with the same alias, range, and cumulative lineage caps as content reads. Exact message retrieval keeps the complete effective available range while loading only the selected sequence range.
- Fork branches inherit only parent messages/blocks at or before their fork points.

## Vector indexing and source reload

- `scheduleSessionArchiveIndex()` batches archive indexing at 50 pending messages or 8,000 estimated tokens. Below threshold, first pending raw content arms one fixed non-sliding five-minute timer; pending blocks, threshold crossing, forced indexing, lifecycle cleanup, and shutdown cancel it. Timer fire reuses the canonical serialized per-Session path, while transient timer loss is recovered by restart backfill.
- When enabled, LanceDB `messages_v7` stores raw segments, block rows, and compact-extracted fact rows. Startup backfill uses SQLite checkpoints and can continue after the service becomes ready. Each incremental flush reads message maxima through local stats, loads only the saved overlap tail/new-message range, and reads blocks only after the block checkpoint; a stale tail beyond the durable local range falls back to the local minimum. Raw messages and full block summaries accumulated while disabled remain pending and are discovered from archive maxima after a later enable/restart. Fact text embedded in those summaries is therefore searchable through block rows, but startup backfill does not reconstruct dedicated fact rows.
- `vector.search(query, limit, format, options)` applies the hardcoded Qwen3 query retrieval instruction without changing document embeddings, then returns semantic-distance-primary canonical source families. Duplicate raw chunks collapse, modern facts join their creating block family, and heavily overlapping raw ranges are diversified before source reload. A saturated ANN row window expands deterministically while the non-deferred diverse-family count remains below the request, reusing the same query vector and stopping at the 1,024-row hard cap; unsaturated/hard-cap results then backfill overlap-deferred families. Model-facing recall reloads original archive messages/blocks from those locations before rendering. A tolerated legacy/stale compatibility fallback may render the stored vector text only when the referenced archive source cannot be reloaded; one bounded metadata-only warning records that fallback without logging query or user content.

## Lexical side-channel and rollout phases

- Exact/current-Session semantic recall may supplement a successful dense search with a transient identifier side-channel over existing Archive SQLite authority. At most four high-confidence bounded locators trigger bounded lookup over at most 16 actual current-to-parent branch reads, the newest 2,000 role/model-visible messages and 1,000 blocks per branch, and hard candidate/result caps. Raw rows are parsed and rendered before the 64-match cap through the same `formatSubstantiveMessageSearchText` helper used by final lexical scoring; this canonical formatting excludes tool-only/display/ephemeral/RAG/thinking content, preserves ordinary dual text/system fields, and applies channel-wrapper precedence so wrapped channel content replaces sibling text for that part. NFKC/lower locator matching then runs only on that shared substantive text. Block summaries keep the bounded parameterized ASCII and bounded JS non-ASCII paths. Lexical and dense candidates fuse at canonical source-family level before ordinary Archive reload, filtering, limit, and preview; broad agent scope never scans, lexical failure falls back to dense results, and disabled Vector still fails before this optional side-channel.
- With explicit startup opt-in `vector.lexicalIndex:true`, Phase 2B Slice 2 lets only the exact Vector owner populate that derivative through independent async bounded backfill and scheduling. It remains read-dark: no recall/hybrid query consumes the FTS database, and Phase 2A remains unchanged.
- With the additional default-off `vector.hybridSearch:true`, Phase 2B performs dense-required persistent hybrid reads inside the exact Vector owner. Ordinary exact-session checkpoint lag/TOCTOU does not invoke Phase 2A: safe partial persistent FTS is historical recall, while current recent rows remain in live history. Phase 2A is reserved for disabled/unconfigured, unready/rebuilding, globally startup-backfilling, or query-error bootstrap paths. Current-agent scope may report/query partial persistent coverage but never scans Archive through Phase 2A. Recall emits no model-facing vector-lag notice; source-backed preview/filter/limit/budget semantics remain unchanged.
- Phase 2B Slice 4 makes the opted-in persistent derivative lifecycle-complete for committed rename/fork boundaries and restart-resumable incompatible-schema shadow rebuild. During conflict, unavailable lifecycle, or rebuild, exact persistent coverage remains false and Phase2A continues as bounded fallback; dense/Archive authority remains independent.

## Recall and preview

- `contentFilter` is a literal case-insensitive post-filter on the selected/reloaded result set. `includeRegex` and `excludeRegex` are later post-filters.
- Semantic recall applies those three filter stages to reloaded unique source groups before enforcing the requested result limit. Preview-budget truncation remains separate from the result limit.
- Raw source families use the original vector query and matched chunk to choose a bounded contiguous window from the authoritative reloaded range. Exact chunk-to-message mapping is strongest; explicit `contentFilter`/`includeRegex` matches are high-priority localization signals; identifier/bilingual lexical overlap supplements them; substantive user/model content wins equal tool-only matches. Valid adjacent model-call/tool-response groups remain atomic only when call/response IDs are unique and complete; malformed/orphan/duplicate-ID tool rows are local barriers. Output labels the full range, selected range, and omitted count without rewriting archived text. When a required positive filter matches only omitted rows, the selected item contributes a bounded priority notice naming exact matching message IDs and exact `recall.target` drill-down calls; filtered or result-limit-omitted source groups contribute no such notice.
- Recent current-Session rows remain available in live history while persistent Dense/FTS recall is intentionally eventually consistent. Ordinary semantic recall performs no checkpoint/deadline status lookup and emits no model-facing lag notice; checkpoint and maximum-latency status remain diagnostic/indexing APIs only. Phase2A is limited to disabled/unconfigured, unready/rebuilding, startup-backfilling, or query-error bootstrap paths. Priority notices from selected source windows and an exact empty-result sentence or meaningful item body are reserved before lower-priority title text; long query/title text clips first. `previewLength` bounds emitted JavaScript string length (UTF-16 code units), while every new budget clamp retains whole grapheme segments and never emits lone surrogates.
- `previewLength` is one total output budget, clamped to 1,000–20,000. Tool details are folded unless explicitly expanded.
- Filtering notices remain visible when every item is excluded or the preview is truncated.
- `get_session_messages` uses the same preview renderer and filter vocabulary for selected session-history messages.
- Explicit session-message and recalled raw-message previews mark `modelVisible:false` rows as `[non-context]` and render their stored content under the same filters, tool folding, and total preview budget. This inspection boundary does not make those rows model-visible or add them to semantic indexing.

## WebUI expansion

The WebUI block endpoint expands exactly one layer into structured timeline messages. A block backed by lower-level blocks returns child CTX-BLOCK messages; a message-backed/L1 block returns raw archive messages. Parent and immediate source records are loaded once and shared by structured output plus the compatible text formatter. Expansion is local read-only UI state and never changes history, queue, or broadcasts.

## Modules and units

- [src-session-archive-store](../units/src-session-archive-store.md)
- [src-jsonl](../units/src-jsonl.md)
- [src-vector](../units/src-vector.md)
- [src-tools-session-agent](../units/src-tools-session-agent.md)

## Invariants

- A child cannot recall parent archive content created after its fork point.
- WebUI expansion and recall preview are read-only with respect to live session state.

## Compatibility

- Legacy archive JSONL remains supported only as a fail-closed startup migration input. Explicit CLI export recreates compatibility JSONL from SQLite.
- Existing supported `recall` target selectors remain readable. Removed ambiguous legacy tool names/arguments are not documented as active aliases.

## Design decisions

### D-context-block-id-high-water

[2026-10-02] Block counters do not reset when active history is cleared. Allocation, clear, and new fork creation resolve the next ID as the maximum of the persisted counter, active block IDs plus one, and the effective Archive block maximum plus one. Archive contributes only an indexed ID scalar through existing alias resolution and cumulative fork caps; no summary or raw content is read to choose candidates, reconstruct active history, or derive summary input. A higher persisted counter never decreases, and an empty block append remains a no-op.

Clear persists the resolved counter through its existing exact-owner boundary while retaining its history, queue, wait, and cache-key semantics. New forks apply the resolved counter and counter-minus-one cap only to the new target/branch; the source, including detached Worker authority and Main stubs, stays unchanged. Legacy low counters recover lazily at these existing boundaries, not during hydration or a startup sweep. Existing fork caps and historical duplicate IDs are not rewritten or widened.

### D-context-sqlite-archive-authority

[2026-08-03] `archive-store.sqlite` is the sole runtime authority for raw messages, summary blocks, lineage, and vector checkpoints. Runtime commits use WAL with `synchronous=FULL` and do not dual-write JSONL. The startup migration must strictly import and verify all legacy active JSONL before moving sources to a path-preserving migration backup; unverifiable sources fail closed and remain retryable. Compatibility JSONL is explicit export output, not live storage.

The sole malformed-line recovery exception is migration-only and evidence-bound: a physical message line may begin with a canonical legacy message header, contain a prefix torn inside a JSON string, and end with exactly one complete canonical message record whose `sessionId` and `seq` match that prefix. Ordinary legacy bootstrap skips the physical line; after structural validation, migration-only lineage inference may count a copied recovered parent record for a new fork cap, while only the dedicated migration transaction may insert the suffix, atomically with its durable recovery marker. Duplicate copied sources must agree byte-semantically after canonicalization, and the unchanged raw file plus recovery audit move to migration backup. Blocks, identity mismatches, multiple viable suffixes, complete-object concatenation, other invalid-prefix grammars, and all other malformed shapes remain fail-closed.

### D-context-recall-vocabulary

Exact selection (`target`), semantic location (`vector_query`), and literal post-filtering (`contentFilter`) are separate inputs. The preview renderer owns output budgets, regex filters, tool folding, and exclusion notices.

### D-context-source-backed-recall

[2026-08-16, updated 2026-08-28] Vector hits locate canonical archive source families; recall normally presents reloaded source messages/blocks through the shared renderer rather than treating embedding chunks as authoritative history. Modern fact hits with a creating block reload that block and include bounded matched-fact wording/metadata in the source-backed item; only legacy null-block facts use their raw source range. Filtering runs in the documented literal/include/exclude order before the final unique-source-group limit, so duplicate chunks and fact/block representations cannot consume or misstate that limit. For legacy or stale rows whose referenced block/message source is unavailable, preserve the existing vector-text compatibility preview, but classify it as a non-authoritative fallback and emit exactly one structured warning per affected hit. Warning fields are limited to bounded source identity and kind/range metadata; query text, vector text/chunks, embeddings, credentials, and unbounded hit payloads must never be logged.

### D-context-identifier-lexical-side-channel

[2026-08-28, clarified 2026-08-29] Exact/current-Session semantic recall may use a nonpersistent identifier side-channel only after dense Vector search succeeds. Deterministic bounded extraction admits at most four commit/hash, explicit or high-confidence Session/Node/path/symbol, slash-command, CamelCase/snake_case, or meaningful numeric locators. Ambiguous lowercase hyphenated prose is rejected unless it is an exact infrastructure-shaped Node ID or explicitly identified/quoted. Existing Archive SQLite rows are searched under hard lineage, row, candidate, and result caps: bounded lineage construction stops after 16 entries; raw lookup loads at most 2,000 role/model-visible rows per entry, derives canonical substantive text with the shared message-format helper, applies NFKC/lower locator matching, then caps at 64 matches. The same helper is final raw scoring authority, so whole JSON, function-call arguments, tool wrappers, thinking, display-only, ephemeral/RAG content, and channel-wrapper sibling text cannot establish or crowd a raw match; ordinary dual text/system fields remain visible. The operation creates no FTS schema, branch, checkpoint, or migration state. Dense and lexical ranks fuse at canonical source-family level, with bounded shared-source boost and raw-range containment collapse, before the established source-backed reload/filter/limit/preview path. Broad scope performs no scan, lookup failure preserves successful dense results, and `VECTOR_DISABLED` remains unchanged.

### D-context-persistent-lexical-dark-slice

[2026-08-29] The first persistent-lexical implementation slice is library-only. It may create a separate derived SQLite FTS5 database at an explicit test/caller path and prove strict schema validation, exact canonical synchronization-trigger definitions, tokenizer, safe identifier/prose query compilation, deduplicated restrictive lineage scope, source-family metadata, repairable selective deletion/checkpoints, transactional rollback, rebuild-required, and Lance-directory coexistence behavior. It must not open from Main/Vector/Worker bootstrap, read live Archive data, schedule/backfill, change recall, or alter Phase 2A/dense semantics until a later confirmed slice defines exact-owner wiring and hybrid fusion.

### D-context-optional-vector

[2026-08-12] Vector indexing and semantic recall are an optional derived layer and default disabled. The SQLite archive remains authoritative and continues receiving all raw messages, blocks, lineage, and checkpoints while Vector is off. Disabled startup must not load LanceDB, start a vector worker, run maintenance/backfill, or issue embeddings; best-effort indexing hooks become quiet no-ops, while direct semantic operations fail clearly as `VECTOR_DISABLED` and exact archive recall remains available. Enabling Vector later runs the existing checkpoint-based startup backfill for raw messages and full block summaries accumulated since the last checkpoint; it does not require an archive migration or a second backfill protocol. Fact text remains in its formatted block summary and is included in that block row.

### D-context-history-search-viewer

[2026-09-29] Authenticated Main WebUI can search archived history across all Agents/Sessions, optionally narrowed to an Agent or one Session, and browse exact `msg#N[-M]` references without invoking a model tool or creating a Session. Global search consumes the same ranked Vector/Archive source-family selection as model recall, but returns structured messages for independent result timelines instead of parsing its formatted preview; model-facing recall keeps its own Agent/Session permissions, output format, filters and budget. Search remains unavailable when Vector is disabled; exact and adjacent archive reads remain available. Read-only adjacent pages use bounded SQLite sequence-ordered reads across historical aliases and effective fork caps, and transport preserves normal image/CTX display metadata while excluding opaque provider replay data. The viewer never reconstructs active history from Archive.
For a raw semantic hit, the viewer scans just that source-family interval in bounded Archive pages using the same per-message scorer/anchor tie-break as model recall, then reads a bounded neighborhood for the existing window/tool-group selector. This avoids selecting an unrelated first-page prefix of an otherwise ordinary long token-bounded segment; source-length I/O is proportional to that family's rows, not a whole Session hydration. Exact multi-message references impose no sequence-span cap: they display one bounded page, label the requested/shown ranges, continue within the selected range until exhausted, and then permit ordinary later browsing.

## Open questions

- **Unconfirmed follow-up:** decide whether a future bounded backfill should reconstruct dedicated `memory_kind: fact` rows for compactions created while Vector was disabled. Current re-enable backfill intentionally restores raw/block coverage only, so fact-specific kind/attribution metadata and preference reranking may be incomplete even though the authoritative fact text is searchable in the block row.
