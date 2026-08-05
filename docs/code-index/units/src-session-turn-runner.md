# Unit: src-session-turn-runner

Files: src/sessionTurnRunner.ts
Secondary files: src/messageRouter.test.ts, src/toolsSessionAgent/handoffWait.test.ts, src/toolsSessionAgent/waitTool.test.ts, src/selftest/queueDrainSelfTest.ts, src/selftest/goalReminderSelfTest.ts, src/selftest/toolLoopStallSelfTest.ts

## Purpose

Owns the one canonical local per-session queue and turn state machine. `MessageRouter` delegates real queue and retry execution here. The runner claims one session, preserves queue/source boundaries, persists input, executes provider/tool iterations, applies compact and goal safe points, presents terminal outcomes, finalizes busy/stop state, and continues trailing queued work.

This extraction is behavior-preserving and local-only. It does not implement Session-worker placement, process RPC, serialized host capabilities, or a second queue loop.

## Key exports

- `SessionTurnRunner` — stateful local runner with one per-session reentrancy set.
- `SessionTurnRunner.processSessionQueue(sessionId, options)` — canonical queue claim through final trailing-work recheck.
- `SessionTurnRunner.processSessionRetry(sessionId)` — direct retry entry into the ordinary turn loop without queue control state.
- `shouldBroadcastChannelText(text)` — shared final-response visibility predicate.

## Canonical flow

1. `processSessionQueue` prevents reentry, loads and claims the live session, then enters retry or queued work.
2. `continueWithQueuedWork` validates leading queue records, respects ready compact commits, drains one compatible source batch, and calls `runSessionTurn`.
3. `runSessionTurn` clears direct-turn waits, refreshes stale snapshots, persists queued input as separate canonical messages, and applies pre-provider compact/goal safe points.
4. `llm.chat` performs provider retries/journaling and appends its assistant result. Tool calls enter the existing `llm.executeTools` path; the complete tool result is appended before wait/compact/follow-up decisions.
5. Final delivery, child reminders, automatic compaction, terminal provider/runtime error presentation, Stop finalization, busy clearing, and queued continuation all stay in the same `try/catch/finally` owner.
6. After releasing the in-process reentrancy set, the runner checks for newly visible queued work and starts a fresh processor so a finish-window enqueue is not stranded.

## Main collaborators

- `sessionManager` — live session load, queue/busy persistence, canonical history append, wait, runtime-state, compact, child reminder, and trigger operations.
- `llm` — provider request/retry/stream behavior and tool-batch execution.
- `session/goal`, `session/managedState`, and `session/snapshotRefresh` — existing safe-point and lifecycle rules.
- Channel context/session broadcast functions — typing, retry/progress, tool progress, final reply, and `turnFinal` effects.

## Invariants

- One runner owns a session turn at a time.
- Queue items retain individual canonical history boundaries even when a compatible batch shares one provider request.
- Platform stream identifiers, ready compact commits, and Stop are hard turn/safe-point boundaries.
- Goal reminders are appended only at the pre-provider safe point after complete input/tool persistence.
- Non-null provider `parts` are cleared only after `llm.chat` returns and has appended them.
- Only `LlmRequestError` uses terminal provider presentation; other runtime errors retain the existing terminal runtime path.
- The `finally` path owns Stop handling, managed yield, queued continuation, runtime-state clearing, busy clearing, and final persistence.
- Local mode remains the only caller at this checkpoint.

## Tests

`src/messageRouter.test.ts` continues to exercise the runner through public `MessageRouter` delegates and focused internal seam probes: queue/source boundaries, retry notices, provider failure, compact safe points, Stop/dequeue/retry, in-tool follow-ups, goal ordering, runtime state, and trailing queue handoff.

## Canonical ownership

The user-visible rules are canonical in [message processing pipeline](../threads/message-processing-pipeline.md). This unit records implementation ownership only and introduces no new product decisions.
