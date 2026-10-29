# Unit: src-tasks

Files: src/taskStore.ts, src/taskStore.test.ts, src/taskService.ts, src/taskService.test.ts, src/tools/taskTools.ts, src/tools/taskTools.test.ts, src/channels/webuiTasks.ts, src/channels/webuiTasks.test.ts
Secondary files: src/tools.ts, src/tools/definitions.ts, src/tools/placement.ts, src/mainManagementTools.ts, src/mainManagementToolService.ts

## Purpose

Implements shared Task storage, validation and notifications through the existing inter-session queue. [Collaboration and Tasks](../behaviors/collaboration-and-tasks.md) owns child/Task/message distinctions, actor/owner rights and observable assignment/completion outcomes. This unit retains database, validation, receipt, notification-revision and child-attachment mechanisms; it is not a scheduler or review/workspace platform.

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
| `tool_task` | Main-local raw implementation that returns the bounded native result and trusted post-actions |

## Storage and output

The Main-owned store opens `state/tasks.sqlite` lazily under the configured data root, using the existing `node:sqlite` API. Its `tasks` table stores task fields, ownership and timestamps; `task_notes` stores append-only progress/cancellation notes with author and timestamp. Tasks never enter Session history or Archive. WAL and a five-second busy timeout permit independent connections; a write transaction holds the lock across the read, authorization check and mutation, preventing two concurrent claim winners. Read transactions keep bounded rows and their omission counts consistent.

New IDs use `task_` plus 12 lowercase random hex characters from six cryptographic random bytes (17 characters total). Ordinary create and legacy Goal migration share the same local generator; SQLite’s primary key prevents overwriting a collision. Existing UUID task IDs remain readable and usable, including persisted parent references; there is no ID migration or truncation. Titles allow 200 characters; descriptions and results allow 20,000, and notes/reasons 1,000; task-ID inputs allow 128. For long description or result updates, model callers should use ToolScript to compose the operation rather than regenerating duplicate content. `list` returns at most 50 summaries, total and omitted counts, defaulting to open/active tasks. When a scope is selected, scope and status filters are applied before the list limit and count. Claimed tasks normally become active, but ownership is independent of open/active status. The authenticated WebUI list route may add nullable `createdByAgent` and `ownerAgent` metadata resolved from the existing Session catalog; it never derives an Agent from a Session ID string. `get` returns the task, up to 20 immediate child summaries and the latest 10 notes in chronological order, with omitted counts. Full descriptions/results are not duplicated in list/child summaries. Notes remain persisted even when omitted from output. Tasks and notes record an explicit actor kind (`session` or `user`); Session rows retain nullable canonical Session IDs, while WebUI user rows use `user` with no fabricated Session ID. Opening an older database rebuilds the two actor-bearing tables transactionally, preserving task/note rows and the existing indexes while projecting legacy rows as Session-authored.

## Session identity aliases

Main supplies the existing real Session catalog resolver and current alias list to TaskStore. Permission checks, ownership comparisons, child attachment, delivery targets and reminder eligibility compare canonical Session IDs. Bounded list/get rows and historical note actors are projected canonically without rewriting the database. Unknown historical targets retain their stored IDs for readability.

Successful mutations, assignment/notification updates and reminder checkpoints persist canonical creator/owner/attached/previous-owner references inside the existing SQLite transaction. Alias-only changes do not count as ownership transfers, reset reminder progress or generate ownership notes. Indexed reminder queries use only the current Session and its known aliases; there is no full-store reconciliation or Session-move transaction. The unique legacy Goal key remains a historical mapping key, and migration retries search the current Session’s known aliases to reuse the original task.

## Model-facing contract

One builtin `task` is default-injected through the existing per-Session authorization projection and has one schema requiring `action`. It uses Main Management ownership for direct, unified and trusted Worker calls; the Main boundary derives identity from the source context and repeats generic authorization. The actor/creator always comes from ToolContext; assign accepts an explicit existing owner target or null.

Exact tool description:

