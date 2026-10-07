# Unit: Provider-neutral history and OpenAI wire helpers

Files: `dotnet/Foxwarm/Models/ConcreteRequestHistory.cs`, `dotnet/Foxwarm/Models/OpenAIHttp.cs`, `dotnet/Foxwarm/Models/OpenAIRequestText.cs`, `dotnet/Foxwarm/Models/OpenAISseReader.cs`, `dotnet/Foxwarm/Models/ProviderHttpRequest.cs`, `dotnet/Foxwarm/Models/ProviderImageParts.cs`, `dotnet/Foxwarm/Models/RequestHistoryRepair.cs`, `dotnet/Foxwarm/Models/SessionChatService.cs`

## Purpose

Builds provider-neutral request history, handles HTTP/SSE primitives, repairs retry inputs, adapts canonical image parts, and presents one chat-service contract to the Session turn host.

## Stable methods and callers

- `ConcreteRequestHistory` selects canonical history/prompt-visible parts for a concrete request without changing active Session JSON.
- `RequestHistoryRepair` repairs provider retry inputs at the supported safe point; it does not rebuild a missing Session authority.
- `OpenAIHttp`, `ProviderHttpRequest`, and `OpenAISseReader` own request headers/body/status/SSE parsing and preserve provider error/stream boundaries.
- `OpenAIRequestText` extracts model-visible request text and recognizes only supported historical compatibility strings; it is not a child-handoff receipt consumer.
- `ProviderImageParts` adapts canonical image refs/inline data; `SessionChatService` composes provider calls, retries, and tool results behind `IChatService`.

Callers: `LocalSessionTurnHost`, model-specific services, retry preparation, image pipeline, and `LlmRequestJournal` qualification.

## Contract and side effects

Provider input is derived from Session state and request scope. Neutral refs-only history is repaired/visibility-filtered before concrete leaf filtering and image hydration. Local preparation, persistent/missing generated-image, and all-images-fail errors occur before provider transport and are non-retryable/non-countable; provider transport failures alone enter normal backoff/retry/health handling. Retry repair preserves the safe point, logical request identity, and attempt attribution; canonical Session messages remain owned by Session persistence.

## Tests

`dotnet/Foxwarm.Tests/Models/RequestHistoryRepairTests.cs`; `ResponsesClientTests.cs`; `RetryPreparationTests.cs`; `HostedResponsesWsImageTests.cs`; `LlmRequestJournalQualificationTests.cs`.
