# Unit: src-tasks

Files: src/taskStore.ts, src/taskStore.test.ts, src/taskService.ts, src/taskService.test.ts, src/tools/taskTools.ts, src/tools/taskTools.test.ts, src/channels/webuiTasks.ts, src/channels/webuiTasks.test.ts
Secondary files: src/tools.ts, src/tools/definitions.ts, src/tools/placement.ts, src/mainManagementTools.ts, src/mainManagementToolService.ts

## Purpose

Implements a small persistent task list shared by Sessions. A coordinator creates a task and passes its ID in an executor's initial message. The executor explicitly claims, updates, and completes the task; the coordinator observes it with list/get. Task actions do not schedule Sessions or implement review/workspace integration. Notifications use the existing inter-session queue delivery with distinct Task metadata, and explicit child attachment integrates with the existing creation and completion boundaries.

## Key exports and function index

| Symbol | Responsibility |
|--------|----------------|
| `TASK_ACTIONS`, `TASK_STATUSES` | Supported action/status enums |
| `TASK_LIST_SCOPES` | Supported task-list scope enum |
| `TASK_LIST_LIMIT`, `TASK_CHILD_LIMIT`, `TASK_NOTE_LIMIT` | Output row bounds |
| `generateTaskId` | Generates the short random ID used by ordinary create and legacy Goal migration |
| `validateTaskArgs` | Strict action-specific keys, required fields, types, lengths and update-status validation |
| `TaskStore.execute` | Runs a validated operation using the current caller Session identity in a SQLite transaction |
| `TaskStore.executeAsUser` | Runs the three authenticated WebUI user mutations without constructing a Session actor |
| `TaskService` | Main-owned shared validation, Session target resolution, serial child attachment and completion delivery |
| `TaskStore.bindChild` | Atomically claims and records the real newly created attached Session |
| `TaskStore.markAssignmentNotification` | Records independent new/previous delivery status for the committed assignment revision |
| `TaskStore.markCompletionNotification` | Records sent/failed notification after durable completion |
| `registerWebUiTaskRoutes` | Authenticated bounded reads, user create/comment/owner mutations, and existing Session-targeted management writes |
| `TaskStore.close` | Releases the lazy SQLite connection |
| `tool_task` | Main-local raw implementation that serializes the bounded result into the standard output envelope |

## Storage and output

The Main-owned store opens `state/tasks.sqlite` lazily under the configured data root, using the existing `node:sqlite` API. Its `tasks` table stores task fields, ownership and timestamps; `task_notes` stores append-only progress/cancellation notes with author and timestamp. Tasks never enter Session history or Archive. WAL and a five-second busy timeout permit independent connections; a write transaction holds the lock across the read, authorization check and mutation, preventing two concurrent claim winners. Read transactions keep bounded rows and their omission counts consistent.

New IDs use `task_` plus 12 lowercase random hex characters from six cryptographic random bytes (17 characters total). Ordinary create and legacy Goal migration share the same local generator; SQLite’s primary key prevents overwriting a collision. Existing UUID task IDs remain readable and usable, including persisted parent references; there is no ID migration or truncation. Titles allow 200 characters; descriptions and results allow 20,000, and notes/reasons 1,000; task-ID inputs allow 128. For long description or result updates, model callers should use ToolScript to compose the operation rather than regenerating duplicate content. `list` returns at most 50 summaries, total and omitted counts, defaulting to open/active tasks. When a scope is selected, scope and status filters are applied before the list limit and count. Claimed tasks normally become active, but ownership is independent of open/active status. The authenticated WebUI list route may add nullable `createdByAgent` and `ownerAgent` metadata resolved from the existing Session catalog; it never derives an Agent from a Session ID string. `get` returns the task, up to 20 immediate child summaries and the latest 10 notes in chronological order, with omitted counts. Full descriptions/results are not duplicated in list/child summaries. Notes remain persisted even when omitted from output. Tasks and notes record an explicit actor kind (`session` or `user`); Session rows retain nullable canonical Session IDs, while WebUI user rows use `user` with no fabricated Session ID. Opening an older database rebuilds the two actor-bearing tables transactionally, preserving task/note rows and the existing indexes while projecting legacy rows as Session-authored.

## Session identity aliases

