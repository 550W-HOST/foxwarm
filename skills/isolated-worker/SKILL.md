---
name: isolated-worker
description: "Create and coordinate a temporary Foxwarm isolated worker on either an existing online Node or a provider-backed Docker Node for one existing Git worktree."
---

# isolated-worker

Use this skill when a non-isolated coordinator should create one temporary worker with a **real isolated-agent boundary**, rather than merely route a normal child session to another Node.

The workflow supports two modes:

1. **Existing-Node mode** — bind the worker to an already-online remote or sandbox Node.
2. **Provider-backed worktree mode** — ask one configured lifecycle provider to ensure a Docker Node for one exact, already-existing Git worktree, validate it by read-only inspect, then bind the worker.

The skill does not create, clone, move, clean, commit, or delete a Git worktree. It does not add a Node lease, ownership system, automatic rollback, or automatic teardown.

## Choose the right mechanism

- **Remote execution only:** `create_child_session({"node":"node-id", ...})` sets that session's `currentNode`. It does not make the session isolated.
- **Risk containment:** create a separate agent with `isolatedNode`, then create a session under that agent with the current coordinator as its explicit parent.
- **Docker worktree containment:** provider-backed mode can ensure the configured `docker-worktree` Node around an existing allowlisted worktree. The provider mounts Git metadata read-only and exposes ordinary `read`, `write`, `edit`, `apply_patch`, and `exec` capabilities.
- **VM-grade security or exclusivity:** not provided by this workflow. Agent binding does not reserve a Node, and Docker worktree containment is explicitly not a VM security boundary.

Isolation is agent-level. All sessions belonging to one isolated agent share its bound Node and restrictions. Use one temporary agent per worker when workers need different isolated Nodes.

## Inputs

Common inputs:

- `nodeId` — exact non-master lifecycle Node ID. It follows the Node contract: 1-128 ASCII letters, digits, `.`, `_`, `:`, or `-`, beginning with a letter or digit.
- `agentName` — unique temporary agent name using one or more letters, digits, `_`, or `-`; this preserves the existing workflow's no-length-cap name contract.
- `sessionName` — worker session leaf using the same narrow safe-name convention; defaults to `worker`.
- `task` — required task text. The generated handoff includes it verbatim inside an explicit worker brief.
- `inheritAgent` — optional existing agent whose durable memory should be inherited, using the same no-length-cap safe-name convention. Omit unless needed.
- `parentSessionId` — optional assertion of the exact current ToolScript owner; normally omit.
- `dryRun` — defaults to `true`.

Provider-backed mode additionally requires both:

- `providerId` — exact configured lifecycle provider ID;
- `worktreePath` — exact absolute, lexically canonical path to an existing Git checkout/worktree.

Optional provider-backed input:

- `networkMode` — `none` by default; `bridge` only when explicitly requested and allowed by provider configuration.

`providerId` and `worktreePath` are all-or-nothing. `networkMode` is rejected outside provider-backed mode.

## Bundled ToolScript

The reusable script is:

```text
skills/isolated-worker/create_isolated_worker.py
```

Run it with `run_script(...)`. Use an absolute script path if the current agent directory is not the Foxwarm checkout.

### Existing-Node dry run

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

### Provider-backed dry run

```json
{
  "filePath": "skills/isolated-worker/create_isolated_worker.py",
  "args": {
    "providerId": "local-dev-containers",
    "nodeId": "sandbox-project-task",
    "worktreePath": "/srv/foxwarm-worktrees/project-task",
    "networkMode": "none",
    "agentName": "tmp-project-task",
    "sessionName": "task",
    "task": "Implement the requested change and report the diff and validation.",
    "inheritAgent": "main",
    "dryRun": true
  }
}
```

Dry run is mutation-free. It:

1. resolves the exact current parent and rejects an isolated coordinator;
2. lists Nodes and lifecycle providers and requires the selected provider to advertise `ensure`;
3. if the exact Node exists, calls read-only `node inspect` and validates exact Node ID/provider/kind/type/availability/default cwd plus Docker worktree/network evidence;
4. if the Node is absent, records a truthful planned ensure without invoking it;
5. validates unique agent/session/inheritance inputs;
6. returns a structured plan with Node existence, ensure parameters, worker binding, handoff, and cleanup/recovery notes.

For an absent Node, canonical provider/worktree evidence is necessarily deferred until apply; dry run does not pretend to validate a Node that does not exist.

