# Thread: context compaction

## Overview

**Governing design constraint; directly requested.** Use recursive, same-level summaries with retrievable origins to retain useful long-running context within a bounded model window. Candidate and planner designs serve that purpose under [active-history authority](./context-compaction-and-recall.md#d-context-active-history-authority) and retained Archive evidence; they must not make the Archive a second working history.

Owns what a compaction plan may summarize and what it records: triggers, response-only tool-result pruning, candidate ranges, planner input and submission, block metadata, and the compact-completion marker. Snapshot jobs, commit safety, cancellation, and scheduling are in [compaction lifecycle](./compaction-lifecycle.md). Archive storage, lineage, and recall are in [archive and recall](./archive-and-recall.md). The active-history authority contract is in the parent [thread](./context-compaction-and-recall.md#d-context-active-history-authority).

## Triggers and tool-response pruning

- `checkAndCompactIfNeeded()` compares final usage with the effective compact threshold. The default is `llm.compactThresholdPercent` (85%) of the resolved model context window; a positive per-session threshold overrides it.
- The runner's continuation trigger compares the previous provider result's total usage with that same threshold. A completed job committed at that safe point satisfies the trigger, and a measurement that strictly exceeds the resolved model context limit waits for pending compact planning before the next provider request. Wait, commit, and Stop rules are canonical in [compaction lifecycle](./compaction-lifecycle.md#commit-and-safe-points).
- Explicit compact requests enter `processSessionCompactionRequest()`.
- The recent raw tail stays out of compaction: the newest raw rows within `llm.compactKeepPercent` (default `0.3`) of the effective compact threshold, or of the raw region present when that is smaller, by estimated tokens. See [D-context-recent-raw-tail](#d-context-recent-raw-tail).

At the automatic trigger, response-only pruning is attempted before layered planning. Layered planning runs only when pruning does not commit. The pruning rule is in [D-context-historical-tool-response-pruning](#d-context-historical-tool-response-pruning).

Pruning is a provider-free rewrite of direct history. Under Session-worker placement, both pruning paths serialize through the exact owner, persist authority, publish the complete projection, and expose the existing `historyVersion` mutation signal so an open Chat refreshes same-count rewritten rows.

## Candidate policy and planning

- The engine decides every operation; the planner writes the summaries. A regular compaction writes one new level-1 block from the raw messages after the newest block (more than 2,000 estimated tokens are required) and merges blocks so that each level holds at most three and levels never increase from oldest to newest. The policy, budgets and migration are canonical in [D-context-log-retention](#d-context-log-retention).
- The plan must contain exactly the required operations. Other preserved raw rows, protected lifecycle rows and non-candidate rows inside an operation's range keep their order after the new block; they are no longer range barriers. Active-history adjacency still decides tool-exchange atomicity and raw candidate grouping under [raw sequence gaps](#raw-sequence-gaps-and-active-history): a present adjacent call/tool-response run is atomic in either persisted shape, prior compact-completed notices and display-only rows are transparent, and duplicate or reversed sequences end raw candidate grouping.
- The compact tool remains in the normal model-facing tool set. Dedicated planning accepts one direct/file plan submission, or an exact-file edit/patch while repair is pending; other calls and invalid plans receive bounded feedback within 15 total planning rounds. Submission forms and repair security are canonical in [D-context-compact-runtime-gate](#d-context-compact-runtime-gate).
- The plan creates the required summary blocks and may preserve a small set of exact raw messages from the new level-1 block's source, remove previously preserved active-history entries, and attach optional durable memory facts to each created block. Naming any member of a preserved tool exchange in `preserveMessages` keeps the model call message and all its paired response messages together; the retained exchange is excluded from covered raw quota as one candidate. `removePreservedMessages` must list every member of a preserved tool exchange; naming only part of one is rejected with the missing seqs.

## Request-size failure diagnostics

The maintained `ModelRequestOwner` adds estimated token counts for base instructions, the memory snapshot, tool declarations, and the history/request remainder to compact-plan provider failures and ordinary context-length/request-too-large failures. The same breakdown reaches existing retry/error presentation and attempt journal diagnostics, after the bounded provider-error summary so it is not truncated away. It uses the existing compaction text and image estimators over the effective instructions, declarations and repaired request history; these are estimates, not provider token accounting. No retry policy, automatic trimming, compaction scheduling, or hard request limit is added. `RequestSizeDiagnosticsTests` and `CompactLifecycleTests.MemoryDiagnostics` cover ordinary rejections and both actual awaited/background planner failure paths.

The [memory warning](./conditional-memory-snapshots.md#d-memory-size-warning) identifies an oversized reusable snapshot before a request fails.

## Modules and units

- [src-session-history](../units/src-session-history.md)
- [src-session-compact-plan](../units/src-session-compact-plan.md)
- [src-session-layered-context](../units/src-session-layered-context.md)

## Invariants

- Outside in-context compaction, every committed operation is one the retention policy required for that snapshot; summarized sources are never split across operations, and non-source rows inside a range survive after the new block (except retired preserved rows).

## Design decisions

### D-context-historical-tool-response-pruning

**Selected derived design for [bounded working context](#overview).** Response-only pruning was approved as a cheaper first step; truthful recall footers additionally require [source-backed evidence](./archive-and-recall.md#d-context-source-backed-recall). Its Archive proof belongs to pruning alone. The later layered planner consumes the resulting active text without inheriting that proof requirement.

[2026-08-13, clarified 2026-08-16] At the existing provider-usage automatic compaction trigger, dry-run one coherent response-only pruning pass over the complete active-history snapshot. Eligibility is limited to oversized historical function responses wholly inside the ordinary oldest/compactable region; never prune function-call arguments, split an atomic call/response group, or touch the protected recent/current tail. Before exposing a recall footer, prove exactly one positive-seq row in the complete active snapshot, exactly one effective immutable archive record at that seq, and byte-semantic equality after the approved transient-provenance normalization; missing, duplicate, conflicting, inherited-identity-conflicting, or offline-edited provenance is nonprunable. Revalidate those exact archive identities at commit. Archive reads validate only and never reconstruct active history. Each rewritten response uses the complete provider-visible `formatToolResponsePayload` envelope and keeps an approximately 500-character Unicode-safe, line-aware head and tail. Prefer an existing non-small top-level `output`, `content`, or `error` key as the bounded excerpt carrier, preserve the other small meaningful siblings under their original keys, and use `output` only when no suitable carrier exists. Also retain the function-response identity and only small fixed path/node/run/status/hash/location-style metadata. Its deterministic footer names the exact `msg#N` recall target and tool identity. Once committed, the pruned projection is ordinary authoritative active history and remains eligible for later layered compaction without another Archive comparison; only the pruning operation owns the Archive proof that makes its recall footer truthful.

[2026-10-09] Commit automatic pruning only when the resulting Session estimate is strictly below 60% of the plan's pre-pruning estimate. The commit re-estimates the proposed history, including any appended suffix, against that fixed cap. This gate rejects marginal prefix rewrites; it measures relative estimated reduction, not the complete provider prompt or a guaranteed percentage of the model context window. Success satisfies that trigger and does not immediately layer-compact; failure leaves the original history unchanged and proceeds with ordinary layered compaction. Commit uses exact-prefix compatibility with appended-suffix retention and the existing authority persistence/resync failure boundary; it adds no revision, cooldown, pass counter, override map, sidecar, or repeated loop. Manual `/compact tools` uses the same response-only primitive without the relative reduction gate, avoids persistence/history-version changes on true no-op, and returns inspected/touched/pruned/token-saving estimates. Successful manual or automatic pruning preserves `promptCacheKey`; `/clear` remains the rotation boundary.

Only a response paired by `tool_use_id` with a unique persisted builtin `skill` call using `action:"load"` is exempt from pruning. This includes the existing `call_tool` descriptor shape after normal unified-call parsing and the readable legacy `load_skill` call; `skill(action:"list")` and unrelated responses receive no exemption. A mixed tool-response message skips only the paired load responses while applying ordinary pruning to every other eligible response.

### D-context-compact-completion

Compact completion is a single self-closing `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` marker. Additional continuation text and compacted-skill guidance are escaped into its `hint` attribute. There is no tag body, separate payload part, or leading `Compaction completed.` line.

Only the newest pure compact-completion notice remains in active model-visible history after a later successful compact. Older current/legacy completion notices are transparent to planning, never become summary text, and are removed from the complete compatible active history at commit time (including force-kept tail items); durable archive records are never rewritten. Other session-boundary events and messages containing real user/tool/content remain protected. Failed or non-committing compaction leaves active history unchanged.

Continuation identity and skill-reload consequences are owned by [conversation and history](../behaviors/conversation-and-history.md#actions-and-consequences). `extractCompactedSkillNames` scans only the consumed snapshot prefix for direct `skill(action:"load")` and persisted legacy `load_skill` calls; arbitrary wrapper output is not skill-load evidence. Canonical implementation: `formatCompactionCompletionMarker()` in [src-session-history](../units/src-session-history.md).

### D-context-compact-planner-debug

[2026-10-07] A successful planner-backed compact completion stores diagnostics at top-level `Message.compaction.planner`, not under `__meta`. `steps` counts planner rounds, `toolCalls` is a string array of tool names in occurrence order (including repeated names, rejected calls and repairs), and `messages` preserves complete newly appended planner instructions, responses and tool feedback without the inherited history prefix. Complete call arguments remain in `messages`, not duplicated in `toolCalls`. Optional `overBudget` lists summaries accepted above their budget tolerance under [D-context-log-retention](#d-context-log-retention) (`sourceKind`, `sourceStart`, `sourceEnd`, `level`, `tokens`, `budget`). Optional `usage` sums each round's reported result once; it excludes parent Session totals and does not recount usage echoed on assistant metadata. Reasoning usage remains a component of output usage. Provider-free cleanup does not invent a planner record, and missing provider usage remains absent.

The diagnostics use ordinary Session-history and Archive persistence and the existing JSON inspection views; there is no separate storage or dedicated UI. Request preparation excludes the entire `compaction` field from provider input and canonical request journals, while context estimates continue to count message parts only. The completion marker itself remains model-visible under [D-context-compact-completion](#d-context-compact-completion).

### D-context-compact-planner-prefix

**Derived design; directly selected to preserve [request-prefix reuse](./conditional-memory-snapshots.md#d-memory-request-prefix-stability), subject to [active-history authority](./context-compaction-and-recall.md#d-context-active-history-authority).** Copy the actual older working prefix rather than synthesize a cleaner candidate-only prompt. The complete job snapshot and complete-exchange split implement those two constraints together.

[2026-10-01] The temporary compact planner starts with the active-history prefix before the force-kept recent tail, at the existing complete tool-exchange boundary. Preserve every prefix entry in order, including blocks, protected entries, and previously preserved raw messages; do not rebuild input from candidates or archive data. Planning instructions and retry exchanges append only to this detached prefix, keeping force-kept recent history out of the planning input. The complete job snapshot remains authoritative for candidate/range metadata, compatible commit validation, and retention of the unchanged tail plus a concurrently appended suffix. This changes neither persistent Session/fork identity nor request settings, sequence counters, history version, prompt-cache lineage, or awaited/background request scope. A zero keep fraction exposes the complete prefix; a split with no older items remains a no-op.

### D-context-compact-runtime-gate

**Derived design for directly requested file-based correction and general file submission.** Node routing is the engineering choice that makes those operations available through existing authorized file capabilities. It serves economical plan repair under the [shared schema](../modules/llm.md#d-llm-stable-tool-schema), [ordinary authorization](./tool-dispatch-authorization.md#d-dispatch-generic-tool-authorization), and [active-source authority](./context-compaction-and-recall.md#d-context-active-history-authority). Artifact lifecycle and dispatch details below are mechanisms, not additional product restrictions.

The goal is to submit and correct a compact plan without repeatedly regenerating a large argument object. File input is another representation of the same plan, not a separate validator or an authorization bypass. Normal and compact requests retain the same model-facing tool definitions under [request-prefix stability](./conditional-memory-snapshots.md#d-memory-request-prefix-stability); execution eligibility is checked separately.

The maintained host accepts direct plan fields or `argsFilePath`, with the file containing a top-level plan object and no recursive file reference. File input excludes direct plan fields; the opt-in in-context selector remains an outer control. Ordinary selected-Node/captured-cwd authorization and complete file reads apply. An authorized file can be submitted from the start, including while another dedicated repair artifact is pending.

Dedicated planning permits one plan submission, or an exact pending-file `edit` (including a single-update patch), within its existing round budget. Rejected arguments preserve available raw text, or an identified structured serialization fallback, in an operation-owned artifact on the captured Node. Feedback identifies the error and file; successful replacement staging can replace an earlier rejected artifact. Cleanup is best-effort on that same Node, with no Main fallback or replay of an accepted plan. Ordinary in-context rejection instead produces an ordinary repairable file without a new pending-operation registry; normal file tools repair it before resubmission. Acceptance and application remain distinct, and current active-source validation still applies.

The maintained implementation, failure classifications and supported call paths are in [Session compaction](../units/session-compaction.md#deliberate-in-context-submission). The retained TypeScript implementation still has its older Main-only, invocation-bound descriptor repair path; its [reference unit](../units/src-session-compact-plan.md#reference-repair-file-semantics) describes those mechanics. That reference limitation does not constrain the maintained Node-routed file-input contract.

### D-context-log-retention

**Directly selected by the user (2026-11-11, decisions D1–D5 of the CTX-block retention design).** Summary detail should fall off with age, roughly logarithmically: recent work keeps fine-grained blocks and older work fewer, coarser ones, while the summary region stays bounded and its older prefix changes rarely. The earlier policy (oldest 40% of each level above 3,000 tokens, quota-driven) let block counts and region size grow without bound and rewrote old blocks near the top of the request prefix. This replaces the earlier `D-context-hard-candidate-policy`.

- **Shape (D1).** Read from oldest to newest, block levels never increase, and each level holds at most `k = 3` blocks. A level is a time-scale rank: a level-`j` block covers roughly `2^(j-1)` level-1 stretches. New level-1 summaries have a 3,000-token budget, merged summaries 1,500.
- **One compaction.** One new level-1 block from the raw messages after the newest block. Then, from level 1 upward, while a level holds more than three blocks, its two oldest merge into one block at the next level; the new level-1 block counts toward level 1. Because `k ≥ 2`, every merge uses blocks that existed before this compaction, so all operations are independent ranges in one plan. Raw messages left between older blocks are not new-block sources.
- **Region backstop (D2).** When the summary region would exceed 24,000 estimated tokens, the oldest block absorbs its younger neighbour at the oldest block's level. The new level-1 block is never absorbed. Existing blocks count at their actual size; a summary written in this run is projected at 0.6 × its budget, and a merged one at no more than its sources, because real summaries average about that share. The backstop runs only when the layout was already normalized at the start of the run and the cascade completes within the cap (coordinator decision 2026-11-11 after the real-Session dry run): during migration it would fold many small legacy blocks into one gist.
- **Pinned rows.** Preserved raw rows, protected lifecycle rows and other non-source rows inside a range stay in order after the new block. Preserved raw rows retire from active history when the block that kept them is merged (D3); the Archive keeps them. The planner prompt marks each such row with the operation that removes it and asks for its content to be covered in that summary.
- **Migration (D4).** Existing layouts are normalized by the same planner, with no separate pass: scanning from newest to oldest, a block whose level is below that of the next younger group joins that group, which keeps the higher level (no +1). Each group with several members becomes one new summary written from its original, possibly mixed-level, sources. Single legacy blocks stay as they are, including oversized ones, until a cascade or backstop merge takes them. At most three block operations run per compaction. Normalization groups are applied oldest first, as many as fit the cap after cascade merges combine some of them. Cascade and backstop merges then follow in the order they occur and stop at the first merge that cannot run now (the cap, or a source waiting for a later normalization). Each merge keeps the level order, so every prefix of them does too; a level can briefly hold four blocks.
- **Budgets (D5).** A budget covers the stored summary including its memory-facts section. A summary above 1.25 × its budget is returned with a budget-only rejection. After two such rejections the plan is accepted, and the overruns are recorded in planner diagnostics as `overBudget`.
- **Exact operations.** `CompactRetention.Plan` computes the required operations from the candidates; the validator accepts a plan only if its `replaceAsBlocks` entries match them exactly (kind, source range, level) and lists the expected operations in its feedback. The model-facing `submit_compact_plan` schema is unchanged. The planner prompt lists the operations with their sources and budgets.
- In-context compaction keeps its opt-in rules (planner-chosen ranges within one segment) and may leave a layout that violates the shape; the next regular compaction normalizes it. **Directly selected by the user (2026-11-11, D6):** a single-block rewrite keeps its source level, because it shortens a block without widening its time span; several blocks still merge one level up. A level-1 source becomes level 2, because block-sourced summaries start at level 2 in the persisted block shape. Budgets are advisory in this mode: the accepted tool result lists summaries over budget in `overBudget` instead of rejecting them. Requester guidance for `/compact` and `compact_session` shapes summary content only; the operations are fixed.

Block merges ignore the earlier same-level segment barriers: non-candidate rows inside a range float, and mixed-level sources are recorded in `sourceBlockIds` like any other children. The new block's raw span runs from its first source to its last.

### D-context-recent-raw-tail

**Directly selected by the user (2026-11-11, D7 of the CTX-block retention design).** The force-kept recent tail is measured in estimated tokens, not in rendered rows. A row count mixes 100-character notices with 20k-character tool results and counts summary blocks as rows, so the kept raw volume varied by about a factor of two between compactions.

- Budget: `compactKeepPercent` × the smaller of the effective compact threshold (the per-Session `compactThresholdTokens`, or `compactThresholdPercent` of the model context window) and the estimated tokens of the raw rows after the newest summary block. Automatic compaction runs at or above the threshold, so it keeps the threshold share; a manual or forced compaction of a shorter history keeps the same share of what is present instead of keeping everything. The configuration key keeps its name and default; its unit changed from a share of rows to a share of tokens. A manual `keepPercent` override uses the same unit. [2026-11-11] A fixed share of the threshold alone would leave a short history entirely in the tail, making manual compaction and `/compact tools` no-ops.
- The tail is the newest rows whose `CompactCandidateBuilder.Tokens` estimate of the model-visible preview fits the budget. The newest row is always kept. Display-only rows and compact-completion notices cost nothing. Summary blocks never belong to the tail: the walk stops at the newest block, so every block is available to block planning.
- The split then moves back to the start of a complete tool exchange, as before. Response-only tool pruning uses the same split.
- A zero budget keeps nothing (the complete prefix is compactable).

### D-context-preserved-raw

**Directly selected preservation constraint for [layered summarization](#overview).** Some wording must survive verbatim rather than through a new summary. The marked active entries and whole-exchange handling implement that choice under [active-history authority](./context-compaction-and-recall.md#d-context-active-history-authority); removing a preserved projection never erases its retained source.

`preserveMessages` keeps exact raw wording immediately after a new summary block. `removePreservedMessages` removes only those marked active-history entries; archive messages and blocks remain immutable.

[2026-11-11, user decision D3] When a regular compaction merges a block, the raw rows it preserved retire from active history; the Archive keeps them. In-context compaction does not retire them.

### D-context-block-execution-friction

[2026-10-11] Each new compact block is requested to carry an optional `frictionScore`: an integer from 0 (none observed) to 100 (severe or repeated execution friction). It is an improvement signal for workflows, skills, memory, or the framework, not Agent emotion, task difficulty, a probability, or an established defect diagnosis.

- The planner judges only the summarized source range. Repeated errors, misunderstandings, authorization/tool-boundary confusion, user corrections, avoidable rework, and blocked progress may justify higher scores. Task complexity, long conversations, expected negative tests, and reasonable exploration alone do not. Later recovery does not erase historical friction or imply that it remains unresolved.
- Missing or invalid values are unscored and omitted without failing an otherwise valid plan. Zero is a valid scored value. Existing active/archive blocks without the field stay unknown; there is no historical backfill or immutable-record rewrite.
- Normalized scores flow through the existing compact job, immutable block record, nullable SQLite `friction_score` column, archive readers/export/import, and structured `__meta.contextBlock` metadata. Ordinary CTX-BLOCK text, summaries, headers, and recall text are unchanged.
- Higher-level candidate prompts expose valid source scores from authoritative active-history metadata, never by rebuilding active input from Archive. The planner reassesses the new range using summaries and available scores; the backend does not average, maximize, accumulate, or rank by them.
- This field adds no automatic optimization, memory/skill edits, UI scoring controls, separate storage/indexes, or logging/events. Candidate quotas, commit compatibility, lineage, token controls, and compact triggers remain unchanged; durable facts still use `memoryFacts`.

### D-context-block-associated-memory-facts

**Directly selected representation constraint for facts discovered during [summarization](#overview).** Per-block association and framework-appended summary text avoid requiring the planner to write each fact twice. This keeps [source-backed recall](./archive-and-recall.md#d-context-source-backed-recall) and fork limits meaningful. The exact storage encoding, caps/deduplication and derived Vector rows are engineering mechanisms, not a second authoritative memory store.

Durable compact facts belong only in the `memoryFacts` array of their matching `replaceAsBlocks` entry.

- The planner does not submit a top-level fact payload or repeat facts in summary prose.
- Normalized facts remain optional archive-block data. The framework appends a deterministic Markdown `Memory facts` section to the stored summary, so later layered compaction sees prior facts in source summaries.
- Total fact caps and text deduplication apply across the whole plan, not once per block. The SQLite reader tolerates migrated historical blocks without this field.
- Best-effort vector rows retain each creating block's identity, level, and raw source range; failures never undo the durable compact commit.
- Fork-lineage semantic search admits a fact-bearing inherited block only through its block cap. Legacy fact rows without block identity must end at or before the message fork cap; crossing facts are discarded, never range-clipped for recall.

## Active-history ranges

### Raw sequence gaps and active history

**Directly selected constraint under [active-history authority](./context-compaction-and-recall.md#d-context-active-history-authority).** [2026-10-29] Candidate ranges and complete tool exchanges follow present active-history order. Valid forward allocation gaps are empty space, not intervening content. Existing display-only and pure compact-completion transparency applies whether those rows are still present or have been removed by ordinary cleanup. Raw identities remain positive, unique and increasing; missing, duplicate or reversed identities, unsequenced exchanges, protected/preserved rows, and block source/level boundaries retain their structural rules.

The maintained engine shares this adjacency rule across candidate segmentation, recent-tail exchange splitting, plan validation and preserved-exchange removal. Preservation expands to actual present members, never an integer interval containing absent IDs. Quotas use candidate tokens/counts, not numeric range width. No Archive read, renumbering or gap record is required. The retained TypeScript reference still has its older numeric-gap segmentation; it is not a second maintained runtime target.
