---
name: agent_management
description: Explain Foxwarm agent lifecycle, safe migration/cleanup, isolation changes, and snapshot refresh behavior.
---

# agent_management

Use this skill when the task is about **agent lifecycle / maintenance**, not just one session.

Typical cases:

- why agent rename is not a simple exposed operation
- what agent delete actually does
- how to recover from a bad agent name
- how to migrate from one agent to another safely
- how isolation changes affect existing sessions
- how snapshot refresh works after editing another agent's memory

## Mental model: agent vs session

Foxwarm keeps **agent** and **session** separate:

- **agent** = long-lived workspace + memory container
- **session** = runtime conversation thread bound to an agent

That means:

- renaming/moving a **session** is comparatively lightweight
- renaming an **agent** is heavier because agent identity is tied to workspace paths, memory location, metadata, and all sessions under it

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

## Agent delete exists, but it is intentionally explicit

Foxwarm does support deleting an agent:

```text
/agent delete <name> --confirm
```

Why confirmation is required:

- it deletes the agent directory and memory
- it deletes all sessions under that agent
- it is permanent and easy to misuse if exposed too casually

So the product stance is:

- **delete exists**
- **rename is not exposed as a simple direct command**
- migration is preferred over trying to mutate agent identity in place

## Recommended recovery when the agent name was a bad choice

### Option A: keep the agent, just use better session names/display names

Use this when the agent name is only mildly awkward and not worth migration.

### Option B: migrate to a new agent

Recommended flow:

1. create the new agent with the intended name
2. copy or rewrite the important memory files
3. move/recreate the sessions you still want
4. refresh snapshots for sessions that should immediately see the new memory/inherit/skill state
5. verify the new agent behaves correctly
6. delete the old agent only when you are sure it is no longer needed

## Isolation changes at the agent level

You can bind an agent to a non-master node:

```text
/agent isolated <agent> <node-id>
```

Clear isolation again:

```text
/agent isolated <agent> off
```

Important behavior:

- isolation is **agent-level**
- the agent's sessions inherit that isolation automatically
- changing isolation updates affected sessions accordingly

## Snapshot refresh after editing another agent's memory

A session does not always re-read memory files instantly just because some memory file changed on disk.

Foxwarm stores a composed prompt snapshot for each session.

So after editing another agent's memory, inherit settings, or visible skills, an already-existing session may need a snapshot refresh to pick up the latest state immediately.

Use:

```text
/session update-snapshot [session-id]
```

There is also a tool-level equivalent:

- `update_session_snapshot`

This is especially important when:

- one agent/session edits another agent's memory files
- inherit relationships change
- visible skill availability changes and an existing session should see the updated catalog now

## Things you generally should NOT do manually

Avoid ad-hoc manual mutation such as:

- renaming agent directories by hand
- deleting agent folders without going through the intended flow
- editing persistent state files blindly to "fake" a rename
- assuming an already-open session will instantly consume memory edits without refreshing its snapshot

## Safe cleanup checklist

Before deleting an old agent:

1. confirm the needed memory files were migrated
2. confirm any wanted sessions were moved/recreated
3. confirm isolation/inherit settings on the replacement agent are correct
4. refresh snapshots for important surviving sessions
5. only then run `/agent delete <name> --confirm`

## Related skill

Use **`node_setup`** when the task is primarily about:

- node bootstrap
- pairing / approval
- sandbox node setup
- isolated-agent binding as part of node deployment
