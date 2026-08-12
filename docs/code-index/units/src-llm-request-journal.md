# Unit: src-llm-request-journal

Files: src/llmRequestJournal.ts, src/llmRequestJournalStore.ts, src/llmRequestJournalStoreFactory.ts, src/llmRequestJournalSqliteStore.ts, src/llmRequestJournalPostgresStore.ts, src/llmRequestJournalMigration.ts, src/llmRequestJournalCutover.ts, src/llmRequestJournalPaths.ts, src/llmRequestJournal.test.ts, src/llmRequestJournalPostgres.integration.test.ts

## Purpose

Persists and reconstructs provider-neutral canonical LLM requests across session and sessionless callers. It owns the backend-neutral domain store, content-addressed input objects, bounded checkpoint/delta manifests, physical attempt records, SQLite/PostgreSQL reconstruction, legacy migration, explicit SQLite-to-PostgreSQL copy/verification, and compatibility export.

Canonical cross-module contract: [canonical LLM request journal](../threads/llm-request-journal.md).

## Key exports

- `beginLlmRequestJournal` — durably content-address inputs and append one pre-send request manifest.
- `appendLlmAttemptStart` — append selected concrete-route and semantic-payload-digest metadata before a physical send.
- `appendLlmAttemptResult` — append normalized success/failure/abort metadata.
- `reconstructLlmRequest` — rebuild exact canonical prompt/schema/messages plus attempt records, or report explicit legacy partialness.
- `listLlmRequestJournal` — bounded discovery by session and purpose with a stable `(createdAt, requestId)` pagination cursor for training/export callers.
- `canonicalJournalJson`, `hashJournalValue` — deterministic object-key canonicalization and SHA-256 identity.
- `LlmRequestJournalStore` — Foxwarm-owned async persistence contract; adapters do not expose generic SQL/query-builder APIs.
- `PostgresLlmRequestJournalStore` / `SqliteLlmRequestJournalStore` — backend implementations with portable deterministic ordering.
- `createConfiguredLlmRequestJournalStore` — creates an uninitialized configured adapter so cutover can validate SQLite authority before any target-schema mutation; ordinary runtime initializes it through the singleton factory.
- `migrateLegacyLlmRequestJournalToSqlite` — SQLite-only migration input for strict legacy JSONL import and equality verification.
- `copySqliteLlmRequestJournalToStore` — quiesced, read-only source copy into an empty PostgreSQL target; canonical validators run against both stores, and authority is published complete only after verification.
- `exportLlmRequestJournalJsonl` — bounded, snapshot-consistent backend-neutral compatibility export with atomic destination replacement.
- Test-only fault/reset hooks.

## Storage and behavior

- SQLite is the default authority. PostgreSQL is an explicit Journal-only alternative selected at startup; there is no fallback, dual-write, or cross-store transaction.
- Cutover requires the canonical SQLite store's completed SQLite-only migration authority before PostgreSQL initialization. A successful cutover atomically writes a versioned non-secret local marker; it fences canonical SQLite initialization, requires the matching PostgreSQL authority to keep existing, and makes a missing/empty PG schema an authority-loss failure rather than a fresh install. Manual marker deletion is not a supported rollback.
- Prompt, full tool schema, and each canonical message use type-namespaced SHA-256 object IDs.
- Same-session manifests use the longest common message prefix against the latest request. Chains checkpoint after a maximum depth of eight.
- Request records store only a hash of the prompt-cache key.
- Attempt records store a hash, not the body, of the provider-specific semantic payload.
- Legacy JSONL is strictly imported only by the startup migration, then moved to path-preserving migration backup. Runtime uses FULL synchronous writer transactions and explicit JSONL export.
- Request/attempt identity structure, object kind/hash, delta ancestry/depth, and reconstructed message count are verified before a request can be reported complete.
- SQLite uses a busy timeout for concurrent server/CLI journal writers. PostgreSQL uses a bounded lazy pool (default max 1), store-local migration lock, validated quoted schema identifier, strict marked-schema table/column plus exact non-deferrable identity-constraint verification compatible with its `ON CONFLICT` writes, and an authority lifecycle of `copying` then `complete` for cutover.
- A database-local authority marker prevents a newly recreated empty file from being mistaken for the migrated journal after migration completion.

## Tests

Tests cover deterministic canonical JSON, checkpoint/delta reconstruction, lossless equal-timestamp pagination, strict migration/conflict handling, SQLite default behavior, PostgreSQL real-container request/attempt/reconstruction/export and concurrent writers, corrupt source rejection, interrupted-copy startup rejection, missing marked-schema tables/columns, newer-version rejection, unavailable/redacted configuration, empty-target copy verification, explicit legacy partialness, post-response non-retry behavior, and assistant request linkage. `npm run test:postgres-journal` owns the disposable integration container lifecycle.

## Design decisions

All cross-module decisions are canonical in [D-llm-request-journal-canonical-boundary](../threads/llm-request-journal.md#d-llm-request-journal-canonical-boundary). This unit does not duplicate them.
