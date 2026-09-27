---
name: timer-automation
description: "Create, inspect, update, and delete Foxwarm session timers, including one-shot and cron schedules. Load this before using timer tools."
---

# Timer Automation

Use this skill when you need to schedule future work for a session, inspect existing timers, modify a timer without recreating it, or remove a timer.

Timer tools are intentionally **not injected into the default model-facing tool schema**. After loading this skill, use `search_tools` / `call_tool` with the builtin timer tool names below.

## Tools

- `create_timer` — create a one-shot or recurring timer.
- `list_timers` — list timers for the current session, or for `sessionId` when you are allowed to manage that session.
- `update_timer` — update an existing timer in place.
- `delete_timer` — delete a timer.

There is no separate `list_timer` tool. The tool name is plural: `list_timers`.

## Examples

Create a one-shot reminder in this session:

```json
{
  "toolId": "builtin:create_timer",
  "args": {
    "afterSeconds": 3600,
    "message": "Check whether the long build finished and report status."
  }
}
```

Create a recurring timer that opens a new session on every firing:

```json
{
  "toolId": "builtin:create_timer",
  "args": {
    "cron": "0 9 * * 1-5",
    "message": "Run weekday morning maintenance checks.",
    "newSession": true,
    "sessionPrefix": "weekday-maintenance"
  }
}
```

Update only the message of an existing timer:

```json
{
  "toolId": "builtin:update_timer",
  "args": {
    "timerId": "abcd1234",
    "message": "Use the updated checklist, then report findings."
  }
}
```

Reschedule an existing timer:

```json
{
  "toolId": "builtin:update_timer",
  "args": {
    "timerId": "abcd1234",
    "cron": "0 0 L * *"
  }
}
```

Delete a timer:

```json
{
  "toolId": "builtin:delete_timer",
  "args": {
    "timerId": "abcd1234"
  }
}
```

## Scheduling Rules

For both `create_timer` and schedule-changing `update_timer`, pass exactly one schedule field:

- `afterSeconds`: positive number of seconds from now; creates a one-shot timer.
- `at`: absolute future time as an ISO string or epoch milliseconds; creates a one-shot timer.
- `cron`: recurring schedule expression.

For `update_timer`, omit schedule fields when you only want to change metadata such as `message`, `newSession`, `sessionPrefix`, or `agentName`. If you provide a schedule, provide only one of `afterSeconds`, `at`, or `cron`.

`newSession=true` means every firing creates a new session instead of delivering into the owner session. `sessionPrefix` and `agentName` are only meaningful with `newSession=true`.

## Cron Syntax

Foxwarm timer cron scheduling uses the installed `node-schedule` package, which parses cron strings with `cron-parser`.

Accepted shape:

```text
*    *    *    *    *    *
┬    ┬    ┬    ┬    ┬    ┬
│    │    │    │    │    └ day of week (0-7; 0 or 7 is Sunday; names like MON are accepted)
│    │    │    │    └───── month (1-12; names like JAN are accepted)
│    │    │    └────────── day of month (1-31, or L)
│    │    └─────────────── hour (0-23)
│    └──────────────────── minute (0-59)
└───────────────────────── second (0-59, optional)
```

Useful supported forms include:

- Wildcards and lists: `*`, `1,2,3`
- Ranges: `1-5`
- Steps: `*/15`, `1-10/2`
- Month/day aliases: `JAN`, `MON`
- `?` in day-of-month/day-of-week fields
- `#` for nth weekday of the month, e.g. `0 0 * * 2#3` for the third Tuesday
- Predefined macros supported by `cron-parser`: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`
- `L` is supported by the actual parser/runtime in this project:
  - day-of-month `L`: last day of the month, e.g. `0 0 L * *` or `0 0 0 L * *`
  - day-of-week `1L`-`7L`: last given weekday of the month, e.g. `0 0 0 * * 1L` for the last Monday

Unsupported / caveats:

- `W` (nearest weekday) is not supported.
- `@reboot` is not supported.
- Older `node-schedule` README text may say `L` is unsupported, but this project's installed runtime (`node-schedule` with `cron-parser`) accepts and schedules `L`; Foxwarm has regression tests for this behavior.

If a cron expression is invalid, `create_timer` / `update_timer` fail with a clear invalid cron error instead of creating a broken timer.
