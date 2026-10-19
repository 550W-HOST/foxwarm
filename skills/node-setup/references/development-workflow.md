# Development work on an existing Node

This example transfers a committed source snapshot and selected materials, assigns a Task-linked child, and collects committed work or evidence for coordinator review. It uses public Foxwarm tools and ordinary local Git. It does not provision a host, modify policy, install dependencies, integrate a release branch, push, or deploy.

## Prerequisites and ownership

- A coordinator authorized to run ToolScript, execute on the source and worker Nodes, transfer files across **both** endpoints, and create/read Tasks and child Sessions. The worker needs its own narrower permissions.
- An existing non-master Node with canonical file/exec support and retained programmatic exec data. Both environments run POSIX shells, Python 3 and Git. This example is not a Windows or exec-only Shell Node workflow.
- A source repository, one committed base, a **new absent** worker workspace with an existing parent directory, existing temporary directories, a local Git author identity and a separate destination artifact directory for each delivery. Keep the input bundle and material destination paths outside the new workspace, for example in an assignment-specific temporary directory: transfers happen before repository initialization. Use absolute paths. Transfer paths use Node defaults, not Session cwd; the helper targets Nodes explicitly without changing the coordinator's selected Node.
- One owner for each mutable workspace and service. The coordinator owns source preparation, assignment, review/import and cleanup. The worker owns only the stated task workspace. Say whether commits, tests or restarts are authorized and whether children are forbidden.
- Installed toolchains and dependencies suitable for the task. A source bundle contains Git objects, not ignored dependencies or uncommitted files. If the assigned profile has read-only dependencies or no network, do not attempt host installs or weaken the boundary; report dependency-changing scope for separate provisioning.

Tool routing rules are not OS, network or resource isolation. A Provider label, selected Node or SSH account does not establish a sandbox or exclusive reservation. Real containment and resource limits are administrator responsibilities.

## One-time administrator setup

Choose an existing configured Provider or authenticated Node. For the optional Linux SSH route, [the bundled adapter guide](../examples/linux-ssh/README.md) supplies concrete private JSON connection configuration and `nodeProviders` registration. Python 3 and an OpenSSH client are optional administrator prerequisites on the adapter host; the target needs Python 3, Bash and Linux `/proc`. Enroll host keys and configure noninteractive credentials normally. No default registration occurs, and no SSH-specific Core tool is involved.

Load `access-control` and use its `references/tool-policy.md` as the canonical syntax and ordering reference. Merge reviewed reusable rules into the instance's actual policy; the following is a **fragment**, not a replacement policy or a per-assignment binding:

```yaml
rules:
  - session: developer/main
    action: allow
  - agent: developer-worker
    node: { provider: linux-machines }
    action: allow
  - agent: developer-worker
    tool: { source: builtin, name: task }
    args:
      action: [get, update, complete]
      taskId: { task: { owned: true } }
    action: allow
  - agent: developer-worker
    tool: { source: builtin, name: task }
    args: { action: list, scope: owned }
    action: allow
  - agent: developer-worker
    tool: { source: builtin, name: [wait, search_tools, skill] }
    action: allow
  - agent: developer-worker
    action: deny
```

The coordinator rule is intentionally powerful; use the installation's trusted coordinator identity. Review earlier matching rules and existing defaults before installing a fragment. `session: 'developer/*'` is an identity pattern; `node: 'linux-machines/*'` is an alternative to the Provider selector. Provider scope grants every Node owned by that Provider, not only a current assignment. `node: { current: true }` instead scopes actual Node effects to the current routing target; it is not a permanent Session-to-Node binding. The example's final worker deny keeps unrelated Main access closed if no earlier allow defeats it.

Task completion supplies creator notification, so a linked worker does not need an additional completion message. If non-Task parent communication is independently needed, review the canonical `send_to_session` parent-relation grant separately. `run_script`/continuation, Node catalog/provider-wide lifecycle inspection, and create/ensure are separate capabilities, not granted merely by a concrete Node selector. Cross-Node copy allows must cover both endpoints; a worker's Provider-only grant does not authorize the Main leg. Do not generate exact Node/Task rules for each assignment or let this helper edit authorization.

## Load the runnable example

The self-contained ToolScript is `examples/development_workflow.py`. Resolve `<skill-directory>` from `skill({action:"load",skillName:"node-setup"})`. It runs from an installed/copied skill directory without importing a source checkout or sibling Python modules:

```text
run_script({node:"master", filePath:"<skill-directory>/examples/development_workflow.py", args:{...}})
```

Choose the source Node that actually holds the script. This `node` argument controls the script's **source file**, not nested tool routing. The coordinator must be allowed to read that source. The helper explicitly routes every exec/read/copy leg. Load `toolscript-automation` for Monty execution, `continue_script`, and native result contracts. The JSON objects below are `run_script.args`; preserve the returned **script result**, not the outer run wrapper, between phases.

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
  "nodeId": "linux-machines/build-linux",
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

`prepared` is an object, not the literal explanatory string above. The helper adds Node, workspace, base and material paths to the new Task, then creates the child with its actual Task ID and Node. `displayName` is the Task title unless explicitly supplied in `child`. It does not infer model/effort overrides. Supply any handoff recall/review fields required by the active child tool schema yourself; the helper forwards them, preserves `handoffConfirmation` last and never fabricates approval text. Do not copy obsolete confirmation-field examples from another skill. Omit `afterSend` to let the helper inspect the actual Task notification state before returning.

The native Task and child receipts are retained. Successful creation with an unconfirmed assignment returns `needs-verification`, not a claim the worker started. A failure after Task creation retains `taskId`; inspect actual Task/Session state before retrying. An intentional retry of child creation can pass that existing `taskId` instead of `task`, but must first ensure no child/assignment already succeeded and that the existing Task description has the full brief. Reusing an existing worker is an ordinary `task(assign, ownerSessionId, notifySession:true)` operation, not another new child or a redundant message.

The worker confirms its Node/cwd/base, follows the Task's scope, validates meaningful behavior and commits only authorized changes. It completes the Task with actual commits, dirty status, tests/limitations, restart status and evidence paths. Task completion is the report; no second routine inter-session report is needed. Completion alone does not export files or approve integration.

### 3. Snapshot actual Git state

After the worker releases mutable ownership for delivery, the coordinator runs:

```json
{
  "phase": "snapshot",
  "nodeId": "linux-machines/build-linux",
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

## Deliberate cleanup

The coordinator releases the assignment only after review, evidence collection and any runtime use finish. Inspect the configured Provider's advertised lifecycle and retention before requesting any supported action; this helper never invokes lifecycle. Existing SSH hosts advertise **no create/ensure/destroy capability**. Cleanup there means only explicitly owned task files, retained execution logs or processes when independently authorized—not provisioning, destroying or shutting down the host. Removing a Task/Session or changing Node routing does not erase files, stop commands or release compute. Preserve imported refs and delivered artifacts according to the coordinator's normal policy.
