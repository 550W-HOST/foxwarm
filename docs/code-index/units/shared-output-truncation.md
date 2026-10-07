# Unit: Shared output truncation and bounded excerpts

Files: `packages/shared/src/outputTruncation.ts`, `packages/shared/src/outputTruncation.test.ts`, `packages/shared/src/boundedTextExcerpt.ts`

## Purpose

Builds model-facing/tool-facing excerpts only when output is over the caller’s budget, preserving line boundaries, Unicode safety, and explicit omission metadata.

## Stable symbols and callers

`truncateOutputForDisplay`, `formatTruncationFooterNotes`, `OutputTruncationResult`, `TruncateOutputOptions`, and bounded excerpt helpers are consumed by `PersistentExecManager`, local file/read tools, and unified tool-output formatting. Full logs/files remain stored or read through their owning unit; this unit only builds the bounded view.

## Contract

In-budget output is returned unchanged unless the caller explicitly forces a non-character budget. When truncation is needed, pathological lines are shortened before a whole-line middle range is omitted; the decorated omission marker counts toward the same character budget. Footer notes identify Foxwarm-generated placeholders and original counts. Unicode segmentation uses `Intl.Segmenter` when available and a code-point-safe fallback otherwise.

Boundary whitespace in the retained excerpt is preserved by callers such as persistent exec; this helper must not broadly trim command output or turn whitespace-only output into absence.

## Tests

`packages/shared/src/outputTruncation.test.ts`; file/tool and persistent-exec tests cover line, Unicode, omission-marker, and boundary-whitespace cases.
