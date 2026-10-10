---
name: access-control
description: Configure Foxwarm entry identities, scoped WebUI access, inbound MCP permissions, and internal tool authorization policy. Use for access.identities, tool-authorization.yaml, allow/deny rules, or safe policy updates; use agent-management for Agent lifecycle, isolation, and Node binding.
---
# Access control

Use this skill when deciding who can enter Foxwarm, which Sessions a browser identity can see, or which concrete tools a caller can use.

## Choose a workflow

| Goal | Read when needed |
| --- | --- |
| Add or change a WebUI/MCP identity, scope browser chat, or diagnose login | [Entry identities and WebUI scope](references/identities.md) |
| Write ordered rules for internal Agents/Sessions or external MCP callers | [Tool policy syntax and examples](references/tool-policy.md) |
| Read and merge the existing policy, install a candidate, and confirm behavior | [Safe updates and troubleshooting](references/policy-updates.md) |
| Connect an MCP client/server or exchange explicit replies between instances | Load [mcp-management](../mcp-management/SKILL.md) |
| Create/migrate an Agent, edit inheritance/memory, or bind/unbind isolation to a Node | Load [agent-management](../agent-management/SKILL.md) |

## Essential boundaries

- `access.identities` defines entry credentials and declared `webui`/`mcp` surfaces. The instance token remains a separate WebUI/HTTP superuser credential, not an MCP identity.
- `webui.sessions` selects browser Sessions by exact ID or `<agent>/*`. Exact bindings follow Session aliases; Agent scopes follow current Agent membership and include future Sessions. Neither grants tools or Agent permissions. A selected Session still executes with its own Agent and tool policy; its tool results are visible in chat without content redaction.
- An identity with `mcp: {}` can authenticate to `/mcp` but has no automatically granted tools. Unmatched external calls are denied even when the policy's internal `defaultAction` is `allow`.
- `state/tool-authorization.yaml` applies to isolated and non-isolated internal Sessions and verified external MCP identities. The first enabled matching rule wins; an earlier broad allow can hide a later deny.
- Authorize the resolved concrete builtin, Node tool, or MCP server/tool, not `call_tool` or an inbound wrapper such as `foxwarm_call`.
- A policy allow does not override legacy isolated-Agent rules, bound-Node/path restrictions, or tool-local checks. Agent lifecycle and actual isolation creation/binding/migration belong to `agent-management`, not this skill.
- Tool rules are not an operating-system or network sandbox. A permitted `exec` can use the chosen environment's commands, files, credentials, and network; path rules do not constrain arbitrary shell effects.

Do not write live credentials into chat, public examples, or commits. Setup Config saves and `set_config` apply supported identity changes without restarting; other app settings can still require restart. Policy updates retain their per-process cache lifecycle. Loading this skill does not authorize an update or a restart.
