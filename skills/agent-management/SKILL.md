---
name: agent-management
description: "Use for Foxwarm agent management tasks: creating agents, editing agent memory, refreshing snapshots, understanding agent vs session boundaries, changing isolation/inheritance, and safely migrating or cleaning up agents."
---

# agent-management

Use this skill when the task is about **agent lifecycle / maintenance**, not just one session.

Typical cases:

- understanding what an agent is vs what a session is
- creating a new agent cleanly
- deciding where to put long-term instructions or project memory
- bootstrapping collaboration rules and starter memory for agents that use child sessions
- editing an agent's memory and knowing when snapshots must be refreshed
- binding or unbinding an agent to an isolated node
- moving work from one agent/session layout to another
- cleaning up an old agent safely
- explaining why direct agent rename is not exposed as a trivial operation

## First: tools vs commands

This distinction matters.

### Tools are agent-facing

These are the things an agent can normally use directly when they are in the tool surface, for example:

- `create_agent`
- `create_session`
- `move_session`
- `set_agent_inherit`
- `set_agent_isolated`
- `update_session_snapshot`
- `list_agents`
- `session` (status by default, list with `action: "list"`)
- `read_memory` / `write_memory` / `edit_memory` / `apply_patch_memory` for the **current** agent
- ordinary file tools for other paths, if your current permissions allow that access

### Commands are user-facing

Commands like these are primarily for the **user** to run in chat/WebUI:

- `/agent ...`
- `/session ...`
- `/node ...`

Do **not** assume you can or should execute those commands yourself as an agent.

Default rule:

- if there is a suitable **tool**, prefer the tool
- if a workflow depends on a **user command surface**, tell the user the exact command to run
- do **not** treat "simulate a WebUI request so I can send `/agent ...` myself" as the normal path

That kind of command simulation is possible in principle through awkward indirect routes, but it is **not recommended** for ordinary agent workflows.

## What an ordinary agent normally sees

An agent session normally works from a prompt snapshot assembled from:

1. framework-level shared system memory
2. inherited agent memory, if the agent inherits from another agent
3. the current agent's own memory files
4. a visible skills catalog

Important details from current implementation:

- the skills catalog injected into the snapshot is only a **catalog/summary**
- full skill documents are loaded on demand with `skill({ action: "load", skillName: ... })`
- `skill({ action: "load", ... })` returns the skill entry and may list supporting resource paths; those resources are not read until needed
- session snapshots are cached per session, so editing memory on disk does not always change an already-open session immediately
- the prompt snapshot also includes runtime hints such as the current agent folder and context-recall guidance

## Progressive disclosure: where knowledge belongs

Use progressive disclosure so future sessions see the right amount of knowledge at the right time:

1. **Framework/system prompt** — universal rules every agent must know. Keep tiny and generic.
2. **Agent memory** — always-needed stable behavior, repeated user preferences, durable environment facts, confirmed decisions, and short pointers. This is injected into prompt snapshots.
3. **Agent docs** — detailed analysis, runbooks, historical notes, design writeups, and artifacts. These are available on disk but not injected by default.
4. **Skills** — reusable workflows or capability packages. Only name + description are shown in the catalog until `skill({ action: "load", ... })` is called.
5. **Skill resources** — references, scripts, assets, examples, evals, or other supporting files listed or linked by the skill entry. Read these only when needed.

When deciding where to put information, ask:

- Should every session under this agent behave differently because of this fact? Put a short durable version in memory.
- Is it reusable across tasks or agents as a procedure/capability? Make or update a skill.
- Is it detailed evidence, historical context, a long runbook, or an artifact? Put it in docs and link from memory or a skill.
- Is it a helper file for one skill? Put it under that skill as a resource and link or list it from `SKILL.md`.

If a directory contains `SKILL.md`, treat it as a skill boundary. Files and subdirectories inside it are supporting resources for that skill; do not expect nested `SKILL.md` files inside references, examples, scripts, docs, or assets to appear as separate catalog entries.

## Special file: `agents/00_SYSTEM.md`

This file is special.

Current prompt assembly injects:

- `agents/00_SYSTEM.md`

as a framework-level system block for **all agents**.

Older installations may still rely on the legacy fallback path:

- `agents/main/memory/00_SYSTEM.md`