> Create, list, inspect, claim, update, complete, or cancel a shared task. Prefer combining task bookkeeping with related work rather than spending a separate model turn on it. Put independent calls in the same tool batch; use run_script for dependencies, especially creating a task and passing its returned taskId to create_child_session. The current Session supplies the actor identity and is the creator of new tasks; ownerSessionId selects the assignee, not the caller. Set ownerSessionId during create for immediate assignment; use assign to transfer or release an existing owner.

| Parameter | Exact model-facing description |
|-----------|--------------------------------|
| `action` | Task operation to perform. |
| `title` | Task title. Required for create; optional for update. Up to 200 characters. |
| `description` | Problem or scope description for a new task, or replacement description when updating. Any Session may update the description of an open or active task, subject to tool permissions. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content. |
| `parentTaskId` | Existing parent task ID for a simple child task. Set only when creating. |
| `taskId` | Existing task ID. Required for get, claim, update, complete, and cancel. |
| `status` | For list, filter by task status. For update, set only open or active. |
| `scope` | For list, choose tasks created by or assigned to the current Session (default), tasks owned by the current Session, tasks in the current Agent, or all tasks. |
| `note` | Short progress note to append when updating a task. |
| `result` | Completion summary for a completed task. For long description or result text, use ToolScript to compose the operation so you do not regenerate duplicate content. |
| `notifySession` | When true, create/assign notify the new owner and, on transfer or release, the previous owner after the change is saved. For update with a note, notify the current owner unless it is the caller. Omitted or false saves without these notifications. |
| `ownerSessionId` | For create, the optional existing Session ID to receive the new task. For assign, the existing Session ID to receive the task, or null to release the current owner. |
| `reason` | Short reason for cancelling a task. |

### Actions