Main supplies the existing real Session catalog resolver and current alias list to TaskStore. Permission checks, ownership comparisons, child attachment, delivery targets and reminder eligibility compare canonical Session IDs. Bounded list/get rows and historical note actors are projected canonically without rewriting the database. Unknown historical targets retain their stored IDs for readability.

Successful mutations, assignment/notification updates and reminder checkpoints persist canonical creator/owner/attached/previous-owner references inside the existing SQLite transaction. Alias-only changes do not count as ownership transfers, reset reminder progress or generate ownership notes. Indexed reminder queries use only the current Session and its known aliases; there is no full-store reconciliation or Session-move transaction. The unique legacy Goal key remains a historical mapping key, and migration retries search the current Session’s known aliases to reuse the original task.

## Model-facing contract

One builtin `task` is default-injected through the existing per-Session authorization projection and has one schema requiring `action`. It uses Main Management ownership for direct, unified and trusted Worker calls; the Main boundary derives identity from the source context and repeats generic authorization. The actor/creator always comes from ToolContext; assign accepts an explicit existing owner target or null.

Exact tool description:

> Create and track a small task shared by Foxwarm Sessions. Use one action at a time to create, list, inspect, claim, update, complete, or cancel a task. The current Session is recorded automatically as the creator and actor; do not use ownerSessionId to identify the caller. When creating a task, you may set ownerSessionId to assign it immediately; use assign only to transfer or release an existing task owner.

| Parameter | Exact model-facing description |
|-----------|--------------------------------|
| `action` | Task operation to perform. |
| `title` | Task title. Required when action is create. |
| `description` | Problem or scope description for a new task, or replacement description when updating. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content. |
| `parentTaskId` | Existing parent task ID for a simple child task. Set only when creating. |
| `taskId` | Existing task ID. Required for get, claim, update, complete, and cancel. |
| `status` | For list, filter by task status. For update, set only open or active. |
| `scope` | For list, choose tasks created by or assigned to the current Session (default), any Session in the current Agent, or all Sessions and users. |
| `note` | Short progress note to append when updating a task. |
| `result` | Completion summary for a completed task. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content. |
| `notifySession` | When true, create/assign notify the new owner and, on transfer or release, the previous owner after the change is saved. For update with a note, notify the current owner unless it is the caller. Omitted or false saves without these notifications. |
| `ownerSessionId` | For create, the optional existing Session ID to receive the new task. For assign, the existing Session ID to receive the task, or null to release the current owner. |
| `reason` | Short reason for cancelling a task. |

### Actions

