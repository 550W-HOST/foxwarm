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

This complete example restricts internal calls from the `reviewer` Agent while preserving the internal default for other Agents. It does not create that Agent or change its isolation/Node binding. Merge rules into the real policy only after reviewing existing ordering.

- Top level: `version: 1`, optional `defaultAction: allow | deny` (omission means `allow`), and optional `rules` (omission means an empty list). Prefer writing both optional fields explicitly.
- Rule: optional unique non-empty `id` (omission assigns `rule-<position>`), optional `enabled` (defaults to `true`), optional `match` (omission/`{}` matches all callers), required `action: allow | deny`, and optional `reason`.
- Limits: at most 256 rules and 256 KiB of policy bytes; IDs up to 128 bytes, reasons up to 1,024 bytes, matcher strings up to 512 bytes, and scalar lists up to 64 items.
- Unknown fields, unsupported versions/operators/path variables, unsafe dotted argument paths, and duplicate IDs are rejected.

## Concise Session and Node selectors

A rule may put `agent`, `session`, `externalId`, `tool`, `node`, `args`, and `path` directly beside `action`. Do not mix these top-level selectors with `match`, even when `match` is empty. Legacy version-1 `match.session`, `match.targetNode` and argument strings retain their exact scalar semantics.

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

## Ordering and fallback

The first **enabled matching rule** wins. Present conditions within one rule are AND; a list of exact alternatives within one scalar matcher is OR. Use separate rules for alternative sets of conditions. An early allow is not overridden by a later deny. A rule without `agent`, `session`, or `externalId` can match both internal and external callers.

For unmatched internal calls, `defaultAction` applies. For unmatched external calls, the result is always deny, even with `defaultAction: allow`. A missing policy file preserves internal default-allow compatibility and denies unmatched external calls. Other read errors and invalid YAML fail closed after the loader's fresh retry; an old expired cache is not a fallback.

Choose the policy's purpose before writing rules:

- A **deny patch** adds selected denials without defining the caller's remaining capabilities; those still follow later rules or the internal default. It does not establish an allowlist.
- A **caller allowlist** grants specific capabilities and finishes with a deny for that caller, as in the first example. Earlier matching rules can still bypass that block, so review the complete ordering.

Use a caller allowlist for restricted or untrusted Agents. Use a deny patch when you intentionally retain the caller's other existing access rather than defining a restricted capability set.

Before granting a builtin, check:

1. **Targets and defaults:** which parameters select an Agent, Session, Node, path, or channel? Follow the actual resolver; omission does not universally mean self.
2. **Effects:** include reads, mutations, file delivery, notifications, and queued input. For example, task assignment, comments, and completion can notify another Session; granting task operations is not merely granting a private task list.
3. **Isolation-dependent checks:** which guards stop running without the isolated flag? Validate the proposed policy with a non-isolated test caller so legacy guards do not mask missing restrictions.
4. **Expressibility:** can existing matchers enforce the intended boundary? If not, omit the capability from the baseline or make it a separately reviewed grant; do not compensate with an unconditional allow.

A familiar name in the legacy default list is not evidence that an unconditional allow is safe after isolation is removed. Use [the offline baseline generator](isolated-rules.md) when its conservative scope fits; review its omissions rather than treating it as an exact migration.

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

`source` accepts `builtin`, `node`, or `mcp`. `tool: read` matches the name alone across sources; it does not mean a master file read. Node-environment operations such as `read`, `write`, `edit`, `apply_patch`, and `exec` use `source: node`, including on `master`. Management operations such as `set_config` use `source: builtin`. Direct calls, unified `call_tool`, and ToolScript resolve to the same concrete identity. Do not grant a wrapper named `call_tool`, `foxwarm_call`, or `foxwarm_session` in place of the actual operation.

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

This grants only inbound send to one existing Session for `peer` if no earlier rule wins. It does not grant read/list, create a Session, or transfer the external identity's privileges to the receiving Session. Session-list permission exposes a bounded global catalog; it is not filtered by per-target read grants.

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

The `session` matcher supports `self: true`, `sameAgent: true`, and `relation: parent | child | [parent, child]`. Present fields are AND; parent/child are direct canonical links and can cross Agents. Self does not include siblings or descendants. This is supported only for exact registered builtin families: `send_to_session`, `send_file`, timer CRUD, `recall`, archive reads, and `view_session`. Names combined in one selector must share one registered target resolver. It is not available for arbitrary MCP/Node arguments or external callers. Missing-argument/alias behavior follows each tool, not a universal “missing means self” rule; channel-target file delivery has no Session target. Nonexistent or invalid targets do not match.

