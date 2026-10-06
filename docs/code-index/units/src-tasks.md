# Unit: src-tasks

Files: src/taskStore.ts, src/taskStore.test.ts, src/tools/taskTools.ts, src/tools/taskTools.test.ts
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
| `TaskStore.close` | Releases the lazy SQLite connection |
| `tool_task` | Main-local raw implementation that serializes the bounded result into the standard output envelope |

## Storage and output

The Main-owned store opens `state/tasks.sqlite` lazily under the configured data root, using the existing `node:sqlite` API. Its `tasks` table stores task fields, ownership and timestamps; `task_notes` stores append-only progress/cancellation notes with author and timestamp. Tasks never enter Session history or Archive. WAL and a five-second busy timeout permit independent connections; a write transaction holds the lock across the read, authorization check and mutation, preventing two concurrent claim winners. Read transactions keep bounded rows and their omission counts consistent.

IDs use `task_` plus a generated UUID. Titles allow 200 characters; descriptions/results 4,000; notes/reasons 1,000; task-ID inputs 128. `list` returns at most 50 summaries, total and omitted counts, defaulting to open/active tasks. Claimed tasks normally become active, but ownership is independent of open/active status. `get` returns the task, up to 20 immediate child summaries and the latest 10 notes in chronological order, with omitted counts. Full descriptions/results are not duplicated in list/child summaries. Notes remain persisted even when omitted from output.

## Model-facing contract

One builtin `task` is default-injected through the existing per-Session authorization projection and has one schema requiring `action`. It uses Main Management ownership for direct, unified and trusted Worker calls; the Main boundary derives identity from the source context and repeats generic authorization. There is no argument for selecting a creator/owner Session.

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
| `reason` | Short reason for cancelling a task. |

### Actions

- `create`: Create a new task. Requires title; accepts description and an existing parentTaskId. Records the current Session as creator and starts open/unclaimed.
- `list`: List bounded task summaries, optionally filtered by status. Supports open, active, completed, cancelled.
- `get`: Inspect one task and its bounded child/note summary. Requires taskId.
- `claim`: Claim an unowned task for the current Session. A task owned by another Session is not transferred. Same-owner retries return the current task; a fresh claim sets active.
- `update`: Update an owned or otherwise permitted task description, status, or progress note. Requires at least one change; only the owner, or creator when unclaimed, may update. Status accepts only open/active and never releases ownership.
- `complete`: Mark a task completed with an optional result summary. Only the owner, or creator when unclaimed, may complete.
- `cancel`: Cancel a task with an optional reason. Creator or owner may cancel; reason is recorded as an authored note.

Unknown actions, unsupported keys and invalid values fail before effect. Completed/cancelled tasks reject every mutation, including claim, repeated completion/cancellation and attempts to reopen. Mutation results include the current task/owner/status; authority and terminal-state errors include current owner/status and the relevant conflict.

## Tests

`taskStore.test.ts` exercises the coordinator/executor lifecycle, permission and terminal-state boundaries, simultaneous SQLite connections with one claim winner, immutable parent relationships, fresh-process persistence, bounded list/get output and argument validation. `tools/taskTools.test.ts` checks the single schema/placement, direct/unified/Worker facade behavior, context-derived identities, unchanged Session state and generic authorization at both dispatch and Main effect boundaries.

## Design decisions

### D-tasks-small-session-owned-work

[2026-10-07] Use one builtin with create/list/get/claim/update/complete/cancel actions for explicit Session-coordinated work, not a scheduling, review or workspace platform. Creator/owner identities come from ToolContext. ParentTaskId is immutable and may reference only an existing task at creation, so the supported interface cannot construct self-links or cycles. No task operation changes Session ownership, history, goal or lifecycle state.
