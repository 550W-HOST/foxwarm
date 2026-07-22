# Unit: shared-output-truncation

Files: packages/shared/src/outputTruncation.ts, packages/shared/src/outputTruncation.test.ts

## Purpose

Provides the shared text excerpt builder used by tool-output guarding and persistent exec output formatting. It creates model-facing excerpts only when an output is already over budget, first shortening pathological long lines, then omitting whole middle line ranges while preserving line boundaries as much as possible.

## Key Exports

- `truncateOutputForDisplay(text, options)` — returns `{ text, truncated, originalLineCount, originalCharCount, lineTruncatedCount, omittedLineCount, placeholderKinds, footerNotes }` for a bounded excerpt.
- `formatTruncationFooterNotes(result)` — returns a copy of the footer note lines for callers that need to compose their own footer.
- `OutputTruncationResult` / `TruncateOutputOptions` — typed metadata for excerpt callers.

## Behavior

- If `force` is false and the original output is within `maxChars`, the helper returns the original text unchanged and emits no placeholder/footer notes.
- If truncation is needed, lines longer than 550 characters are shortened to the first/last 250 characters with a Foxwarm placeholder such as `...[foxwarm: line too long (... chars at line ...)]...`.
- If the line-shortened output still exceeds `maxChars`, the helper omits a contiguous middle range using a whole-line placeholder such as `[foxwarm: N lines (line range A-B) omitted because this file is too long]`.
- Footer notes explicitly say Foxwarm placeholders are not original output and include original line/character counts.
- Slicing is Unicode-aware via `Intl.Segmenter` when available and falls back to code point splitting after replacing lone surrogates.

## Integration

- `src/toolOutputGuard.ts` uses the helper for unified model-facing tool output excerpts, preserving the existing structured result shape and saved full-output metadata.
- `packages/shared/src/persistentExec.ts` uses the helper for foreground exec display output and composes its own `--- / Exit code` footer.

## Design Decisions

- [2026-07-09] Inline per-line truncation is only applied when the whole output is already over budget (or the caller explicitly forces truncation for a non-character budget such as exec token budget); normal in-budget output remains byte-for-byte unchanged.
