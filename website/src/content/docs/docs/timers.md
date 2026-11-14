---
title: Timers
description: Have a Session check in, report or follow up on a schedule, once or repeatedly.
---

A timer delivers a message to a Session at a set time or on a recurring schedule. The agent then handles it like any other message: it can check something, run a job, and report to you, in the WebUI or in an attached [chat](/docs/channels/).

Because Foxwarm runs on your server, timers keep firing when your browser is closed.

## Ask the agent

The simplest way is to describe what you want:

```text
Every weekday at 9:00, check last night's CI runs on build-box and post a
two-line summary here. Only mention failures in detail.
```

The agent creates the timer with its timer tools and can list, change or delete it later. Timers belong to a Session; each one is shown with its ID when listed.

## Commands

| Command | Effect |
| --- | --- |
| `/timer create --after-seconds <seconds> <message>` | Once, after a delay |
| `/timer create --at <ISO-time> <message>` | Once, at a time such as `2026-12-01T09:00:00+08:00` |
| `/timer create --cron '<expr>' <message>` | Repeatedly, on a cron schedule with 5 or 6 fields |
| `/timer list` | List this Session's timers |
| `/timer pause <id>` / `/timer resume <id>` | Pause or resume a timer |
| `/timer delete <id>` | Delete a timer |

Cron schedules use the server's local time zone.

## Fresh Session for each run

By default every trigger arrives in the Session that owns the timer, so its history grows with each run. For recurring jobs that do not need that history, add `--new-session`. Each trigger then starts a new Session, optionally in another Agent with `--agent-name <agent>` and with a name prefix from `--session-prefix <prefix>`:

```text
/timer create --cron "0 9 * * 1-5" --new-session --session-prefix ci-report Check last night's CI and report failures.
```

## Scripts without a model turn

A timer can also run a [ToolScript](/docs/tools-skills-mcp/#combine-calls-with-toolscript) instead of sending a message. The script runs for the owning Session without starting a model turn, which suits cheap periodic checks. It can send a message to wake the agent only when something needs attention. Ask the agent to set this up; the `timer-automation` Skill describes the options.
