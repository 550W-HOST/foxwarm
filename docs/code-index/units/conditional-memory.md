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
- Supported attributes are `model-id` (matched against the concrete model identity) and `runtime` (`foxwarm` or `claude-code`). Each may appear once. A block is kept only when every attribute matches.
- An attribute value is a space-separated list of patterns. Only `*` is a wildcard; matching is case-sensitive and anchored. The value matches when at least one positive pattern matches (or there are no positive patterns) and no `!`-prefixed pattern matches. An empty value is the single empty pattern.
- Unknown or repeated attributes, single quotes, irregular spacing, and malformed, orphaned, unclosed or nested markup remain literal text. A matching pair keeps only its body; a nonmatching pair removes wrapper and body.

Runtime is fixed when a Session is created, and external-runtime snapshots are built separately without a model marker, so the runtime condition does not change snapshot identity or reuse. A Claude Code snapshot uses the CLI-reported model name (empty before the first run), not a Foxwarm configuration key; Claude Code blocks should therefore select `runtime="claude-code"`.

## Design Decisions

### D-conditional-memory-condition-lists

[2026-11-01] **User-approved.** Keep the small full-line grammar instead of adding a general expression language. Attributes combine with AND, space-separated patterns with OR, and `!` excludes; a `runtime` attribute selects instructions for Foxwarm or Claude Code Sessions. Forms previously treated as literal stay literal, and existing single-pattern blocks keep their results. The retained TypeScript reference parser does not implement these extensions; its differential corpus covers only the shared original grammar.

## Tests

`dotnet/Foxwarm.Tests/Memory/ConditionalMemoryTests.cs` covers lists, negation, combined attributes and literal fallbacks; `ClaudeRuntimeTests.Runtime_conditions_select_Claude_Code_memory_blocks` verifies the runtime selection in actual Claude Code and Foxwarm snapshots. `Fixtures/parity-corpus.json` remains the shared-grammar differential.
