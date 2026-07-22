# Unit: shared-apply-patch

Files: packages/shared/src/applyPatch.ts

## Purpose

Parses and applies text-based patch operations (update, add, delete) to file contents. It handles patch envelope extraction, diff parsing with context matching and fuzz tolerance, and chunk-based line splicing to produce patched output.

## Key Exports

- `ApplyPatchOperation` — Discriminated union type for update/add/delete file operations
- `extractPatchEnvelope(input)` — Extracts and validates the patch envelope from raw input
- `parseApplyPatchInput(input)` — Parses a full patch into a list of `ApplyPatchOperation` objects
- `applyUpdatePatch(content, lines, filePath)` — Applies an update diff to existing file content
- `buildAddedFileContent(lines)` — Joins add-section lines into final file content

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `isFileHeader(line)` | ~30 | Checks if a line is a file action header |
| `normalizeNewlines(text)` | ~34 | Converts CRLF to LF |
| `extractPatchEnvelope(input)` | ~38–62 | Extracts and validates patch begin/end markers |
| `parseApplyPatchInput(input)` | ~64–107 | Parses envelope into structured file operations |
| `parseUpdateSection(lines, filePath)` | ~109–120 | Validates update section has changed lines |
| `parseAddSection(lines, filePath)` | ~122–134 | Strips `+` prefixes from add-file lines |
| `getLineEnding(text)` | ~136 | Detects original line ending style |
| `restoreLineEndings(text, lineEnding)` | ~140 | Restores CRLF if original used it |
| `isDone(state, prefixes)` | ~144 | Checks if parser reached a terminator |
| `readStr(state, prefix)` | ~149 | Reads and consumes a prefixed line from parser state |
| `advanceCursorToAnchor(anchor, inputLines, cursor, parser)` | ~157 | Scans forward for an anchor line, with fuzz fallback |
| `readSection(lines, startIndex, filePath)` | ~178 | Reads a diff section into context and chunks |
| `findContext(inputLines, context, start, eof)` | (truncated) | Locates context lines in original file with fuzz matching |
| `parseUpdateDiff(lines, input, filePath)` | (truncated) | Orchestrates anchor/section parsing into positioned chunks |
| `applyChunks(input, chunks, filePath)` | (truncated) | Splices insert/delete chunks into original lines |
| `applyUpdatePatch(content, lines, filePath)` | (truncated) | Top-level update: normalize, parse, apply, restore endings |
| `buildAddedFileContent(lines)` | (truncated) | Joins lines for newly added files |

## Dependencies

None — this module is self-contained with no imports from other project modules.

## Behavior

- Normalizes line endings to LF for processing, restores original endings on output.
- Patch envelope extraction supports both explicit `*** Begin Patch / *** End Patch` wrappers and bare patches starting with a file header.
- Update diffs use `@@` anchors to locate positions in the original file, with a fuzz mechanism that falls back to trimmed matching when exact matches fail.
- Chunks track original line indices for deletions and insertions; `applyChunks` validates no overlapping or out-of-bounds chunks.
- Throws descriptive errors on malformed input, missing context matches, or structural violations.

## Integration

This is a shared utility consumed by other packages that need to apply text patches to file contents (e.g., tool implementations that handle `apply_patch` operations from an LLM). It provides the parsing and application logic while leaving file I/O to callers.