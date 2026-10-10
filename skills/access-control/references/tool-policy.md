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
- Rule: unique non-empty `id`, optional `enabled` (defaults to `true`), optional `match` (omission/`{}` matches all callers), required `action: allow | deny`, and optional `reason`.
- Limits: at most 256 rules and 256 KiB of policy bytes; IDs up to 128 bytes, reasons up to 1,024 bytes, matcher strings up to 512 bytes, and scalar lists up to 64 items.
- Unknown fields, unsupported versions/operators/path variables, unsafe dotted argument paths, and duplicate IDs are rejected.

## Ordering and fallback

The first **enabled matching rule** wins. Present conditions within one rule are AND; a list of exact alternatives within one scalar matcher is OR. Use separate rules for alternative sets of conditions. An early allow is not overridden by a later deny. A rule without `agent`, `session`, or `externalId` can match both internal and external callers.

For unmatched internal calls, `defaultAction` applies. For unmatched external calls, the result is always deny, even with `defaultAction: allow`. A missing policy file preserves internal default-allow compatibility and denies unmatched external calls. Other read errors and invalid YAML fail closed after the loader's fresh retry; an old expired cache is not a fallback.

## Match fields

| Field | Meaning |
| --- | --- |
| `agent` | Internal caller's authoritative Agent, not the target Agent; never matches an external caller |
| `session` | Caller/source execution Session ID, not a target Session; external execution contexts are not internal Sessions |
| `externalId` | Verified inbound identity ID; never matches an internal caller |
| `tool` | Concrete source/server/name selector, or exact tool-name shorthand |
| `targetNode` | Actual trusted execution Node; not a caller-supplied authority claim |
| `args` | Map of dotted argument names to exact scalar or registered Session-target matchers |
| `path` | Containment conditions on supported source-specific file path facts |

Scalar fields accept an exact scalar, an exact list, or an object with `equals`, `oneOf`, and/or `exists`. Conditions in that object are also AND. There are no wildcard, regex, substring, or shell-command operators.

Prefer explicit tool selectors:

```yaml
source: mcp
server: project-tools
name: lookup_issue
```

`source` accepts `builtin`, `node`, or `mcp`. `tool: read` matches the name alone across sources; it does not mean a master file read. Node-environment operations such as `read`, `write`, `edit`, `apply_patch`, and `exec` use `source: node`, including on `master`. Management operations such as `set_tool_rules` use `source: builtin`. Direct calls, unified `call_tool`, and ToolScript resolve to the same concrete identity. Do not grant a wrapper named `call_tool`, `foxwarm_call`, or `foxwarm_session` in place of the actual operation.

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

The `session` matcher supports `self: true`, `sameAgent: true`, and `relation: parent | child | [parent, child]`. Present fields are AND; parent/child are direct canonical links and can cross Agents. Self does not include siblings or descendants. This is supported only for exact registered builtin families: `send_to_session`, `send_file`, timer CRUD, `recall`, archive reads, and `get_session_messages`. Names combined in one selector must share one registered target resolver. It is not available for arbitrary MCP/Node arguments or external callers. Missing-argument/alias behavior follows each tool, not a universal “missing means self” rule; channel-target file delivery has no Session target. Nonexistent or invalid targets do not match.

### Node and path scope

`targetNode` is the resolved Node for the actual effect. For inbound requests, it is absent for Session operations, outbound MCP calls, and pairing administration; it is not inferred as `master`. Adding `targetNode: master` to an external Session-send rule would prevent that rule from matching.

`path` accepts optional `arg` (one name or a list), `allWithin`, and/or `anyNotWithin`. At least one containment condition is required. Omitted `arg` selects all derived path records; no selected records means no match. Supported variables are `${agent.dir}`, `${agent.memoryDir}`, and `${workspace}` (the instance Agent directory root, not the Session cwd). Agent variables cannot match an external caller with no Agent.

Path facts are derived for supported file/memory tools, patch headers, file delivery/image saves, policy candidates, copy legs, and `exec.cwd`; an unrelated MCP tool named `read` gains no filesystem facts. Master paths canonicalize existing symlinks and the nearest existing ancestor for prospective paths. Remote paths remain Node-owned/opaque: they cannot satisfy host `allWithin` rules and count as outside for `anyNotWithin`. Use trusted Node/environment boundaries rather than pretending a Main path base restricts remote files.

Even a permitted `exec` with a matched cwd can execute commands that access other paths or the network. Path containment is not an OS sandbox and does not promise protection against concurrent symlink replacement between authorization and the filesystem effect.

## Generic policy versus legacy isolation

Generic deny applies to isolated and non-isolated Sessions. Generic allow passes only this policy layer: current legacy isolated-Agent exact tool rules, bound-Node restrictions, own-Agent master paths, Session relations, own channel attachment requirements, and tool-local validation remain separate checks. A denied call cannot be fixed merely by adding a generic allow if a later structural check rejects it.

Use [agent-management](../../agent-management/SKILL.md) for actual isolation creation, binding, migration, and lifecycle operations. Do not remove existing isolation as a workaround for a policy mismatch.
