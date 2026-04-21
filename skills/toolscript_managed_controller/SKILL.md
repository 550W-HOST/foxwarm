---
name: toolscript_managed_controller
description: Use ToolScript managed-session primitives and background controller runs when one session should temporarily control another session's inbound work.
---

# toolscript_managed_controller

Use this skill when you want a ToolScript run to act like a **controller** for another session.

## Fast start

Before grepping tests, read:

- `examples/toolscript/managed_controller_basic.py`
- `examples/toolscript/README.md`

Small helper worth knowing immediately:

- `step_and_release_managed_session(...)`

As with normal ToolScript automation, first verify the target session and the surrounding tool/runtime flow in the regular agent loop, then encode the known controller flow into a script.

This is the skill for:

- opening managed control of a child/related session
- waiting for inbound work to arrive on that managed session
- stepping the managed session in a controlled way
- releasing control cleanly
- understanding how this interacts with **background ToolScript runs**

## Canonical examples

If your task is “wait for one managed event, step once, then release”, start by copying the managed controller example.

## Core idea

A managed session is a session whose normal inbound work is temporarily diverted into a **managed inbox** instead of auto-running immediately.

A ToolScript controller can then:

1. `open_managed_session(...)`
2. `wait_for_managed_event(...)`
3. `session_step(...)`
4. repeat or `release_managed_session(...)`

The intended modern direction is:

- `ownerSessionId` = permission / ownership anchor
- `controllerRunId` = actual background ToolScript run holding the controller role

So think in terms of **controller runs**, not only “one foreground session babysitting another”.

## Main host functions inside ToolScript

### `open_managed_session(session_id)`

Opens managed control of the target session.

Returns structured data including:

- `sessionId`
- `ownerSessionId`
- `controllerRunId?`
- `leaseId`
- `revision`
- `pendingInboxCount`

Important:

- session/isolation permission checks still apply
- self-management is rejected
- stale/orphaned leases are reclaimed by recovery logic

### `wait_for_managed_event(session_id, lease_id, expected_revision=None, run_mode=None, inbox_order=None)`

This pauses the ToolScript run until the managed session receives new work and the controller run is resumed.

Typical use:

```python
event = wait_for_managed_event(child_id, lease["leaseId"], lease["revision"])
```

When this happens in a background ToolScript run:

- the run enters `status="waiting"`
- `waitingReason="managed_event"`
- the system can resume that controller run when the managed inbox receives new work

### `session_step(...)`

Runs one controlled step of the managed session.

Important arguments:

- `session_id`
- `lease_id`
- `expected_revision?`
- `run_mode?`
- `inbox_order?`
- `message` / `parts`

Important result fields:

- `revision`
- `runMode`
- `inboxOrder`
- `yieldReason`
- `consumedPendingInboxCount`
- `pendingInboxCount`
- `newMessages`

### `release_managed_session(...)`

Releases the lease and returns queued control to the session itself.

Pending inbox work is replayed back into the normal queue when appropriate.

### `step_and_release_managed_session(...)`

Use this helper for the very common pattern:

- step once
- then immediately release the lease

Example:

```python
result = step_and_release_managed_session(
    child_id,
    lease["leaseId"],
    event["revision"],
    run_mode="idle",
    inbox_order="before",
    message="Controller handled this request.",
)
```

It returns the `session_step(...)` result plus:

- `releasedPendingInboxCount`

By default the helper keeps the result light. If you really need the full `newMessages` payload, pass `include_messages=True`.

## `runMode`, `inboxOrder`, `yieldReason`

### `runMode`

Currently supported:

- `idle`
  - run to idle
- `tool`
  - stop after the first completed tool batch

### `inboxOrder`

Currently supported:

- `before`
  - pending inbox first, then manager input
- `after`
  - manager input first, then pending inbox
- `ignore`
  - do not consume pending inbox in this step

### `yieldReason`

Current values:

- `idle`
- `tool`
- `no-work`

Use this to understand **why the step stopped**.

## Minimal controller example

```python
child_id = args["child_session_id"]

lease = open_managed_session(child_id)

event = wait_for_managed_event(
    child_id,
    lease["leaseId"],
    lease["revision"],
)

result = step_and_release_managed_session(
    child_id,
    lease["leaseId"],
    event["revision"],
    run_mode="idle",
    inbox_order="before",
    message="Controller processed your request.",
)

result
```

## Typical outer run pattern

For controller-style automation, prefer starting the script as a **background ToolScript run**:

- `start_toolscript_run({filePath, args})`
- or `run_script({filePath, args, mode:"background"})`

Why:

- the run can persist independently of the immediate foreground reply
- the managed child can wake the controller run later
- the controller run becomes the more natural runtime holder of the lease

## Important current constraints

- this is still a low-level primitive layer, not a polished high-level manager DSL
- there is no `ask_user(...)`
- stop conditions are still limited (`idle`, `tool`)
- owner session still matters as the permission/ownership anchor even though controller runs now matter much more for runtime control
- not every future ergonomic helper/sugar exists yet

## Permission / safety notes

- managed control does **not** bypass isolation rules
- only permitted owner/target relationships can manage each other
- if a controller run disappears or a lease goes stale, recovery logic can reclaim the managed session
- pending managed inbox work can wake the owner and, when available, the controller run

## Practical advice for agents

When you use these primitives, do not jump straight into a huge loop.

Prefer this sequence:

1. identify the exact target session
2. open the lease
3. wait for one event
4. step once with a very small action
5. inspect the structured result
6. only then expand into a loop or a richer controller

That makes it much easier to debug revisions, inbox ordering, and stopping behavior.