# Thread: Model request, streaming, retries, images, and journal

## Producer to consumer path

```text
SessionTurnRunner / LocalSessionTurnHost
  -> SessionChatService.ChatCoreAsync
  -> ModelRequestOwner.RequestAsync + ConfiguredModelRequests
     (normal canonical requests may refresh request-only Task context before retries)
  -> concrete provider transport (HTTP/SSE or Responses WebSocket)
  -> completed eligible commentary prefix -> exact turn-host append callback
  -> ChatResult/stream result (uncommitted suffix only)
  -> LocalSessionTurnHost tool loop or canonical assistant append
  -> SessionSaveLane + Archive/JSON authority
```

- **Producer:** `LocalSessionTurnHost` supplies the exact Session snapshot/history, request scope, Agent memory, model settings, and tool definitions. It owns the outer tool loop, strict assistant/tool message pairs, retry safe point, and `SessionToolExecutor` batch calls.
- **Owner:** `SessionChatService.ChatCoreAsync` selects route context and delegates provider-neutral request work to `ModelRequestOwner.RequestAsync`/`ConfiguredModelRequests`; concrete provider units own wire serialization/transport. `SessionChatService` does not own the tool-call loop.
- **Durable boundaries:** `LlmRequestJournalStore.BeginRequestAsync` first persists a neutral manifest after `RequestHistoryRepair.SelectAndRepair` visibility/repair and request-only display projection, before concrete model filtering/image hydration. Later, after the concrete semantic wire payload is formed and immediately before transport, `AppendAttemptStartAsync` persists concrete model/provider/attempt/effective-prompt metadata plus a payload digest; it does not store the hydrated wire body, base64 image data, auth headers, or WebSocket suffix. Canonical assistant/tool messages enter active JSON/Archive only through `LocalSessionTurnHost` and `SessionSaveLane.CommitCanonicalAppendAsync`. Normal Responses streams use that same owner for ordered completed commentary prefixes; detached requests and incomplete function calls have no such commit lane.
- **Consumers:** `LocalSessionTurnHost` executes returned tool calls through `SessionToolExecutor`, appends strict assistant/tool pairs, and decides whether to continue/terminal-stop; WebUI realtime receives deltas/events; DevTools reads journal/response fixtures. Normal canonical requests receive request-only Task context from `SessionChatService`; this context is not appended to active history or queue.

## Provider preparation and transport order

`ModelRequestOwner.RequestAsync` selects a concrete leaf, builds prompt/cache/options, starts the neutral journal manifest, then calls `ConcreteRequestHistory.PrepareRequest`: request-history repair/visibility is applied before concrete destination filtering. `ImageBlobStore.HydrateAsync` then resolves provider-specific image parts for that concrete model, followed by `ConfiguredModelRequests.CreatePreparedService` and the provider serializer/transport. The transport invokes the shared `AttemptPrepared` callback only after its concrete semantic payload is complete and before sending HTTP/SSE or a Responses WebSocket suffix/reconnect payload. The owner uses that boundary for active-attempt notification, durable start/abort and dispatch cancellation; see [the journal's two-phase contract](../units/model-journal.md#two-journal-phases-and-failure-behavior). The request-ID draft reset remains earlier, so cancellation there is not evidence of a complete concrete plan.

`AnthropicMessagesService`, `CompletionsChatService`, and Responses services own only provider-specific forms/events. Messages SSE now feeds the existing draft/realtime progress path, then shared JSON/SSE canonical conversion; the normal turn host commits its display-only limit notice after the assistant. Its terminal, watchdog, argument-error and replay contracts are mapped in [Anthropic/Completions](../units/model-anthropic-completions.md). `LocalSessionTurnHost`/`SessionToolExecutor` own the tool-call loop and strict model/tool message append chain.

## Completed Responses segments

`ISessionChatService` carries the exact turn host's segment-append callback through `RequestChatService`, `SessionChatService` and the concrete attempt. SSE and WebSocket completed-item events enter the same ordered lane; replayable reasoning/search/image items may precede completed assistant commentary, while gaps, function calls and final-answer items stop prefix commitment. No arbitrary deltas or partial tool batches become history. Delivery follows durable append; local append failure aborts the attempt without provider retry. The successful result contains only the remaining suffix (including an empty complete marker when appropriate); journal results retain the full successful attempt. Session drafts trim committed output indices rather than displaying the same text twice. See [Responses](../units/model-responses.md).

After a failed attempt commits a segment, ordinary retry preparation reads a fresh immutable root even if the queue safe point consumed nothing. Stop retains already committed commentary. `keepReasoningOnError` is opt-in and only retains a contiguous completed encrypted reasoning prefix from an interrupted upstream, never after Stop, response completion or local callback/commit failure. It is not provider execution resumption or a new history authority.

## Distinct image failure classes

Same-model missing generated blob and other local preparation/persistence/hydration failures happen before provider send and are `ModelPreparationException` paths; they do not enter provider retry, health, or countable-failure handling. The `all-images-fail` condition is produced while processing provider output/generated-image results, not during send preparation; it is nevertheless non-retryable and non-countable for provider health. A provider HTTP/SSE/WS failure after attempt start follows normal provider retry classification. Concrete serialization and local active-attempt callback failures also stay outside provider retry/health handling, even though serializers run inside the service call.

## Retry and journal ordering

`LocalSessionTurnHost.PrepareRetryAsync` reaches the save-lane safe point, drains leading queue inputs, and reports whether committed context changed. Normal provider retry applies backoff and preserves the outer retry budget. `SessionChatService` refreshes request-only Task context at the same retry safe point; if it changes, `ModelRequestOwner` starts a new journal logical request ID for the changed semantic context. Unchanged-input failover keeps the same ID, and a later leaf prompt override remains on that ID. Retry does not reset the outer budget.

Attempt-start persistence is required before provider transport; failure to make it durable is `LlmJournalPreparationException` and prevents sending that attempt. Result-write failure after a successful provider result is diagnostic-only: the result is returned and provider retry is not duplicated. Journal records are not active Session authority or child-handoff receipts.

Raw request/response/error/stream diagnostics remain a separate best-effort debugging surface with existing recent-file housekeeping, not a second journal. Their producer/redaction contract belongs to [raw diagnostics](../units/model-raw-diagnostics.md).

## Canonical units and tests

- [Model configuration/routing](../units/model-configuration.md)
- [Provider-neutral history/wire](../units/model-common-wire.md)
- [Anthropic/Completions](../units/model-anthropic-completions.md)
- [Responses](../units/model-responses.md)
- [Journal](../units/model-journal.md)
- `RoutingAttemptsTests`, provider request/streaming tests, `RequestHistoryRepairTests`, `LlmRequestJournalQualificationTests`, `PreparedCancellationTests` (normal owner serializer/notice/draft boundaries, queued durable start cancellation and real ToolScript one-shot), retry safe-point tests, `HostedResponsesWsImageTests`, and generated-image non-retryable/all-fail tests.