[Task actor/owner rights](../behaviors/collaboration-and-tasks.md#who-is-acting-on-a-task) and [notification outcomes](../behaviors/collaboration-and-tasks.md#when-does-a-task-change-notify-or-start-a-session) are the behavior owners. Store validation is action-specific and transactional: unsupported keys/types/actions fail before effect; a mixed status update checks authority before any title/description/note write. Model-facing terminal mutations reject with current status/owner in the error. Authenticated user comments use their separate append-only path, including on terminal Tasks; they do not reopen them.

- Creation validates an existing parent and resolves an optional owner through the real catalog. Self-owned creation, fresh claim, changed assignment and transition to active seed/reset the existing fixed-30 progress checkpoint. Same-owner claim is idempotent.
- List filters status/scope before its bounded query/count; get returns bounded immediate children and chronological recent notes. Canonical aliases are compared without broad store scans.
- Changed assignments append a short actor-authored ownership note; cancellation stores its optional reason as an authored note. Assignment tracks an incrementing revision and independent new/previous recipient pending/sent/failed/skipped states. A delayed result cannot mark a later revision delivered. Pending/sent retries do not resend; an explicit failed-notification retry targets only that recipient. Transfer/release uses trusted passive previous-owner ingress.
- Task mutation commits before delivery. Completion records its notification outcome separately and has no background retry service; repeating the terminal mutation is rejected. Notes use the same postcommit helper across model and user entry points.

Internal TaskService results retain the full task and post-actions. The builtin projects successful mutations to the short native receipt below.

### Model mutation receipts

The model-facing builtin boundary projects `create`, `claim`, `assign`, `update`, `complete` and `cancel` results to a short native object receipt containing `taskId`, `status`, `ownerSessionId` and `sentNotifications`, plus an actual postcommit `warning` when notification delivery fails. It does not echo title, description, note, result, timestamps, null internal notification states or other store fields. This projection occurs after TaskService has completed persistence, notification delivery and internal post-action construction, so creator notifications, child-handoff completion signals, assignment status and failure warnings retain their existing semantics. `list` keeps its bounded summaries and `get` remains the explicit full detail query with description/result/notes. Direct, unified, Worker and nested ToolScript calls use the same top-level native object projection, without an `output` string envelope or JSON decoding. Internal post-actions are stripped before display; the existing shared provider/WebUI formatters render the object as YAML without task-specific rendering. `sentNotifications` is the number of successful awaited deliveries during this operation, not cumulative database notification status or the notify intent: assignment can be 0/1/2, note/completion 0/1, and self-skip, no recipient, silent or failed delivery adds zero. Child attachment exposes the same actual total beside its creation acknowledgment, so the assignment is not counted twice. Delivery/retry/store behavior is unchanged. ToolScript may return this same receipt as ordinary data, but Activity does not infer internal script sends or creations from it. Older results lacking this field do not establish a notification count.

## Notification metadata

Automatic notices use `<foxwarm-message type="task" taskId="..." event="...">` with a task ID bounded to 128 characters and assigned/note/completed/transferred/released event metadata. Session-authored notes omit `sourceKind`; WebUI user-authored comments use the same note event and include `sourceKind="user"`. New-owner assignment notices identify Foxwarm task work and instruct completion through the task tool, whose completion notifies a Session creator automatically; previous-owner, note, completion, and other notices retain the generic task-notification hint. Source Session/time provenance remains, but replyTargetSessionId/replyVia are absent. These notices do not carry the peer-directive relation that arms a child routine-report boundary. Ordinary send_to_session keeps its existing inter-agent wrapper, reply attributes and relation classification; old messages are not rewritten.

The existing permission, queue/wait and Worker ingress paths remain in use. New-owner/completion delivery triggers normally; previous-owner transfer/release remains passive. Only trigger options cross enqueue; Task metadata is applied once before that boundary. The WebUI’s existing non-channel wrapper classifier displays Task system-like cards, not Inter-agent source/reply previews.

## Child attachment and WebUI

[Task-linked children](../behaviors/collaboration-and-tasks.md#how-does-linking-a-new-child-to-a-task-change-the-handoff) own assignment/transfer and completion consequences. `TaskService.createAttachedChild` serializes supported Task mutations against child creation: preflight checks existence, terminal state and creator/current-owner authority before child effects, then binds the actual child as owner and records the link before sending one full-description assignment. A failed postcommit notification does not roll back the child/Task. The recorded attached-child identity feeds the trusted completion post-action described below.

Authenticated WebUI create/comment/assign routes inject a user actor, never a selected Session or supplied actor ID. The existing claim/update/complete/cancel routes retain Session-targeted management; [user versus Session authority](../behaviors/collaboration-and-tasks.md#a-user-selected-session-is-not-the-user-actor) owns that distinction. Routes reuse TaskService without a second realtime/identity system:

- GET `/api/tasks?status=&limit=` returns bounded global summaries/counts, with limit 1–50 and optional catalog-resolved creator/owner Agent metadata. GET `/api/tasks/:id` returns bounded detail.
- POST `/api/tasks`, `/:id/comments`, and `/:id/assign` use user-authored create, note and ownership operations. Comment notification is opt-in; create/assign service defaults remain distinct. Terminal comments append notes without a status mutation.
- POST `/:id/claim`, `/complete`, `/cancel` and PATCH `/api/tasks/:id` retain the Session-targeted action. The maintained managed PATCH path supports title/description/note/open-or-active status; [Task service and timer scheduler](tasks-timers.md) locates its C# implementation.

Bodies cannot override route action/taskId or provide arbitrary creator identity. Errors use stable codes and HTTP 400/403/404/409; unexpected failures return a safe generic 500 without internal paths.

## Tests

`tools/taskTools.test.ts` also exercises the explicit owned-Task policy matcher across Main, Worker, unified and nested ToolScript paths, real Session aliases, unowned/missing/other-owner targets and ownership transfer. The default shared get/update contracts remain unchanged; policy resolution is canonical in [generic authorization](../threads/tool-dispatch-authorization.md#d-dispatch-generic-tool-authorization).

The task-linked creation/transfer case in `tools/taskTools.test.ts` covers both fresh and forked children receiving task assignments without a fabricated model confirmation, while preserving completion notifications.

`session/taskContext.test.ts` covers request-only fixed-30 progress and authority-save migration failure/retry. `sessionQueueOptions.test.ts` and real Worker ingress tests cover passive persistence/restart without wake; the detached runner exercises finish-window passivity and three-Session linked completion. `taskService.test.ts` verifies independent recipient results, retries and assignment-revision races. `taskStore.test.ts` exercises the coordinator/executor lifecycle, permission and terminal-state boundaries, simultaneous SQLite connections with one claim winner, immutable parent relationships, fresh-process persistence, bounded list/get output and argument validation. `tools/taskTools.test.ts` checks native receipts/list/get through the shared provider and WebUI YAML formatters, the single schema/placement, direct/unified/Worker facade behavior, context-derived identities, unchanged Session state and generic authorization at both dispatch and Main effect boundaries. `sessionWorkerCrossSession.test.ts` verifies native direct, unified and nested ToolScript results across the real Worker reverse boundary. Real local Session moves verify old task references remain readable, writes become canonical, ownership/creator notifications and attached completion still work, and fixed-30 progress/migration mappings survive aliases.

## Legacy Goal and reminders

TaskStore persists a unique legacy Session mapping plus per-task visible-message checkpoint/count. Full migrated Goal text stays in the task description even when bounded get output abbreviates it. The current interface has no `set_goal`, reminder interval parameter or reminder action. Migration, compaction checkpoints and request-only delivery are canonical in [task context](src-session-task-context.md#d-tasks-replace-goal). A successful completion notification exposes its real creator target to the ordinary tool post-action path. When the completing Session is the recorded attached child, a separate internal completion signal resolves that child’s report-required handoff boundary even if its actual parent differs from the creator. This does not fabricate a successful parent send or suppress actionable error reporting. Direct and unified dispatch recognize the resolved builtin identity. A caller-local Task facade hook forwards the trusted taskId/attachedSessionId receipt through nested ToolScript execution; the outer run/continue tool uses the same handoff consumer. Arbitrary script result data cannot create a receipt.

## Design decisions

### D-tasks-small-session-owned-work

**Selected service design under the directly requested [lightweight work-tracking scope](../behaviors/collaboration-and-tasks.md#do-i-need-a-child-a-task-or-a-message).** The single action surface and creator/owner distinction were adopted for that scope. Persistence, child attachment and notifications implement it without making delivery and task mutation one atomic external transaction.

[2026-10-06] Use one builtin with create/list/get/claim/assign/update/complete/cancel actions for explicit Session-coordinated work, not a scheduling, review or workspace platform. Actor/creator identity comes from ToolContext; an explicit owner is a catalog-resolved assignee. ParentTaskId is immutable and may reference only an existing task at creation, so the supported interface cannot construct self-links or cycles. Task fields and progress stay in the task store, not Session.history/Archive. Completion notification uses ordinary inter-session delivery; attached-child completion resolves the existing handoff boundary. No separate notification transport or scheduler is introduced.

### D-task-list-scopes

[2026-10-09] Model-facing `list` defaults to tasks created by or assigned to the current Session, with explicit `owned`, `current-agent` and `all` scopes. `owned` filters only the canonical current owner, preserving the creator-or-owner default. Current-Agent membership comes from Session catalog Agent metadata, not Session ID naming. The authenticated WebUI list route retains its global listing behavior.

### D-task-note-notification-opt-in

**Directly selected notification boundary for [Task communication](../behaviors/collaboration-and-tasks.md#when-does-a-task-change-notify-or-start-a-session).** Saving progress need not wake its recipient. Shared postcommit delivery is the mechanism; it does not convert a silent note into a handoff or authorize automatic self-notification.

[2026-10-10] [Task notification behavior](../behaviors/collaboration-and-tasks.md#when-does-a-task-change-notify-or-start-a-session) owns explicit note/comment opt-in and self/unowned skips. Both entry points use the shared postcommit helper; WebUI forwards its checkbox value explicitly.
