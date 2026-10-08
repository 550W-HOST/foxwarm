# Unit: shared-apply-patch

Files: packages/shared/src/applyPatch.ts, packages/shared/src/applyPatch.test.ts

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
| `formatContextErrorPath(filePath)` | Keeps a long file path from consuming the failed-hunk error budget |
| `formatBoundedFailedHunk(patchLines, maxLength)` | Joins a failed hunk and keeps its head and tail within the diagnostic character budget |
| `formatContextMismatch(patchLines, start, eof, filePath)` | Reports the match failure and only the failed hunk within output limits |
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
- Malformed input retains its specific failure reason and, where useful, one short format hint rather than a repeated full patch example. Context-match errors show only the failed patch hunk, bounded to the context error limit.

## Integration

This is the sole pure patch engine. `fileToolCore.applyPatchOperations` consumes it for Main file/memory, native CLI Node, and primitive Provider execution. Main authorization and external inbound path facts use the same parser before effects. Compact repair uses the parser and update transform directly while retaining its held-file-descriptor and exact invocation-owned path checks. Environment and authority boundaries remain outside this module; see [D-shared-package-boundary](../modules/shared-utilities.md#d-shared-package-boundary).

## Design Decisions

### D-apply-patch-change-counts

Successful add and update operations include compact Git-style line counts in each file summary. Counts come from parsed patch content: add-file content lines count as additions, and only `+`/`-` update lines count as additions/deletions, excluding file headers, hunk anchors, and context. Multiple hunks aggregate per operation. Updated files always show both sides, including zero, while added files show additions only and deleted-file output remains unchanged. The same formatter is shared by master and node execution so normal success and already-applied partial-failure summaries stay aligned.

### D-apply-patch-context-matching

[2026-10-07] Main and shared Node context matching first search exact lines, then trailing-whitespace-trimmed lines, then fully trimmed lines. Only after all three fail, trim and map:

- U+2010–U+2015 and U+2212 to ASCII hyphen.
- U+2018–U+201B to single quote, and U+201C–U+201F to double quote.
- U+00A0, U+2002–U+200A, U+202F, U+205F, U+3000 to ordinary space.

Anchors also gain this final Unicode fallback after their existing exact/trim behavior. Normalization locates existing content only; it does not rewrite retained context or inserted text. Existing anchor reuse, missing-anchor fallback, EOF preference, line endings, and per-file partial-success semantics remain unchanged.

### D-apply-patch-context-diagnostics

[2026-10-09] Context-match error diagnostics retain a short path/match explanation followed by the original failed patch hunk. The hunk keeps its `@@` anchor when present and preserves context, deletion, and insertion prefixes. Errors are limited to 1,600 characters overall; short hunks are shown completely, while longer hunks show their beginning and end with an explicit middle-omitted marker. No actual file content or other hunk is searched for or included. This limit covers the context error; caller-owned already-applied and remaining-operation summaries remain intact.

## Tests

`applyPatch.test.ts` owns the single parser/matcher suite: operation counts, supported Unicode mappings and stricter-pass precedence, anchor/EOF behavior, CRLF/final-newline preservation, malformed envelopes, basic/multiple hunks, blank context, and bounded failed-hunk diagnostics for short, long, and multi-hunk failures. Node and backend tool tests verify matching regressions, unchanged failed files, skipped subsequent operations, and retained partial-success summaries.

Main filesystem tests in `src/tools/applyPatchOutput.test.ts` go through canonical `callTool`; Node wrapper tests cover partial effects and injected primitives. `src/nodeExecution.test.ts` covers provider-owned opaque parent paths, and compact repair, memory/path, authorization, metadata, and paired CLI transport tests retain their respective integration boundaries.
