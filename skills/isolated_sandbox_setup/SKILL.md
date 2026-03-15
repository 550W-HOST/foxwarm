---
name: isolated_sandbox_setup
description: Guide for pairing a remote node and creating an isolated agent bound to that node.
---

# isolated_sandbox_setup

Use this skill to help a user set up a safer sandbox / isolated-agent workflow.

## Goal

Create an agent that:
- is isolated from other agents
- is bound to a non-master node
- can only use that bound node for execution
- may only access its own `memory/` files on master

## Recommended flow

### 1. Pair a node

List pending pairing requests:

```text
/node pair list
```

Approve one and optionally choose the final node id:

```text
/node pair approve <pending-id> <node-id>
```

Inspect approved nodes:

```text
/node known
```

List currently online nodes:

```text
/node
```

### 2. Create an isolated agent bound to that node

```text
/agent create <agent-name> --isolated <node-id>
```

Examples:

```text
/agent create sandbox-agent --isolated pair-smoke
```

### 3. Change an existing agent to isolated mode

```text
/agent isolated <agent-name> <node-id>
```

Disable isolation again:

```text
/agent isolated <agent-name> off
```

## Safety notes

- Isolated agents must bind to a **non-master** node.
- Isolated agents cannot inherit shared memory from other agents.
- Their sessions inherit isolated restrictions automatically.
- `search_memory` is restricted:
  - normal sessions: current agent only
  - isolated sessions: current session only

## Suggested verification

After creating the isolated agent:

1. Create or open a session under the agent
2. Confirm its node is the bound node
3. Confirm cross-agent operations are rejected
4. Confirm `/search` only returns allowed-scope results
