# Entry identities and WebUI scope

## Separate entry access from execution permission

| Mechanism | What it grants | What it does not grant |
| --- | --- | --- |
| Instance token | Existing administrator WebUI/HTTP access | Authentication to inbound MCP |
| Identity `surfaces.webui.sessions` | Chat, history, live events, and attachment uploads for selected Sessions | Setup, Code, terminal, management, or Agent/tool authority |
| Identity `surfaces.mcp: {}` | Bearer authentication to the inbound MCP endpoint | Any concrete tool until policy allows it |
| Tool authorization policy | Allow/deny decisions for concrete calls | Entry credentials, new Agents/Sessions, or OS/network isolation |

One configured identity may declare both surfaces with the same token. Surface declarations are capabilities to enter, not permission tiers. The identity ID is the `externalId` used for inbound MCP policy matching. Browser messages do not cause a Session's subsequent tool calls to inherit that external identity: those calls use the Session's internal Agent/Session authority.

## Configuration

Resolve the installation's data directory and app configuration first; load [foxwarm-maintenance](../../foxwarm-maintenance/SKILL.md) when that location is unknown. The default app file is `state/config.yaml` under the data directory. Preserve the existing app settings and identities when merging this example:

```yaml
access:
  identities:
    collaborator:
      token: REPLACE_WITH_A_LONG_PRIVATE_TOKEN
      surfaces:
        webui:
          sessions:
            - project/review
        mcp: {}
```

Replace the token privately and use an existing exact Session ID instead of `project/review`. Omit `webui` for an MCP-only identity, or omit `mcp` for a browser-only identity. An empty `webui.sessions` list is invalid; `mcp` must be an empty object, not a boolean or permission map.

To include every current and future Session in one Agent, use an Agent scope instead:

```yaml
webui:
  sessions:
    - project/*
```

Only `<agent>/*` is a supported pattern; bare `*`, other glob patterns, and regular expressions are not supported. `main/*` selects Sessions belonging to the default `main` Agent even when their IDs have no Agent prefix. Exact IDs and Agent scopes can be combined in the same list. Refresh the page or Session list to see newly created or moved members; authorization checks current membership rather than a login-time snapshot.

The current access parser accepts only:

- `access.identities`: a map with up to 64 identities.
- Identity IDs: 1–128 characters, beginning with an ASCII letter/digit and otherwise using letters, digits, `.`, `_`, or `-`.
- Each identity: `token` and `surfaces`, with at least one supported surface. Tokens must be distinct, non-empty bounded Bearer-token strings (up to 4,096 UTF-8 bytes).
- `webui`: only `sessions`, a non-empty list of up to 256 distinct exact Session IDs or `<agent>/*` scopes. This is a limit on configured entries, not on the number of Sessions an Agent scope may select.
- `mcp`: only `{}`.

Unknown fields are rejected. These tokens are explicit YAML values, not environment-variable substitutions. Do not reuse the instance superuser or Node pairing token; the app validation also rejects identity-token reuse of the instance superuser token. There is no token-issuance API or separate persisted guest-token store.

## Apply an identity change

1. Confirm authority to change entry access and the intended exact Session bindings, Agent scopes, and surfaces. An Agent scope also grants access to future Sessions in that Agent.
2. Read the current app configuration without disclosing its secret values. Merge only the requested identity changes.
3. Save through the installation's supported configuration workflow. Do not use `mcp_config`: that tool manages outbound connections only.
4. Use the installation's approved startup/restart workflow. Access identities are startup-only; a successful file save alone does not update running authentication. Do not restart without the required approval.
5. Check with the identity credential, not the administrator token, that the intended surface works and an unbound Session or undeclared surface is refused. Use a permitted read or another non-mutating operation when checking MCP tools.

For inbound endpoint/client configuration, follow [mcp-management](../../mcp-management/SKILL.md) and its [inbound reference](../../mcp-management/references/inbound.md).

## Restricted WebUI behavior

The identity uses the normal WebUI login flow but receives a restricted chat root, not the administrator workbench. It can chat with selected existing Sessions and see their ordinary history and tool results. Setup, Code, terminal, debug, model controls, sidebar, popup/embedded management surfaces, and other unscoped routes remain administrator-only. Slash commands and mention-prefixed slash commands are rejected before command dispatch.

Exact bindings resolve through committed old-to-current Session aliases. A completed move preserves exact-bound access through the old/new IDs when both resolve to the same live Session, including a move to another Agent. Agent scopes instead use the resolved Session's actual current Agent: a move out removes that scope's access, and an old ID prefix does not retain it. Missing or ambiguous references grant nothing. Binding one exact Session does not bind its siblings. Image access also requires a reference in the selected Session's committed history; arbitrary filesystem downloads are not granted.

A WebUI binding is not a safe substitute for limiting the bound Agent's tool policy or environment. If a visitor should not see a secret, do not send it to that Session or let its tools return it. Creating a dedicated Agent/Session or changing its Node isolation is an [agent-management](../../agent-management/SKILL.md) workflow.

## Troubleshooting

- **Login denied:** check the token's declared surface, privately verify the token, and confirm the process restarted after the last configuration change.
- **Browser login works but `/mcp` fails:** cookies are not MCP authentication. Send one `Authorization: Bearer <identity-token>` header and declare `mcp: {}`; the instance token is not a valid substitute.
- **Login succeeds but a Session is absent:** for an exact binding, verify that it and the requested ID resolve to the same live Session. For an Agent scope, check the Session's current Agent membership and refresh the list.
- **MCP authentication works but calls fail:** entry access and concrete tool permission are separate. Inspect the [ordered policy](tool-policy.md), including earlier identity-neutral rules.
