# Unit: src-session-task-context

Files: src/session/taskContext.ts, src/session/taskContext.test.ts
Related implementation: src/taskStore.ts, src/session/stateFile.ts, src/session/history.ts, src/sessionTurnRunner.ts, src/llm.ts, src/mainManagementTools.ts, src/mainManagementToolService.ts
Active .NET implementation: dotnet/Foxwarm/Sessions/TaskReminder.cs, dotnet/Foxwarm/Models/SessionChatService.cs, dotnet/Foxwarm/Sessions/TaskProgress.cs, dotnet/Foxwarm/Sessions/TaskStore.cs, dotnet/Foxwarm/Sessions/SessionContinuation.cs, packages/shared/src/sessionContinuation.ts, dotnet/Foxwarm.Tests/Sessions/TaskReminderHistoryTests.cs

## Purpose

Migrate persisted legacy Goal state at the exact Session authority save and remind a Session of the active tasks it created and owns with a bounded, persisted system history row. Task persistence and permissions belong to [tasks](src-tasks.md); queue and provider lifecycle remain with their existing owners.

## Function Index

| Function | Responsibility |
| --- | --- |
| `ordinaryVisibleSequences(session)` / `TaskProgress.Sequences` | Collect the last 30 distinct ordinary model-visible sequence IDs; exclude hidden, lifecycle-only, Goal-reminder, Task-reminder and context-block messages |
| `migrateLegacySessionGoal(session)` | Ask Main for an idempotent legacy mapping and clear the passed legacy field for the authority save |
| `checkpointTaskProgress(session)` | Persist visible progress before committed compaction removes history, without producing context or waking a Session |
| `SessionChatService.AppendTaskReminderAsync` | Before a normal owner request, consume due progress and append one `TaskReminder.Build` row through the canonical append path |
| `TaskReminder.IsRow` / `isTaskReminderMessage` | Recognize only the generated row (flag plus a single task-reminder wrapper part) for progress and Continue classification |
| `createTaskRequestContext(session)` | Retained TypeScript reference only: the superseded request-only hook |

## Migration boundary

`writeAuthoritativeSessionState` is shared by Main-local and Worker owners. If legacy Goal is present, it first asks the fixed internal Main Management RPC to ensure a task identified by a unique `legacyGoalSessionId` mapping. The task retains full Goal text, starts active, and has creator and owner equal to the real source Session. Empty legacy Goal clears without making an empty task. Invalid legacy text fails the save rather than losing it.

Only after the Main task commit does the writer prepare the new Session JSON without Goal. A precommit Session write failure restores the hot legacy field; retry finds the same task, including after restart. Existing mapped completed/cancelled tasks never revive. Worker calls are fenced to the registered source generation/incarnation, and Worker does not open or write the Main task database for migration. Detached reads do not migrate or clear state.

The serializer keeps legacy field support for read snapshots and exact failure rollback. Normal authoritative writers no longer persist Goal, and the model registry/export no longer exposes `set_goal`. Historical single Goal reminders and two-part compact-completion/Goal rows retain their existing Continue read classification.

## Persisted reminder boundary

Governing goal: [request-prefix stability](../overview.md#d-request-prefix-stability). Decision: [D-tasks-reminder-history](#d-tasks-reminder-history).

- Eligible tasks are active with both creator and owner equal to the current canonical Session. Indexed queries include its real catalog aliases, preserving progress across supported local identity moves. Delegated tasks are excluded. Canonical matching and read-old/write-new references are owned by [tasks](src-tasks.md#session-identity-aliases).
- The interval is fixed at 30 ordinary visible messages, counted using `isModelVisibleMessage` plus the exclusions above. No reminder action or interval setting exists. The reminder row itself is excluded, so it never counts towards the next interval.
- Model mutations seed progress from the exact ToolContext sequence; Session-targeted WebUI mutations use a detached authority sequence without Main hydration. TaskStore persists each task's last counted sequence and bounded progress count. Compaction checkpoints progress before removal; repeated checkpoints/retries cannot count the same sequence again. Restart retains progress.
- Only a normal exact-owner provider call consumes a due reminder. Immediately before that request, the owner consumes the due progress and appends one `role: "user"` row whose single system part is `<foxwarm-system kind="task-reminder">Continue the active tasks:` followed by one `ID — title (status)` line per task, an omitted count beyond 50 tasks, and the closing tag. The row carries `__meta.taskReminder: true`; canonical append stamps its `seq` and the wrapper's `seq` attribute like other persisted input wrappers. The request then sends plain committed history; there is no request-only context.
- The row uses the ordinary canonical append/save path (active JSON, Archive and realtime commit events). It does not enqueue work, change last-message time or wake an idle Session. Ordinary task tool calls/results remain part of normal tool history.
- Provider retries, adoption refreshes and committed-context retry preparation re-read committed history, so they resend the same row. Consumption reset the progress, so Continue or Run queued after a failure, Stop or restart does not append another. Tasks completed or cancelled after the append stay in that historical row; a later request without another 30 messages does not repeat it.
- Auxiliary, compaction and explicitly detached snapshot requests do not consume or append it. New compaction emits one compact-completion marker, not a Goal or task reminder, and treats an existing reminder row as ordinary system history.
- Continue/idle classification treats the generated row as transparent: the history before it decides whether the turn is unfinished. The row is appended only when a request is about to run, so this keeps the classification identical to the history without it. Authored task-reminder text, an unflagged row or a row with additional content is ordinary input.
- The WebUI omits the row in Conversation mode like other internal runtime rows. Grouped and Detailed views show it as a `task-reminder` system card; inside a tool run it joins the group with a counted "Task reminder" tag, like historical Goal reminders.
- The retained TypeScript reference (`createTaskRequestContext`) still implements the superseded request-only delivery; it is not the active Main.

## Tests

`taskContext.test.ts` covers the TypeScript reference's ordinary/hidden/control/context-block counting and real authority-save failure and retry. `TaskReminderHistoryTests` covers the .NET due/not-due append position and persisted text, the row's exclusion from progress, provider retry without a second row, a failed due request surviving restart with Continue resending the same row once and retaining progress, idle due progress and auxiliary requests that neither wake nor consume, and Continue classification of trailing generated, unflagged and extended rows. `TaskStoreTests` covers migration idempotency/full text, persisted counters and current titles in due context. `sessionContinuation.test.ts` mirrors the classification cases; WebUI `chatSharedMetadata.test.mjs` and `toolGroupEventCards.e2e.mjs` cover Conversation omission and the grouped/expanded card. Historical Continue fixtures remain unchanged.

## Design decisions

### D-tasks-replace-goal

[2026-10-06] Retire Goal writes and its model tool in favor of self-created, self-owned active tasks. Preserve legacy Goal text through an idempotent Main mapping at the existing exact-owner authority save. Use fixed-30 reminders with persisted visible-message progress and no idle wake; their delivery is now owned by [D-tasks-reminder-history](#d-tasks-reminder-history), which superseded the original request-only delivery. Keep historical compact Goal rows readable; new compact completion has only its lifecycle marker.

### D-tasks-reminder-history

[2026-11-10] User decision: a due Task reminder is a persisted system history row, as the earlier Goal reminder was, not request-only context. A per-request block after history becomes the request's cache breakpoint and its cache entry cannot be reused, which conflicts with [request-prefix stability](../overview.md#d-request-prefix-stability). The row is appended once through the canonical append path before the normal owner request that consumes it; eligibility, the fixed-30 interval, text, progress persistence, no idle wake and the exclusion of auxiliary/detached requests are unchanged. The row does not count towards the next interval and is transparent to Continue/idle classification.
