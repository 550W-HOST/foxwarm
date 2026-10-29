---
name: isolated-worker
description: "Create and coordinate a temporary Foxwarm isolated worker on an existing online Node."
---

# isolated-worker

Use this skill when a non-isolated coordinator should create one temporary worker with a **real isolated-agent boundary**, rather than merely route a normal child session to another Node.

The workflow binds one worker to an already-online remote or sandbox Node. It does not create or manage the Node, add a lease, or automatically tear down resources.

## Choose the right mechanism

- **Remote execution only:** `create_child_session({"suffix":"worker","node":"node-id","handoffRecall":"<briefly consider what to say and which existing rules apply>","handoffConfirmation":"<briefly and honestly check whether this handoff should proceed>\nI confirm this handoff should proceed."})` sets that session's `currentNode`. Keep handoffRecall before message and handoffConfirmation last. Briefly recall the relevant rules and what to say, then honestly check the handoff. End the confirmation with “I confirm this handoff should proceed.” only if it should proceed; otherwise omit or cancel the call. When these properties are absent from the schema, they may be omitted. This does not make the session isolated.
- **Risk containment:** create a separate agent with `isolatedNode`, then create a session under that agent with the current coordinator as its explicit parent.
- **VM-grade security or exclusivity:** not provided by this workflow. Agent binding does not reserve a Node or provide an OS/network sandbox.

Isolation is agent-level. All sessions belonging to one isolated agent share its bound Node and restrictions. Use one temporary agent per worker when workers need different isolated Nodes.

## Inputs

- `nodeId` — exact non-master Node ID. It follows the Node contract: 1-128 ASCII letters, digits, `.`, `_`, `:`, or `-`, beginning with a letter or digit.
- `agentName` — unique temporary agent name using one or more letters, digits, `_`, or `-`; this preserves the existing workflow's no-length-cap name contract.
- `sessionName` — worker session leaf using the same narrow safe-name convention; defaults to `worker`.
- `task` — required task text. The generated handoff includes it verbatim inside an explicit worker brief.
- `inheritAgent` — optional existing agent whose durable memory should be inherited, using the same no-length-cap safe-name convention. Omit unless needed.
- `parentSessionId` — optional assertion of the exact current ToolScript owner; normally omit.
- `dryRun` — defaults to `true`.
- `handoffRecall` — Put this before message. Briefly consider what to say and which existing rules apply.
- `handoffConfirmation` — Put this last. Briefly and honestly check whether this handoff should proceed. Only if it should, end with the exact sentence: “I confirm this handoff should proceed.” Otherwise omit or cancel the call.

Supply both handoffRecall and handoffConfirmation for installations that require handoff review; omit both otherwise. The helper forwards your review and does not generate approval. Invalid supplied reviews fail before creation. A missing required review is reported by the send tool through the existing partial-failure path.

## Bundled ToolScript

The reusable script is:

```text
skills/isolated-worker/create_isolated_worker.py
```

Run it with `run_script(...)`. Use an absolute script path if the current agent directory is not the Foxwarm checkout.

### Dry run

```json
{
  "filePath": "skills/isolated-worker/create_isolated_worker.py",
  "args": {
    "nodeId": "worker-node-1",
    "agentName": "tmp-worker-1",
    "sessionName": "task",
    "task": "Inspect the assigned repository and report the findings.",
    "dryRun": true
  }
}
```

Existing-Node mode preserves the original workflow: list Nodes, require the exact non-master Node to be present/online, validate the agent/inheritance plan, then begin at agent creation when applied.

### Apply

After reviewing the dry-run plan, repeat with `dryRun:false`. The script performs:

1. `create_agent({agentName,isolatedNode:nodeId,createMainSession:false})`;
2. `create_session({agentName,sessionName,parentSessionId:<current>})`;
3. `send_to_session(...)` with the complete worker brief.

## Generated worker handoff

The initial message is intentionally more complete than the raw task. It contains:

- assigned Node;
- the user's task verbatim;
- a work-only-in-the-assigned-environment constraint;
- no Node selection/lifecycle or child-session actions;
- no commit/push/restart/deploy unless the verbatim task explicitly requires that exact action;
- an exact final-report instruction using `send_to_session({sessionId:"<parent>",handoffRecall:"<briefly consider what to say and which existing rules apply>",message:"...",afterSend:"finish",handoffConfirmation:"<briefly and honestly check whether this handoff should proceed>\nI confirm this handoff should proceed."})`, with `handoffConfirmation` last;
- required report fields: changed files/diff, validation, blockers, unresolved questions, and remaining working-tree changes, without assuming a commit exists.

Do not add parent-only scheduling, autonomy, phase progression, or “ask the user” instructions to the worker brief.

## Result and failure handling

This is fail-fast and **not transactional**.

A completed result includes the exact Node, agent, session and parent identities.

On failure, the result identifies:

- `failedStage`;
- exact `completedStages`;
- surviving Node/agent/session resources;
- retry notes;
- the existing user-confirmed agent cleanup boundary.

The script never auto-destroys a Node or deletes an agent after a later failure.
A `create_agent` failure emits the cleanup command only when the post-error agent recheck actually detects the agent. Session creation failure reports an existing agent but no session; send failure reports the surviving Node, agent and session.

### Agent cleanup

There is no agent-facing `delete_agent` tool. Preserve the explicit user boundary:

```text
/agent delete <agent-name> --confirm
```

Do not manually delete agent directories or edit state files to simulate rollback.

### Node cleanup

This workflow uses an existing Node and never creates, ensures or destroys it. Retain that Node unless the operator manages it separately; binding a worker does not establish Node ownership.

## Compatibility boundary

The workflow requires parent-linked cross-agent isolated communication. The worker session is created with the current coordinator as its exact parent, which is the narrow isolation exception used by `send_to_session` in both directions.

The Session worker, when enabled, remains a trusted local Main-host process. The selected Node is the ordinary tool execution target; this skill does not place Session workers on sandbox Nodes.

## No exclusivity guarantee

Binding an agent to a Node does not reserve that Node. If exclusive execution matters, the operator must assign a distinct Node/environment and avoid binding other sessions to it. This skill intentionally implements no lease or ownership abstraction.

## Related skills

- `node-setup` — bootstrap, pairing, approval, and sandbox troubleshooting.
- `agent-management` — agent/session lifecycle, isolation semantics, memory, and cleanup.
- `toolscript-automation` — general ToolScript authoring and run inspection.