### Apply provider-backed mode

After reviewing the dry-run plan, repeat with `dryRun:false`. The script performs:

1. `node({action:"ensure", providerId, nodeId, parameters:{worktreePath,networkMode}})`;
2. read-only `node({action:"inspect", nodeId})`;
3. fail-closed validation of the ensure and inspect results;
4. `create_agent({agentName,isolatedNode:nodeId,createMainSession:false})`;
5. `create_session({agentName,sessionName,parentSessionId:<current>})`;
6. `send_to_session(...)` with the complete worker brief.

The inspect result must be an exact ready `sandbox` / `docker-worktree` descriptor owned by the requested provider, with exact default cwd, exact worktree path, exact network mode, running status, and the canonical five development tools. Any mismatch stops before agent creation.

## Generated worker handoff

The initial message is intentionally more complete than the raw task. It contains:

- assigned Node;
- canonical worktree for provider-backed mode;
- the user's task verbatim;
- a work-only-in-the-assigned-environment constraint;
- no Node selection/lifecycle or child-session actions;
- no commit/push/restart/deploy unless the verbatim task explicitly requires that exact action;
- the Docker provider's Git-metadata-read-only caveat;
- an exact report instruction using `send_to_session({sessionId:"<parent>",...,waitAfterHandoff:true})`;
- required report fields: changed files/diff, validation, blockers, unresolved questions, and remaining working-tree changes, without assuming a commit exists.

Do not add parent-only scheduling, autonomy, phase progression, or “ask the user” instructions to the worker brief.

## Result and failure handling

This is fail-fast and **not transactional**.

A completed provider-backed result includes exact Node/agent/session/parent
identities, `nodeAbsentBeforeEnsure`, and
`nodePresenceAfterEnsure: "present"`; failure results use the same presence
field with `"present"` or `"unknown"`. Unknown presence is never encoded as
false: recovery reports `possibleNodeId`, because inspect failure or malformed
full evidence cannot prove absence after an ensure error. These observations do
not establish creation or ownership because list and ensure are not one atomic
lease operation.

On failure, the result identifies:

- `failedStage`;
- exact `completedStages`;
- surviving or potentially surviving Node/agent/session resources;
- retry/inspection notes;
- the existing user-confirmed agent cleanup boundary.

The script never auto-destroys a Node or deletes an agent after a later failure.
Before agent creation, recovery explicitly states that no agent/session was
created and emits no agent cleanup command. A `create_agent` failure emits the
cleanup command only when the post-error agent recheck actually detects the
agent. Session creation failure reports an existing agent but no session; send
failure reports the surviving Node, agent, and session.

### Agent cleanup

There is no agent-facing `delete_agent` tool. Preserve the explicit user boundary:

```text
/agent delete <agent-name> --confirm
```

Do not manually delete agent directories or edit state files to simulate rollback.

### Node cleanup

Node lifecycle and agent binding remain separate:

- if the Node was present in preflight, retain it by default and do not recommend destroy merely because a worker was bound;
- if it was absent in preflight but present after ensure, ownership is still unconfirmed because another coordinator may have created it between those observations;
- if ensure failed with an unknown outcome, inspect the exact Node first;
- provider-backed cleanup always retains the Node by default and returns no destroy descriptor solely from preflight absence;
- a non-isolated coordinator may separately inspect and explicitly destroy only with independent operator/workflow confirmation that the Node is disposable. Destroy retains worktree bytes, Git metadata, and provider execution artifacts.

## Compatibility boundary

The workflow requires parent-linked cross-agent isolated communication. The worker session is created with the current coordinator as its exact parent, which is the narrow isolation exception used by `send_to_session` in both directions.

The Session worker, when enabled, remains a trusted local Main-host process. The selected Node is the ordinary tool execution target; this skill does not place Session workers on sandbox Nodes.

## No exclusivity guarantee

Binding an agent to a Node does not reserve that Node. If exclusive execution matters, the operator must assign a distinct provider Node/worktree and avoid binding other sessions to it. This skill intentionally implements no lease or ownership abstraction.

## Related skills

- `node-setup` — bootstrap, pairing, approval, provider configuration, and sandbox troubleshooting.
- `agent-management` — agent/session lifecycle, isolation semantics, memory, and cleanup.
- `toolscript-automation` — general ToolScript authoring and run inspection.
