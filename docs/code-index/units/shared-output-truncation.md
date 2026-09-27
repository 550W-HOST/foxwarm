# Unit: shared-output-truncation

Files: packages/shared/src/outputTruncation.ts, packages/shared/src/outputTruncation.test.ts

## Purpose

Provides the shared text excerpt builder used by tool-output guarding and persistent exec output formatting. It creates model-facing excerpts only when an output is already over budget, first shortening pathological long lines, then omitting whole middle line ranges while preserving line boundaries as much as possible.

## Key Exports

- `truncateOutputForDisplay(text, options)` — returns bounded excerpt text plus original size, line shortening, omitted range/reason, placeholder-kind, and footer-note metadata.
- `formatTruncationFooterNotes(result)` — returns a copy of the footer note lines for callers that need to compose their own footer.
- `OutputTruncationResult` / `TruncateOutputOptions` — typed metadata for excerpt callers.

## Behavior

- If `force` is false and the original output is within `maxChars`, the helper returns the original text unchanged and emits no placeholder/footer notes.
- If truncation is needed, lines longer than 550 characters are shortened to the first/last 250 characters with a Foxwarm placeholder such as `...[foxwarm: line too long (... chars at line ...)]...`.
- If the line-shortened output still exceeds `maxChars`, the helper omits a contiguous middle range using a visually delimited standalone placeholder such as `--- [foxwarm: N lines (line range A-B) omitted because this file is too long] ---`. The complete decorated marker participates in the same character budget as retained content. Inline `...[foxwarm: line too long ...]...` markers remain undecorated.
- Footer notes explicitly say Foxwarm placeholders are not original output and include original line/character counts. When whole lines were actually omitted, another note repeats the omitted count, original line range, and reason; line-only shortening emits no range-omission note.
- Slicing is Unicode-aware via `Intl.Segmenter` when available and falls back to code point splitting after replacing lone surrogates.

## Integration

- `src/toolOutputGuard.ts` uses the helper for unified model-facing tool output excerpts, preserving the existing structured result shape and saved full-output metadata.
- `packages/shared/src/persistentExec.ts` uses the helper for foreground exec display output and composes its own `--- / Exit code` footer.

## Design Decisions

### D-output-truncation-visible-line-range-omission

[2026-07-30] Render a real whole-line middle-range omission as a standalone `--- [foxwarm: N lines (line range A-B) omitted because REASON] ---` line, and count that entire decorated marker against the excerpt character budget. Repeat the omitted count, original line range, and reason in footer metadata so the information remains visible even when the middle marker is missed. Keep the existing placeholder disclaimer and original total line/character note. Do not add the range footer note when no whole lines were omitted, and do not decorate the inline line-too-long placeholder.

- [2026-07-09] Inline per-line truncation is only applied when the whole output is already over budget (or the caller explicitly forces truncation for a non-character budget such as exec token budget); normal in-budget output remains byte-for-byte unchanged.
