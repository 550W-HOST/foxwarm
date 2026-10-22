# Thread: context compaction

## Overview

Owns what a compaction plan may summarize and what it records: triggers, response-only tool-result pruning, candidate ranges, planner input and submission, block metadata, and the compact-completion marker. Snapshot jobs, commit safety, cancellation, and scheduling are in [compaction lifecycle](./compaction-lifecycle.md). Archive storage, lineage, and recall are in [archive and recall](./archive-and-recall.md). The active-history authority contract is in the parent [thread](./context-compaction-and-recall.md#d-context-active-history-authority).

## Triggers and tool-response pruning

- `checkAndCompactIfNeeded()` compares final usage with the effective compact threshold. The default is `llm.compactThresholdPercent` (85%) of the resolved model context window; a positive per-session threshold overrides it.
- The runner's continuation trigger compares the previous provider result's total usage with that same threshold. A completed job committed at that safe point satisfies the trigger, and a measurement that strictly exceeds the resolved model context limit waits for pending compact planning before the next provider request. Wait, commit, and Stop rules are canonical in [compaction lifecycle](./compaction-lifecycle.md#commit-and-safe-points).
- Explicit compact requests enter `processSessionCompactionRequest()`.
- The default compact request keeps the newest 30% of rendered history (`llm.compactKeepPercent`, default `0.3`).

At the automatic trigger, response-only pruning is attempted before layered planning. Layered planning runs only when pruning does not commit. The pruning rule is in [D-context-historical-tool-response-pruning](#d-context-historical-tool-response-pruning).

Pruning is a provider-free rewrite of direct history. Under Session-worker placement, both pruning paths serialize through the exact owner, persist authority, publish the complete projection, and expose the existing `historyVersion` mutation signal so an open Chat refreshes same-count rewritten rows.

## Candidate policy and planning

- Raw-message candidates require more than 2,000 estimated tokens and, when eligible, must replace at least 20% of eligible raw tokens by default.
- Each block source level below 3,000 summary tokens is ineligible. At or above 3,000, only the oldest floor(40%) is exposed. At or above 5,000, the plan must cover 20% of source blocks, clamped to feasible legal multi-block segments.
- Prior compact-completed notices are transparent candidate noise: they neither enter summaries nor split legal ranges. Other protected lifecycle items, preserved raw items, duplicate/nonmonotonic active sequence structure, and non-candidate blocks are hard range barriers. A forward gap in otherwise valid raw sequence numbers is a range boundary, and the first valid message after it starts the next segment rather than being skipped. A present immediately consecutive active raw call/tool-response run is atomic in either persisted shape (several responses in one tool message, or one response per tool message); a call with no following tool-response row is an ordinary single-message candidate. An ignored lifecycle item occupies its sequence number and ends the current segment, but the next consecutive call/response run starts a new segment and stays atomic. A response whose call is hidden inside a block remains an ordinary candidate island. Display-only messages are transparent and excluded from quota denominators.
- The compact tool remains in the normal model-facing tool set. Dedicated planning accepts one direct/file plan submission, or an exact-file edit/patch while repair is pending; other calls and invalid plans receive bounded feedback within 15 total planning rounds. Submission forms and repair security are canonical in [D-context-compact-runtime-gate](#d-context-compact-runtime-gate).
- The plan may create layered summary blocks, preserve a small set of exact raw messages, remove previously preserved active-history entries, and attach optional durable memory facts to each created block. Naming any member of a preserved tool exchange in `preserveMessages` keeps the model call message and all its paired response messages together; the retained exchange is excluded from covered raw quota as one candidate. `removePreservedMessages` must list every member of a preserved tool exchange; naming only part of one is rejected with the missing seqs.

Configuration defaults: `compactBlockLevelMinTokens=3000`, `compactBlockLevelForceTokens=5000`, `compactBlockCandidateFraction=0.4`, `compactBlockForceCompactFraction=0.2`, and `compactMessageForceCompactFraction=0.2`.

## Modules and units

- [src-session-history](../units/src-session-history.md)
- [src-session-compact-plan](../units/src-session-compact-plan.md)
- [src-session-layered-context](../units/src-session-layered-context.md)

## Invariants

- Compaction ranges never cross a protected candidate segment boundary.

## Design decisions

### D-context-historical-tool-response-pruning

[2026-08-13, clarified 2026-08-16] At the existing provider-usage automatic compaction trigger, dry-run one coherent response-only pruning pass over the complete active-history snapshot. Eligibility is limited to oversized historical function responses wholly inside the ordinary oldest/compactable region; never prune function-call arguments, split an atomic call/response group, or touch the protected recent/current tail. Before exposing a recall footer, prove exactly one positive-seq row in the complete active snapshot, exactly one effective immutable archive record at that seq, and byte-semantic equality after the approved transient-provenance normalization; missing, duplicate, conflicting, inherited-identity-conflicting, or offline-edited provenance is nonprunable. Revalidate those exact archive identities at commit. Archive reads validate only and never reconstruct active history. Each rewritten response uses the complete provider-visible `formatToolResponsePayload` envelope and keeps an approximately 500-character Unicode-safe, line-aware head and tail. Prefer an existing non-small top-level `output`, `content`, or `error` key as the bounded excerpt carrier, preserve the other small meaningful siblings under their original keys, and use `output` only when no suitable carrier exists. Also retain the function-response identity and only small fixed path/node/run/status/hash/location-style metadata. Its deterministic footer names the exact `msg#N` recall target and tool identity. Once committed, the pruned projection is ordinary authoritative active history and remains eligible for later layered compaction without another Archive comparison; only the pruning operation owns the Archive proof that makes its recall footer truthful.

[2026-10-09] Commit automatic pruning only when the resulting Session estimate is strictly below 60% of the plan's pre-pruning estimate. The commit re-estimates the proposed history, including any appended suffix, against that fixed cap. This gate rejects marginal prefix rewrites; it measures relative estimated reduction, not the complete provider prompt or a guaranteed percentage of the model context window. Success satisfies that trigger and does not immediately layer-compact; failure leaves the original history unchanged and proceeds with ordinary layered compaction. Commit uses exact-prefix compatibility with appended-suffix retention and the existing authority persistence/resync failure boundary; it adds no revision, cooldown, pass counter, override map, sidecar, or repeated loop. Manual `/compact tools` uses the same response-only primitive without the relative reduction gate, avoids persistence/history-version changes on true no-op, and returns inspected/touched/pruned/token-saving estimates. Successful manual or automatic pruning preserves `promptCacheKey`; `/clear` remains the rotation boundary.

Only a response paired by `tool_use_id` with a unique persisted builtin `skill` call using `action:"load"` is exempt from pruning. This includes the existing `call_tool` descriptor shape after normal unified-call parsing and the readable legacy `load_skill` call; `skill(action:"list")` and unrelated responses receive no exemption. A mixed tool-response message skips only the paired load responses while applying ordinary pruning to every other eligible response.

### D-context-compact-completion

Compact completion is a single self-closing `<foxwarm-system kind="session-boundary" event="compact-completed" ... />` marker. Additional continuation text and compacted-skill guidance are escaped into its `hint` attribute. There is no tag body, separate payload part, or leading `Compaction completed.` line.

Only the newest pure compact-completion notice remains in active model-visible history after a later successful compact. Older current/legacy completion notices are transparent to planning, never become summary text, and are removed from the complete compatible active history at commit time (including force-kept tail items); durable archive records are never rewritten. Other session-boundary events and messages containing real user/tool/content remain protected. Failed or non-committing compaction leaves active history unchanged.

Continuation identity and skill-reload consequences are owned by [conversation and history](../behaviors/conversation-and-history.md#actions-and-consequences). `extractCompactedSkillNames` scans only the consumed snapshot prefix for direct `skill(action:"load")` and persisted legacy `load_skill` calls; arbitrary wrapper output is not skill-load evidence. Canonical implementation: `formatCompactionCompletionMarker()` in [src-session-history](../units/src-session-history.md).

### D-context-compact-planner-debug

[2026-10-07] A successful planner-backed compact completion stores diagnostics at top-level `Message.compaction.planner`, not under `__meta`. `steps` counts planner rounds, `toolCalls` is a string array of tool names in occurrence order (including repeated names, rejected calls and repairs), and `messages` preserves complete newly appended planner instructions, responses and tool feedback without the inherited history prefix. Complete call arguments remain in `messages`, not duplicated in `toolCalls`. Optional `usage` sums each round's reported result once; it excludes parent Session totals and does not recount usage echoed on assistant metadata. Reasoning usage remains a component of output usage. Provider-free cleanup does not invent a planner record, and missing provider usage remains absent.

The diagnostics use ordinary Session-history and Archive persistence and the existing JSON inspection views; there is no separate storage or dedicated UI. Request preparation excludes the entire `compaction` field from provider input and canonical request journals, while context estimates continue to count message parts only. The completion marker itself remains model-visible under [D-context-compact-completion](#d-context-compact-completion).

### D-context-compact-planner-prefix

[2026-10-01] The temporary compact planner starts with the active-history prefix before the force-kept recent tail, at the existing complete tool-exchange boundary. Preserve every prefix entry in order, including blocks, protected entries, and previously preserved raw messages; do not rebuild input from candidates or archive data. Planning instructions and retry exchanges append only to this detached prefix, keeping force-kept recent history out of the planning input. The complete job snapshot remains authoritative for candidate/range metadata, compatible commit validation, and retention of the unchanged tail plus a concurrently appended suffix. This changes neither persistent Session/fork identity nor request settings, sequence counters, history version, prompt-cache lineage, or awaited/background request scope. A zero keep fraction exposes the complete prefix; a split with no older items remains a no-op.

### D-context-compact-runtime-gate

[2026-10-06] Dedicated planning accepts a single `submit_compact_plan` call by itself. Direct arguments require `replaceAsBlocks`, preferably a direct array with nested block/fact schema or alternatively a nonempty JSON string encoding that array. `replaceAsBlocks: []` and `replaceAsBlocks: "[]"` are valid only when another operation performs work. `preserveMessages` and `removePreservedMessages` remain direct number arrays; obsolete top-level `createBlocksJson` and `createBlocks` inputs fail without aliases.

The alternate submission is `argsFilePath` alone, without any direct fields. The schema uses ordinary optional properties, not a new top-level `oneOf`/`anyOf`; the server enforces the exclusive forms. Normal and compact phases expose the same current tool definition under [D-llm-stable-tool-schema](../modules/llm.md#d-llm-stable-tool-schema).

On the first provider-argument JSON parse failure or plan-validation failure, planning saves `FunctionCall.rawArgsText` verbatim to one private master-side `.json` file under the owner's Agent directory. A provider with structured arguments only may use an explicitly identified JSON-serialization fallback; a parse failure never substitutes the empty parsed-argument placeholder. Further failures retain that same file without renaming or overwriting it. Pending-repair instructions identify the complete rejected tool arguments as the file's source, distinguish the fallback from verbatim provider text, and show the current unformatted file once: complete when at most 1,000 characters, otherwise its first and last 500 characters with an explicit middle-omitted label. Each retry regenerates this preview from the same artifact, including after successful edits. Instructions identify the exact path and repair/submission steps and explain that `read` is unavailable and unnecessary; the invalid-argument tool response does not repeat raw JSON.

While this file is pending, planning may execute one `edit` or one `apply_patch` update of that exact literal path, then returns to the planner. It does not enable arbitrary file access, directories, memory, exec, unified dispatch, or other tools. Existing edit/patch text semantics, cancellation controls, node:master instance authorization, and isolated-Agent checks apply; a deny has no fallback. A patch must contain only one update, never add/delete or another target. File submission reads only the invocation-bound pending artifact, parses a JSON object, and uses the unchanged compact-plan validator.

The artifact is bound to the transient Session object and operation object, with a private directory and file (0700/0600). Literal path, canonical realpath, original inode/device, link count, owner, and permissions are checked around descriptor I/O; descriptor writes cannot follow a substituted symlink. Repair calls and feedback exist only in transient planning history and preview, never authoritative Session history or Archive. Success, cancellation, provider failure, and round exhaustion best-effort close/unlink the file and remove its empty private directory. No repair authority or recovery state is persisted across processes; planner prefix, ready-first scheduling, quotas, commit compatibility, and the 15-round budget remain unchanged.

### D-context-hard-candidate-policy

Raw and block candidate quotas are computed after visibility, atomic grouping, and protection barriers. A plan may accumulate coverage across legal segments but one operation cannot cross a segment.

### D-context-preserved-raw

`preserveMessages` keeps exact raw wording immediately after a new summary block. `removePreservedMessages` removes only those marked active-history entries; archive messages and blocks remain immutable.

### D-context-block-execution-friction

[2026-10-11] Each new compact block is requested to carry an optional `frictionScore`: an integer from 0 (none observed) to 100 (severe or repeated execution friction). It is an improvement signal for workflows, skills, memory, or the framework, not Agent emotion, task difficulty, a probability, or an established defect diagnosis.

- The planner judges only the summarized source range. Repeated errors, misunderstandings, authorization/tool-boundary confusion, user corrections, avoidable rework, and blocked progress may justify higher scores. Task complexity, long conversations, expected negative tests, and reasonable exploration alone do not. Later recovery does not erase historical friction or imply that it remains unresolved.
- Missing or invalid values are unscored and omitted without failing an otherwise valid plan. Zero is a valid scored value. Existing active/archive blocks without the field stay unknown; there is no historical backfill or immutable-record rewrite.
- Normalized scores flow through the existing compact job, immutable block record, nullable SQLite `friction_score` column, archive readers/export/import, and structured `__meta.contextBlock` metadata. Ordinary CTX-BLOCK text, summaries, headers, and recall text are unchanged.
- Higher-level candidate prompts expose valid source scores from authoritative active-history metadata, never by rebuilding active input from Archive. The planner reassesses the new range using summaries and available scores; the backend does not average, maximize, accumulate, or rank by them.
- This field adds no automatic optimization, memory/skill edits, UI scoring controls, separate storage/indexes, or logging/events. Candidate quotas, commit compatibility, lineage, token controls, and compact triggers remain unchanged; durable facts still use `memoryFacts`.

### D-context-block-associated-memory-facts

Durable compact facts belong only in the `memoryFacts` array of their matching `replaceAsBlocks` entry.

- The planner does not submit a top-level fact payload or repeat facts in summary prose.
- Normalized facts remain optional archive-block data. The framework appends a deterministic Markdown `Memory facts` section to the stored summary, so later layered compaction sees prior facts in source summaries.
- Total fact caps and text deduplication apply across the whole plan, not once per block. The SQLite reader tolerates migrated historical blocks without this field.
- Best-effort vector rows retain each creating block's identity, level, and raw source range; failures never undo the durable compact commit.
- Fork-lineage semantic search admits a fact-bearing inherited block only through its block cap. Legacy fact rows without block identity must end at or before the message fork cap; crossing facts are discarded, never range-clipped for recall.
