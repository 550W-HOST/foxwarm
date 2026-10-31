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
  {"tool":["read","write","edit","exec"], "node":"c1", "action":"allow"},
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

## Custom executable wrappers

`claudeCode.executable` may name a wrapper instead of `claude`, for example to run the CLI in a container or on another host. Foxwarm treats the wrapper exactly like the CLI; any forwarding, file transfer, synchronization and remote cleanup are the wrapper's responsibility. The wrapper must follow this contract:

- **Invocation:** Main starts `setsid --wait -- <executable> <arguments>` with structured arguments (no shell), the inherited environment and the private context directory as the working directory. The wrapper is the leader of a new process group. The arguments are the ones listed by `claude --help` for this mode: `-p`, stream-json input/output, `--tools ""`, `--strict-mcp-config`, `--mcp-config`, `--allowedTools "mcp__foxwarm__*"`, permission flags, `--disable-slash-commands`, `--setting-sources user`, `--settings`, `--append-system-prompt-file`, and either `--session-id <uuid>` for a new context or `--resume <uuid>`.
- **Files:** `--mcp-config`, `--settings` and `--append-system-prompt-file` name Main-local files that are mode 0600 and deleted after the run. The MCP configuration contains one HTTP server named `foxwarm` whose URL is Main's local `/runtime/mcp` endpoint and whose `Authorization` header carries a credential valid only for this run. A remote wrapper must make that endpoint reachable, for example through a tunnel, and must not retain the credential.
- **Input and output:** stdin receives one stream-json user message and is then closed. stdout must carry the CLI's stream-json events, one JSON object per line and at most 8 MiB per record, with the same `session_id`. A `system`/`init` event must report only `mcp__foxwarm__*` tools plus `EndConversation`, exactly one connected `foxwarm` MCP server, no plugins and `dontAsk` permission mode. The run succeeds only after a `result` event; exiting earlier marks the input outcome as unknown, and it is not replayed. stderr is drained and discarded.
- **Resume:** before starting a `--resume` run, Main requires the transcript at `<config>/projects/<cwd>/<uuid>.jsonl` on the Main host, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude` and `<cwd>` is the working directory with every character other than ASCII letters and digits replaced by `-`. A wrapper that runs the CLI elsewhere must keep this file present on Main.
- **Stopping:** after a `result` event, and on Stop or failure, Main sends `SIGINT` to the process group, waits 2 seconds, then kills the process tree and sends `SIGKILL` to the group. The wrapper should forward `SIGINT` to the CLI, exit promptly, and ensure that no remote process outlives it.

See the [runtime unit](code-index/units/session-claude-runtime.md) for the full support boundary, credentials, persistence, trust details and open questions.
