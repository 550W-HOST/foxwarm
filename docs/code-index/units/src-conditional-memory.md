# Unit: src-conditional-memory

Files: src/conditionalMemory.ts, src/conditionalMemory.test.ts

## Purpose

Provides pure parsing and formatting primitives for model-conditional memory source bodies and model-specific prompt snapshot identity headers. Runtime snapshot assembly, model routing, persistence, and request journaling are outside this unit.

## Key exports

- `filterConditionalMemorySource(source, modelId)` — evaluates complete supported `foxwarm-if` blocks in one supplied memory-source body while preserving unrelated source bytes.
- `buildCurrentModelSnapshot(modelId, snapshotBody)` — prefixes a materialized snapshot with the canonical concrete model identity and a stable separator.
- `readCurrentModelSnapshotId(snapshot)` — reads only the exact generated first-line current-model header.

## Behavior

- Conditional wrappers must occupy complete lines, with optional surrounding spaces or tabs. The opening wrapper has one double-quoted `model-id` attribute; the closing wrapper is `</foxwarm-if>`.
- Matching is case-sensitive and anchored to the complete concrete model identity. Only `*` is a wildcard, matching zero or more characters including `/`; all other pattern characters are literal.
- A matching pair retains only its body. A nonmatching pair removes the complete wrapper and body. Multiple sequential and empty pairs are supported.
- Parsing is scoped to one supplied source body, so a condition cannot span memory files.
- Bounded Markdown backtick and tilde fence tracking keeps fenced examples literal without introducing a general Markdown or template parser.
- Unsupported, malformed, orphaned, unclosed, or nested markup remains literal. An unclosed or nested outer region is never partially evaluated.
- Source newline bytes and trailing-newline state are retained except where recognized wrapper lines or filtered bodies are removed.
- Snapshot headers use Foxwarm attribute escaping and exact canonical formatting. The reader rejects missing, body-positioned, noncanonical, or invalid headers.

## Tests

`src/conditionalMemory.test.ts` covers exact and wildcard matching, inline examples, wrapper whitespace, multiple and empty pairs, fenced examples, malformed and nested preservation, LF/CRLF and trailing-newline behavior, escaped pattern/model identities, stable header formatting, and first-line-only header reads.

## Integration

[src-llm](./src-llm.md) calls these helpers while assembling each selected memory-source body and materializing or validating a prompt for an already selected concrete model. This unit itself performs no file I/O, model selection, Session mutation, persistence, or journal writes. Canonical cross-module behavior is owned by [conditional memory snapshots](../threads/conditional-memory-snapshots.md).

## Design Decisions

### D-conditional-memory-bounded-source-grammar

[2026-09-08] Conditional memory is a small source-body grammar rather than a general template language. Only complete, nonnested full-line `foxwarm-if` pairs outside fenced Markdown are evaluated. Malformed or unsupported markup remains ordinary literal prompt text because the feature is behavioral prompt selection, not an authorization or confidentiality boundary.

Model conditions use exact case-sensitive canonical concrete identities with literal `*` wildcards. Generated snapshots carry one deterministic first-line current-model header with no time-varying metadata; header identity is stored in the prompt text rather than a separate persisted metadata field. Runtime identity, persistence, and refresh decisions are canonical in [D-conditional-memory-concrete-snapshot-identity](../threads/conditional-memory-snapshots.md#d-conditional-memory-concrete-snapshot-identity).
