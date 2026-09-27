# Unit: src-jsonl

Files: src/jsonl.ts, src/jsonl.test.ts

## Purpose

Provides shared streaming JSONL framing without treating Unicode line or paragraph separators inside JSON strings as record boundaries.

## Key exports

- `streamUtf8JsonlLines(stream, onLine)` — adapts a raw Node `Readable`, installs Node's stateful UTF-8 decoder with `setEncoding('utf8')`, delegates framing, and destroys the owned stream during cleanup.
- `streamDecodedJsonlLines(chunks, onLine)` — frames an arbitrary already-decoded `AsyncIterable<string>` and awaits each nonblank record callback in order without assuming ownership of the iterable.

## Behavior

- Records are delimited by LF, with an optional CR immediately before LF; lone CR is not a delimiter.
- Literal U+2028 and U+2029 remain ordinary JSON string characters.
- Each record retains the existing whole-line `trim()` behavior, blank records are skipped, and a final nonblank record does not require a trailing newline.
- The decoded helper rejects non-string chunks at runtime rather than accidentally accepting and independently decoding Buffers.
- The raw wrapper relies on Node's stateful decoder, so multi-byte UTF-8 characters remain intact across arbitrary Buffer boundaries.

## Integration

- `src/session/archiveStore.ts` uses the UTF-8 wrapper for legacy session message/block JSONL migration and verification.
- `src/llmRequestJournal.ts` uses the UTF-8 wrapper for incremental legacy import and strict migration verification.

## Tests

`src/jsonl.test.ts` covers decoded LF/CRLF/final/blank framing, awaited callback order, literal U+2028/U+2029, runtime rejection of raw Buffers by the decoded helper, wrapper cleanup on callback failure, and raw one-byte Buffer chunking across three-byte and four-byte UTF-8 characters.
