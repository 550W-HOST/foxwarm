# Unit: src-session-task-context

Files: src/session/taskContext.ts, src/session/taskContext.test.ts
Related implementation: src/taskStore.ts, src/session/stateFile.ts, src/session/history.ts, src/sessionTurnRunner.ts, src/llm.ts, src/mainManagementTools.ts, src/mainManagementToolService.ts

## Purpose

Migrate persisted legacy Goal state at the exact Session authority save and provide bounded, request-only context for active tasks created and owned by that Session. Task persistence and permissions belong to [tasks](src-tasks.md); queue and provider lifecycle remain with their existing owners.

## Function Index

| Function | Responsibility |
| --- | --- |
| `ordinaryVisibleSequences(session)` | Collect the last 30 distinct ordinary model-visible sequence IDs; exclude hidden, lifecycle-only, legacy Goal-reminder and context-block messages |
| `migrateLegacySessionGoal(session)` | Ask Main for an idempotent legacy mapping and clear the passed legacy field for the authority save |
| `checkpointTaskProgress(session)` | Persist visible progress before committed compaction removes history, without producing context or waking a Session |
| `createTaskRequestContext(session)` | Return one normal request/retry hook that refreshes a bounded task summary and retains only still-active task IDs for that request |

## Migration boundary

`writeAuthoritativeSessionState` is shared by Main-local and Worker owners. If legacy Goal is present, it first asks the fixed internal Main Management RPC to ensure a task identified by a unique `legacyGoalSessionId` mapping. The task retains full Goal text, starts active, and has creator and owner equal to the real source Session. Empty legacy Goal clears without making an empty task. Invalid legacy text fails the save rather than losing it.

Only after the Main task commit does the writer prepare the new Session JSON without Goal. A precommit Session write failure restores the hot legacy field; retry finds the same task, including after restart. Existing mapped completed/cancelled tasks never revive. Worker calls are fenced to the registered source generation/incarnation, and Worker does not open or write the Main task database for migration. Detached reads do not migrate or clear state.

The serializer keeps legacy field support for read snapshots and exact failure rollback. Normal authoritative writers no longer persist Goal, and the model registry/export no longer exposes `set_goal`. Historical single Goal reminders and two-part compact-completion/Goal rows retain their existing Continue read classification.

## Request-only reminder boundary

- Eligible tasks are active with both creator and owner equal to the current canonical Session. Indexed queries include its real catalog aliases, preserving progress across supported local identity moves. Delegated tasks are excluded. Canonical matching and read-old/write-new references are owned by [tasks](src-tasks.md#session-identity-aliases).
- The interval is fixed at 30 ordinary visible messages, counted using `isModelVisibleMessage` plus the exclusions above. No reminder action or interval setting exists.
- Model mutations seed progress from the exact ToolContext sequence; Session-targeted WebUI mutations use a detached authority sequence without Main hydration. TaskStore persists each task's last counted sequence and bounded progress count. Compaction checkpoints progress before removal; repeated checkpoints/retries cannot count the same sequence again. Restart retains progress.
- Only a normal exact-owner provider call consumes a due reminder. It supplies a bounded system-part summary containing task ID, title and status; excess tasks use an omitted count.
- Context is concatenated into provider request contents only. It does not append independent reminder/history/archive rows, enqueue work or wake idle Sessions. Ordinary task tool calls/results remain part of normal tool history.
- A retry of that same request re-reads the task database and keeps only still-active retained tasks. Completion, cancellation, transfer or release removes stale context immediately. A later request without another 30 messages does not repeat it.
- Auxiliary and explicitly detached snapshot requests do not invoke the hook. New compaction emits one compact-completion marker, not a Goal or task reminder.

## Tests

`taskContext.test.ts` covers ordinary/hidden/control/context-block counting, real authority-save failure and retry, full Session immutability for request context, fixed-30 delivery, retry retention and terminal removal. `taskStore.test.ts` covers migration idempotency/full text, terminal retry, persisted counters and compacted-away progress. Provider tests verify request/retry contents without canonical history mutation. The activated Worker fixture verifies real reverse-RPC migration into Main-owned task persistence; historical Continue fixtures remain unchanged.

## Design decisions

### D-tasks-replace-goal

[2026-10-06] Retire Goal writes and its model tool in favor of self-created, self-owned active tasks. Preserve legacy Goal text through an idempotent Main mapping at the existing exact-owner authority save. Use fixed-30 request-only reminders with persisted visible-message progress and no history/archive reminder writes or idle wake. Keep historical compact Goal rows readable; new compact completion has only its lifecycle marker.