Also important:

- default agent memory loading explicitly skips `00_SYSTEM.md` in per-agent memory directories
- that means ordinary agents should **not** create their own per-agent `00_SYSTEM.md` expecting it to behave like the global one

So the guidance is:

- treat `agents/00_SYSTEM.md` as the framework/global system layer
- treat `agents/main/memory/00_SYSTEM.md` as a legacy compatibility fallback, not the preferred location for new installs
- for agent-specific instructions, use normal memory files such as:
  - `MEMORY.md`
  - `SOUL.md`
  - `USER.md`
  - or other clearly named `.md` files
- do **not** recommend adding a custom `00_SYSTEM.md` under another agent unless you are intentionally changing framework behavior and understand the prompt assembly code

## Mental model: agent vs session

Foxwarm keeps **agent** and **session** separate:

- **agent** = long-lived workspace + memory container
- **session** = runtime conversation thread bound to an agent

That means:

- renaming or moving a **session** is comparatively lightweight
- changing an **agent** is heavier because agent identity is tied to workspace paths, memory location, metadata, and all sessions under it

Node selection and isolation are also separate:

- a session's `currentNode` selects where ordinary runtime tools execute
- `create_child_session({ suffix: "worker", node: "node-id", confirmation: "Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?\n<replace this with your own non-empty review; do not copy this placeholder verbatim>\nI have completed the check, found no issue, and confirm this inter-agent handoff should proceed." })` sets `currentNode` but does not make the child isolated. Keep and complete `confirmation` only when the current tool schema requires it; otherwise it may be omitted
- isolation is agent-level; an isolated agent binds all of its sessions to one non-master node and narrows their permissions

If different workers need different real isolation boundaries, use different
temporary agents, not several sessions under one agent. Load `isolated-worker`
for the reusable parent-linked workflow.

## Collaboration and memory bootstrapping

If you are creating or configuring an agent that may use child sessions, do not improvise its collaboration rules from scratch.

Read the reference docs next to this skill first:

- `references/COLLABORATION-PATTERNS.md` — organizer/executor defaults, role detection, fork/non-fork/reuse guidance, handoff checklists, tunable preferences, and memory hygiene.
- `references/memory-templates/` — copyable starter memory files for shared base agents and specialized agents.

These reference files are intentionally not part of the normal `skill({ action: "load", ... })` payload. Keep this `SKILL.md` as the short entry point; read references explicitly when configuring agent memory.

Recommended default: use an **Organizer / Executor** pattern inside each agent. The main/direct session coordinates scope, ownership, parallelism, and user-facing decisions; child sessions execute bounded tasks and report back through the required reply path.

For multi-agent setups, put generic Organizer / Executor rules in a shared/base agent and let specialized agents inherit them. Each specialized agent should keep only domain-specific durable memory in its own memory files.

Keep agent memory small. Long session history is already preserved by layered context, compaction summaries, archives, and `recall`; do not copy routine progress logs into `MEMORY.md`. As a rule of thumb, if an agent's `MEMORY.md` grows past about **500 lines**, it is probably carrying too much. Move reusable processes into skills, move knowledge/artifact notes into `agent-dir/docs/`, and keep only short pointers plus always-needed rules in memory.

## What isolated agents are for

An isolated agent is mainly a **risk-containment** setup.

Use it when you want an agent's runtime work to happen on a separate non-master node instead of freely on `master`.

Typical cases:

- the agent will handle tasks that may be risky
- the agent is attached to an external group chat or channel that may contain untrusted content
- prompt-injection exposure is plausible and you want a narrower execution boundary

The point is not "perfect safety".
The point is to reduce blast radius by moving runtime execution onto a bound node and narrowing what the agent can still do on `master`.

## Isolated-agent boundary

If an agent is isolated, the boundary is:

- it can use the tools available on its **bound isolated node**
- it can still do limited host-side work on `master`
- on `master`, that limited work is mainly its own `memory/` plus files inside its own agent directory
- it cannot switch to other nodes
- it cannot operate on unrelated nodes
- it cannot read or edit other agents' directories on `master`

So for an isolated agent, the mental model is:

- runtime work: bound node
- durable local files on `master`: own agent area only
- other nodes / other agent directories: not allowed

