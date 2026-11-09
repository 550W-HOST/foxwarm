---
name: access-control
description: Configure Foxwarm entry identities, scoped WebUI access, inbound MCP permissions, and internal tool authorization policy. Use for access.identities, tool-authorization.yaml, allow/ask/deny rules, or safe policy updates; use agent-management for Agent lifecycle, isolation, and Node binding.
---
# Access control

Use this skill when deciding who can enter Foxwarm, which Sessions a browser identity can see, or which concrete tools a caller can use.

## Choose a workflow

| Goal | Read when needed |
| --- | --- |
| Add or change a WebUI/MCP identity, scope browser chat, or diagnose login | [Entry identities and WebUI scope](references/identities.md) |
| Write ordered rules for internal Agents/Sessions or external MCP callers | [Tool policy syntax and examples](references/tool-policy.md) |
| Restrict one Agent and the Agents created from it | [Agent-local layers](references/tool-policy.md#agent-local-layers) and the [agent-management templates](../agent-management/references/memory-templates/) |
| Generate a conservative isolated-like caller allowlist for review | [Offline generator and its limits](references/isolated-rules.md), using [the script](scripts/generate-isolated-rules.mjs) |
| Read and merge the existing policy, install a candidate, and confirm behavior | [Safe updates and troubleshooting](references/policy-updates.md) |
| Connect an MCP client/server or exchange explicit replies between instances | Load [mcp-management](../mcp-management/SKILL.md) |
| Create/migrate an Agent, edit inheritance/memory, or migrate a legacy isolated Agent | Load [agent-management](../agent-management/SKILL.md) |

## Essential boundaries

- `access.identities` defines entry credentials and declared `webui`/`mcp` surfaces. The instance token remains a separate WebUI/HTTP superuser credential, not an MCP identity.
- `webui.sessions` selects browser Sessions by exact ID or `<agent>/*`. Exact bindings follow Session aliases; Agent scopes follow current Agent membership and include future Sessions. Neither grants tools or Agent permissions. A selected Session still executes with its own Agent and tool policy; its tool results are visible in chat without content redaction.
- An identity with `mcp: {}` can authenticate to `/mcp` but has no automatically granted tools. Unmatched external calls are denied even when the policy's internal `defaultAction` is `allow`.
- `state/tool-authorization.yaml` applies to isolated and non-isolated internal Sessions and verified external MCP identities. The first enabled matching rule wins; an earlier broad allow can hide a later deny.
- `action: ask` makes an internal call wait for an approver's decision in the WebUI. Scoped identities decide only when named by every asking rule and scoped to the Session; external callers treat ask as deny.
- Agent-local rule layers add per-Agent restrictions after the global policy. They apply to the Agent and every Agent created from it, can only narrow, and are changed by a creator-ancestor Agent or an administrator.
- Concise top-level `session`/`node` selectors support identity patterns, current-Node and Provider scope without a Session-to-Node permission binding. Use the policy reference for multi-endpoint and owned-Task semantics.
- Configuration changes that would send a stored secret somewhere new follow the caller's authorization for unrestricted master `exec` unless a top-level `secrets` rule names them; see [Stored secrets](references/tool-policy.md#stored-secrets).
- Authorize the resolved concrete builtin, Node tool, or MCP server/tool, not `call_tool` or an inbound wrapper such as `foxwarm_call`.
- Legacy Agent `isolated` authorization is [deprecated and planned for removal](../../docs/code-index/modules/tools-and-permissions.md#d-tools-legacy-isolation-deprecation). While it remains implemented, a policy allow does not override its exact rules, bound-Node/path restrictions, or tool-local checks. Agent lifecycle and isolation migration belong to `agent-management`, not this skill.
- An isolated-like rules fragment is not a complete isolation replacement. Removing isolation also removes incoming relationship guards and other tool-local restrictions; generating a fragment does not authorize that change.
- Tool rules are not an operating-system or network sandbox. A permitted `exec` can use the chosen environment's commands, files, credentials, and network; path rules do not constrain arbitrary shell effects.
- Tool rules govern Foxwarm tools only. Web search or image generation built into a model are controlled by the model configuration, so give restricted Agents a model without them.

Do not write live credentials into chat, public examples, or commits. Setup Config saves and `set_config` apply supported identity changes without restarting; other app settings can still require restart. Policy updates retain their per-process cache lifecycle. Loading this skill does not authorize an update or a restart.
