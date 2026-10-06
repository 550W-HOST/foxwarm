# Unit: src-tasks

Files: src/taskStore.ts, src/taskStore.test.ts, src/taskService.ts, src/taskService.test.ts, src/tools/taskTools.ts, src/tools/taskTools.test.ts, src/channels/webuiTasks.ts, src/channels/webuiTasks.test.ts
Secondary files: src/tools.ts, src/tools/definitions.ts, src/tools/placement.ts, src/mainManagementTools.ts, src/mainManagementToolService.ts

## Purpose

Implements a small persistent task list shared by Sessions. A coordinator creates a task and passes its ID in an executor's initial message. The executor explicitly claims, updates, and completes the task; the coordinator observes it with list/get. This unit does not create or schedule Sessions, modify Session state, or implement review/workspace integration.

## Key exports and function index

| Symbol | Responsibility |
|--------|----------------|
| `TASK_ACTIONS`, `TASK_STATUSES` | Supported action/status enums |
| `TASK_LIST_LIMIT`, `TASK_CHILD_LIMIT`, `TASK_NOTE_LIMIT` | Output row bounds |
| `validateTaskArgs` | Strict action-specific keys, required fields, types, lengths and update-status validation |
| `TaskStore.execute` | Runs a validated operation using the current caller Session identity in a SQLite transaction |
| `TaskService` | Main-owned shared validation, Session target resolution, serial child attachment and completion delivery |
| `TaskStore.markCompletionNotification` | Records sent/failed notification after durable completion |
| `registerWebUiTaskRoutes` | Authenticated bounded reads and Session-targeted management writes |
| `TaskStore.close` | Releases the lazy SQLite connection |
| `tool_task` | Main-local raw implementation that serializes the bounded result into the standard output envelope |

## Storage and output

The Main-owned store opens `state/tasks.sqlite` lazily under the configured data root, using the existing `node:sqlite` API. Its `tasks` table stores task fields, ownership and timestamps; `task_notes` stores append-only progress/cancellation notes with author and timestamp. Tasks never enter Session history or Archive. WAL and a five-second busy timeout permit independent connections; a write transaction holds the lock across the read, authorization check and mutation, preventing two concurrent claim winners. Read transactions keep bounded rows and their omission counts consistent.

IDs use `task_` plus a generated UUID. Titles allow 200 characters; descriptions/results 4,000; notes/reasons 1,000; task-ID inputs 128. `list` returns at most 50 summaries, total and omitted counts, defaulting to open/active tasks. Claimed tasks normally become active, but ownership is independent of open/active status. `get` returns the task, up to 20 immediate child summaries and the latest 10 notes in chronological order, with omitted counts. Full descriptions/results are not duplicated in list/child summaries. Notes remain persisted even when omitted from output.

## Model-facing contract

One builtin `task` is default-injected through the existing per-Session authorization projection and has one schema requiring `action`. It uses Main Management ownership for direct, unified and trusted Worker calls; the Main boundary derives identity from the source context and repeats generic authorization. The actor/creator always comes from ToolContext; assign accepts an explicit existing owner target or null.

Exact tool description:

> Create and track a small task shared by Foxwarm Sessions. Use one action at a time to create, list, inspect, claim, update, complete, or cancel a task. The current Session is recorded automatically; do not provide another Session identity.

| Parameter | Exact model-facing description |
|-----------|--------------------------------|
| `action` | Task operation to perform. |
| `title` | Task title. Required when action is create. |
| `description` | Short problem or scope description for a new task, or replacement description when updating. |
| `parentTaskId` | Existing parent task ID for a simple child task. Set only when creating. |
| `taskId` | Existing task ID. Required for get, claim, update, complete, and cancel. |
| `status` | For list, filter by task status. For update, set only open or active. |
| `note` | Short progress note to append when updating a task. |
| `result` | Short completion summary for a completed task. |
| `notifySession` | When true, notify the assigned Session after the task assignment is committed. |
| `ownerSessionId` | Existing Session ID to receive the task, or null to release the current owner. |
| `reason` | Short reason for cancelling a task. |

### Actions

