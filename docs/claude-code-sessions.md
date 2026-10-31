# Claude Code Sessions

## Quick start

Install and configure Claude Code for the account running Main on Linux (`setsid` is required). Foxwarm uses that account's existing model, login and subscription; it does not supply an LLM model, key or proxy. The optional startup configuration is:

```yaml
claudeCode:
  executable: claude
  credentialLifetimeSeconds: 3600
```

Select **Claude Code** in the new-Session dialog, or call a creation tool with `runtime: "claude-code"`. For example, from an existing Session:

```javascript
create_child_session({"suffix":"cli", "runtime":"claude-code",
  "message":"List the files in the current workspace."})
```

Supply the handoff fields required by your tool schema when confirmation is enabled. Runtime is chosen only at creation; omission selects Foxwarm, including for children of Claude Code Sessions.

## Restrict Agent and Node access

The CLI runs on Main and receives the same Foxwarm tools an ordinary Session would see, filtered by the same global, Agent and ancestor rules. Business tools run on the Session's selected Node.

Each rule layer is evaluated in order, and a call that matches no rule passes that layer. A rule that names only Nodes therefore restricts Node operations but leaves management tools such as `mcp_config` (which can start commands on Main) and `set_config` to the global policy. To confine a worker, list what it needs and end with a catch-all deny. From an authorized ancestor or administrator, before assigning work:

```javascript
set_agent_rules({"agentName":"worker", "rules":[
  {"tool":["read","write","edit","apply_patch","exec"], "node":"c1", "action":"allow"},
  {"tool":"search_tools", "action":"allow"},
  {"tool":{"source":"builtin","name":"send_to_session"},
   "args":{"sessionId":{"session":{"relation":"parent"}}}, "action":"allow"},
  {"action":"deny"}
]})
```

Create the worker's Claude Code Session with `agentName: "worker"` and `node: "c1"`. The worker can use files and commands in the c1 subtree, discover tools and report to its parent Session; everything else is denied, and denied tools are hidden from its tool list. Add further grants such as `task` or memory tools as needed. An Agent that creates its own sub-Agents needs grants for `create_agent`, `set_agent_rules` and `create_child_session`, and for `node_create_auth_token` with the parent Node. For selector semantics and delegation, see [Node authorization forests](code-index/behaviors/nodes-workspaces-and-permissions.md#node-authorization-forests).

## Limits and precautions

- **Current support:** Linux/Main-local hosting only. Fork, Foxwarm compaction, wait/batch controls and ToolScript run/resume are unavailable. Use `afterSend: "continue"` for reports. Model/effort changes belong to Claude Code, not Foxwarm's Session controls.
- **Trust:** the host account, executable and user/managed configuration are trusted. Private cwd and `--setting-sources user` exclude project/local settings but do not create an OS sandbox or override unrestricted host-tool grants. Review automatic helpers/hooks before real-account use. Flags were checked against 2.1.314; the installed CLI/account still needs qualification.
- **Recovery:** Stop revokes run access and drains the CLI. Unknown input outcomes are not replayed; Continue explicitly resumes known work. Restore a missing transcript or Clear. Clear starts a fresh context and clears Main history, without deleting the CLI account's transcripts.

See the [runtime unit](code-index/units/session-claude-runtime.md) for the full support boundary, credentials, persistence, trust details and open questions.
