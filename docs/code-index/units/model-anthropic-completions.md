# Unit: Anthropic Messages and Chat Completions adapters

Files: `dotnet/Foxwarm/Models/Anthropic/AnthropicCanonicalConverter.cs`, `dotnet/Foxwarm/Models/Anthropic/AnthropicMessagesService.cs`, `dotnet/Foxwarm/Models/Anthropic/AnthropicRequestSerializer.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsCanonicalConverter.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsChatService.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsRequestSerializer.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsStreaming.cs`

## Purpose

Serializes canonical Session messages, tool calls, images, and system content for Anthropic Messages and OpenAI-compatible Chat Completions, returns a provider-neutral result. Chat Completions also accumulates streaming deltas.

## Stable methods and callers

`AnthropicCanonicalConverter`/`CompletionsCanonicalConverter` map canonical roles/content/tool records; request serializers build provider JSON and headers; `AnthropicMessagesService`/`CompletionsChatService` execute attempts; `CompletionsEventAccumulator` and `CompletionsSseCollector` merge SSE deltas, usage, stop reasons, and tool-call fragments.

Callers: `SessionChatService`, `ConfiguredModelRequests`, `SessionOwner` turn host, and retry/journal preparation. Tool calls return through `UnifiedTools` only after the stream result is committed to the turn path.

## Contract and side effects

Provider-specific omissions/normalizations are confined to the adapter; canonical Session history and Archive records keep the provider-neutral form. HTTP errors, malformed SSE, partial tool calls, and usage accounting remain attempt-scoped failures and do not silently publish a successful assistant message.

Anthropic Messages remains nonstreaming. Canonical conversion retains empty signed thinking and `redacted_thinking` data; same-concrete replay preserves the opaque evidence. Request-only concrete mismatch preparation removes signatures/redacted metadata without changing canonical history or Archive. Reported input usage includes finite cache-creation input tokens, while finite cached-read usage stays separate and is not subtracted.

## Tests

`dotnet/Foxwarm.Tests/Models/AnthropicTests.cs`; `CompletionsTests.cs`; `ResponsesStreamingTests.cs`; image/tool serialization tests.
