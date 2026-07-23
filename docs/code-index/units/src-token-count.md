# Unit: src-token-count

Files: src/tokenCount.ts, src/tokenCountImages.test.ts

## Purpose

Provides token counting utilities for estimating token usage across message parts, complete messages, and entire sessions. Image payloads (base64 data) are excluded from token estimates and tracked separately as image counts to avoid inflating estimates.

## Key Exports

- `estimateTokenCount` — re-exported from `packages/shared`
- `TokenEstimateSummary` — interface with `tokens` and `imageCount` fields
- `estimateMessagePartSummary(part)` — returns token estimate and image count for a single message part
- `estimateMessagePartTokens(part)` — returns token count only for a message part
- `estimateMessageSummary(message)` — returns summary for a full message
- `estimateMessageTokens(message)` — returns token count for a full message
- `estimateSessionSummary(session)` — returns summary for an entire session (history + persistent memory)
- `estimateSessionTokens(session)` — returns token count for an entire session
- `estimateSessionRangeTokens(session, startIndex)` — returns token count for a slice of session history

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `isImageMimeType(mimeType)` | ~18 | Checks if a MIME type starts with `image/` |
| `isImageInlineData(value)` | ~22 | Type guard for inline image data objects |
| `sanitizeValueForTokenEstimate(value)` | ~27–57 | Recursively strips image payloads, replacing with placeholder text |
| `estimateMessagePartSummary(part)` | ~63–99 | Estimates tokens and image count for a single message part |
| `estimateMessagePartTokens(part)` | ~101 | Wrapper returning only token count from part summary |
| `estimateMessageSummary(message)` | ~103–111 | Aggregates part summaries for a full message |
| `estimateMessageTokens(message)` | ~116 | Wrapper returning only token count from message summary |
| `estimateSessionSummary(session)` | ~118–132 | Aggregates message summaries for a session, includes persistent memory |
| `estimateSessionTokens(session)` | ~137 | Wrapper returning only token count from session summary |
| `estimateSessionRangeTokens(session, startIndex)` | ~142–151 | Counts tokens for messages from a given index onward |

## Dependencies

- `./types` — `MessagePart`, `Message`, `InlineData`
- `./toolCallArgs` — `stringifyFunctionCallArgs`
- `../packages/shared/dist/tokenCount` — `estimateTokenCount` (core estimation logic)
- `./session/messageVisibility` — `isModelVisibleMessage`

## Behavior

- Recursively sanitizes values before token estimation, replacing image base64 data with `'[image omitted]'` placeholder to prevent inflated counts.
- Counts tokens for text, thinking content, function call names/args, function response payloads, and non-image inline data.
- Tracks image occurrences separately via `imageCount` in `TokenEstimateSummary`.
- Skips messages not visible to the model (via `isModelVisibleMessage`) when estimating session-level tokens.
- Includes `persistentMemorySnapshot` in session-level estimates.

## Integration

- Used by the `/status` command to display token usage and image counts to users.
- Provides session-level token estimates likely consumed by context management and compaction logic.
- Relies on `isModelVisibleMessage` to align estimates with what the model actually receives.
- The shared `estimateTokenCount` function from `packages/shared` is the underlying character-to-token heuristic.