Isolation does not create or reserve a VM/container. The operator supplies that
environment, and binding does not prevent another agent/session from sharing the
same node.

Coordinator communication is intentionally narrow: the supported isolated
worker pattern uses an explicit parent/child session relation. Builds that
support parent-linked cross-agent isolation allow messaging only across that
direct link; unrelated cross-agent access remains denied. Older builds with a
blanket cross-agent isolated deny cannot complete that workflow and will reject
the initial `send_to_session` call.

## Common workflow: create a new agent

### If you are using tools

Prefer the agent-facing tool path when available:

- `create_agent`

Useful fields in current implementation include:

- `agentName`
- `inherit` — shared-memory parent agent
- `isolatedNode` — bind the agent to a non-master node immediately
- `createMainSession`

If you also need a separate extra session afterward, use:

- `create_session`

For an isolated worker controlled by the current session, do not create an
unrelated isolated agent main session and assume it can report back. The intended
shape is:

1. `create_agent` with `isolatedNode` and `createMainSession:false`
2. `create_session` under that agent with `parentSessionId` set to the coordinator
3. `send_to_session` to deliver the task

The bundled `isolated-worker` skill packages this sequence in a ToolScript with
read-only validation mode and partial-failure recovery reporting. It can also
optionally compose a configured provider `ensure` plus exact read-only inspect
for one existing worktree before creating the agent/session.

### If you are guiding the user

Tell the user to run a command such as:

```text
/agent create <name>
/agent create <name> --isolated <node-id>
```

Remember: those `/agent ...` examples are **user-facing commands**, not your default execution path as an agent.

## Common workflow: write memory for an agent

### For your current agent

Use the dedicated memory tools:

- `read_memory`
- `write_memory`
- `edit_memory`
- `apply_patch_memory`
- `delete_memory`

These are the safest/default path for the current agent's memory.

### For another agent

There is no dedicated "write some other agent's memory" helper tool.

So if you truly need to edit another agent's memory, the realistic options are:

- use ordinary file tools against that agent's memory path **if your permissions allow it**
- or ask the user to do the change

Typical target location would be:

- `agents/<agent-name>/memory/*.md`

Be careful not to over-assume permissions. Some isolated or restricted contexts may not allow this.

## Common workflow: refresh snapshots after memory changes

A session does not always re-read memory files instantly just because a file changed on disk.

Foxwarm stores a composed prompt snapshot for each session.

So after editing another agent's memory, inherit settings, or visible skills, an already-existing session may need a snapshot refresh to pick up the latest state immediately.

### Agent-facing path

Use the tool:

- `update_session_snapshot`

### User-facing path

Tell the user to run:

```text
/session update-snapshot [session-id]
```

### When snapshot refresh is especially important

- one session edits another agent's memory files
- you changed inheritance with `set_agent_inherit`
- you changed isolation and want existing sessions to rebuild prompt/runtime state cleanly
- skill visibility changed and an already-open session should see the updated catalog now

## Common workflow: set or clear agent inheritance

### Agent-facing path

Use:

- `set_agent_inherit`

### User-facing path

Tell the user to run:

```text
/agent inherit <agent> <parent-agent|none>
```

Use this when you want shared memory from one agent to appear in another agent's default prompt snapshot.

## Common workflow: bind or unbind an agent to a node

### Agent-facing path

Use:

- `set_agent_isolated`

### User-facing path

Tell the user to run:

```text
/agent isolated <agent> <node-id>
/agent isolated <agent> off
```

Important behavior:

- isolation is **agent-level**
- the agent's sessions inherit that isolation automatically
- changing isolation updates affected sessions accordingly
- an isolated session cannot switch itself to some other arbitrary node for normal work
- if a different node is really required, the right model is usually to change the agent's isolation binding deliberately, not to let the isolated agent use other nodes directly
- binding currently does not guarantee that the node is online or exclusively assigned; verify with `node({ action: "list" })` before starting work

## Common workflow: move work between agents/sessions

Be precise about whether you are moving a **session** or replacing an **agent**.

### Session move/rename

If the goal is to move or rename a session thread, use the session-level capability.

Agent-facing path:

- `move_session`

User-facing path:

```text
/session move <new-session-id> [--parent <parent-session-id>]
/session move <existing-agent>/<new-session-id> [--parent <parent-session-id>]
```

