# Unit: src-llm-request-journal

Files: src/llmRequestJournal.ts, src/llmRequestJournal.test.ts

## Purpose

Persists and reconstructs provider-neutral canonical LLM requests across session and sessionless callers. It owns content-addressed input objects, bounded checkpoint/delta manifests, physical attempt records, SQLite reconstruction, legacy migration, and compatibility export.

Canonical cross-module contract: [canonical LLM request journal](../threads/llm-request-journal.md).

## Key exports

- `beginLlmRequestJournal` — durably content-address inputs and append one pre-send request manifest.
- `appendLlmAttemptStart` — append selected concrete-route and semantic-payload-digest metadata before a physical send, with an optional effective system prompt that is content-addressed and omitted when equal to the request prompt.
- `appendLlmAttemptResult` — append normalized success/failure/abort metadata.
- `reconstructLlmRequest` — rebuild exact canonical prompt/schema/messages plus attempt records, or report explicit legacy partialness.
- `listLlmRequestJournal` — bounded discovery by session and purpose with a stable `(createdAt, requestId)` pagination cursor for training/export callers.
- `canonicalJournalJson`, `hashJournalValue` — deterministic object-key canonicalization and SHA-256 identity.
- `migrateLegacyLlmRequestJournalToSqlite` — migration-only strict JSONL import and equality verification.
- `exportLlmRequestJournalJsonl` — bounded, snapshot-consistent SQLite-backed compatibility export with atomic destination replacement, mandatory file fsync, and parent-directory fsync where supported.
- Test-only fault/reset hooks.

## Storage and behavior

- The dedicated journal SQLite/WAL database is the sole runtime authority, isolated from ordinary conversation archive locks.
- Prompt, full tool schema, and each canonical message use type-namespaced SHA-256 object IDs.
- Same-session manifests use the longest common message prefix against the latest request. Chains checkpoint after a maximum depth of eight.
- Request records store only a hash of the prompt-cache key.
- Attempt records store a hash, not the body, of the provider-specific semantic payload. A nullable prompt-object reference records only an effective prompt that differs from the request prompt; old/null attempts inherit the request prompt.
- Initialization adds the nullable attempt prompt column inside the existing immediate SQLite transaction boundary. The busy timeout is installed before WAL/schema setup so concurrent server and CLI owners can serialize the additive migration.
- Legacy JSONL is strictly imported only by the startup migration, then moved to path-preserving migration backup. Runtime uses FULL synchronous writer transactions and explicit JSONL export.
- Legacy JSONL import and verification use the shared stateful UTF-8 LF/CRLF framing helper in [src-jsonl](./src-jsonl.md). Incremental import advances its persisted byte offset only after the selected source range has decoded, framed, parsed, and flushed successfully.
- Request/attempt identity structure, request and attempt-prompt object kind/hash, delta ancestry/depth, and reconstructed message count are verified before a request can be reported complete. Reconstruction exposes both the request prompt and each attempt's resolved effective prompt.
- SQLite uses a busy timeout for concurrent server/CLI journal writers.
- A database-local authority marker prevents a newly recreated empty file from being mistaken for the migrated journal after migration completion.

## Tests

Tests cover deterministic canonical JSON, checkpoint/delta reconstruction, attempt-prompt fallback/override/deduplication and corruption, compatibility export/reimport, concurrent additive schema migration, lossless equal-timestamp pagination, strict migration/retry/conflict handling (including no offset advance after malformed input), SQLite-only runtime and export, independent process/conversation-archive concurrency, malformed/corrupt-record rejection, explicit legacy partialness, post-response non-retry behavior, and assistant request linkage.

## Design decisions

All cross-module decisions are canonical in [D-llm-request-journal-canonical-boundary](../threads/llm-request-journal.md#d-llm-request-journal-canonical-boundary). This unit does not duplicate them.
