# Unit: src-session-turn-runner

Files: src/sessionTurnRunner.ts
Secondary files: src/sessionTurnRunnerDetachedOwner.test.ts, src/sessionWorkerHost.test.ts, src/messageRouter.test.ts, src/toolsSessionAgent/handoffWait.test.ts, src/toolsSessionAgent/waitTool.test.ts, src/selftest/queueDrainSelfTest.ts, src/selftest/goalReminderSelfTest.ts, src/selftest/toolLoopStallSelfTest.ts

## Purpose

Owns the one canonical per-session queue and turn state machine for both Main-local and Session-worker placement. `MessageRouter` delegates real local queue and retry execution here, while `SessionWorkerHost` invokes the same runner for its exact owner. The runner claims one session, preserves queue/source boundaries, persists input, executes provider/tool iterations, applies compact and goal safe points, presents terminal outcomes, finalizes busy/stop state, and continues trailing queued work.

One turn-specific `SessionTurnHost` exposes only effects called by the runner. `LocalSessionTurnHost` delegates local effects to existing in-process modules and channel callbacks, while the Worker binds the same interface to its exact owner and fixed typed Main delivery operations. The runner remains the only queue/turn loop; placement and RPC ownership stay outside this unit.

## Key exports

- `SessionTurnRunner` — stateful local runner with one per-session reentrancy set.
- `SessionTurnHost` — non-RPC interface for the runner's current persistence, compact, provider/tool, runtime-event, and channel-delivery effects.
- `LocalSessionTurnHost` — in-process implementation shared by Main-local turns and the child host; it binds one effects owner and accepts a small coherent override object for exact snapshot, system-queue, compaction, safe-point pending-queue ingestion, intermediate delivery, and committed-final behavior. Unbound hosts preserve module-backed behavior. A bound host rejects every other ID and every different same-ID Session object before invoking effects.
- `SessionTurnRunner.processSessionQueue(sessionId, options)` — canonical queue claim through final trailing-work recheck.
- `SessionTurnRunner.processSessionRetry(sessionId)` — direct retry entry into the ordinary turn loop without queue control state.
- `shouldBroadcastChannelText(text)` — shared final-response visibility predicate.

## Canonical flow

1. `processSessionQueue` prevents reentry, loads the live session, and awaits the complete busy-owner persistence claim before entering retry or queued work. A rejected claim cannot start turn work or schedule a trailing recursive processor.
2. `continueWithQueuedWork` validates leading queue records, respects ready compact commits, drains one compatible source batch, and calls `runSessionTurn`. Serialized direct-reply intent participates in the compatibility key; QQ Bot and WeWork passive sources use channel instance plus scoped conversation, not platform message/card ID.
3. `runSessionTurn` clears direct-turn waits, refreshes stale snapshots, persists queued input as separate canonical messages, and applies pre-provider compact/goal safe points.
4. `runSessionTurn` creates one ephemeral turn identity and passes it through every `llm.chat` call in that invocation. `llm.chat` performs provider retries/journaling and appends its assistant result. Tool calls enter the existing `llm.executeTools` path with current-turn QQ reply metadata in the in-process ToolContext; when the result also has non-empty text, the local host broadcasts it or the Worker host awaits one fixed Main intermediate-delivery attempt after canonical append/publication. The complete tool result is appended before wait/compact/follow-up decisions. A no-tool result also checks one compatible leading queue prefix before final delivery; when consumed input continues the invocation in separate canonical rows, the completed non-empty result is delivered once as intermediate text, the shared usage-threshold compact guard runs, and continuation occurs only after the loop-top compact safe point. At persisted safe points the Worker host may ingest its newly durable mailbox prefix into the already-owned queue without a concurrent second runner, giving Worker and local placement the same provider-time follow-up behavior.
5. Final delivery, child reminders, automatic compaction, terminal provider/runtime error presentation, Stop finalization, busy clearing, and queued continuation all stay in the same `try/catch/finally` owner. A fixed Worker pre-final maintenance fatal bypasses generic semantic-error/reminder/send branches: exact direct sources receive the one presentation-only final, while source-less turns surface the original fatal after their release attempt. Every terminal busy release uses the same awaited effects transition, so simultaneous Stop/queue mutations share its full persistence commit.
6. After a successful invocation releases the in-process reentrancy set, the runner checks for newly visible queued work and starts a fresh processor so a finish-window enqueue is not stranded. A direct mutation-fenced maintenance presentation returns one ephemeral per-invocation outcome through the current queue call stack; it preserves the durable queue but suppresses only that invocation's trailing processor. Any claimed turn or release failure suppresses the normal handoff even if a custom effect left the owner marked idle. Failure from the intentionally spawned trailing processor is logged once with the session ID; it is not retried or broadcast, and the durable queue remains available to a later explicit trigger.

