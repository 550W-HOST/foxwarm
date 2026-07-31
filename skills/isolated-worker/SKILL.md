---
name: isolated-worker
description: "Create and coordinate a temporary Foxwarm isolated worker on an existing approved/online node using an agent-level isolation boundary, a parent-linked worker session, and the bundled create_isolated_worker ToolScript."
---

# isolated-worker

Use this skill when a main session should place one worker on a user-provided Foxwarm node with a **real isolated-agent boundary**, rather than merely route a normal child session to another node.

This workflow assumes the operator has already provisioned and started the host/container. It does not create VMs, cloud instances, containers, node leases, or teardown jobs.

## Choose the right mechanism

- **Remote execution only:** `create_child_session({"node":"node-id", ...})` sets that session's `currentNode`. It does not make the session isolated.
- **Risk containment:** create a separate agent with `isolatedNode`, then create a session under that agent with the current coordinator as its explicit parent.
- **Physical/environment isolation:** comes from the user-provided VM/container. Foxwarm agent isolation narrows tool and master-file permissions; it does not create the sandbox itself.

Isolation is agent-level. All sessions belonging to one isolated agent share its bound node and restrictions. Use one temporary agent per worker when workers need different isolated nodes.

## Before running

1. Load `node-setup` if the node still needs bootstrap or pairing.
2. Confirm the node is approved and connected with `node({ action: "list" })`. The current agent-facing node list proves a node is online; it does not list approved-but-offline nodes.
3. Choose a unique ASCII `agentName` and `sessionName` using letters, digits, `_`, or `-`.
4. Keep the coordinator non-isolated. The underlying `create_agent` and `create_session` tools are unavailable to an isolated caller.
5. Decide whether the temporary agent should inherit durable memory from an existing agent. Omit `inheritAgent` unless that shared context is actually needed.

## Bundled ToolScript

The reusable script is:

```text
skills/isolated-worker/create_isolated_worker.py
```

It calls existing builtins through ToolScript:

1. `session` — resolve and verify the current parent session;
2. `node({ action: "list" })` — require the selected non-master node to be connected;
3. `list_agents` — fail if the requested agent already exists;
4. `create_agent` — create the isolated agent with `createMainSession=false`;
5. `create_session` — create one worker session with `parentSessionId` set to the current session;
6. `send_to_session` — deliver the initial task.

The parent relation is important: it is the narrow relationship used for coordinator/worker messaging in Foxwarm versions that permit explicitly parent-linked cross-agent isolated communication.

### Safe validation first

`dryRun` defaults to `true`. A dry run performs only status/list calls and returns the plan.

```json
{
  "filePath": "skills/isolated-worker/create_isolated_worker.py",
  "args": {
    "nodeId": "worker-node-1",
    "agentName": "tmp-worker-1",
    "sessionName": "task",
    "task": "Inspect the assigned repository. When finished, send the result to <parent>.",
    "dryRun": true
  }
}
```

Run it with `run_script(...)`. After checking the plan, repeat with `dryRun:false`:

```json
{
  "filePath": "skills/isolated-worker/create_isolated_worker.py",
  "args": {
    "nodeId": "worker-node-1",
    "agentName": "tmp-worker-1",
    "sessionName": "task",
    "task": "Inspect the assigned repository. When finished, send the result to <parent>.",
    "inheritAgent": "main",
    "dryRun": false
  }
}
```

Use an absolute script path if the current agent directory is not the Foxwarm program checkout.

## Result and failure handling

A completed result includes `agentName`, `sessionId`, `nodeId`, `parentSessionId`, and the completed stages.

This is a fail-fast workflow, **not a transaction**:

- all validation happens before the first mutation where the current tools allow it;
- if `create_agent` fails, the script re-lists agents to detect an obvious partial creation;
- if session creation fails, the isolated agent may remain;
- if initial delivery fails, both agent and session may remain, and the task can be retried after the communication/runtime issue is fixed;
- there is no agent-facing `delete_agent` tool, so the script cannot truthfully promise rollback.

The returned `recovery` field names the surviving resource and suggests either retrying the failed step or asking the user to run:

```text
/agent delete <agent-name> --confirm
```

Do not manually delete agent directories or edit state files to simulate rollback.

## Compatibility boundary

The workflow requires Foxwarm to allow `send_to_session` across agent boundaries **only for the explicitly linked parent/child pair**. Older/current builds with a blanket cross-agent isolated deny will create the parent-linked worker but fail at initial delivery. The script reports this as `partial_failure`; it does not hide the leftover agent/session.

## No exclusivity guarantee

Binding an agent to a node does not reserve that node. If exclusive execution matters, the operator must provide a distinct node/container and avoid assigning other sessions to it. This skill intentionally does not implement leasing or provisioning.

## Related skills

- `node-setup` — bootstrap, pairing, approval, node connectivity, and sandbox troubleshooting.
- `agent-management` — agent/session lifecycle, isolation semantics, memory, and cleanup.
- `toolscript-automation` — general ToolScript authoring and run inspection.
