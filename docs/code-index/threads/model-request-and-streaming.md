# Thread: Model request, streaming, retries, images, and journal

## Producer to consumer path

```text
SessionTurnRunner / LocalSessionTurnHost
  -> SessionChatService.ChatCoreAsync
  -> ModelRequestOwner.RequestAsync + ConfiguredModelRequests
     (normal canonical requests may refresh request-only Task context before retries)
  -> concrete provider transport (HTTP/SSE or Responses WebSocket)
  -> ChatResult/stream result
  -> LocalSessionTurnHost tool loop or canonical assistant append
  -> SessionSaveLane + Archive/JSON authority
```

- **Producer:** `LocalSessionTurnHost` supplies the exact Session snapshot/history, request scope, Agent memory, model settings, and tool definitions. It owns the outer tool loop, strict assistant/tool message pairs, retry safe point, and `SessionToolExecutor` batch calls.
- **Owner:** `SessionChatService.ChatCoreAsync` selects route context and delegates provider-neutral request work to `ModelRequestOwner.RequestAsync`/`ConfiguredModelRequests`; concrete provider units own wire serialization/transport. `SessionChatService` does not own the tool-call loop.
- **Durable boundaries:** `LlmRequestJournalStore.BeginRequestAsync` first persists a neutral manifest after `RequestHistoryRepair.SelectAndRepair` visibility/repair and before concrete model filtering/image hydration. Later, after the concrete semantic wire payload is formed and immediately before transport, `AppendAttemptStartAsync` persists concrete model/provider/attempt/effective-prompt metadata plus a payload digest; it does not store the hydrated wire body, base64 image data, auth headers, or WebSocket suffix. Canonical assistant/tool messages enter active JSON/Archive only through `LocalSessionTurnHost` and `SessionSaveLane.CommitCanonicalAppendAsync`.
- **Consumers:** `LocalSessionTurnHost` executes returned tool calls through `SessionToolExecutor`, appends strict assistant/tool pairs, and decides whether to continue/terminal-stop; WebUI realtime receives deltas/events; DevTools reads journal/response fixtures. Normal canonical requests receive request-only Task context from `SessionChatService`; this context is not appended to active history or queue.

## Provider preparation and transport order

`ModelRequestOwner.RequestAsync` selects a concrete leaf, builds prompt/cache/options, starts the neutral journal manifest, then calls `ConcreteRequestHistory.PrepareRequest`: request-history repair/visibility is applied before concrete destination filtering. `ImageBlobStore.HydrateAsync` then resolves provider-specific image parts for that concrete model, followed by `ConfiguredModelRequests.CreatePreparedService` and the provider serializer/transport. The transport invokes the journal attempt-start callback only after its concrete semantic payload is complete and before sending HTTP/SSE or a Responses WebSocket suffix/reconnect payload.

`AnthropicMessagesService`, `CompletionsChatService`, and Responses services own only provider-specific forms/events. `LocalSessionTurnHost`/`SessionToolExecutor` own the tool-call loop and strict model/tool message append chain.

## Distinct image failure classes

Same-model missing generated blob and other local preparation/persistence/hydration failures happen before provider send and are `ModelPreparationException` paths; they do not enter provider retry, health, or countable-failure handling. The `all-images-fail` condition is produced while processing provider output/generated-image results, not during send preparation; it is nevertheless non-retryable and non-countable for provider health. A provider HTTP/SSE/WS failure after attempt start follows normal provider retry classification.

## Retry and journal ordering

`LocalSessionTurnHost.PrepareRetryAsync` reaches the save-lane safe point, drains leading queue inputs, and reports whether committed context changed. Normal provider retry applies backoff and preserves the outer retry budget. `SessionChatService` refreshes request-only Task context at the same retry safe point; if it changes, `ModelRequestOwner` starts a new journal logical request ID for the changed semantic context. Unchanged-input failover keeps the same ID, and a later leaf prompt override remains on that ID. Retry does not reset the outer budget.

Attempt-start persistence is required before provider transport; failure to make it durable is `LlmJournalPreparationException` and prevents sending that attempt. Result-write failure after a successful provider result is diagnostic-only: the result is returned and provider retry is not duplicated. Journal records are not active Session authority or child-handoff receipts.

## Canonical units and tests

- [Model configuration/routing](../units/model-configuration.md)
- [Provider-neutral history/wire](../units/model-common-wire.md)
- [Anthropic/Completions](../units/model-anthropic-completions.md)
- [Responses](../units/model-responses.md)
- [Journal](../units/model-journal.md)
- `RoutingAttemptsTests`, provider request/streaming tests, `RequestHistoryRepairTests`, `LlmRequestJournalQualificationTests`, retry safe-point tests, `HostedResponsesWsImageTests`, and generated-image non-retryable/all-fail tests.
