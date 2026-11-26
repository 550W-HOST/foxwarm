# Unit: Conditional Agent memory

Files: `dotnet/Foxwarm/Memory/ConditionalMemory.cs`

## Purpose

Filters `foxwarm-if` blocks in one memory-source body for a concrete model identity and Session runtime, and formats/reads the current-model snapshot header.

Snapshot ownership, legitimate refreshes, and caller composition are governed by [conditional memory and request prefixes](../threads/conditional-memory-snapshots.md#d-memory-request-prefix-stability).

## Stable symbols and callers

- `FilterConditionalMemorySource(source, modelId, runtime = "foxwarm")` — called by `AgentMemory.BuildAsync` and its selected-file path for every framework, inherited, own and selected memory body. `AgentMemory` passes `claude-code` when it builds an external-runtime snapshot and `foxwarm` otherwise.
- `BuildCurrentModelSnapshot` / `ReadCurrentModelSnapshotId` — the first-line model marker used for snapshot reuse.

The filtered text is prompt input; this unit does not write Session authority or Archive.

## Grammar

- Wrappers occupy complete lines with optional surrounding spaces or tabs, outside fenced Markdown, and are not nested. The opening wrapper is `<foxwarm-if` followed by one or more ` name="value"` attributes, each separated by exactly one space, then `>`. The closing wrapper is `</foxwarm-if>`.
- Supported attributes are `model-id` (matched against the concrete model identity), `runtime` (`foxwarm` or `claude-code`) and `master-node` (`true` or `false`: whether the runtime has a master Node, [capability profile](./hosted-capabilities.md#d-capability-profile)). Each may appear once. A block is kept only when every attribute matches.
- An attribute value is a space-separated list of patterns. Only `*` is a wildcard; matching is case-sensitive and anchored. The value matches when at least one positive pattern matches (or there are no positive patterns) and no `!`-prefixed pattern matches. An empty value is the single empty pattern.
- Unknown or repeated attributes, single quotes, irregular spacing, and malformed, orphaned, unclosed or nested markup remain literal text. A matching pair keeps only its body; a nonmatching pair removes wrapper and body.

The capability profile is fixed for the process, so `master-node` never changes a running installation's snapshots; the bundled framework prompt uses it for the hosted copy. Runtime is fixed when a Session is created, and external-runtime snapshots are built separately without a model marker, so the runtime condition does not change snapshot identity or reuse. A Claude Code snapshot uses the CLI-reported model name (empty before the first run), not a Foxwarm configuration key; Claude Code blocks should therefore select `runtime="claude-code"`.

## Design Decisions

### D-conditional-memory-condition-lists

[2026-11-01] **User-approved.** Keep the small full-line grammar instead of adding a general expression language. Attributes combine with AND, space-separated patterns with OR, and `!` excludes; a `runtime` attribute selects instructions for Foxwarm or Claude Code Sessions. Forms previously treated as literal stay literal, and existing single-pattern blocks keep their results. `Fixtures/parity-corpus.json` covers only the original shared grammar, not these extensions.

### D-conditional-memory-bounded-source-grammar

**Implementation design for the requested conditional-memory feature.** The grammar serves [concrete snapshot identity and stable reuse](../threads/conditional-memory-snapshots.md#d-conditional-memory-concrete-snapshot-identity). Its parsing and literal-fallback rules are the selected source representation, not a general template engine or a security guarantee; the runtime owner decides when those source bodies are adopted.

[2026-09-08] Conditional memory is a small source-body grammar rather than a general template language. Only complete, nonnested full-line `foxwarm-if` pairs outside fenced Markdown are evaluated. Malformed or unsupported markup remains ordinary literal prompt text because the feature is behavioral prompt selection, not an authorization or confidentiality boundary.

Model conditions use exact case-sensitive canonical concrete identities with literal `*` wildcards. Generated snapshots carry one deterministic first-line current-model header with no time-varying metadata; header identity is stored in the prompt text rather than a separate persisted metadata field. Runtime identity, persistence, and refresh decisions are canonical in [D-conditional-memory-concrete-snapshot-identity](../threads/conditional-memory-snapshots.md#d-conditional-memory-concrete-snapshot-identity).


## Tests

`dotnet/Foxwarm.Tests/Memory/ConditionalMemoryTests.cs` covers lists, negation, combined attributes and literal fallbacks; `ClaudeRuntimeTests.Runtime_conditions_select_Claude_Code_memory_blocks` verifies the runtime selection in actual Claude Code and Foxwarm snapshots. `Fixtures/parity-corpus.json` remains the shared-grammar corpus for the DevTools `conditional-memory` probe.
