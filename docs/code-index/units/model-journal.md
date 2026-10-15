# Unit: LLM request journal

Files: `dotnet/Foxwarm/Models/LlmRequestJournal.cs`

## Purpose

Persists a reconstructable request manifest plus attempt-start/result metadata for provider diagnostics and retry provenance. It is not active Session history, a provider wire-body archive, or a child-handoff receipt consumer.

## Stable methods and callers

- `InitializeAsync` opens/migrates `state/llm-request-journal.sqlite` and validates the schema.
- `BeginRequestAsync` creates a request ID and stores the neutral repaired/visibility-filtered manifest: purpose/iteration, system prompt object, tool-schema object, message object IDs, requested route, prompt-cache hash, and delta/checkpoint links.
- `AppendAttemptStartAsync` records concrete model/virtual route/provider, attempt number, effective-prompt override, and `semanticPayloadSha256`; it persists digest/metadata rather than the hydrated wire body, base64 image payload, auth headers, or WebSocket suffix.
- `AppendAttemptResultAsync` records outcome/result/error metadata; `AppendChatResultAsync` maps a successful `ChatResult` to that result event.
- `ReconstructAsync` rebuilds the manifest/result view and marks corruption instead of throwing an opaque read failure; `ListAsync` returns bounded request pages.
- `MigrateLegacyAsync`, `MarkSqliteAuthorityAsync`, `HasSqliteAuthorityAsync`, and `ExportJsonlAsync` own the old JSONL import/authority marker/export boundary. `EncodeCli` exposes canonical CLI JSON encoding.

Callers: `ModelRequestOwner` begins the manifest after request-history repair/visibility and starts an attempt after concrete request payload construction; DevTools reads/export/migration commands; retry logic begins a new request ID when committed semantic context changes.

## Two journal phases and failure behavior

The manifest phase is neutral refs-only input after repair/visibility and before concrete model filtering/image hydration. The shared [request-only display projection](./model-common-wire.md) formats trusted outer ToolScript execution responses and strips display metadata and message-level `compaction` diagnostics from new journal manifests, and old journal rows are not rewritten or migrated. The attempt-start phase happens only after the concrete semantic wire payload is formed and immediately before provider transport; the journal retains digest/metadata, not the complete body. A local preparation or same-model missing-generated-blob error occurs before send and does not enter provider retry/health. A provider output all-images-fail condition is classified during result processing, is non-retryable/non-countable, and is not a send-preparation failure.

Successful provider result write failure is diagnostic-only: `ModelRequestOwner` warns and returns the result without duplicating provider retry. Journal records never reconstruct missing active Session JSON or authorize replay.

## Stored format, reconstruction, and migration

The independent SQLite journal uses WAL/FULL durability and immediate write transactions; it is not an Archive dual-write. Content-addressed objects hold neutral messages, prompts, schemas, and results. Request manifests use checkpoints and bounded deltas with a maximum delta depth of eight. Reads reconstruct references and distinguish corrupt records from supported `legacy-partial` results. List pagination orders by the stable `(createdAt, requestId)` cursor rather than a timestamp alone.

The journal-local JSON codec preserves the compatible key ordering, finite binary64 number rendering, lowercase control escapes, Unicode, and lone-surrogate behavior used for object identity and exported records. It does not change the general application JSON codec. Import/read/CLI paths must not pass strings through a lossy conversion before validation or output.

Legacy JSONL import validates the versioned record shapes, object hashes/kinds, manifests, attempt references, and conflicts. It performs bounded first-pass writes and a full-file read-only verification before committing completed import authority and moving the source to its backup. UTF-8 framing and byte offsets matter: invalid, conflicting, or incomplete input must retain the source and must not be declared fully imported. Existing SQLite authority and the atomic old attempt-start prompt-column upgrade remain separate startup checks. Explicit JSONL export reads a consistent SQLite snapshot; ordinary requests do not maintain a second JSONL authority.

## Tests

`dotnet/Foxwarm.Tests/Models/LlmRequestJournalTests.cs`; `LlmRequestJournalQualificationTests.cs`; `RequestHistoryRepairTests.cs`; `ResponsesClientTests.cs`; DevTools journal fixtures.