| Registered family | Target/default behavior |
| --- | --- |
| `send_to_session` | Required `sessionId`; resolves `<main>`, `<parent>`, and catalog aliases. Self-send is rejected by the handler even if policy allows it. |
| `send_file` | Session target defaults to self only without a non-empty channel target. Channel delivery has no Session relationship target. |
| `create_timer`, `list_timers`, `update_timer`, `delete_timer` | `sessionId` defaults to self. This matcher scopes the owner, not persisted timer settings or `agentName` for new-session delivery. |
| `get_archived_messages`, `get_archived_blocks` | `sessionId` defaults to self. |
| `recall` | Exact recall defaults to self. Vector search without `sessionId` has a self target only with `scope: current-session`; broader/default search has no single Session target. |
| `view_session` | Required `sessionId`; no universal default. |

Each table row is a separate resolver family; combine names only within the same row when a rule uses the Session matcher. The parser's family registry is in `src/toolAuthorization.ts`, and target/default resolution is in `src/toolAuthorizationSessionTargets.ts`; see the [canonical policy contract](../../../docs/code-index/units/src-tool-authorization.md#policy-contract).

Registered target resolution uses authoritative catalog IDs and direct-parent facts, not ID prefixes. Scalar argument matching instead compares the supplied value, before tool-local defaults/normalization. For example, `{ exists: false }` requires absence, not an empty string or `null` accepted as a default by some handlers. `session`, `skill.agentName`, timer new-session Agent fields, and channel attachment ownership do not gain relationship matching merely by having target-like arguments. A permitted Session list exposes its bounded catalog; individual read grants do not project that list into a private subset.

### Discovery visibility

Discovery and default tool injection conservatively project the ordered policy without knowing every future argument or path. A definite identity-only deny can hide a tool; an argument/path/unknown-target denial does not prove that all invocations are denied. Conditional allows may keep the tool visible. Do not diagnose a rule by assuming every denied call removes its tool schema.

`search_tools` has its own authorization and filters returned capabilities. Only `call_tool` is a permission-neutral dispatcher. ToolScript's nested `call_tool` uses the same resolved authorization boundary; that does not make `run_script` or all of its host functionality an unconditional grant.

### Node and path scope

`targetNode` is the resolved Node for the actual effect. For inbound requests, it is absent for Session operations, outbound MCP calls, and pairing administration; it is not inferred as `master`. Adding `targetNode: master` to an external Session-send rule would prevent that rule from matching.

`path` accepts optional `arg` (one name or a list), `allWithin`, and/or `anyNotWithin`. At least one containment condition is required. Omitted `arg` selects all derived path records; no selected records means no match. Supported variables are `${agent.dir}`, `${agent.memoryDir}`, and `${workspace}` (the instance Agent directory root, not the Session cwd). Agent variables cannot match an external caller with no Agent.

Path facts are derived for supported file/memory tools, patch headers, file delivery/image saves, policy candidates, copy legs, and `exec.cwd`; an unrelated MCP tool named `read` gains no filesystem facts. Master paths canonicalize existing symlinks and the nearest existing ancestor for prospective paths. Remote paths remain Node-owned/opaque: they cannot satisfy host `allWithin` rules and count as outside for `anyNotWithin`. Use trusted Node/environment boundaries rather than pretending a Main path base restricts remote files.

Even a permitted `exec` with a matched cwd can execute commands that access other paths or the network. Path containment is not an OS sandbox and does not promise protection against concurrent symlink replacement between authorization and the filesystem effect.

## Generic policy versus legacy isolation

Generic deny applies to isolated and non-isolated Sessions. Generic allow passes only this policy layer: current legacy isolated-Agent exact tool rules, bound-Node restrictions, own-Agent master paths, Session relations, own channel attachment requirements, and tool-local validation remain separate checks. A denied call cannot be fixed merely by adding a generic allow if a later structural check rejects it.

Use [agent-management](../../agent-management/SKILL.md) for actual isolation creation, binding, migration, and lifecycle operations. Do not remove existing isolation as a workaround for a policy mismatch.

If a separately approved migration removes isolation, the generic policy still applies, but the legacy exact rules and isolated-only guards no longer do. Review lost path/target/incoming restrictions and persisted automation explicitly; [the generated baseline's limits](isolated-rules.md#differences-from-legacy-isolation) are not proof of full equivalence.
