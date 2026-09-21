---
title: Agents, Sessions, and memory
description: Learn how Foxwarm separates Agent identity, Session threads, curated memory, and archived context.
---

An Agent keeps reusable instructions and project knowledge. Its Sessions hold the individual conversations and tasks.

## Agent

An **Agent** is a durable workspace and memory container. Its curated Markdown memory lives under:

```text
agents/<agent>/memory/
```

Use Agent memory for instructions, preferences, project facts, and confirmed decisions that should carry across Sessions. An Agent can inherit memory from another Agent. That inheritance is separate from parent and child relationships between Sessions.

## Session

A **Session** is a runnable conversation thread attached to an Agent. It owns its history, queue, selected model, current Node, and other runtime state. One Agent can have a main project Session and separate threads for review or experiments, all using the same Agent memory.

Common commands:

```text
/session list
/session new
/session fork
/session archive
/model
```

## Where context lives

| Context | Use it for | Where to find it |
| --- | --- | --- |
| Agent memory files | Curated, long-lived knowledge and instructions | `agents/<agent>/memory/` |
| Session history | The current conversation and tool results | The Session timeline |
| Archive and recall | Earlier messages and compacted source material | Recall tools and expanded context blocks |
| Vector search | Finding earlier context by topic | Optional [history search](/docs/history-search/) |

Keep routine progress in the Session instead of copying it into Agent memory. Foxwarm can compact older Session history into traceable layers and recall archived source when needed.

## Child Sessions

A child Session has a parent Session and is useful for a bounded parallel task or review. It still belongs to an Agent. Session relationships organize coordination, while Agent inheritance controls shared memory.

## Choose an Agent or Session

- Create a new Session when the Agent and its project knowledge should stay the same, but the conversation needs its own thread.
- Create a new Agent for a separate workspace, set of long-lived instructions, permission policy, or role.
- Fork a Session when a new thread should start with the current visible context and archive lineage up to that point.
- Archive a finished Session to remove it from normal navigation. Archiving does not physically delete its data.

For the complete command surface and persistence details, see [Session Management](https://github.com/550W-HOST/foxwarm/blob/main/docs/session-management.md) and [Multi-Agent Guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/multi-agent.md).
