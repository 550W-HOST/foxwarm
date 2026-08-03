# Unit: src-llm-request-journal

Files: src/llmRequestJournal.ts, src/llmRequestJournal.test.ts

## Purpose

Persists and reconstructs provider-neutral canonical LLM requests across session and sessionless callers. It owns content-addressed input objects, bounded checkpoint/delta manifests, physical attempt records, JSONL recovery, and the SQLite query index.

Canonical cross-module contract: [canonical LLM request journal](../threads/llm-request-journal.md).

## Key exports

- `beginLlmRequestJournal` — durably content-address inputs and append one pre-send request manifest.
- `appendLlmAttemptStart` — append selected concrete-route and semantic-payload-digest metadata before a physical send.
- `appendLlmAttemptResult` — append normalized success/failure/abort metadata.
- `reconstructLlmRequest` — rebuild exact canonical prompt/schema/messages plus attempt records, or report explicit legacy partialness.
- `listLlmRequestJournal` — bounded discovery by session and purpose with a stable `(createdAt, requestId)` pagination cursor for training/export callers.
- `canonicalJournalJson`, `hashJournalValue` — deterministic object-key canonicalization and SHA-256 identity.
- Test-only fault/reset hooks.

## Storage and behavior

- JSONL is the append-only recovery source; a dedicated journal SQLite/WAL database is the read index, isolated from ordinary conversation archive locks.
- Prompt, full tool schema, and each canonical message use type-namespaced SHA-256 object IDs.
- Same-session manifests use the longest common message prefix against the latest request. Chains checkpoint after a maximum depth of eight.
- Request records store only a hash of the prompt-cache key.
- Attempt records store a hash, not the body, of the provider-specific semantic payload.
- JSONL suffix import is streaming and batched, and remains idempotent through primary keys. Successful live append advances the shared byte offset atomically with its SQLite row; JSONL-first failure leaves the cursor behind for recovery. Cross-process append locking repairs a torn non-newline tail before later records.
- Request/attempt identity structure, object kind/hash, delta ancestry/depth, and reconstructed message count are verified before a request can be reported complete.
- SQLite uses a busy timeout for concurrent server/CLI journal writers.

## Tests

Tests cover deterministic canonical JSON, checkpoint/delta reconstruction, lossless equal-timestamp pagination, multi-batch streaming bootstrap, torn-tail repair plus SQLite-loss rebuild, JSONL-to-SQLite crash recovery, independent process/conversation-archive concurrency, malformed/corrupt-record rejection, explicit legacy partialness, post-response non-retry behavior, and assistant request linkage.

## Design decisions

All cross-module decisions are canonical in [D-llm-request-journal-canonical-boundary](../threads/llm-request-journal.md#d-llm-request-journal-canonical-boundary). This unit does not duplicate them.
