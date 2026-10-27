# Unit: Anthropic Messages and Chat Completions adapters

Files: `dotnet/Foxwarm/Models/Anthropic/AnthropicCanonicalConverter.cs`, `dotnet/Foxwarm/Models/Anthropic/AnthropicMessagesService.cs`, `dotnet/Foxwarm/Models/Anthropic/AnthropicRequestSerializer.cs`, `dotnet/Foxwarm/Models/Anthropic/AnthropicStreaming.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsCanonicalConverter.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsChatService.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsRequestSerializer.cs`, `dotnet/Foxwarm/Models/Completions/CompletionsStreaming.cs`

## Purpose

Serializes canonical Session messages, tools, images and system content for Anthropic Messages and OpenAI-compatible Chat Completions. Both adapters publish actual accumulated stream progress and return a provider-neutral result through the existing request owner and Session turn path.

## Stable methods and callers

- `AnthropicRequestSerializer.BuildRequest` and `ConvertHistory` build Messages payloads and wire-only role merges. `AnthropicMessagesService.ChatAsync` selects SSE or JSON from the prepared boolean `stream`, starts the journal attempt before transport, owns cancellation/watchdog/HTTP disposal and invokes the normal progress callback.
- `AnthropicEventAccumulator.Consume` reconstructs indexed ordered blocks, cumulative usage and stop metadata. `Complete` requires message start, closed blocks, a stop-reason field and terminal `message_stop`. `AnthropicSseCollector.CollectAsync` stops at that terminal event and flushes an unterminated final event at EOF.
- `AnthropicCanonicalConverter.ConvertAssistant`, `StopReason` and `Usage` share canonical conversion between JSON and SSE, including structured argument errors and thinking-token component accounting.
- Completions serializers/converter and `CompletionsChatService.ChatAsync` retain their own wire forms. `CompletionsEventAccumulator` and `CompletionsSseCollector` merge deltas, usage, stop reasons and tool fragments without adopting the Messages terminal law.

Callers: `SessionChatService`, `ConfiguredModelRequests`, `ModelRequestOwner`, retry/journal preparation and the `LocalSessionTurnHost` tool loop. Tool input is not executed by either collector. Canonical conversion uses the shared [per-call argument-error boundary](./session-domain.md#tool-argument-parsing); Messages passes native JSON inputs directly rather than reserializing malformed nonobjects before parsing.

## Contract and side effects

Messages defaults to `stream:true` and top-level ephemeral `cache_control`; explicit `extraFields` overrides remain authoritative. Nonboolean `stream` fails preparation before an attempt-start record or provider send. `stream:false` retains JSON conversion and five-minute header/body-byte idle handling by default. An explicit [one-shot CLI timeout](./core-delivery-cli.md#cli-behavior) replaces that idle default while the request owner bounds the complete attempt.

Streaming gets three minutes to first model activity, then the configured content-inactivity allowance (default one minute). Thinking/redacted-thinking open and close switch the inactivity allowance to at least ten minutes and back. Text, thinking and tool-input fragments reset semantic activity; pings, signatures, headers and usage do not. Progress snapshots contain visible text/reasoning and ordered tool arguments, never signatures or redacted data. Caller Stop, callback exceptions, terminal completion and failed partial streams dispose the owned transport.

Refusal, pause-turn and unsupported server-tool blocks are nonretryable/noncountable response failures. Output/context limits retain usable text and complete tools; malformed or nonobject tool inputs carry `argsParseError` and cannot execute. The normal turn host appends an `llm-stop` display-only notice after committing the assistant; that notice is excluded from later provider history. The request journal records the same truncation result without becoming Session authority. HTTP, malformed SSE and incomplete message boundaries remain attempt-scoped failures without a successful partial assistant append.

Canonical conversion retains empty signed thinking and `redacted_thinking` data; same-concrete replay preserves opaque evidence. Request-only concrete mismatch preparation removes signatures/redacted metadata without changing canonical history or Archive. Input usage includes finite cache-creation input tokens; cached-read usage remains separate. Thinking tokens are a component of total output, not an additional output total.

## Tests

`AnthropicTests`, `AnthropicStreamingTests`, `CompletionsTests`, `ResponsesStreamingTests`, routing/retry/journal qualification and image/tool serialization tests. `packages/webui/test/mainHostAnthropic.e2e.mjs` qualifies the original App against owned local SSE/JSON peers: live progress, held terminal completion, ordered real tools, invalid-input nonexecution, limit notices, replay/filtering, leaf image preparation, cancellation/watchdog, journal/Archive and clean host restart. No paid-provider behavior is claimed.
