# Unit: shared-session-continuation

Files: packages/shared/src/sessionContinuation.ts, packages/shared/src/sessionContinuation.test.ts
Secondary files: dotnet/Foxwarm/Sessions/SessionContinuation.cs, dotnet/Foxwarm.Tests/Sessions/TerminalBatchErrorTests.cs, dotnet/Foxwarm.Tests/Sessions/TerminalBatchErrorTests.Success.cs, src/sessionContinuation.ts, src/sessionTurnRunner.ts, packages/webui/src/components/Chat.tsx, packages/webui/src/components/conversationTiming.ts, packages/webui/src/components/timelineRows.ts, packages/webui/test/sessionContinuation.test.mjs

## Purpose

Owns pure committed-history continuation classification used directly by Main and WebUI, plus the narrower canonical compact-maintenance predicate used for browser timing. This module has no runtime imports or backend Session dependency. Runtime admission and the backend-only `SessionContinuationUnavailableError` remain outside it.

The history and Continue contract is canonical in [D-pipeline-control-commands](../threads/message-processing-pipeline.md#d-pipeline-control-commands); this unit records implementation ownership, not a new protocol.

## Exports and stable symbols

| Symbol | Responsibility |
|---|---|
| `ContinuationMessage`, `ContinuationMessagePart`, `ContinuationFunctionCall`, `ContinuationFunctionResponse` | Small structural input shape containing only consumed history fields; backend and browser messages need no conversion |
| `isSessionTurnIncomplete(messages)` | Skips transparent rows, recognizes terminal model output and fully paired terminal tool batches, and conservatively retains incomplete history |
| `isCompactCompletionMaintenanceMessage(message)` | Recognizes only canonical system-only completion or the exact generated completion/reminder pair; narrower than legacy continuation transparency |
| `isTerminalToolCompletion` | Finds the nearest call batch and requires unique matching call/response IDs and names, no missing/extra responses, no non-null top-level response errors anywhere in the batch, and a successful terminal call |
| `hasOnlyEffectiveBareWaitArgs` / `isTerminalCompletionCall` | Preserve effective-bare wait and persisted legacy handoff argument semantics |
| `isGeneratedCompactCompletionMessage` | Shared exact metadata/part-shape recognition of generated compact completion with current or legacy goal guidance |

## Integration and tests

- Retained TypeScript Main imports the built module from `packages/shared/dist`; browser callers import its source directly, without importing backend runtime types. The maintained C# `SessionContinuation` applies the same batch-error rule for exact-owner Continue admission. A paired handoff suppressed by a batch error remains incomplete after interruption, including beneath transparent display/compact rows. The root build compiles shared first.
- `sessionContinuation.test.ts` owns the canonical classifier behavior table, moved from the former server/browser parity suite. It covers display-only and temporary rows, retry notices, compact completion/reminders, segmented Responses completion, legacy waits/handoffs, and complete call/response pairing.
- WebUI `sessionContinuation.test.mjs` retains only its separate existing UI source assertions. Real Continue admission and turn behavior remain covered by server Router/runner tests; mounted Chat and Conversation fixtures retain rendering and control coverage.
- Compact-maintenance timing uses this same implementation through `conversationTiming` and `timelineRows`; authored marker text or extra real content does not become canonical maintenance.
