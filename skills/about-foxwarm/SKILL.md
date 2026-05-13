---
name: about-foxwarm
description: "Explain Foxwarm concepts, setup, and exploration paths: agents, sessions, tools, nodes, skills, channels, WebUI, memory, ToolScript, and where to find docs."
---

# About Foxwarm

Use this skill when the user asks what Foxwarm is, what it can do, or how to continue exploring after first-time setup.

## One-sentence overview

Foxwarm is a lightweight, extensible AI assistant runtime for development workflows. It combines chat, long-term memory, tool calling, agent/session separation, skills, channels, WebUI, and optional remote nodes.

## Core concepts

### Agent

An **agent** is a long-lived workspace and memory container.

An agent stores durable instructions and notes under:

```text
agents/<agent>/memory/
```

Use agents when different long-term roles, projects, memories, or isolation boundaries should stay separate.

### Session

A **session** is a runnable conversation thread bound to an agent.

A session stores runtime history, model selection, current node, queue state, parent/child relations, and other metadata.

Use sessions for individual chats or task threads. One agent can have many sessions.

### Child session

A **child session** is a session linked to a parent session for parallel work such as investigation, testing, review, or research.

Child sessions should explicitly report back to the parent when they finish.

### Tool

A **tool** is an action the assistant can call, such as reading files, editing files, running shell commands, searching memory, sending files, managing sessions, or interacting with nodes.

Tool availability depends on the current session, agent isolation, and node.

### Node

A **node** is an execution host for tools.

- `master` is the default local node where the Foxwarm server runs.
- Remote nodes can run on another machine, in Docker, in a terminal approval UI, in a browser extension, or in a sandbox.
- Nodes are paired with the Foxwarm master and then approved.

Use nodes when tools should run somewhere other than the master process, for example on another machine, inside a sandbox, or inside a browser.

### Skill

A **skill** is a reusable instruction/documentation pack. Skills are usually stored under:

```text
skills/<skill>/SKILL.md
```

The prompt contains a catalog of available skills; full skill documents are loaded on demand.

### Channel

A **channel** is a user-facing message interface such as WebUI, Telegram, Matrix, WeChat Work, or Weixin.

Channels are configured in:

```text
state/config.yaml
```

In current Foxwarm versions, channel edits from WebUI Setup are hot-reloaded: managed channels are stopped and started again without restarting the Foxwarm process.

### Models

Model provider configuration lives in:

```text
state/models.yaml
```

The WebUI OOBE/Setup page can create this file. Foxwarm enters first-time OOBE when `state/models.yaml` is missing.

### Memory

Agent memory is durable markdown stored in the agent's memory directory. It is used to preserve project context, user preferences, and long-term instructions.

Session history is separate from agent memory.

### ToolScript

ToolScript is an automation layer for orchestrating tool calls and managed sessions. Use ToolScript when a workflow needs repeatable multi-step tool automation.

## First things to try after setup

If models are configured and WebUI is open, the user can ask:

- "What can Foxwarm do?"
- "Explain agents, sessions, nodes, tools, skills, and channels."
- "Summarize this repository."
- "Show me available sessions and models."
- "Help me connect a browser node."
- "Help me configure a Telegram channel."
- "Create a project memory note from this README."

## Where to find details

Point users to the repository docs for deeper details:

- `README.md` — install, OOBE, models, channels, and quick start.
- `docs/architecture.md` — runtime architecture and data layout.
- `docs/session-management.md` — sessions, models, nodes, prompt snapshots.
- `docs/multi-agent.md` — agent/session/child-session collaboration.
- `docs/node-client.md` — node bootstrap and pairing.
- `docs/vector-memory.md` — vector memory.
- `examples/toolscript/README.md` — ToolScript examples.

## Answering style

When answering Foxwarm questions:

1. Start with the user's immediate goal.
2. Explain only the concepts needed for that goal.
3. Give exact file paths, WebUI locations, or commands when useful.
4. Mention docs for deeper reading rather than dumping every detail.
5. Keep terminology consistent: agent, session, node, skill, tool, channel.
