# Connect an external client to Foxwarm

Inbound MCP lets an external client use selected existing capabilities or queue work for an existing Session. It is not the outbound server registry managed by `mcp_config`.

## Prepare the receiving instance

1. Load [access-control](../../access-control/SKILL.md) and merge a private identity into `access.identities` with `surfaces.mcp: {}`. If the same identity needs restricted browser chat, explicitly declare its `webui.sessions` too; neither surface grants the other.
2. Grant only the required concrete tools in the existing policy. Review first-match ordering and identity-neutral rules. External-unmatched calls are denied, including when the policy is absent or its internal default is allow.
3. Apply the complete app candidate through WebUI Setup Config or `set_config` with `target: config`. A running Main HTTP listener can enable its first MCP identity immediately; without that listener, the result requires an approved restart. With no identity declaring `mcp`, authentication is refused. Identity deletion, token rotation, and MCP-surface removal close only the affected contexts and streams. The policy has its separate [safe update workflow](../../access-control/references/policy-updates.md).
4. Use the receiving instance's `/mcp` URL on its existing HTTP port, retaining any reverse-proxy deployment prefix. Use HTTPS over an untrusted network. Send one `Authorization: Bearer <identity-token>` header on every request; WebUI cookies, the instance token, and Node pairing credentials do not authenticate MCP.

A headless receiving instance can set `bot.enableWebUI: false` and `bot.enableTrigger: false`. An MCP identity still enables the shared HTTP server and Node connections.

## Connect from a Foxwarm Session

On the calling instance, follow [outbound connections](outbound.md). Configure the receiver as a named `streamable-http` server using its existing private identity token. Discover its tools:

```json
{
  "query": "foxwarm",
  "sources": ["mcp"],
  "server": "peer",
  "limit": 5,
  "includeSchema": true
}
```

Use this descriptor with `search_tools`, then invoke the returned ID with `call_tool`. For example, after granting a send rule for the exact receiving Session:

```json
{
  "toolId": "mcp:peer/foxwarm_session",
  "args": {
    "action": "send",
    "sessionId": "project/review",
    "message": "Please review the requested change."
  }
}
```

Accepted means queued, not completed or answered. The receiving Session runs under its own Agent and tool permissions. To receive an explicit answer without polling, use [explicit instance replies](instance-replies.md): start notifications **before** sending with `reply: true`. Reading history is a separate permission and operation, not a mandatory reply mechanism.

## Entry points and concrete permissions

| Inbound tool | Use | Policy identity |
| --- | --- | --- |
| `foxwarm_discover` | Search supported Node, outbound MCP, or pairing tools | Each concrete result/capability |
| `foxwarm_call` | Call a discovered tool ID with its arguments | Resolved Node tool, MCP server/tool, or supported builtin |
| `foxwarm_node` | List, inspect selection, or select a Node | `builtin:node` with `args.action` and a real Node target where applicable |
| `foxwarm_exec_result` | Read status/output retained by this MCP context | Original command/tool/Node permission is rechecked |
| `foxwarm_session` | Bounded list/read or send to an existing exact Session ID | `builtin:session`, `builtin:get_session_messages`, or `builtin:send_to_session` |

For send/read, use an exact internal Session ID, not `<main>` or `<parent>`. Session-list permission exposes a bounded global catalog rather than filtering by per-Session read grants. The [policy reference](../../access-control/references/tool-policy.md) explains caller versus target matching and concrete authorization; do not allow the inbound wrapper name as a substitute.

`foxwarm_discover` accepts `sources: ["node"]`, `["mcp"]`, or `["builtin"]` (or combinations). Builtin discovery currently supports `node_pair_list` and `node_pair_approve` only. Do not infer that arbitrary internal builtins are exposed. Node selection does not grant Node tool permission, and approving pairing grants trust rather than tool access.

## Supported environments and retained results

- First-party CLI Nodes must negotiate protocol v3 and advertise external-owner support.
- First-party Docker-worktree Nodes must already be configured, created, and ready. Creation/destruction remains internal administration.
- Configured outbound MCP servers expose only the tools allowed by this external identity's rules.

Supported Node tools are `read`, `write`, `edit`, `apply_patch`, and `exec`. Inbound MCP does not expose execution on `master`, executable providers, browser tabs, cross-Node copy, Node lifecycle changes, or general Agent/Session management. Agent isolation/binding belongs to [agent-management](../../agent-management/SKILL.md); Node bootstrap belongs to [node-setup](../../node-setup/SKILL.md).

An `exec` result returns its actual `execId`. Read it with `foxwarm_exec_result` while the same MCP context lives; do not substitute a PID. Each context retains at most 20 command records, evicts completed records when needed, and rejects another start when 20 remain unresolved. Contexts expire after 15 minutes of inactivity; deletion/restart loses result ownership, not necessarily the already-started OS process. A dropped connection does not mean a mutation was cancelled. Do not automatically repeat an effect with an unknown outcome.

Tool policy is not an OS/network sandbox. Review the selected environment's mounts, credentials, files, and network before granting `exec`.

## Further reference

The public [external MCP client guide](../../../website/src/content/docs/docs/mcp-inbound.md) includes a standalone SDK example and concrete policy-operation mappings. Identity/policy rules remain owned by `access-control`; this reference owns the connection and use path.
