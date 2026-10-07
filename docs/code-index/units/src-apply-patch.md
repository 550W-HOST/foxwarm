# Unit: src-apply-patch

Files: src/applyPatch.ts, src/applyPatch.test.ts, src/selftest/applyPatchSelfTest.ts

## Purpose

Parses and applies structured text patches to file contents, supporting update (context-based diff), add, and delete operations. Handles envelope extraction, diff parsing with anchor-based navigation and fuzzy context matching, and chunk-based line splicing.

## Key Exports

- `ApplyPatchOperation` — discriminated union type for update/add/delete file operations
- `extractPatchEnvelope(input)` — extracts and normalizes the patch envelope from raw input
- `parseApplyPatchInput(input)` — parses a full patch into a list of `ApplyPatchOperation`s
- `applyUpdatePatch(content, lines, filePath)` — applies an update diff to file content
- `buildAddedFileContent(lines)` — joins add-file lines into final content

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
| `applySingleUpdate(input, diffBody) (selftest)` | Constructs and applies a single-file patch fixture |
| `test(name, fn) (selftest)` | Runs standalone parser/application selftests |

## Dependencies

None from other project modules — this unit is self-contained. The selftest imports from `../applyPatch`.

## Behavior

- Envelope extraction supports both wrapped (`*** Begin Patch` / `*** End Patch`) and bare patches starting with a file header.
- Update diffs use `@@` anchors and contiguous context sequences. Whitespace and Unicode fallback ordering, along with bounded mismatch diagnostics, follow [D-apply-patch-context-matching](./shared-apply-patch.md#d-apply-patch-context-matching). Fallbacks are tracked via a `fuzz` counter; inserted text is not normalized.
- Chunks are accumulated with absolute `origIndex` positions, then applied sequentially with overlap detection.
- Line endings are preserved: content is normalized to LF for processing, then restored to the original style.
- Context-match errors report a bounded candidate mismatch or preview rather than the entire hunk. Malformed patch errors remain separate.

## Integration

This is the master-side patch engine consumed by higher-level tools that receive structured diffs (e.g., from an LLM tool call). Callers provide file content and raw patch text; this unit returns the transformed content or throws on invalid input. Master result summaries pass its structurally matching parsed operations to the shared formatter; the line-count contract is canonical in [D-apply-patch-change-counts](./shared-apply-patch.md#d-apply-patch-change-counts). The selftest validates the parser and application logic in isolation without filesystem access.

## Tests

`src/applyPatch.test.ts` runs the same meaningful fixtures against Main and shared Node engines: all supported Unicode mappings in both directions, stricter-match precedence, anchor disambiguation, EOF/CRLF/final-newline preservation, rejection of missing ASCII punctuation and noncontiguous context, and bounded long/ambiguous diagnostics. The existing standalone selftest covers parser and edit semantics. Filesystem and partial-success coverage is owned by `src/tools/applyPatchOutput.test.ts`.
