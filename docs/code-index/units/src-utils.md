# Unit: src-utils

Files: src/utils/diskJsonData.ts, src/utils/diskJsonData.test.ts, src/utils/messageFormat.ts, src/utils/messagePreview.ts, src/utils/localTime.ts, src/utils/localTime.test.ts, src/utils/systemMessageParts.ts, src/utils/systemMessageParts.test.ts, src/utils/promptWrappers.ts, src/utils/promptWrappers.test.ts, src/utils/unicode.ts

## Purpose

Core utility functions for durable JSON file persistence with write coalescing and backup rotation, message formatting and preview generation for display, local timestamp formatting, system message part splitting, Foxwarm prompt wrapper tag formatting/parsing, and Unicode-safe string operations (surrogate sanitization, grapheme-aware truncation).

## Key Exports

- `DiskJsonData<T>` — class for durable JSON read/write with atomic rename, backup rotation, and write coalescing
- `getNumberedBackupPath`, `getLegacyBackupPath` — backup path helpers
- `formatMessageText`, `formatMessagePreviewText`, `formatPrefixedMultilineText` — message-to-text formatting
- `getMessagePreview`, `formatMessagePreviewLine`, `formatSessionMessagesPreview` — message preview utilities
- `formatLocalTimestamp`, `formatLocalTimeRange` — local time formatting with numeric UTC offset
- `buildSystemMessageParts`, `isSystemPayloadTextPart` — split system messages into header + payload parts
- `buildInputTimePart`, `buildTimestampedSystemMessageParts`, `withInputTimePart` — freeze source-boundary timestamps for model-visible inbound input
- `escapeFoxwarmAttributeValue`, `formatFoxwarmSystemTag`, `formatFoxwarmMessageOpen`, `formatFoxwarmMessageClose`, `formatSystemPartForModel`, `parseFoxwarmTagLine` — build/parse Foxwarm XML-ish prompt wrapper tags with escaped attrs and raw message bodies
- `replaceLoneSurrogates`, `containsLoneSurrogate`, `containsAnySurrogate` — surrogate detection/replacement
- `takeUnicodeSafe`, `takeUnicodeSafeEnd`, `truncateUnicodeSafe`, `truncateUnicodeSafeWithEllipsis` — grapheme-aware truncation
- `sanitizeLoneSurrogatesInPayload` — deep object sanitization of lone surrogates

## Function Index

