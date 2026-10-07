# Unit: shared-apply-patch

Files: packages/shared/src/applyPatch.ts, packages/shared/src/applyPatch.test.ts
Secondary test reference: src/applyPatch.test.ts

## Purpose

Parses and applies text-based patch operations (update, add, delete) to file contents. It handles patch envelope extraction, diff parsing with context matching and fuzz tolerance, and chunk-based line splicing to produce patched output.

## Key Exports

- `ApplyPatchOperation` — Discriminated union type for update/add/delete file operations
- `extractPatchEnvelope(input)` — Extracts and validates the patch envelope from raw input
- `parseApplyPatchInput(input)` — Parses a full patch into a list of `ApplyPatchOperation` objects
- `applyUpdatePatch(content, lines, filePath)` — Applies an update diff to existing file content
- `buildAddedFileContent(lines)` — Joins add-section lines into final file content
- `countApplyPatchOperationLines(operation)` — Counts inserted and deleted patch content lines
- `formatApplyPatchOperationSummary(operation, displayPath?)` — Formats the per-file success summary used by master and node tools

## Function Index

| Function | Description |
|----------|-------------|
| `isFileHeader(line)` | Checks known file action prefixes |
| `normalizeNewlines(text)` | Converts CRLF to LF |
| `extractPatchEnvelope(input)` | Extracts the patch envelope or wraps a bare patch |
| `parseApplyPatchInput(input)` | Parses file operations |
| `parseUpdateSection(lines, filePath)` | Validates update sections contain changed lines |
| `parseAddSection(lines, filePath)` | Strips add-file content prefixes |
| `getLineEnding(text)` | Detects original line ending style |
| `restoreLineEndings(text, lineEnding)` | Restores CRLF when needed |
| `isDone(state, prefixes)` | Checks parser termination |
| `readStr(state, prefix)` | Consumes a prefixed parser line |
| `normalizeMatchLine(value)` | Trims and maps the supported Unicode punctuation/spaces for matching only |
| `advanceCursorToAnchor(anchor, inputLines, cursor, parser)` | Navigates anchors with exact, trim, then Unicode fallback |
| `readSection(lines, startIndex, filePath)` | Reads contiguous context and edit chunks |
| `equalsSlice(source, target, start, mapFn)` | Compares a contiguous line sequence using one normalization pass |
| `findContextCore(lines, context, start)` | Searches in exact, trimEnd, trim, then Unicode order |
| `findContext(lines, context, start, eof)` | Prefers end-of-file context before the existing forward-search fallback |
| `diagnosticSnippet(value, offset)` | Produces a bounded, escaped excerpt near a differing character |
| `findDiagnosticCandidate(lines, context, start)` | Finds a unique first nonblank context line or long-prefix candidate for diagnostics only |
| `formatContextMismatch(lines, context, start, eof, filePath)` | Reports context size and a local mismatch or limited preview within output limits |
| `parseUpdateDiff(lines, input, filePath)` | Positions chunks using anchors and context matching |
| `applyChunks(input, chunks, filePath)` | Splices edit chunks and rejects overlaps |
| `applyUpdatePatch(content, lines, filePath)` | Normalizes, applies chunks, and restores line endings |
| `buildAddedFileContent(lines)` | Joins add-file content lines |
| `countApplyPatchOperationLines(operation)` | Counts inserted/deleted patch content lines |
| `formatApplyPatchOperationSummary(operation, displayPath?)` | Formats per-file success summaries |

## Dependencies

None — this module is self-contained with no imports from other project modules.

## Behavior

- Normalizes line endings to LF for processing, restores original endings on output.
- Patch envelope extraction supports both explicit `*** Begin Patch / *** End Patch` wrappers and bare patches starting with a file header.
- Update diffs use `@@` anchors and contiguous context sequences with whitespace and Unicode fallbacks; see [D-apply-patch-context-matching](#d-apply-patch-context-matching).
- Chunks track original line indices for deletions and insertions; `applyChunks` validates no overlapping or out-of-bounds chunks.
- Per-file success summaries report `Added path (+N)` and `Updated path (+N -M)`; delete summaries retain `Deleted path`.
- Throws descriptive errors on malformed input, missing context matches, or structural violations.

## Integration

This is a shared utility consumed by other packages that need to apply text patches to file contents (e.g., tool implementations that handle `apply_patch` operations from an LLM). It provides the parsing and application logic while leaving file I/O to callers.

## Design Decisions

### D-apply-patch-change-counts

Successful add and update operations include compact Git-style line counts in each file summary. Counts come from parsed patch content: add-file content lines count as additions, and only `+`/`-` update lines count as additions/deletions, excluding file headers, hunk anchors, and context. Multiple hunks aggregate per operation. Updated files always show both sides, including zero, while added files show additions only and deleted-file output remains unchanged. The same formatter is shared by master and node execution so normal success and already-applied partial-failure summaries stay aligned.

### D-apply-patch-context-matching

[2026-10-07] Main and shared Node context matching first search exact lines, then trailing-whitespace-trimmed lines, then fully trimmed lines. Only after all three fail, trim and map:

- U+2010–U+2015 and U+2212 to ASCII hyphen.
- U+2018–U+201B to single quote, and U+201C–U+201F to double quote.
- U+00A0, U+2002–U+200A, U+202F, U+205F, U+3000 to ordinary space.

Anchors also gain this final Unicode fallback after their existing exact/trim behavior. Normalization locates existing content only; it does not rewrite retained context or inserted text. Existing anchor reuse, missing-anchor fallback, EOF preference, line endings, and per-file partial-success semantics remain unchanged.

Context-match error diagnostics are limited to 1,600 characters overall and 240 characters per line, with escaped snippets limited to 160 characters. A unique match for the first nonblank context line (or its first 32 characters for a long line) may identify a candidate and the first inconsistent Expected/Actual line; snippets focus near the differing character. Ambiguous or unlocated context gets at most three expected and three actual preview lines plus context size.

These candidates are diagnostic only and never authorize patch application; missing punctuation and omitted intervening lines still fail. No complete-context log is written. These limits cover the context error; caller-owned already-applied summaries remain intact.

## Tests

The local test file covers operation counts. Cross-engine behavioral fixtures are in `src/applyPatch.test.ts`; Node filesystem tests in `packages/shared/src/nodeTools.test.ts` verify Unicode edits, unchanged failed files, skipped subsequent operations, and already-applied summaries.
