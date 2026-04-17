---
name: agent_management
description: Use for Foxwarm agent management tasks: creating agents, editing agent memory, refreshing snapshots, understanding agent vs session boundaries, changing isolation/inheritance, and safely migrating or cleaning up agents.
---

# agent_management

Use this skill when the task is about **agent lifecycle / maintenance**, not just one session.

Typical cases:

- understanding what an agent is vs what a session is
- creating a new agent cleanly
- deciding where to put long-term instructions or project memory
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
- `list_sessions`
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
- full skill documents are loaded on demand with `load_skill`
- session snapshots are cached per session, so editing memory on disk does not always change an already-open session immediately
- the prompt snapshot also includes directory hints such as the current agent's `agent_memory` and `agent_folder` paths

## Special file: `agents/main/memory/00_SYSTEM.md`

This file is special.

Current prompt assembly injects:

- `agents/main/memory/00_SYSTEM.md`

as a framework-level system block for **all agents**.

Also important:

- default agent memory loading explicitly skips `00_SYSTEM.md` in per-agent memory directories
- that means ordinary agents should **not** create their own per-agent `00_SYSTEM.md` expecting it to behave like the main global one

So the guidance is:

- treat `agents/main/memory/00_SYSTEM.md` as the framework/global system layer
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

## What isolated agents are for

An isolated agent is mainly a **risk-containment** setup.

Use it when you want an agent's runtime work to happen on a separate non-master node instead of freely on `master`.

Typical cases:

- the agent will handle tasks that may be risky
- the agent is attached to an external group chat or channel that may contain untrusted content
- prompt-injection exposure is plausible and you want a narrower execution boundary

The point is not "perfect safety".
The point is to reduce blast radius by moving runtime execution onto a bound node and narrowing what the agent can still do on `master`.

## Isolated-agent boundary in plain language

If an agent is isolated, it should think about permissions like this:

- it can use the tools available on its **bound isolated node**
- it can still do limited host-side work on `master`
- on `master`, that limited work is mainly its own `memory/` plus files inside its own agent directory
- it should **not** assume it can switch to other nodes just because they exist
- it should **not** assume it can operate on unrelated nodes
- it should **not** assume it can read or edit other agents' directories on `master`

So for an isolated agent, the safe mental model is:

- runtime work: bound node
- durable local files on `master`: own agent area only
- other nodes / other agent directories: not your default playground

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
- an isolated session should not expect to switch itself to some other arbitrary node for normal work
- if a different node is really required, the right model is usually to change the agent's isolation binding deliberately, not to let the isolated agent wander across nodes

## Common workflow: move work between agents/sessions

Be precise about whether you are moving a **session** or replacing an **agent**.

### Session move/rename

If the goal is to move or rename a session thread, use the session-level capability.

Agent-facing path:

- `move_session`

User-facing path:

```text
/session move <new-session-id>
/session move <existing-agent>/<new-session-id>
```

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
- handoff to `node_setup` for node-side details

### Scenario E: "Can I delete the old agent now?"

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

Use **`node_setup`** when the task is primarily about:

- node bootstrap
- pairing / approval
- sandbox node setup
- isolated-agent binding as part of node deployment