## Main collaborators

- `LocalSessionTurnHost` delegates compact, child reminder, provider/tool execution, intermediate/final channel delivery, and other effects to their existing owners. Its bound local `CurrentSessionTurnEffects` carries exact-owner save, canonical one/many append, busy, wait, history/runtime events, provider stream/abort effects, and the process-local default ExecRuntime. The Worker supplies typed Main delivery overrides over the reverse transport; detached tests may provide one alternate exact owner without changing the runner or provider schema. Tool execution validates the passed owner identity before deriving the local persistence/runtime context; owner mismatch fails before any effect is used.
- Pure session-local policy helpers such as goal/managed-state checks, usage thresholds, and provider error predicates remain direct runner dependencies rather than host capabilities.
- `session/goal`, `session/managedState`, and `session/snapshotRefresh` — existing safe-point and lifecycle rules.
- Channel context/session broadcast functions — typing, retry/progress, tool progress, final reply, and `turnFinal` effects. Final routing reads the immutable QueueSource snapshot's direct-reply intent while retaining the live callback only as the local delivery mechanism. WeWork stream IDs and QQ Bot inbound `msg_id` are retained and propagated as missing-live-context delivery fallbacks; channel instance plus scoped conversation is their merge boundary, and Main adapters own the latest passive context.

## Invariants

- One runner owns a session turn at a time; claim persistence completes before any provider/history/tool work begins.
- Queue items retain individual canonical history boundaries even when a compatible batch shares one provider request.
- Different passive channel instances/conversations, differing direct-reply intents, ready compact commits, and Stop are hard turn/safe-point boundaries; message/card IDs alone are not.
- Goal reminders are appended only at the pre-provider safe point after complete input/tool persistence.
- Non-null provider `parts` are cleared only after `llm.chat` returns and has appended them.
- Only `LlmRequestError` uses terminal provider presentation; other runtime errors retain the existing terminal runtime path except the fixed mutation-fenced Worker maintenance fatal described above.
- The `finally` path owns Stop handling, managed yield, queued continuation, runtime-state clearing, busy clearing, and final persistence.
- Main-local and Session-worker placement both invoke this runner; the Worker host owns the exact Session and uses typed Main delivery for external channel output.
- The turn host is an in-process runner boundary; only the Worker-owned effects and fixed delivery services cross process RPC. No second queue loop or generic broadcast RPC exists.
- Intermediate delivery is one post-append/publication attempt, excludes WebUI and the active WeWork stream, preserves QQ passive source metadata, and logs failures without poisoning the semantic turn. `lastTextBroadcasted` remains the duplicate-suppression signal for tool/wait/stop completion.

## Tests

`src/messageRouter.test.ts` continues to exercise the runner through public `MessageRouter` delegates and focused internal seam probes: queue/source boundaries, retry notices, provider failure, compact safe points, Stop/dequeue/retry, in-tool follow-ups, goal ordering, runtime state, and trailing queue handoff. `src/sessionTurnRunnerDetachedOwner.test.ts` runs provider and real local-tool turns for an exact owner absent from the global map and checks archive/frontier/state-file ordering plus busy, wait, event, append-many, mismatch, and persistence-failure behavior.

## Canonical ownership

The user-visible rules are canonical in [message processing pipeline](../threads/message-processing-pipeline.md). This unit records implementation ownership only and introduces no new product decisions.
