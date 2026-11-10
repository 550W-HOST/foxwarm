---
name: agent-management
description: "Configure Foxwarm Agents: creation, local tool rules, inheritance, placement, memory layout and templates for restricted workers or channel assistants; plan migration or cleanup. Use for Agent lifecycle, not routine edits to a known memory file."
---

# Agent management

Use this entry to choose an operation, then read only the linked section. Routine memory edits with known tools need nothing beyond this page.

## Essential boundaries

- An **Agent** owns long-lived memory, an Agent directory, memory inheritance, local tool rules and placement defaults. A **Session** is one conversation of an Agent. A **Node** is where tools run; a **Provider** is the driver that lists or creates Nodes.
- Memory inheritance shares instructions only. It grants no authority and creates no reporting relationship.
- An Agent created by a model records its creator Agent. Only Agents above it on that creator chain, or an administrator, can change its local rules; it can inherit memory only from that chain; and its creator cannot be deleted while it exists. See [creation](references/OPERATIONS.md#create-an-agent).
- What a Session may do is decided by the global tool policy plus every Agent-local rule layer on its Agent's creator chain. Placement (`defaultNode`, a Session's `node`) chooses where tools run and grants nothing.
- Containment comes from the environment a Node runs in: a container, VM or separate machine. Tool rules decide which tools reach that environment; they are not an OS or network sandbox.
- Legacy Agent isolation has been [retired](../../docs/code-index/modules/tools-and-permissions.md#d-tools-legacy-isolation-deprecation). Restrict an Agent with local rules and a `defaultNode`. Agents that were isolated are [migrated at startup](references/OPERATIONS.md#legacy-isolated-agents).
- Tools are for agents; `/agent`, `/session` and `/node` commands are for users. Do not send command-shaped text instead of calling a tool.
- Deleting an Agent is a user command with confirmation. Check what depends on the Agent first.

## Choose a workflow

| Task | Read when needed |
| --- | --- |
| Create an Agent | [Create an Agent](references/OPERATIONS.md#create-an-agent) |
| Restrict an Agent, for example a delegated worker or a chat-facing assistant | [Restrict an Agent](references/OPERATIONS.md#restrict-an-agent) and its [templates](#templates) |
| Run delegated work in a disposable environment | `node-setup`: the container Provider and the development workflow |
| Choose where an Agent's Sessions run | [Placement](references/OPERATIONS.md#placement) |
| Decide where knowledge belongs | [Where knowledge belongs](references/OPERATIONS.md#where-knowledge-belongs) |
| Edit memory, or make another Session use a change | [Memory edits and snapshot refresh](references/OPERATIONS.md#memory-edits-and-snapshot-refresh) |
| Change inheritance | [Inheritance](references/OPERATIONS.md#inheritance) |
| Rename or move Sessions, or replace an Agent | [Moves and migration](references/OPERATIONS.md#moves-and-migration) |
| Remove a Session or an Agent | [Deletion](references/OPERATIONS.md#deletion) |
| Handle an existing isolated Agent | [Legacy isolated Agents](references/OPERATIONS.md#legacy-isolated-agents) |
| Set up collaboration rules for Agents that delegate | [Collaboration patterns](references/COLLABORATION-PATTERNS.md) |

## Templates

Starter files live in [`references/memory-templates/`](references/memory-templates/). Memory templates are written as the target `MEMORY.md`; replace the `<...>` placeholders. A `.rules.json` file is the complete `rules` array for `create_agent`.

| Template | Use for |
| --- | --- |
| `coordination-base.md` | A shared base Agent that other Agents inherit: the delegation choices that differ per installation |
| `specialized-project.md`, `research.md`, `operations.md` | Domain Agents |
| `restricted-worker.md` + `restricted-worker.rules.json` | One shared worker Agent; each assignment gets its own Node, Session and Task |
| `channel-assistant.md` + `channel-assistant.rules.json` | An Agent that answers a chat channel from a Node reserved for it |

## Routine memory edits

Use the memory tools for the current Agent. For another Agent, use ordinary file tools on its `memory/` directory if your permissions allow, or ask the user.

An edit made in this conversation normally needs no snapshot refresh: its content is already here. If another Session needs the change now, send it a short message with the delta. Refresh an exact Session only when it must rebuild its prompt immediately or the user asks; do not broadcast refreshes.

## Related skills

- `access-control`: rule syntax, the global policy, Agent-local layers in detail, entry identities and inbound MCP.
- `node-setup`: pairing and bootstrapping Nodes, Providers including disposable containers, and the development workflow for delegated work.
- `agent-skill-creator`: when a reusable procedure belongs in a skill rather than in memory.