- `create`: Create a new task. Requires title; accepts description and an existing parentTaskId. Records the current Session as creator and starts open/unclaimed.
- `list`: List bounded task summaries, optionally filtered by status. Supports open, active, completed, cancelled.
- `get`: Inspect one task and its bounded child/note summary. Requires taskId.
- `claim`: Claim an unowned task for the current Session. A task owned by another Session is not transferred. Same-owner retries return the current task; a fresh claim sets active.
- `assign`: Assign or transfer a task to an existing Session, or release its owner. Creator or current owner may assign; targets resolve through the real Session catalog. Null releases ownership and sets open; a target sets active. An authored short note records each transfer. Optional notifySession defaults false; true sends a bounded ordinary notification after commit, with pending/sent/failed/skipped state. Release with notification is rejected; self-target is skipped without warning. Successful/pending same-owner retries do not resend, including after reopen; failed delivery may be retried explicitly. Notification failure returns a warning without undoing assignment.
- `update`: Update an owned or otherwise permitted task description, status, or progress note. Requires at least one change; only the owner, or creator when unclaimed, may update. Status accepts only open/active and never releases ownership.
- `complete`: Mark a task completed with an optional result summary. Only the owner, or creator when unclaimed, may complete. After commit, the shared service sends a normal inter-session notification to the creator. Delivery failure returns a warning without undoing completion. Self completion records skipped without a redundant self-send or warning. Pending/sent/failed/skipped state survives restart; repeated completion never resends. No background notification retry runs.
- `cancel`: Cancel a task with an optional reason. Creator or owner may cancel; reason is recorded as an authored note.

Unknown actions, unsupported keys and invalid values fail before effect. Completed/cancelled tasks reject every mutation, including claim, repeated completion/cancellation and attempts to reopen. Mutation results include the current task/owner/status; authority and terminal-state errors include current owner/status and the relevant conflict.

## Child attachment and WebUI

`create_child_session.taskId` uses the approved property description: “Optional existing task ID to attach the new Session to. If the task has no owner, the new Session claims it; if another Session owns it, creation fails.” A Main-owned serial service lane prevents supported task mutations from racing child creation: preflight rejects nonexistent, terminal or owned tasks before child effects, then binds the actual created child as owner and records a link note before initial delivery. No Session is created automatically by the task tool. The existing child creation hint includes task-linked completion guidance instead of routine manual reporting; it does not create an extra history/queue task. Non-task children keep ordinary reporting.

Authenticated WebUI routes reuse the same TaskService; no separate role/identity system or realtime stream is introduced. Ordinary token-authenticated WebUI has management access to all Sessions. POST create requires an explicit existing `sessionId`; other writes may select one explicitly or default to the task owner/creator. This is a management operation target, not an identity inferred from authentication. Shared creator/owner permissions still apply, and results return the resolved `sessionId`.

- GET `/api/tasks?status=&limit=` returns bounded summaries, total/omitted; limit is 1–50.
- GET `/api/tasks/:id` returns task and bounded child/note details.
- POST `/api/tasks` creates; POST `/api/tasks/:id/claim`, `/assign`, `/complete`, `/cancel` use the matching action.
- PATCH `/api/tasks/:id` updates description/note/open-or-active status.

Bodies cannot override route action/taskId or supply arbitrary creator identity. Task errors have stable codes and HTTP 400/403/404/409; unexpected failures return a safe generic 500, without internal paths.

## Tests

`taskStore.test.ts` exercises the coordinator/executor lifecycle, permission and terminal-state boundaries, simultaneous SQLite connections with one claim winner, immutable parent relationships, fresh-process persistence, bounded list/get output and argument validation. `tools/taskTools.test.ts` checks the single schema/placement, direct/unified/Worker facade behavior, context-derived identities, unchanged Session state and generic authorization at both dispatch and Main effect boundaries.

## Design decisions

### D-tasks-small-session-owned-work

[2026-10-07] Use one builtin with create/list/get/claim/assign/update/complete/cancel actions for explicit Session-coordinated work, not a scheduling, review or workspace platform. Creator/owner identities come from ToolContext. ParentTaskId is immutable and may reference only an existing task at creation, so the supported interface cannot construct self-links or cycles. Tasks do not mutate Session semantic ownership, history or lifecycle state. Completion notification uses ordinary inter-session delivery.