| Function | Lines (approx) | Description |
|----------|-------|-------------|
| `getNumberedBackupPath(filePath, index)` | ~47 | Returns numbered `.N.bak` path |
| `getLegacyBackupPath(filePath)` | ~51 | Returns `.bak` path |
| `shouldIgnoreDirectorySyncError(error)` | ~54 | Checks if dir sync error is ignorable |
| `syncDirectory(dirPath)` | ~61 | Fsyncs a directory handle for durability |
| `writeFileDurably(filePath, content)` | ~74 | Opens, writes, and fsyncs a file |
| `DiskJsonData.constructor(filePath, options)` | ~89 | Initializes paths, backup config, hooks |
| `DiskJsonData.getBackupPaths()` | ~105 | Lists configured backup file paths |
| `DiskJsonData.listCandidatePaths()` | ~114 | Primary path + all backup paths |
| `DiskJsonData.readFromPath(filePath)` | ~118 | Reads and normalizes JSON from a path |
| `DiskJsonData.loadFirstAvailable()` | ~129 | Tries primary then backups, returns first valid |
| `DiskJsonData.write(data)` | ~143 | Queues a write, triggers flush loop |
| `DiskJsonData.flushLoop()` | ~162 | Drains pending writes sequentially |
| `DiskJsonData.resolveWaitersUpTo(requestId)` | ~176 | Resolves promises for completed writes |
| `DiskJsonData.rejectWaitersUpTo(requestId, error)` | ~186 | Rejects promises for failed writes |
| `DiskJsonData.buildTempPath()` | ~196 | Generates unique temp file path |
| `DiskJsonData.rotateBackupsIfNeeded()` | ~201 | Rotates numbered backups before write |
| `DiskJsonData.writeSerialized(queuedWrite)` | ~232 | Atomic write: temp → fsync → rename → dir sync |
| `isEphemeralSystemText(text)` | ~33 | Checks if system text is ephemeral metadata |
| `truncateText(text, maxChars)` | ~37 | Truncates with unicode-safe ellipsis |
| `formatMultilineText(text, continuationPrefix)` | ~44 | Prefixes continuation lines |
| `formatPrefixedMultilineText(prefix, text, continuationPrefix)` | ~57 | Joins prefix with multiline text |
| `stringifyFunctionArgs(part)` | ~65 | Serializes function call arguments |
| `formatFunctionResponse(part)` | ~69 | Extracts and formats tool response content |
| `formatPartLines(message, part, options)` | ~89 | Converts a single MessagePart to display lines |
| `formatMessageText(message, options)` | ~126 | Formats full message with optional role prefix |
| `formatMessagePreviewText(message, previewLength, options)` | ~145 | Short preview of a message |
| `getMessagePreview(msg, previewLength, options)` | ~12 | Preview with display-only redaction support |
| `formatMessagePreviewLine(msg, idx, previewLength, options)` | ~17 | Indexed emoji-prefixed preview line |
| `formatSessionMessagesPreview(sessionId, messages, ...)` | ~24 | Formats a batch of session messages |
| `coerceDate(input)` | ~1 | Converts number to Date if needed |
| `pad2(value)` | ~5 | Zero-pads to 2 digits |
| `formatOffset(date)` | ~9 | Formats UTC offset as ±HHMM |
| `formatLocalTimestamp(input, options)` | ~17 | Full local timestamp string |
| `formatLocalTimeRange(startInput, endInput, options)` | ~26 | Range or single timestamp |
| `buildSystemMessageParts(message)` | ~3 | Splits system message at first newline |
| `isSystemPayloadTextPart(part)` | ~18 | Checks if part is a system payload text |
| `escapeFoxwarmAttributeValue(value)` | promptWrappers | Escapes `& < > " '`, control chars, and newlines for tag attribute values |
| `formatFoxwarmSystemTag(attrs)` / `formatFoxwarmSystemHint(hint, attrs)` | promptWrappers | Formats pure metadata as `<foxwarm-system ... />` |
| `formatFoxwarmMessageOpen(attrs)` / `formatFoxwarmMessageClose()` / `formatFoxwarmMessage(attrs, content)` | promptWrappers | Formats source wrappers around raw content |
| `isFoxwarmMetadataLine` / `parseFoxwarmTagLine` / `parseFoxwarmOpeningTag` / `parseFoxwarmWrappedContent` / `formatSystemPartForModel` | promptWrappers | Recognizes wrapper tag lines/full wrappers, parses escaped attrs, and maps `MessagePart.system` to model-facing foxwarm-system wrappers, including known legacy identity/time/session/goal-reminder/child-reminder text upgrades |
| `isHighSurrogate(code)` | ~11 | Checks high surrogate range |
| `isLowSurrogate(code)` | ~15 | Checks low surrogate range |
| `isAnySurrogate(code)` | ~19 | Checks any surrogate range |
| `replaceLoneSurrogates(text, replacement)` | ~23 | Replaces unpaired surrogates in a string |
| `containsLoneSurrogate(text)` | ~55 | Boolean check for lone surrogates |
| `splitGraphemes(text)` | ~59 | Splits text into grapheme clusters via Intl.Segmenter |
| `graphemeLength(text)` | ~72 | Returns grapheme count |
| `takeUnicodeSafe(text, maxGraphemes)` | ~76 | Takes first N graphemes safely |
| `takeUnicodeSafeEnd(text, maxGraphemes)` | ~88 | Takes last N graphemes safely |
| `truncateUnicodeSafe(text, maxGraphemes, ellipsis)` | ~100 | Truncates with appended ellipsis |
| `truncateUnicodeSafeWithEllipsis(text, max, ellipsis)` | ~112 | Truncates counting ellipsis in budget |
| `appendPathSegment(path, key)` | ~125 | Builds JSON-path-style segment |
| `sanitizePayloadInternal(value, path, seen)` | ~130 | Recursive deep surrogate sanitizer |
| `sanitizeLoneSurrogatesInPayload(value, rootPath)` | ~170 | Public entry for deep sanitization |
| `containsAnySurrogate(text)` | ~174 | Fast check for any surrogate code unit |

## Dependencies

- `../types` — `Message`, `MessagePart` types
- `../toolCallArgs` — `stringifyFunctionCallArgs` for serializing tool call arguments

## Design Decisions

### D-disk-json-durability

`DiskJsonData` owns the durable JSON algorithm: serialized/coalesced writes use same-directory temp files, file sync, atomic replace, and directory sync. Each store explicitly selects its backup rotation count; readers try the primary then configured backups.

### D-prompt-wrapper-boundary

Foxwarm prompt wrappers are XML-like metadata envelopes, not full XML serialization of message bodies. Generated attributes are escaped while `<foxwarm-message>` body content remains raw. New system parts use canonical wrappers; supported legacy system text and split `systemPayload` are read compatibility only.
- `../session/messageVisibility` — `formatModelVisibilitySuffix`, `redactDisplayOnlyMessageForModel` for visibility-aware previews

## Behavior

- `DiskJsonData.write()` coalesces rapid writes: only the latest pending data is flushed, earlier intermediate values are skipped but their promises still resolve.
- Writes use an atomic temp-file + fsync + rename + directory-sync pattern to prevent corruption on crash.
- Backup rotation shifts numbered backups (N → N+1) before each write; errors are swallowed in `bestEffort` mode.
- `loadFirstAvailable` iterates primary then backups, returning the first parseable file — provides automatic recovery from corruption.
- Unicode utilities use `Intl.Segmenter` when available for grapheme-accurate truncation, falling back to code-point iteration.
- Message formatting handles multiple part types (text, system, thinking, function calls, function responses, inline data) with configurable truncation and filtering of ephemeral/RAG content.

## Integration

- `DiskJsonData` is the persistence layer for session state and other JSON-backed stores throughout the application.
- `formatMessageText` / `getMessagePreview` are used by session display, logging, and context-building code to render messages as compact text.
- `truncateUnicodeSafe` is consumed by message formatting and anywhere safe string length limits are needed.
- `buildSystemMessageParts` structures system-injected messages before they enter the message pipeline.
- `sanitizeLoneSurrogatesInPayload` guards outbound payloads (e.g., to APIs) against invalid Unicode.