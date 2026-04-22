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

## Default first path

For a first controller script, use this as the default path:

1. start the script as a **background** ToolScript run
2. `open_managed_session(...)`
3. `wait_for_managed_event(...)`
4. `step_and_release_managed_session(...)`

Recommended defaults for that first step:

- `run_mode="idle"`
- `inbox_order="before"`
- process one event
- release immediately after that step

This is the skill for:

- opening managed control of a child/related session
- waiting for inbound work to arrive on that managed session
- stepping the managed session in a controlled way
- releasing control cleanly
- understanding how this interacts with **background ToolScript runs**

## Canonical examples

If your task is “wait for one managed event, step once, then release”, start by copying the managed controller example.

## Canonical example

If your task is “wait for one managed event, step once, then release”, start by copying the managed controller example.

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

This is the lower-level primitive. For the most common first-time pattern, prefer `step_and_release_managed_session(...)`.

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

Use this helper as the default first choice for the very common pattern:

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

For most first scripts, this is the main entry you want after `wait_for_managed_event(...)`.

## `runMode`, `inboxOrder`, `yieldReason`

### `runMode`

Currently supported:

- `idle` *(default recommendation)*
  - run to idle
- `tool`
  - stop after the first completed tool batch

### `inboxOrder`

Currently supported:

- `before` *(default recommendation)*
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

## Mental model

A managed session is a session whose normal inbound work is temporarily diverted into a **managed inbox** instead of auto-running immediately.

Useful implementation notes:

- `ownerSessionId` is the permission / ownership anchor
- `controllerRunId` is the background ToolScript run currently holding the controller role

So in normal use, think in terms of **one controller run handling one managed session for one step or small sequence**, then releasing it.

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

If the first small step works cleanly, then expand into a richer controller. That keeps revisions, inbox ordering, and stopping behavior much easier to understand.