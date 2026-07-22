# Unit: src-apply-patch

Files: src/applyPatch.ts, src/selftest/applyPatchSelfTest.ts

## Purpose

Parses and applies structured text patches to file contents, supporting update (context-based diff), add, and delete operations. Handles envelope extraction, diff parsing with anchor-based navigation and fuzzy context matching, and chunk-based line splicing.

## Key Exports

- `ApplyPatchOperation` — discriminated union type for update/add/delete file operations
- `extractPatchEnvelope(input)` — extracts and normalizes the patch envelope from raw input
- `parseApplyPatchInput(input)` — parses a full patch into a list of `ApplyPatchOperation`s
- `applyUpdatePatch(content, lines, filePath)` — applies an update diff to file content
- `buildAddedFileContent(lines)` — joins add-file lines into final content

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `isFileHeader(line)` | ~30 | Checks if a line starts with a known file action prefix |
| `normalizeNewlines(text)` | ~34 | Converts CRLF to LF |
| `extractPatchEnvelope(input)` | ~37–63 | Extracts patch body between Begin/End markers or wraps bare patches |
| `parseApplyPatchInput(input)` | ~65–107 | Parses envelope into structured file operations |
| `parseUpdateSection(lines, filePath)` | ~109–119 | Validates update section has at least one change line |
| `parseAddSection(lines, filePath)` | ~121–133 | Strips leading `+` from add-file lines |
| `getLineEnding(text)` | ~135 | Detects original line ending style |
| `restoreLineEndings(text, lineEnding)` | ~139 | Converts LF back to CRLF if needed |
| `isDone(state, prefixes)` | ~143 | Checks if parser reached end or a terminator |
| `readStr(state, prefix)` | ~148 | Reads and consumes a line matching a prefix |
| `advanceCursorToAnchor(anchor, inputLines, cursor, parser)` | ~155–175 | Scans forward for an anchor line, with fuzzy whitespace fallback |
| `readSection(lines, startIndex, filePath)` | ~177–240 | Parses a contiguous diff section into context and chunks |
| `findContext(inputLines, context, start, eof)` | ~242–290 | Locates context lines in the original file with fuzz tolerance |
| `parseUpdateDiff(lines, input, filePath)` | ~292–335 | Orchestrates anchor navigation and section parsing into positioned chunks |
| `applyChunks(input, chunks, filePath)` | ~337–360 | Splices insert/delete chunks into original lines |
| `applyUpdatePatch(content, lines, filePath)` | ~362–368 | End-to-end update: normalize, parse diff, apply chunks, restore endings |
| `buildAddedFileContent(lines)` | ~370 | Joins lines with newline |
| `applySingleUpdate(input, diffBody)` (selftest) | ~4–14 | Helper to construct and apply a single-file update patch |
| `test(name, fn)` (selftest) | ~16–23 | Minimal test runner that logs pass/fail |

## Dependencies

None from other project modules — this unit is self-contained. The selftest imports from `../applyPatch`.

## Behavior

- Envelope extraction supports both wrapped (`*** Begin Patch` / `*** End Patch`) and bare patches starting with a file header.
- Update diffs use `@@` anchors to jump to a position in the file, then match context lines to locate the exact edit site. Fuzzy matching (trimmed whitespace comparison) is used as a fallback, tracked via a `fuzz` counter.
- Chunks are accumulated with absolute `origIndex` positions, then applied sequentially with overlap detection.
- Line endings are preserved: content is normalized to LF for processing, then restored to the original style.
- Errors are thrown with descriptive messages including file path and line context for debugging malformed patches.

## Integration

This is the core patch engine consumed by higher-level tools that receive structured diffs (e.g., from an LLM tool call). Callers provide file content and raw patch text; this unit returns the transformed content or throws on invalid input. The selftest validates the parser and application logic in isolation without filesystem access.