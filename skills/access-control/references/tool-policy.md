# Tool policy syntax and examples

The fixed instance authority is `state/tool-authorization.yaml` under the data directory. It applies to every internal Session and verified inbound MCP caller. Use [safe policy updates](policy-updates.md) rather than overwriting the live authority with an example.

## Version 1 shape

```yaml
version: 1
defaultAction: allow
rules:
  - id: reviewer-read-master
    enabled: true
    match:
      agent: reviewer
      tool: { source: node, name: read }
      targetNode: master
      path:
        arg: filePath
        allWithin: '${agent.dir}'
    action: allow
    reason: Read the review workspace
  - id: reviewer-deny-other-tools
    match:
      agent: reviewer
    action: deny
```

This complete example restricts internal calls from the `reviewer` Agent while preserving the internal default for other Agents. It does not create that Agent or change its default Node. Merge rules into the real policy only after reviewing existing ordering.

- Top level: `version: 1`, optional `defaultAction: allow | ask | deny` (omission means `allow`), and optional `rules` (omission means an empty list). Prefer writing both optional fields explicitly.
- Rule: optional unique non-empty `id` (omission assigns `rule-<position>`), optional `enabled` (defaults to `true`), optional `match` (omission/`{}` matches all callers), required `action: allow | ask | deny`, optional `reason`, and optional `approval` (only with `ask`; see [Require approval](#require-approval)).
- Limits: at most 256 rules and 256 KiB of policy bytes; IDs up to 128 bytes, reasons up to 1,024 bytes, matcher strings up to 512 bytes, and scalar lists up to 64 items.
- Unknown fields, unsupported versions/operators/path variables, unsafe dotted argument paths, and duplicate IDs are rejected.

## Concise Session and Node selectors

A rule may put `agent`, `session`, `externalId`, `tool`, `node`, `secrets`, `args`, and `path` directly beside `action`. Do not mix these top-level selectors with `match`, even when `match` is empty. Legacy version-1 `match.session`, `match.targetNode` and argument strings retain their exact scalar semantics.

```yaml
version: 1
defaultAction: deny
rules:
  - session: developer/main
    action: allow
  - agent: [developer, developer-worker]
    node: 'development/*'
    action: allow
  - agent: [developer, developer-worker]
    tool: { source: builtin, name: task }
    args:
      action: [get, update, complete]
      taskId: { task: { owned: true } }
    action: allow
  - agent: [developer, developer-worker]
    tool: { source: builtin, name: task }
    args: { action: list, scope: owned }
    action: allow
  - agent: [developer, developer-worker]
    tool: { source: builtin, name: send_to_session }
    args: { sessionId: { session: { relation: parent } } }
    action: allow
  - agent: [developer, developer-worker]
    tool: { source: builtin, name: [wait, search_tools] }
    action: allow
```

This example grants the coordinator all tools, grants other development Sessions every Node belonging to the `development` Provider, and adds explicit Task/parent coordination. It does not bind a Session to one Node, create an Agent or Node, grant Provider creation, or change Agent isolation. Review any additional coordination capability separately. With `defaultAction: deny`, callers not covered by these rules are denied too; when composing a caller-specific block into another policy, retain the intended defaults and existing rules.

- Top-level `session` and string/list `node` accept bounded ASCII identity patterns using `*` for zero or more identity characters, including `/`. Other characters are literal; `?`, character classes and regular expressions are not supported. Lists are alternatives. `session: 'developer/*'` selects caller Sessions, not target Sessions or authoritative Agent membership; use `agent` for the latter.
- `node: { current: true }` matches only actual effects on the caller's selected Node, using the exact owner's routing fact. It does not grant unrelated Session/Main/MCP operations merely because that Node is selected.
- `node: { provider: development }` selects the authoritative Core Provider namespace; exact Provider-ID lists are also supported. It is equivalent to the qualified prefix for executable providers, not a match against `args.providerId`. Native Provider IDs are `master` and `authenticated-remote`.
- A Node selector matches concrete Node capabilities, the file targets of `send_file`/`image_write_to_file`, both endpoints of `copy_between_nodes`, and concrete `node` select/inspect/destroy targets. List and provider-wide create/ensure/inspect have no concrete Node target and require separate rules.
- A multi-Node **allow** requires every endpoint to satisfy that rule. A Node **deny** matches any affected endpoint. Thus allowing `development/*` never grants a copy's `master` leg. First-match ordering still applies; an earlier matching allow wins.
- `run_script` is a Session-owned VM operation, not a neutral Node wrapper, even when its source file is on a Node. Grant the starter/continuation explicitly if wanted; file source reads and nested calls still require their own concrete permissions.
- Omitted rule IDs are only diagnostic position IDs. Use explicit IDs when stable labels matter; generated and explicit IDs must still be unique.

Executable-provider Nodes use Core IDs such as `development/worker-one`. The executable itself still receives its local ID, `worker-one`; native `master` and authenticated CLI IDs remain unchanged. Do not silently rewrite old exact rules or persisted Session selections: review the affected configuration and select the qualified ID deliberately. Historical records remain readable, and old provider execution records reattach through their persisted Provider identity without replaying a command.

### Owned Tasks

`args.taskId: { task: { owned: true } }` is registered only for the exact builtin `task` selector. Main resolves the real task owner and canonical Session identity. Missing, unowned and another Session's tasks do not match; `ownerSessionId` is an assignment target, never proof of caller ownership. This matcher restricts the referenced task, not all tasks globally. Default shared description/note updates and get semantics are unchanged unless a policy restricts them.

For list access, grant `args: { action: list, scope: owned }`. `owned` includes only tasks currently owned by the caller; the existing `current-session` scope still includes tasks created **or** owned by the caller. A creator is not necessarily the current owner.

### Stored secrets

A `set_config` or `mcp_config` change that would send a stored secret (`${secret:NAME}`) to a new destination carries those secret names: a new reference, or a changed provider base URL or protocol, inherited `llm` base URL, text-redaction endpoint, ASR URL, channel server, or MCP URL, transport, command, arguments, working directory or environment. Model lists, limits, descriptions, timeouts and enablement carry none. `exec` carries the secret names in its `secretEnv`, which passes stored secrets to the command as environment variables. `add_secret` carries its name, and `ask_user` the names its secret questions ask for, when configuration already refers to that name, because the new value then reaches those destinations.

```yaml
rules:
  - agent: deploy-worker
    secrets: { anyOf: ['staging-*'] }
    action: allow
  - secrets: { anyOf: ['prod-*'] }
    action: deny
    reason: Production credentials are changed by the user.
  - agent: deploy-worker
    secrets: { owned: true }
    action: ask
    reason: Confirm before the worker uses credentials it added itself.
```

- A rule with `secrets` decides only the secrets, never the call itself; the call still needs its own allow. Patterns use secret-name characters and `*`; a scalar is a one-item list.
- An allow covers a call only if its patterns cover every named secret; a deny or ask matches any of them. The first matching `secrets` rule decides.
- `owned: true` selects secrets the caller's Agent owns: those it added with `add_secret` from a value or a file, or received through its own secret question. Alone or together with `anyOf`, it applies to each name.
- Secrets the caller's Agent owns need no allow. An allow must cover the other named secrets, and when the Agent owns all of them and no `secrets` rule matches, they are allowed. A deny or ask still matches owned secrets. Secrets added by Setup or moved from configuration belong to the instance, and a deleted Agent's secrets pass to the instance.
- Without a matching `secrets` rule, the secrets follow the caller's authorization for unrestricted `exec` on master, because such a caller can already read the secret store. Rules on `exec` scoped by arguments or paths are skipped for this; the first other rule matching `exec` on master decides, else the default. With no rules this allows; a deny or ask on master `exec` that does not depend on the command, or an Agent-local layer ending in a selector-free deny, denies (or asks), even after a command allowlist. Legacy isolated Agents are refused except for secrets they own.
- `secrets` is a top-level selector only and cannot be combined with `externalId`.

## Ordering and fallback

The first **enabled matching rule** wins. Present conditions within one rule are AND; a list of exact alternatives within one scalar matcher is OR. Use separate rules for alternative sets of conditions. An early allow is not overridden by a later deny. A rule without `agent`, `session`, or `externalId` can match both internal and external callers.

For unmatched internal calls, `defaultAction` applies. For unmatched external calls, the result is always deny, even with `defaultAction: allow` or `ask`. A matching `ask` rule also denies an external call. A missing policy file preserves internal default-allow compatibility and denies unmatched external calls. Other read errors and invalid YAML fail closed after the loader's fresh retry; an old expired cache is not a fallback.

Choose the policy's purpose before writing rules:

- A **deny patch** adds selected denials without defining the caller's remaining capabilities; those still follow later rules or the internal default. It does not establish an allowlist.
- A **caller allowlist** grants specific capabilities and finishes with a deny for that caller, as in the first example. Earlier matching rules can still bypass that block, so review the complete ordering.

Use a caller allowlist for restricted or untrusted Agents. Use a deny patch when you intentionally retain the caller's other existing access rather than defining a restricted capability set.

Before granting a builtin, check:

1. **Targets and defaults:** which parameters select an Agent, Session, Node, path, or channel? Follow the actual resolver; omission does not universally mean self.
2. **Effects:** include reads, mutations, file delivery, notifications, and queued input. For example, task assignment, comments, and completion can notify another Session; granting task operations is not merely granting a private task list.
3. **Expressibility:** can existing matchers enforce the intended boundary? If not, omit the capability from the baseline or make it a separately reviewed grant; do not compensate with an unconditional allow.

## Require approval

`action: ask` makes a matching internal call wait for a person's decision before it runs. The request appears in the WebUI dock of the calling Session with the tool, arguments, resolved targets and the asking rules' reasons; the approver may add a note, which the agent receives on approval and on rejection.

```yaml
- id: confirm-production
  agent: ops
  tool: { source: node, name: exec }
  node: production
  action: ask
  reason: Commands on production
  approval:
    timeoutSeconds: 1800
    approvers: [alex]
```

- `approval` is optional and valid only with `ask`. `timeoutSeconds` is an integer from 30 to 604800. `approvers` lists 1–64 access identity IDs. Ask cannot be combined with an `externalId` selector.
- The instance administrator can always decide. A scoped WebUI identity decides only when its `webui.sessions` scope includes the Session and every rule that asked for this call names it. When several layers ask, the shortest timeout applies. `approvers` limits who decides, not who sees: anyone who can open the Session sees the request and its arguments, as they see the call in its history.
- Layers combine deny over ask over allow: any denying layer denies the call; otherwise any asking layer makes it wait. The call is authorized again against the current policy after approval, so a deny installed meanwhile still wins.
- Without `timeoutSeconds`, foreground calls wait until a decision or Stop. Unattended timer script slices and webhook handler runs use one hour. A pending request expires when Foxwarm restarts; the call is not replayed. If the call is stopped after approval but before it starts, the request is recorded as cancelled.
- An approval covers exactly one call and the internal checks of that call. An ask that applies only to an internal step of another allowed call (for example, a tool that reads the policy file as part of its work) is not requested and fails the call; ask for the outer tool instead. Nested ToolScript calls are separate calls and ask on their own.
- A timer that would later create a Session through an asking `create_session` outcome is rejected at registration.
- Discovery treats an asking tool as possibly invocable. Other Channels receive only a notice that a call is waiting.

## Match fields

| Field | Meaning |
| --- | --- |
| `agent` | Internal caller's authoritative Agent, not the target Agent; never matches an external caller |
| `session` | Caller/source execution Session ID, not a target Session; external execution contexts are not internal Sessions |
| `externalId` | Verified inbound identity ID; never matches an internal caller |
| `tool` | Concrete source/server/name selector, or exact tool-name shorthand |
| `targetNode` | Actual trusted execution Node; not a caller-supplied authority claim |
| `args` | Map of dotted argument names to exact scalar or registered Session/owned-Task target matchers |
| `path` | Containment conditions on supported source-specific file path facts |

Scalar fields accept an exact scalar, an exact list, or an object with `equals`, `oneOf`, and/or `exists`. Conditions in that object are also AND. These legacy scalar matchers remain exact: there are no regex, substring, or shell-command operators. Only the new top-level `session` and `node` identity selectors below interpret `*`. Argument strings never become patterns.

Prefer explicit tool selectors:

```yaml
source: mcp
server: project-tools
name: lookup_issue
```

`source` accepts `builtin`, `node`, or `mcp`. `tool: read` matches the name alone across sources; it does not mean a master file read. Node-environment operations such as `read`, `write`, `edit`, and `exec` use `source: node`, including on `master`. Management operations such as `set_config` use `source: builtin`. Direct calls, unified `call_tool`, and ToolScript resolve to the same concrete identity. Do not grant a wrapper named `call_tool`, `foxwarm_call`, or `foxwarm_session` in place of the actual operation.

### Session scope

Exact target scope usually uses `args.sessionId`, not `match.session`:

```yaml
version: 1
defaultAction: allow
rules:
  - id: peer-send-review
    match:
      externalId: peer
      tool: { source: builtin, name: send_to_session }
      args: { sessionId: project/review }
    action: allow
  - id: peer-deny-other-tools
    match:
      externalId: peer
    action: deny
```

This grants only inbound send to one existing Session for `peer` if no earlier rule wins. It does not grant read/list, create a Session, or transfer the external identity's privileges to the receiving Session. Inbound Session-list permission exposes the bounded global catalog; per-ID read and send grants do not filter it. A model's own Session list shows only itself and the Sessions its policy might let it read, message, assign to, stop or rename.

Internal callers may also use registered relationship matching:

```yaml
version: 1
defaultAction: allow
rules:
  - id: reviewer-send-same-agent
    match:
      agent: reviewer
      tool: { source: builtin, name: send_to_session }
      args:
        sessionId:
          session:
            sameAgent: true
    action: allow
  - id: reviewer-deny-other-tools
    match: { agent: reviewer }
    action: deny
```

The `session` matcher supports `self: true`, `sameAgent: true`, and `relation: parent | child | [parent, child]`. Present fields are AND; parent/child are direct canonical links and can cross Agents. Self does not include siblings or descendants. This is supported only for exact registered builtin families: `session`, `send_to_session`, `send_file`, timer CRUD, `recall`, archive reads, `view_session`, `stop_session`, and the `task` assignment target. Names combined in one selector must share one registered target resolver. It is not available for arbitrary MCP/Node arguments or external callers. Missing-argument/alias behavior follows each tool, not a universal “missing means self” rule; channel-target file delivery has no Session target. Nonexistent or invalid targets do not match.

| Registered family | Target/default behavior |
| --- | --- |
| `session` | `sessionId` defaults to the calling Session for every action, including `list`. `{session: {self: true}}` allows the list and the caller's own status; `{sameAgent: true}` also allows status of the Agent's other Sessions. |
| `send_to_session` | Required `sessionId`; resolves `<main>`, `<parent>`, and catalog aliases. Self-send is rejected by the handler even if policy allows it. |
| `send_file` | Session target defaults to self only without a non-empty channel target. Channel delivery has no Session relationship target. |
| `create_timer`, `list_timers`, `update_timer`, `delete_timer` | `sessionId` defaults to self. This matcher scopes the owner, not persisted timer settings or `agentName` for new-session delivery. |
| `get_archived_messages`, `get_archived_blocks` | `sessionId` defaults to self. |
| `recall` | Exact recall defaults to self. Vector search without `sessionId` has a self target only with `scope: current-session`; broader/default search has no single Session target. |
| `view_session` | Required `sessionId`; no universal default. |
| `stop_session` | Required `sessionId`; no universal default. |
| `task` | `ownerSessionId`, the Session a Task is assigned to; absent means no match. `<parent>` and `<main>` are not resolved here, so callers must pass the real Session ID. Use the owned-Task matcher on `taskId` for the caller's own Tasks. |

Each table row is a separate resolver family; combine names only within the same row when a rule uses the Session matcher. The family registry is `ToolAuthorizationPolicy.TargetResolvers` in the Main server; see the [policy selectors and authoritative facts](../../../docs/code-index/units/tool-authorization.md#policy-selectors-and-authoritative-facts) for target and default resolution.

Registered target resolution uses authoritative catalog IDs and direct-parent facts, not ID prefixes. Scalar argument matching instead compares the supplied value, before tool-local defaults/normalization. For example, `{ exists: false }` requires absence, not an empty string or `null` accepted as a default by some handlers. `skill.agentName`, timer new-session Agent fields, and channel attachment ownership do not gain relationship matching merely by having target-like arguments. Model-facing Session and Agent lists are filtered by these grants; see List visibility below.

### Session creation targets

To restrict direct and scheduled creation to the caller's Agent without granting other tools, place this deny patch before broader matching allows:

```yaml
- action: deny
  tool: {source: builtin, name: create_session}
  args: {agentName: {agent: {sameAgent: false}}}
```

The Agent matcher is registered only for this exact builtin/argument pair; `sameAgent: true` is also supported. New-Session timer creation/updates reuse generic creation-target policy after normalization, including inherited targets. Their own timer permissions still apply. Future name/settings conditions can make the ordered check indeterminate and reject registration; this does not add trigger-time authorization or change human timer commands. See the [policy contract](../../../docs/code-index/units/tool-authorization.md#session-creation-agent-targets) and [scheduled-work boundary](../../../docs/code-index/behaviors/automation-and-scheduled-work.md#schedule-a-message-or-execute-a-quiet-script).

### Discovery visibility

Discovery and default tool injection conservatively project the ordered policy without knowing every future argument or path. A definite identity-only deny can hide a tool; an argument/path/unknown-target denial does not prove that all invocations are denied. Conditional allows may keep the tool visible. Do not diagnose a rule by assuming every denied call removes its tool schema.

`search_tools` has its own authorization and filters returned capabilities. Only `call_tool` is a permission-neutral dispatcher. ToolScript's nested `call_tool` uses the same resolved authorization boundary; that does not make `run_script` or all of its host functionality an unconditional grant.

#### List visibility

`session(action: "list")` and `list_agents` show the caller's own Session and Agent, plus the Sessions and Agents its policy might let it use. A Session is listed when `session` status or rename, `view_session`, `recall` or archive reads with its `sessionId`, `send_to_session`, `stop_session`, or a `task` created for or assigned to it might be allowed. An Agent is listed when it owns a listed Session, or when creating or moving Sessions there, reading its skills or managing it might be allowed. Timers, `send_file`, compaction and settings tools, `delete_session`, `move_session` and parent changes don't add rows. A rule that allows `session` status for every Session lists every Session; limit it with `args.sessionId: {session: {…}}` to narrow the list. The list doesn't grant any call, and hiding a Session doesn't make it confidential.

### Node and path scope

`targetNode` is the resolved Node for the actual effect. For inbound requests, it is absent for Session operations, outbound MCP calls, and pairing administration; it is not inferred as `master`. Adding `targetNode: master` to an external Session-send rule would prevent that rule from matching.

`path` accepts optional `arg` (one name or a list), `allWithin`, and/or `anyNotWithin`. At least one containment condition is required. Omitted `arg` selects all derived path records; no selected records means no match. Supported variables are `${agent.dir}`, `${agent.memoryDir}`, and `${workspace}` (the instance Agent directory root, not the Session cwd). Agent variables cannot match an external caller with no Agent.

Path facts are derived for supported file/memory tools, patch headers, file delivery/image saves, policy candidates, copy legs, and `exec.cwd`; an unrelated MCP tool named `read` gains no filesystem facts. Master paths canonicalize existing symlinks and the nearest existing ancestor for prospective paths. Remote paths remain Node-owned/opaque: they cannot satisfy host `allWithin` rules and count as outside for `anyNotWithin`. Use trusted Node/environment boundaries rather than pretending a Main path base restricts remote files.

Even a permitted `exec` with a matched cwd can execute commands that access other paths or the network. Path containment is not an OS sandbox and does not promise protection against concurrent symlink replacement between authorization and the filesystem effect.

## Agent-local layers

An Agent can also carry its own ordered rule list. Set it with `create_agent({rules})` or replace it with `set_agent_rules`. The list uses the version-1 rule syntax above, written as a JSON array, but without caller selectors (`agent`, `session`, `externalId`): a layer always applies to calls made by Sessions of its own Agent **and of every Agent created from it**, directly or indirectly.

```json
[
  {"id": "no-master", "node": {"exact": "master"}, "action": "deny"},
  {"id": "current-node", "tool": {"source": "node"}, "node": {"current": true}, "action": "allow"},
  {"id": "report", "tool": {"source": "builtin", "name": "send_to_session"},
   "args": {"sessionId": {"session": {"relation": "parent"}}}, "action": "allow"},
  {"action": "deny"}
]
```

- **Evaluation.** The global policy decides first. Then every local layer on the creator chain, from the top-level Agent down to the caller's own Agent, must pass. Within a layer the first enabled matching rule decides; a call that matches no rule passes that layer. End a layer with `{"action": "deny"}` to make it an allowlist.
- **Layers only narrow.** A local allow passes only its own layer. It cannot override a deny or ask from the global policy or another layer, including a global `defaultAction: deny`, so the global policy must also let the intended calls through. Local rules may use `ask` with the same `approval` options; layers combine as described in [Require approval](#require-approval).
- **Same facts.** Local rules see the same Node, path, Session-target and owned-Task facts as global rules, including `node: {current: true}` for the caller's selected Node.
- **Who can change a layer.** A model may replace the rules of Agents created by its own Agent, directly or indirectly, but never its own or an ancestor's. Administrators can replace any layer. An empty list removes the layer's rules. Changes apply to the next call; no snapshot refresh is involved.
- **Global `agent:` rules are unchanged.** A global `agent: A` selector still matches only Sessions of A itself, not Agents created from A. Put rules meant for a whole subtree in A's local layer.
- **Scope.** Layers apply to internal Sessions only. Inbound MCP callers have no Agent and remain governed by the global policy alone.
- **Compatibility.** Older Main server versions do not enforce Agent-local layers. Do not run an installation that relies on them with such a version.

Two node-selector details matter for allowlists. A top-level `node` selector also matches the `node` tool's select, inspect and destroy targets and the endpoints of file transfers, so scope an environment allowance with `tool: {source: node}` unless those are intended. `node: {current: true}` also matches `master` when a Session is placed there, so put an explicit master deny first. The [agent-management templates](../../agent-management/references/memory-templates/) include complete reviewed layers for a restricted worker and a channel assistant.

## Generic policy and tool-local checks

Generic deny applies to every internal Session. Generic allow passes only this policy layer: Agent-local layers, own channel attachment requirements, Node readiness and tool-local validation remain separate checks. A denied call cannot be fixed merely by adding a generic allow if a later check rejects it.

Agents migrated from legacy isolation carry a generated Agent-local layer. Review or replace it with [agent-management](../../agent-management/SKILL.md); a global allow cannot widen it.
