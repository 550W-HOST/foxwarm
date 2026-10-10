---
name: mcp-management
description: Configure outbound MCP servers or inbound Foxwarm access, discover and call MCP tools, and set up explicit replies between Foxwarm instances. Use for HTTP/SSE/stdio connections, credentials, MCP troubleshooting, or Session message notifications.
---
# MCP management

Use this skill to choose the MCP connection or messaging workflow. MCP tools are discoverable with `search_tools` and invoked with `call_tool`; loading a skill does not grant permission.

## Choose a workflow

| Goal | Read when needed |
| --- | --- |
| Connect Foxwarm to another MCP server, list servers, discover/call tools, or change a connection | [Outbound connections](references/outbound.md) |
| Connect an external client to Foxwarm's `/mcp` endpoint, send work to a Session, or use permitted Node tools | [Inbound access](references/inbound.md) |
| Let one Foxwarm Session receive explicit replies from another instance without polling its history | [Explicit instance replies](references/instance-replies.md) |
| Configure an entry identity, restrict WebUI Sessions, or grant/deny concrete tools | Load [access-control](../access-control/SKILL.md) |

## Keep the lifecycles separate

- **Outbound connections:** use the hidden `mcp_config` builtin through `call_tool`. Successful updates apply to subsequent calls without restart. Do not edit the backing MCP state file manually.
- **Inbound identities:** `access.identities` belongs to app configuration; Setup Config and `set_config` with `target: config` apply supported identity changes without restart. `mcp_config` does not create identities or change WebUI access. Follow `access-control` and the installation's approved service-control workflow.
- **Tool policy:** use a merged complete candidate and `set_config` with `target: tool-rules`, not `mcp_config`. The policy update workflow and cache timing belong to `access-control`.
- **Notifications:** explicitly start reception for the current Session and one configured `streamable-http` server, then request `reply: true` when sending work. Normal assistant output is not automatically forwarded.

Never print or commit real tokens, environment secrets, or private headers. Obtain endpoint and credential values through the installation's approved private path; redact diagnostics.

## Related skills

- [agent-management](../agent-management/SKILL.md): Agent lifecycle, inheritance, isolation, and Node binding.
- [node-setup](../node-setup/SKILL.md): Node pairing and bootstrap.
- [toolscript-automation](../toolscript-automation/SKILL.md): orchestration of dependent tool calls.
