# Development work on a Node

This example transfers a committed source snapshot and selected materials, assigns a Task-linked child, and collects committed work or evidence for coordinator review. With a Provider that creates environments, such as the [container Provider](../examples/container/README.md), it also provisions a fresh Node for each assignment and releases it after review. It uses public Foxwarm tools and ordinary local Git. It does not modify policy, install dependencies, integrate a release branch, push, or deploy.

## Prerequisites and ownership

- A coordinator authorized to run ToolScript, execute on the source and worker Nodes, transfer files across **both** endpoints, create/read Tasks and child Sessions, and, for provisioned Nodes, `create`, `inspect` and `destroy` them and delete worker Sessions. The worker Agent has its own narrower rules.
- A non-master Node with canonical file/exec support and retained programmatic exec data: an existing one, or one the `provision` phase creates. Both environments run POSIX shells, Python 3 and Git. This example is not a Windows or exec-only Shell Node workflow.
- A source repository, one committed base, a **new absent** worker workspace with an existing parent directory, existing temporary directories, a local Git author identity and a separate destination artifact directory for each delivery. Keep the input bundle and material destination paths outside the new workspace, for example in an assignment-specific temporary directory: transfers happen before repository initialization. Use absolute paths. Transfer paths use Node defaults, not Session cwd; the helper targets Nodes explicitly without changing the coordinator's selected Node.
- One owner for each mutable workspace and service. The coordinator owns provisioning, source preparation, assignment, review/import and release. The worker owns only the stated task workspace. Say whether commits, tests or restarts are authorized and whether children are forbidden.
- Installed toolchains and dependencies suitable for the task. A source bundle contains Git objects, not ignored dependencies or uncommitted files. If the assigned profile has read-only dependencies or no network, do not attempt host installs or weaken the boundary; report dependency-changing scope for separate provisioning.

Tool routing rules are not OS, network or resource isolation. A Provider label, selected Node or SSH account does not establish a sandbox or exclusive reservation. Real containment and resource limits are administrator responsibilities.

## One-time administrator setup

**Choose where work runs.** For disposable environments, register the [container Provider](../examples/container/README.md) with a profile whose image has the project's toolchain plus Git and Python 3; each assignment then gets its own container. For existing Linux machines, the [SSH adapter guide](../examples/linux-ssh/README.md) supplies private connection configuration and `nodeProviders` registration; those hosts are shared between assignments and have no lifecycle. Any other authenticated non-master Node also works. No Provider is registered by default.

**Create the worker Agent once.** Use one worker Agent for all assignments and restrict it with an Agent-local allowlist, starting from agent-management's [restricted-worker rules](../../agent-management/references/memory-templates/restricted-worker.rules.json):

```text
create_agent({agentName:"developer-worker", createMainSession:false, rules:<contents of restricted-worker.rules.json>})
```

