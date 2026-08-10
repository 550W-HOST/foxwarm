# Module: message-routing

## Responsibility

Message routing owns inbound channel-to-session routing, command dispatch, side requests, and the canonical queue/LLM/tool turn loop. `MessageRouter` owns ingress while `SessionTurnRunner` owns queue claim through finalization and uses one `LocalSessionTurnHost` for current in-process effects. External channel input enters through the SessionRuntime enqueue DTO boundary; the local turn runner intentionally retains live `Session` access.

## Key units

- [src-message-router](../units/src-message-router.md) — authorization gate, session resolution, prompt-ready QueueItem construction, and runner delegation.
- [src-session-turn-runner](../units/src-session-turn-runner.md) — the single canonical local queue/turn/tool/compact/error/finalization state machine.
- [src-commands](../units/src-commands.md) — command registry and handlers.
- [src-btw](../units/src-btw.md) — display-only side request against a cloned session prefix.
- [src-selftest-misc](../units/src-selftest-misc.md) — queue and tool-loop self-tests.
- [src-wait-tool](../units/src-wait-tool.md) — wait behavior and race tests.

## Public interfaces

- `MessageRouter.handleIncomingMessage(ctx, message)` — top-level channel entry.
- `MessageRouter.processSessionQueue(sessionId)` — delegates request queue processing to its `SessionTurnRunner`.
- `CommandHandler.handleCommand(ctx, command, args)` — user command dispatch.
- `COMMANDS` — autocomplete/help registry.
- `runBtwRequest(sessionId, message)` — side request that does not mutate model-visible history.
- `shouldBroadcastChannelText(text)` — final text broadcast filter.

## Invariants

- One processing loop owns a session at a time.
- Authorization is checked before command or session routing.
- Queue items are consumed in insertion order, subject to ready compact-commit safe points; retry and compact planning do not enter the queue.
- Each consumed queue item remains a separate canonical history message; only provider-facing serialization may normalize adjacent roles.
- Direct user input, inter-session messages, timers, triggers, and internal events enter the same queue gate.
- Migrated external producers use SessionRuntime commands/events to reach that gate; `SessionTurnRunner` remains the only local turn owner and does not RPC-wrap its hot loop.
- Platform stream/card identifiers remain turn metadata and prevent incompatible queued items from being merged.
- Side requests do not mutate real model-visible history or execute returned tool calls.
- Runtime phase state is set around model/tool execution and cleared on every exit path.
- Compact maintenance items do not cancel an active wait.
- Guest-session node selection follows current isolation semantics: isolated guests bind to their configured node; non-isolated guests may use the configured node as initial execution routing.

## Canonical cross-module flows

- Full request lifecycle: [message processing pipeline](../threads/message-processing-pipeline.md).
- Provider-to-WebUI streaming: [streaming pipeline](../threads/streaming-pipeline.md).
- Tool resolution and isolation: [tool dispatch](../threads/tool-dispatch.md).
- Context maintenance: [context compaction and recall](../threads/context-compaction-and-recall.md).

## Compatibility

- Existing bracketed source headers remain display/read compatibility. Newly generated source content uses Foxwarm wrappers.
- Legacy busy fields may remain in API payloads while canonical runtime state uses explicit phases.

## Design decisions

### D-routing-prompt-ready-queue

Channel source wrappers are added once when a queued user item is constructed. Queue processing consumes prompt-ready parts and does not regenerate source prefixes.

### D-routing-runtime-state

The runner publishes transient `requesting-model` and `running-tool` phases separately from channel-specific progress payloads.

### D-routing-final-broadcast

Final replies carry a generic `turnFinal` signal. Channels may use it to close an aggregate response; the runner does not embed platform-specific completion logic.

## Canonical cross-module ownership

- Canonical queue-item history boundaries: [D-pipeline-canonical-queue-item-boundaries](../threads/message-processing-pipeline.md#d-pipeline-canonical-queue-item-boundaries).
- Platform source/turn boundaries: [D-pipeline-source-boundary](../threads/message-processing-pipeline.md#d-pipeline-source-boundary).
- Busy-time queue presentation: [D-pipeline-busy-queue-silence](../threads/message-processing-pipeline.md#d-pipeline-busy-queue-silence).
- Manual Continue/stop/dequeue semantics: [D-pipeline-control-commands](../threads/message-processing-pipeline.md#d-pipeline-control-commands).
- Provider request failure boundary: [D-llm-request-errors](./llm.md#d-llm-request-errors).