- `create`: Create a new task. Requires title; accepts description, an existing parentTaskId, optional existing ownerSessionId (or null), and notifySession. Records the current Session as creator. Without an owner it starts open/unclaimed; an explicit owner commits active ownership atomically with creation. Optional notification uses the same postcommit assignment delivery/self-skip/failure rules, with no previous recipient. Self-owned creation seeds fresh fixed-30 progress.
- `list`: List bounded task summaries, optionally filtered by status and scope. Scope defaults to `current-session`, includes tasks created by or assigned to that Session; `current-agent` includes creator or owner Sessions in the current Agent; `all` includes every Session- or user-created task. Agent membership resolves through the real Session catalog, and local scopes include user-created tasks when assigned to a matching Session.
- `get`: Inspect one task and its bounded child/note summary. Requires taskId.
- `claim`: Claim an unowned task for the current Session. A task owned by another Session is not transferred. Same-owner retries return the current task; a fresh claim sets active.
- `assign`: Assign or transfer to an existing Session, or release its owner. Creator/current owner may assign; targets resolve through the real catalog. Null releases ownership and sets open; a target sets active. Changes record a short authored note. Optional `notifySession` defaults false. When true, the committed change notifies a new owner normally and a previous owner on transfer/release through queue-only delivery. New-owner notices for create-with-owner and assign/transfer include the complete stored description together with the original task ID, title, and status; previous-owner transfer/release notices remain brief and passive. Self targets are skipped. Each recipient has independent persisted pending/sent/failed/skipped state. Successful/pending retries do not resend; explicitly repeating a failed notification retries only that recipient. An assignment revision prevents an older delayed result from marking a newer assignment delivered. Null ownership may notify the released owner, but there is no new recipient. Notification failure warns without undoing assignment. Queue-only behavior is canonical in [the pipeline](../threads/message-processing-pipeline.md#d-pipeline-passive-task-notification).
- `update`: Update an owned or otherwise permitted task description, status, or progress note. Description/status changes require the owner, or creator when unclaimed. A note-only update may be authored by any Session and appends a persistent note; `notifySession: true` sends a queue-backed `event="note"` Task notification to a different current owner after commit. Omitted or false saves the note without notifying; an owner does not receive their own note, and an unowned task has no recipient. Failed opted-in delivery returns a warning without rolling back the note. Status accepts only open/active and never releases ownership.
- `complete`: Mark a task completed with an optional result summary. Only the owner, or creator when unclaimed, may complete. After commit, the shared service sends a Task notification to the creator through the existing inter-session queue. Delivery failure returns a warning without undoing completion. Self completion records skipped without a redundant self-send or warning. Pending/sent/failed/skipped state survives restart; repeated completion never resends. No background notification retry runs.
- `cancel`: Cancel a task with an optional reason. Creator or owner may cancel; reason is recorded as an authored note.

Unknown actions, unsupported keys and invalid values fail before effect. Completed/cancelled tasks reject every mutation, including claim, repeated completion/cancellation and attempts to reopen. Internal TaskService mutation results include the current task/owner/status; the model-facing builtin projects successful mutations to the short receipt described below. Authority and terminal-state errors include current owner/status and the relevant conflict.

### Model mutation receipts

The model-facing builtin boundary projects `create`, `claim`, `assign`, `update`, `complete` and `cancel` results to a short JSON receipt containing only `taskId`, `status` and `ownerSessionId`, plus an actual postcommit `warning` when notification delivery fails. It does not echo title, description, note, result, timestamps, null internal notification states or other store fields. This projection occurs after TaskService has completed persistence, notification delivery and internal post-action construction, so creator notifications, child-handoff completion signals, assignment status and failure warnings retain their existing semantics. `list` keeps its bounded summaries and `get` remains the explicit full detail query with description/result/notes. Direct, unified, Worker and nested ToolScript calls use the same projection.

## Notification metadata

Automatic notices use `<foxwarm-message type="task" taskId="..." event="...">` with a task ID bounded to 128 characters and assigned/note/completed/transferred/released event metadata. Session-authored notes omit `sourceKind`; WebUI user-authored comments use the same note event and include `sourceKind="user"`. New-owner assignment notices identify Foxwarm task work and instruct completion through the task tool, whose completion notifies a Session creator automatically; previous-owner, note, completion, and other notices retain the generic task-notification hint. Source Session/time provenance remains, but replyTargetSessionId/replyVia are absent. These notices do not carry the peer-directive relation that arms a child routine-report boundary. Ordinary send_to_session keeps its existing inter-agent wrapper, reply attributes and relation classification; old messages are not rewritten.

The existing permission, queue/wait and Worker ingress paths remain in use. New-owner/completion delivery triggers normally; previous-owner transfer/release remains passive. Only trigger options cross enqueue; Task metadata is applied once before that boundary. The WebUI’s existing non-channel wrapper classifier displays Task system-like cards, not Inter-agent source/reply previews.

## Child attachment and WebUI

`create_child_session.taskId` assigns or transfers an existing non-terminal task to the new Session; the child receives the full stored description and optional message as one task assignment and starts work. A Main-owned serial service lane prevents supported task mutations from racing child creation: preflight rejects nonexistent, terminal or unauthorized tasks before child effects, then assigns the actual created child as owner and records a link note before assignment delivery. No Session is created automatically by the task tool. The task assignment is a task notice rather than an inter-agent handoff, and task completion notifies a Session creator automatically without a separate routine report. Non-task children keep ordinary reporting.

Authenticated WebUI routes reuse the same TaskService; no separate role/identity system or realtime stream is introduced. Ordinary token-authenticated WebUI has management access to all Sessions. The three user operations are authenticated user actions: POST create, POST comment, and POST assign/release never infer an actor from the selected Session and reject `sessionId` actor input. Owner Session IDs are only recipients. Existing claim/update/complete/cancel routes retain their Session-targeted compatibility semantics. User-created tasks have no Session creator, so completion keeps the existing `skipped` notification result rather than fabricating a target. User notifications use the existing queue with no source Session plus explicit user Task metadata; failed delivery warns after the durable mutation without rollback.

- GET `/api/tasks?status=&limit=` returns bounded summaries, total/omitted; limit is 1–50 and the route retains its global task-list semantics. Authenticated WebUI list rows also include nullable catalog-resolved `createdByAgent` and `ownerAgent` fields for filtering; tool-facing list output remains unchanged apart from its caller-selected scope.
- GET `/api/tasks/:id` returns task and bounded child/note details.
- POST `/api/tasks` creates a user-authored task and accepts an optional existing `ownerSessionId`.
- POST `/api/tasks/:id/comments` appends a user-authored note and can notify the current owner through the same note notification helper as Session `update(note)` when `notifySession` is true.
- POST `/api/tasks/:id/assign` changes or releases the owner; by default it notifies the new owner and passively notifies the old owner.
- POST `/api/tasks/:id/claim`, `/complete`, `/cancel` and PATCH `/api/tasks/:id` retain the matching Session-targeted action.
- PATCH `/api/tasks/:id` updates description/note/open-or-active status.

Bodies cannot override route action/taskId or supply arbitrary creator identity. Task errors have stable codes and HTTP 400/403/404/409; unexpected failures return a safe generic 500, without internal paths.

## Tests

`session/taskContext.test.ts` covers request-only fixed-30 progress and authority-save migration failure/retry. `sessionQueueOptions.test.ts` and real Worker ingress tests cover passive persistence/restart without wake; the detached runner exercises finish-window passivity and three-Session linked completion. `taskService.test.ts` verifies independent recipient results, retries and assignment-revision races. `taskStore.test.ts` exercises the coordinator/executor lifecycle, permission and terminal-state boundaries, simultaneous SQLite connections with one claim winner, immutable parent relationships, fresh-process persistence, bounded list/get output and argument validation. `tools/taskTools.test.ts` checks the single schema/placement, direct/unified/Worker facade behavior, context-derived identities, unchanged Session state and generic authorization at both dispatch and Main effect boundaries. Real local Session moves verify old task references remain readable, writes become canonical, ownership/creator notifications and attached completion still work, and fixed-30 progress/migration mappings survive aliases.

## Legacy Goal and reminders

TaskStore persists a unique legacy Session mapping plus per-task visible-message checkpoint/count. Full migrated Goal text stays in the task description even when bounded get output abbreviates it. The current interface has no `set_goal`, reminder interval parameter or reminder action. Migration, compaction checkpoints and request-only delivery are canonical in [task context](src-session-task-context.md#d-tasks-replace-goal). A successful completion notification exposes its real creator target to the ordinary tool post-action path. When the completing Session is the recorded attached child, a separate internal completion signal resolves that child’s report-required handoff boundary even if its actual parent differs from the creator. This does not fabricate a successful parent send or suppress actionable error reporting. Direct and unified dispatch recognize the resolved builtin identity. A caller-local Task facade hook forwards the trusted taskId/attachedSessionId receipt through nested ToolScript execution; the outer run/continue tool uses the same handoff consumer. Arbitrary script result data cannot create a receipt.

## Design decisions

### D-tasks-small-session-owned-work

[2026-10-06] Use one builtin with create/list/get/claim/assign/update/complete/cancel actions for explicit Session-coordinated work, not a scheduling, review or workspace platform. Creator/owner identities come from ToolContext. ParentTaskId is immutable and may reference only an existing task at creation, so the supported interface cannot construct self-links or cycles. Task fields and progress stay in the task store, not Session.history/Archive. Completion notification uses ordinary inter-session delivery; attached-child completion resolves the existing handoff boundary. No separate notification transport or scheduler is introduced.

### D-task-list-scopes

[2026-10-09] Model-facing `list` defaults to tasks created by or assigned to the current Session, with explicit `current-agent` and `all` scopes. Current-Agent membership comes from Session catalog Agent metadata, not Session ID naming. The authenticated WebUI list route retains its global listing behavior.

### D-task-note-notification-opt-in

[2026-10-10] Note and comment notifications are opt-in via `notifySession: true`. Omitting the field or setting it false saves the note without delivery; true notifies a different current owner after persistence. Owner-authored notes and notes on unowned tasks are not delivered, and failed delivery does not roll back the note. The WebUI supplies its existing checkbox value explicitly.