Then write the matching [memory template](../../agent-management/references/memory-templates/restricted-worker.md) to the new Agent's `memory/MEMORY.md`. Agent folders are siblings, so use the absolute path `<parent of your agent_folder>/developer-worker/memory/MEMORY.md` and read it back once. The layer keeps the worker's tools on its current Node, lets it report through its Task and ask its parent through a parent-owned Task, and denies `master`, memory writes and everything else. These rules govern Foxwarm tools only, so also give the worker Agent a model without built-in web search or image generation. [Restrict an Agent](../../agent-management/references/OPERATIONS.md#restrict-an-agent) explains each rule.

**Let the global policy pass these calls.** A local layer only narrows. With the default `defaultAction: allow` and no conflicting rules, nothing more is needed. If the instance policy denies by default, merge reviewed allows for the coordinator and the worker Agent; [access-control's policy reference](../../access-control/references/tool-policy.md) is the canonical syntax. This is a **fragment**, not a replacement policy:

```yaml
rules:
  - session: developer/main
    action: allow
  - agent: developer-worker
    action: allow   # narrowed by developer-worker's local layer
```

The coordinator rule is intentionally powerful; use the installation's trusted coordinator identity, and review earlier matching rules first. If the coordinator is restricted instead, remember that Provider-wide `create` and `ensure` have no concrete Node target and need their own rules, that cross-Node copy allows must cover both endpoints, and that `run_script` is a separate grant. Do not generate exact Node or Task rules per assignment, and do not let this helper edit authorization.

## Load the runnable example

The self-contained ToolScript is `examples/development_workflow.py`. Resolve `<skill-directory>` from `skill({action:"load",skillName:"node-setup"})`. It runs from an installed/copied skill directory without importing a source checkout or sibling Python modules:

```text
run_script({node:"master", filePath:"<skill-directory>/examples/development_workflow.py", args:{...}})
```

Choose the source Node that actually holds the script. This `node` argument controls the script's **source file**, not nested tool routing. The coordinator must be allowed to read that source. The helper explicitly routes every exec/read/copy leg. Load `toolscript-automation` for Monty execution, `continue_script`, and native result contracts. The JSON objects below are `run_script.args`; preserve the returned **script result**, not the outer run wrapper, between phases.

### 0. Provision a fresh Node (Providers that create Nodes)

Skip this for an existing Node, which works the same way in the later steps. Otherwise choose a Node ID for this assignment that has never been used, for example `sandbox/parser-change-01`. Authorization rules that follow a Session's current Node compare IDs, so a reused ID would reach the new environment from an old Session.

```json
{
  "phase": "provision",
  "providerId": "sandbox",
  "nodeId": "sandbox/parser-change-01",
  "parameters": {"profile": "offline"}
}
```

The helper calls `node` `create` and returns the Node's `defaultCwd`. Core refuses an ID that still exists, so the phase fails instead of reattaching to an old environment. If the receipt does not show the Node ready, it inspects the Node once and returns `needs-verification` instead of continuing. Creation does not select the Node or assign work. To reconnect deliberately to an environment that should still exist, for example a stopped container, call `node` `ensure` yourself; the helper never does. For a container profile, put the workspace under its default directory in the next step, for example `/workspace/example-task`.

### 1. Prepare source and transfer

In the assigned source checkout, run ordinary Git through its Node's exec tool. Select the desired committed base as HEAD in an appropriate existing checkout before bundling; do not reset, stash or discard somebody else's work. A source bundle does not include dirty files:

```sh
git -C /workspace/project rev-parse HEAD
git -C /workspace/project status --short
git -C /workspace/project bundle create /tmp/assignment-source.bundle HEAD
```

Record the returned full commit ID as `base`. The source bundle includes reachable history so the worker needs no network clone. Create a fresh destination namespace for this assignment; `/workspace/example-task` must not exist, and its parent and `/tmp` must exist. Then:

```json
{
  "phase": "prepare",
  "sourceNode": "master",
  "sourceBundle": "/tmp/assignment-source.bundle",
  "nodeId": "sandbox/parser-change-01",
  "bundlePath": "/tmp/example-task-source.bundle",
  "workDir": "/workspace/example-task",
  "tempDir": "/tmp",
  "base": "FULL_COMMIT_ID_FROM_REV_PARSE",
  "gitIdentity": {"name": "Example Developer", "email": "developer@example.invalid"},
  "materials": [{"sourcePath": "/tmp/brief.md", "targetPath": "/tmp/example-task-brief.md"}]
}
```

The helper copies with normal `copy_between_nodes` without overwriting, initializes a new local repository, fetches the bundle's HEAD, verifies the exact base, checks out branch `work`, and sets only repository-local author identity. It does not create a receiving coordinator worktree. Keep the completed `prepare` result as `prepared`.

### 2. Assign a Task-linked child

Pass that completed result in place of `PREPARED_RESULT`:

```json
{
  "phase": "assign",
  "prepared": "PREPARED_RESULT",
  "task": {
    "title": "Implement the agreed parser change",
    "description": "Implement only the agreed change. Read the supplied brief. You own the assigned workspace; do not install dependencies, access other hosts, create children, push, restart services or deploy. Local commits are authorized. Run the focused parser checks and report actual results and limitations. Write test evidence under /tmp."
  },
  "child": {"agentName": "developer-worker", "suffix": "parser-change"}
}
```

The worker Agent's rules allow its tools only on the Node the child starts on, so the child is created directly on the prepared Node.

`prepared` is an object, not the literal explanatory string above. The helper adds Node, workspace, base and material paths to the new Task, then creates the child with its actual Task ID and Node. `displayName` is the Task title unless explicitly supplied in `child`. It does not infer model/effort overrides. Supply any handoff recall/review fields required by the active child tool schema yourself; the helper forwards them, preserves `handoffConfirmation` last and never fabricates approval text. Do not copy obsolete confirmation-field examples from another skill. Omit `currentSessionTurnAction` to let the helper inspect the actual Task notification state before returning.

The native Task and child receipts are retained. Successful creation with an unconfirmed assignment returns `needs-verification`, not a claim the worker started. A failure after Task creation retains `taskId`; inspect actual Task/Session state before retrying. An intentional retry of child creation can pass that existing `taskId` instead of `task`, but must first ensure no child/assignment already succeeded and that the existing Task description has the full brief. Reusing an existing worker is an ordinary `task(assign, ownerSessionId, notifySession:true)` operation, not another new child or a redundant message.

The worker confirms its Node/cwd/base, follows the Task's scope, validates meaningful behavior and commits only authorized changes. It completes the Task with actual commits, dirty status, tests/limitations, restart status and evidence paths. Task completion is the report; no second routine inter-session report is needed. Completion alone does not export files or approve integration.

### 3. Snapshot actual Git state

After the worker releases mutable ownership for delivery, the coordinator runs:

```json
{
  "phase": "snapshot",
  "nodeId": "sandbox/parser-change-01",
  "workDir": "/workspace/example-task",
  "tempDir": "/tmp",
  "base": "FULL_COMMIT_ID_FROM_REV_PARSE"
}
```

The result contains actual base/HEAD, new commit IDs, raw NUL-separated porcelain dirty status and a unique ordinary snapshot directory under `tempDir`. A `base..HEAD` bundle is created **only** when new commits exist and base is an ancestor. Dirty/untracked work is reported, never silently bundled, committed or discarded. No-new-commit investigation is legitimate: `commits` is empty and `bundlePath` is null, with no fake commit, bundle or ref. Keep the completed result as `snapshot`.

### 4. Receive selected delivery files, then review

Choose an existing, fresh artifact directory on the coordinator's target Node. Pass the completed snapshot object, not a string:

```json
{
  "phase": "receive",
  "snapshot": "SNAPSHOT_RESULT",
  "targetNode": "master",
  "artifactDir": "/tmp/parser-review-01",
  "evidence": [{"path": "/tmp/parser-tests.log", "name": "parser-tests.log"}]
}
```

The helper copies the bundle when present and each selected evidence file using standard transfer, retaining receipts. Names are filenames, not host-relative paths. Existing destination files are not overwritten. Evidence-only delivery works without a bundle. Preserve the returned snapshot metadata as part of the coordinator's review; the helper has no separate artifact registry.

The coordinator reads the report, dirty state and evidence. For committed delivery, inspect the transferred bundle deliberately in the existing source repository:

```sh
git -C /workspace/project bundle verify /tmp/parser-review-01/commits.bundle
git -C /workspace/project fetch /tmp/parser-review-01/commits.bundle HEAD:refs/heads/review/parser-change
git -C /workspace/project log --oneline BASE..refs/heads/review/parser-change
git -C /workspace/project diff BASE..refs/heads/review/parser-change
```

Use the actual base and a chosen feature/review ref; the helper performs **no automatic fetch, integration, release-branch update or push**. A bundle includes committed work only. Keep the Node/workspace until needed uncommitted files and evidence have been preserved or deliberately discarded.

## Pending, partial results and failures

Inspect both the outer ToolScript lifecycle and `result.status`. An outer timeout/agent wait requires the existing `continue_script` continuation, not a new invocation. The helper's `pending` is an exec still running; it retains the exact Node, exec ID/log locator and prior successful copy receipts and performs no later step. Use normal `wait(waitExecIds:[...])` and its actual completion event, not polling or re-running the command. Then:

```json
{"phase":"collect", "pending":"PENDING_RESULT", "exitCode":0, "logPath":"ACTUAL_SAME_NODE_COMPLETION_LOG"}
```

Replace the explanatory strings with the retained pending object and actual completion evidence. `collect` reads the log without replaying exec and returns the original phase's completed result, ready for the next explicit phase. Nonzero/unknown exits fail. If `needs-content` remains because retained data is unavailable or exceeds the normal ToolScript budget, inspect the real log with bounded file reads; do not parse shortened display text as complete JSON or restart an uncertain operation.

The helper catches host errors and returns the failed stage, native receipts and surviving successful transfers/Task ID. It does not retry, roll back or clean up partial files/repositories. A later copy failure can leave a partial destination; inspect before choosing a fresh destination or explicitly removing only owned partial files. An uncertain child-creation result likewise requires Task/Session inspection, not automatic duplication.

## Release the environment

The coordinator releases an assignment only after review, evidence collection and any runtime use have finished. Nothing is released automatically.

For a provisioned Node, first decide whether anything inside it is still needed: uncommitted files, logs or evidence not yet received. Then run, with the exact confirmation text:

```json
{
  "phase": "release",
  "nodeId": "sandbox/parser-change-01",
  "workerSessionId": "developer-worker/parser-change",
  "confirmation": "destroy node sandbox/parser-change-01"
}
```

The helper inspects the Node, deletes the finished worker Session (its archive is kept), then destroys the Node, which removes the container with its workspace and command logs. If deleting the Session fails, for example because it is still busy, the helper stops before destroying anything; a busy Session receives a stop request, so run release again once it is idle. Omit `workerSessionId` to keep the Session for reference; with its Node destroyed and the ID never reused, its file and command tools have nowhere to run.

Existing SSH hosts advertise **no create, ensure or destroy**. Releasing there means removing only explicitly owned task files, retained execution logs or processes when independently authorized, not shutting down the host. Removing a Task or Session or changing Node routing never erases files, stops commands or releases compute by itself. Preserve imported refs and delivered artifacts according to the coordinator's normal policy.
