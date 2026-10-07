# Thread: Model request, streaming, retries, images, and journal

## Producer to consumer path

```text
SessionTurnRunner / LocalSessionTurnHost
  -> SessionChatService.ChatCoreAsync
  -> ModelRequestOwner + ConfiguredModelRequests
  -> concrete provider transport (HTTP/SSE or Responses WebSocket)
  -> ChatResult/stream result
  -> LocalSessionTurnHost tool loop or canonical assistant append
  -> SessionSaveLane + Archive/JSON authority
```

- **Producer:** `LocalSessionTurnHost` supplies the exact Session snapshot/history, request scope, Agent memory, model settings, and tool definitions. It owns the outer tool loop, strict assistant/tool message pairs, retry safe point, and `SessionToolExecutor` batch calls.
- **Owner:** `SessionChatService.ChatCoreAsync` selects the route and delegates provider-neutral request work to `ModelRequestOwner`/`ConfiguredModelRequests`; concrete provider units own wire serialization/transport. `SessionChatService` does not own the tool-call loop.
- **Durable boundary:** every complete semantic request payload awaits durable attempt-start journal append before provider transport, after request-history repair/visibility and before concrete filtering/image hydration; Responses WebSocket does the same before suffix/reconnect transport. Successful result-write failure is diagnostic-only and must not trigger a duplicate provider retry. Canonical assistant/tool messages enter active JSON/Archive only through `LocalSessionTurnHost` and `SessionSaveLane.CommitCanonicalAppendAsync`.
- **Consumers:** `LocalSessionTurnHost` executes returned tool calls through `SessionToolExecutor`, appends strict assistant/tool pairs, and decides whether to continue/terminal-stop; WebUI realtime receives deltas/events; DevTools reads journal/response fixtures.

## Provider paths and request preparation

`ModelRequestOwner` captures routing/owner/scope and `ConfiguredModelRequests` selects one concrete leaf. `ConcreteRequestHistory`/`RequestHistoryRepair` provide neutral refs-only request history after repair/visibility. Concrete filtering and image hydration happen next, followed by provider serializers and `OpenAIHttp`/SSE or Responses WebSocket transport. `AnthropicMessagesService`, `CompletionsChatService`, and Responses services own only their provider-specific forms/events.

`ImageBlobStore` hydration has separate failure classes: local preparation, persistent/missing generated-blob, and all-images-fail conditions occur before provider transport and are non-retryable/non-countable provider failures. They do not enter provider health/cooldown or normal provider retry. A provider HTTP/SSE/WS failure after attempt start follows the normal retry path.

## Retry and journal ordering

`LocalSessionTurnHost.PrepareRetryAsync` reaches the save-lane safe point, drains leading queue inputs, and reports whether committed context changed. Normal provider retry applies backoff and preserves the outer retry budget. If committed context changes, the journal logical ID changes for the new semantic request; unchanged-input failover keeps the same logical ID; a later leaf prompt override remains on that ID. Retry does not reset the outer budget.

Attempt-start journal append records complete semantic input and attempt provenance; it is not a redaction promise and does not automatically sanitize a user prompt. Result-write failure after a successful provider result is diagnostic-only. Journal records are not active Session authority or child-handoff receipts.

## Canonical units and tests

- [Model configuration/routing](../units/model-configuration.md)
- [Provider-neutral history/wire](../units/model-common-wire.md)
- [Anthropic/Completions](../units/model-anthropic-completions.md)
- [Responses](../units/model-responses.md)
- [Journal](../units/model-journal.md)
- `RoutingAttemptsTests`, provider request/streaming tests, request-history/journal qualification tests, retry safe-point tests, and image non-retryable/all-fail tests.
