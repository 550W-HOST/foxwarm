# Unit: Provider-neutral history and OpenAI wire helpers

Files: `dotnet/Foxwarm/Models/ConcreteRequestHistory.cs`, `dotnet/Foxwarm/Models/OpenAIHttp.cs`, `dotnet/Foxwarm/Models/OpenAIRequestText.cs`, `dotnet/Foxwarm/Models/OpenAISseReader.cs`, `dotnet/Foxwarm/Models/ProviderHttpRequest.cs`, `dotnet/Foxwarm/Models/ProviderImageParts.cs`, `dotnet/Foxwarm/Models/RequestHistoryRepair.cs`, `dotnet/Foxwarm/Models/SessionChatService.cs`

## Purpose

Builds provider-neutral request history, handles HTTP/SSE primitives, repairs retry inputs, adapts canonical image parts, and presents one chat-service contract to the Session turn host.

## Stable methods and callers

- `ConcreteRequestHistory` selects canonical history/prompt-visible parts for a concrete request without changing active Session JSON.
- `ConcreteRequestHistory.ProjectDisplayMetadata` removes top-level message `compaction` diagnostics and function-response display metadata from request copies. Trusted `toolScriptSubCalls` presence projects the outer native response into `{ output: formattedExecutionText }`, including empty subcall arrays. `LlmRequestJournalStore.CanonicalMessage` applies the same projection before canonical journaling; concrete preparation applies it before image hydration and provider serialization. Ordinary MCP values and result-owned metadata are not classifiers. Session/Archive/run history stays native; pruned historical outputs and guard summaries retain their existing formatter fallback.
- `RequestHistoryRepair` repairs provider retry inputs at the supported safe point; it does not rebuild a missing Session authority.
- `OpenAIHttp`, `ProviderHttpRequest`, and `OpenAISseReader` own request headers/body/status/SSE parsing and preserve provider error/stream boundaries. The reader optionally accepts a terminal predicate and final-event EOF flush for Messages; existing Completions EOF behavior is unchanged. Provider-specific accumulation remains in the adapters.
- `OpenAIRequestText` extracts model-visible request text and recognizes only supported historical compatibility strings; it is not a child-handoff receipt consumer.
- `ProviderImageParts` adapts canonical image refs/inline data; `SessionChatService.ChatAsync`/`ChatCoreAsync` supplies prompt/cache/model request orchestration behind `IChatService`, while `LocalSessionTurnHost` owns the tool loop.

Callers: `LocalSessionTurnHost`, model-specific services, retry preparation, image pipeline, and `LlmRequestJournalStore` qualification.

## Contract and side effects

Provider input is derived from Session state and request scope. The neutral repaired/visibility-filtered manifest precedes concrete leaf filtering and image hydration. Same-model missing-generated-blob and other local preparation/persistence failures happen before provider send and do not enter provider retry/health. The `all-images-fail` condition is produced while processing provider output/generated-image results; it is non-retryable/non-countable but is not a send-preparation failure. Provider transport failures alone enter normal backoff/retry/health handling. Retry repair preserves the safe point, logical request identity, and attempt attribution; canonical Session messages remain owned by Session persistence.

## Tests

`dotnet/Foxwarm.Tests/Models/RequestHistoryRepairTests.cs`; `ResponsesClientTests.cs`; `RetryPreparationTests.cs`; `HostedResponsesWsImageTests.cs`; `LlmRequestJournalQualificationTests.cs`.
