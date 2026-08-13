# Unit: src-session-compact-plan

Files: src/session/compactPlan.ts, src/session/compactPlan.test.ts, src/session/sessionAutoCompactUsageGuard.test.ts, src/toolsSessionAgent/sessionCompactThreshold.test.ts

## Purpose

Defines the model-facing `submit_compact_plan` schema, candidate/policy types, compact prompt, quota calculations, plan normalization, and validation feedback. It does not mutate sessions; `src/session/history.ts` owns job execution and commit.

## Key exports

- `COMPACT_PLAN_TOOL_NAME` (`submit_compact_plan`) and `COMPACT_PLAN_TOOL_DEFINITION`.
- `COMPACT_FLOW_MAX_ROUNDS` (`15`), `COMPACT_LEVEL_TOKEN_THRESHOLD` (`2000`), and preview constants.
- Candidate, plan, policy, validation-detail, preserved-message, and memory-fact types.
- `clampCompactFraction`, `calculateBlockCompactionWindow` — candidate/force window math.
- `buildMessageCandidateItem`, `buildBlockCandidateItem`, target-level and filtering helpers.
- `buildCompactPromptText` — sectioned goal, range, summary, preservation, quota, and fact instructions.
- `normalizeMemoryFacts` — best-effort per-block fact parsing/sanitization with plan-wide caps and deduplication.
- `validateCompactPlanArgs` — structural, range, overlap, barrier, and quota validation.
- `buildCompactPlanValidationFeedback` — actionable retry text.

## Stable-symbol index

| Symbol/section | Responsibility |
|---|---|
| `calculateBlockCompactionWindow` | Oldest candidate window, newest hard keep, and high-backlog requested coverage |
| `buildCompactPromptText` | One planning prompt over validated candidate segments and run policies |
| `normalizeMemoryFacts` | Optional `createBlocksJson[].memoryFacts` parsing that cannot invalidate the block plan |
| `validateCompactPlanArgs` | Canonical tool-argument parser and validator |
| `buildCompactPlanValidationFeedback` | Converts validation detail into bounded retry guidance |

## Current policy inputs

`src/session/history.ts` supplies per-run policy values. Defaults are:

- raw target-level eligibility: more than 2,000 estimated tokens;
- raw required replacement: 20% of eligible estimated tokens;
- block-level eligibility: 3,000 summary tokens;
- high-backlog force threshold: 5,000 summary tokens;
- eligible block candidate window: oldest floor(40%);
- high-backlog required source-block coverage: 20%, clamped to feasible legal multi-block segments;
- total planning rounds: 15.

## Validation invariants

- A create-block operation stays inside one prompt-listed segment, source kind, and source block level.
- Operations do not overlap and summaries are non-empty.
- Block-source operations normally consume multiple blocks; only the explicit stranded-island exception permits a single source block.
- `preserveMessages` must name raw candidates covered by a newly created message block and cannot split an atomic tool group.
- `removePreservedMessages` can name only previously marked preserved active-history entries listed to the planner.
- Preserved raw tokens do not count as replaced quota; stranded single-block lifts do not count as block reduction.
- Quota coverage may accumulate across segments, but one operation never crosses a segment.
- Optional malformed block memory facts are skipped rather than failing a valid compaction plan; the bounded total and text deduplication apply across all created blocks.

## Integration

- `COMPACT_PLAN_TOOL_DEFINITION` keeps the stable plan-tool shape while facts are nested only in each `createBlocksJson` object; it has no top-level fact argument.
- The dedicated compact runtime accepts the plan tool and rejects other calls with feedback.
- Validated operations are consumed by [src-session-history](./src-session-history.md).
- Cross-module behavior and rationale are canonical in [context compaction and recall](../threads/context-compaction-and-recall.md).

## Design decisions

### D-compact-plan-policy-input

Candidate eligibility and quotas are explicit run policy inputs shared by prompt and validator. The schema does not hide a second set of thresholds.

### D-compact-plan-preserve-exact

Exact raw preservation/removal uses top-level sequence arrays. It never changes immutable archive records or asks the model to manufacture partial raw ranges.

### D-compact-plan-unconfirmed-text

Summary guidance preserves requester wording and unresolved terms when meaning matters; it must not infer a later resolution from facts outside the summarized source range.