Identity moves preserve the session's existing incoming parent relation by
default and rewrite direct child references to the moved ID. A batch may move
the sessions in an existing tree individually without reconstructing those
relations. Use `parentSessionId` on the agent-facing `move_session` tool, or
`--parent` on `/session move`, only when the moved session should intentionally
receive a different existing parent. Keep `/session unparent` as the explicit
detach operation; there is no recursive tree-move API.

### Agent migration

If the real goal is “this agent should really have been named/configured differently”, do **not** treat that as a session move.

Preferred migration flow:

1. create the correctly named/newly configured agent
2. copy or rewrite the important memory files
3. move/recreate the sessions you still want
4. set inherit/isolation on the replacement agent as needed
5. refresh snapshots for surviving sessions that should immediately see the new state
6. only then consider deleting the old agent

## Why there is no simple direct agent rename

A direct agent rename is intentionally not treated as a trivial cosmetic action.

Reasons include:

- agent paths are part of the persistent structure
- sessions under that agent are tied to that identity
- memory files, session metadata, and tool-visible workspace layout all depend on it
- a bad "just rename the folder" approach is easy to get wrong and can leave confusing partial state

So the safe recommendation is usually:

- create the correctly named agent
- move/recreate the needed sessions
- copy/adjust memory deliberately
- refresh snapshots where needed
- only then clean up the old agent

## Delete / cleanup

### Current capability boundary

There is a user-facing delete command:

```text
/agent delete <name> --confirm
```

But there is **not** a normal agent-facing `delete_agent` tool in the current tool surface.

So as an agent, your normal behavior should be:

- explain what deletion will do
- verify the migration/cleanup preconditions
- then tell the user the exact delete command to run if deletion is still wanted

This also means a multi-step create-agent/create-session workflow cannot promise
transactional rollback. Validate first, report exactly which resources survived
a failure, and use user-confirmed deletion for cleanup rather than manually
removing directories.

### What delete does

Current command behavior deletes:

- all sessions for that agent
- the agent directory and memory

So it is intentionally explicit and confirmation-gated.

## Things you generally should NOT do manually

Avoid ad-hoc manual mutation such as:

- renaming agent directories by hand
- creating per-agent `00_SYSTEM.md` and assuming it will be loaded by default
- deleting agent folders without going through the intended flow
- editing persistent state files blindly to "fake" a rename
- assuming an already-open session will instantly consume memory edits without refreshing its snapshot
- treating user-facing `/agent` or `/node` commands as if you can casually execute them yourself

## Quick scenario checklist for ordinary agent work

### Scenario A: "I need a new helper agent for a project"

Covered path:

- create agent
- optionally set inherit/isolation
- add memory files
- create/open sessions

### Scenario B: "I edited another agent's MEMORY.md; why does its open session still act old?"

Covered path:

- snapshot caching explanation
- `update_session_snapshot`
- `/session update-snapshot` user command fallback

### Scenario C: "The agent name was bad; should I rename it?"

Covered path:

- no direct simple rename
- recommended migration flow instead

### Scenario D: "I want this agent restricted to a sandbox node"

Covered path:

- agent-level isolation
- tool path vs user command path
- handoff to `node-setup` for node-side details

### Scenario E: "Create one temporary isolated worker on an existing node"

Covered path:

- load `isolated-worker`
- dry-run its bundled ToolScript
- create a parent-linked isolated agent/session and send the task
- report partial resources honestly if a later step fails

### Scenario F: "Can I delete the old agent now?"

Covered path:

- no default delete tool
- user-facing delete command only
- cleanup checklist before deletion

## Safe cleanup checklist

Before telling the user to delete an old agent:

1. confirm the needed memory files were migrated
2. confirm any wanted sessions were moved/recreated
3. confirm isolation/inherit settings on the replacement agent are correct
4. refresh snapshots for important surviving sessions
5. only then suggest `/agent delete <name> --confirm`

## Related skill

Use **`node-setup`** when the task is primarily about:

- node bootstrap
- pairing / approval
- sandbox node setup
- isolated-agent binding as part of node deployment

Use **`isolated-worker`** when the task is to create one parent-linked temporary
isolated worker on an already-online Node or through a configured
Docker-worktree provider for one exact existing worktree.
