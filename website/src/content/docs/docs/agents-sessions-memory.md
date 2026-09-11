---
title: Agents, Sessions, and memory
description: Understand Foxwarm's separate Agent identity, Session threads, curated memory, and archived context.
---

Foxwarm separates long-lived identity from runnable conversation threads.

## Agent

An **Agent** is a durable workspace and memory container. Its curated Markdown memory lives under:

```text
agents/<agent>/memory/
```

Use Agent memory for stable instructions, preferences, project facts, and confirmed decisions that should remain useful across Sessions. An Agent can inherit memory from another Agent, but inheritance does not create a parent/child Session relationship.

## Session

A **Session** is one runnable conversation thread attached to an Agent. It owns its history, queue, selected model, current Node, and other runtime state. One Agent can have several Sessions—for example, a main project thread, a review thread, and an experiment—while sharing the same Agent memory.

Common commands:

```text
/session list
/session new
/session fork
/session archive
/model
```

## Three kinds of remembered context

| Context | Purpose | Ownership |
| --- | --- | --- |
| Agent memory files | Curated, long-lived knowledge and instructions | `agents/<agent>/memory/` |
| Session history | The active, model-visible conversation and tool loop | Persisted `Session.history` |
| Archive and recall | Older source context, lineage, and audit history | SQLite archive |
| Vector memory | Optional semantic retrieval over archived context | Derived index; disabled by default |

These are related but not interchangeable. Do not write routine progress into Agent memory just to preserve a long chat. Foxwarm can compact older Session history into traceable layers and recall archived source when needed.

## Child Sessions

A child Session is a Session with a parent relationship, useful for a bounded parallel task or review. It is not automatically a new Agent. Parent/child relationships organize coordination; Agent inheritance organizes memory.

## Practical organization

- Create a new **Session** when the identity and durable project knowledge should stay the same but the thread should be separate.
- Create a new **Agent** when the workspace, long-term instructions, permissions, or role should be distinct.
- Fork a Session when the new thread should begin with the current thread's visible context and archive lineage up to that point.
- Archive finished Sessions to remove them from normal navigation without treating archive as physical data deletion.

For the complete command surface and persistence details, see [Session Management](https://github.com/550W-HOST/foxwarm/blob/main/docs/session-management.md) and [Multi-Agent Guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/multi-agent.md).
