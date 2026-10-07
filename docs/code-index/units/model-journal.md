# Unit: LLM request journal

Files: `dotnet/Foxwarm/Models/LlmRequestJournal.cs`

## Purpose

Persists qualified provider-neutral request inputs, attempt provenance, and repair metadata for request reconstruction/audit without making the journal the Session authority.

## Stable methods and callers

`LlmRequestJournalStore.Prepare`, `Qualify`, `Append`, `Read`, and journal codec records are called by configured model requests/session turn host. Preparation receives request owner/scope, canonical history/image references, provider route, and retry-safe request text; append occurs only after qualification and the appropriate turn safe point. `JournalCommand` consumes it for developer inspection.

## Contract and side effects

Journal entries are attempt/request records, not active Session history and not a child-handoff receipt consumer. Attempt-start append occurs only after complete semantic request preparation and before concrete provider transport; Responses WebSocket follows the same rule before suffix/reconnect transport. Failed/unsupported pre-provider preparation can remain absent; result-write failure after a successful provider result is diagnostic-only and must not trigger a duplicate provider retry. The journal records the qualified semantic payload and provenance; it does not promise automatic user-prompt redaction or reconstruct missing JSON authority.

## Tests

`dotnet/Foxwarm.Tests/Models/LlmRequestJournalTests.cs`; `LlmRequestJournalQualificationTests.cs`; `RequestHistoryRepairTests.cs`; DevTools journal command fixtures.
