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

The CLI runs on Main; business tools use the Session's selected Node and normal Agent/ancestor rules. From an authorized ancestor or administrator, restrict an existing worker before assigning work:

```javascript
set_agent_rules({"agentName":"worker", "rules":[
  {"node":"c1", "action":"allow"},
  {"node":"*", "action":"deny"}
]})
```

Create the worker's Claude Code Session with `agentName: "worker"` and `node: "c1"`. This permits the c1 subtree and denies other Node targets; non-Node capabilities keep their existing policy. For parent creation, selector semantics and delegation, see [Node authorization forests](code-index/behaviors/nodes-workspaces-and-permissions.md#node-authorization-forests).

## Limits and precautions

- **Current support:** Linux/Main-local hosting only. Fork, Foxwarm compaction, wait/batch controls and ToolScript run/resume are unavailable. Use `afterSend: "continue"` for reports. Model/effort changes belong to Claude Code, not Foxwarm's Session controls.
- **Trust:** the host account, executable and user/managed configuration are trusted. Private cwd and `--setting-sources user` exclude project/local settings but do not create an OS sandbox or override unrestricted host-tool grants. Review automatic helpers/hooks before real-account use. Flags were checked against 2.1.314; the installed CLI/account still needs qualification.
- **Recovery:** Stop revokes run access and drains the CLI. Unknown input outcomes are not replayed; Continue explicitly resumes known work. Restore a missing transcript or Clear. Clear starts a fresh context and clears Main history, without deleting the CLI account's transcripts.

See the [runtime unit](code-index/units/session-claude-runtime.md) for the full support boundary, credentials, persistence, trust details and open questions.
