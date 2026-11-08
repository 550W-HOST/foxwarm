---
title: Access control
description: Decide who can reach your agents, which tools each Agent may use on which Node, and how to keep credentials out of an agent's reach.
---

A new installation trusts its agents: they can use every tool on every Node you add. That is convenient for a personal instance. When agents work for other people, read untrusted content or should only touch certain machines, Foxwarm lets you narrow this down at several independent points.

| Question | Controlled by |
| --- | --- |
| Who can sign in or call in? | The WebUI token, [identities](#scoped-webui-access), [webhooks](/docs/webhooks/) and Channel [allow lists](/docs/channels/#who-can-talk-to-the-agent) |
| Which tools may this Agent use, with which arguments, on which Node? | [Instance rules](#instance-wide-rules) and [rules for each Agent](#rules-for-each-agent) |
| What can a permitted command actually reach? | The Node's operating-system user, files and network |

Tool rules are not a sandbox. A permitted shell command can do whatever the Node's user can do. Choose Nodes, OS users and network access to match the work.

## Instance-wide rules

Instance rules live in `state/tool-authorization.yaml`:

```yaml
version: 1
defaultAction: allow
rules:
  - agent: support
    tool: { source: node, name: [read, exec] }
    node: support-box
    action: allow
  - agent: support
    action: deny
```

- Rules are checked in order and the **first matching rule wins**. An early allow is not overridden by a later deny.
- Within a rule, all conditions must match. `agent` and `session` select the **calling** Agent or Session; `tool` selects the concrete tool (`source: builtin`, `node` or `mcp`); `node` selects where it runs; `args` and `path` match arguments and file paths.
- A call that matches no rule gets `defaultAction`. Calls from external MCP clients that match no rule are always denied.

To restrict one Agent, list what it may do and finish with a deny for that Agent, as above. Ask the agent to load the `access-control` Skill for the complete matcher reference and safe update steps.

## Ask before a tool runs

A rule can ask for a decision instead of allowing or denying:

```yaml
version: 1
defaultAction: allow
rules:
  - id: confirm-production
    agent: ops
    tool: { source: node, name: exec }
    node: production
    action: ask
    reason: Commands on production
    approval:
      timeoutSeconds: 1800
      approvers: [alex]
```

A matching call waits until someone approves or rejects it in the WebUI. The request appears above the message box with the tool, its arguments and targets, and the rule's reason. You can add a note for the agent either way. The call runs only after approval; a rejected or expired request returns an error to the agent, and Stop cancels a waiting call.

- You can always decide as administrator. A [scoped identity](#scoped-webui-access) can decide only when it can see the Session and every rule that asked names it in `approvers`.
- Without `timeoutSeconds`, a call waits until someone decides or the turn is stopped. Scheduled scripts give up after an hour unless the rule sets a deadline.
- A request still waiting when Foxwarm restarts is dropped. The call does not run later.
- Each approval covers one call. Repeating the call asks again.
- Rules in every layer still apply: a deny anywhere wins, and the call waits only when no layer denies it. `defaultAction: ask` and Agent rule lists can ask too.
- External MCP clients cannot wait, so for them a rule that asks counts as a deny.
- Other Channels receive a notice that a call is waiting; decisions are made in the WebUI.

## Rules for each Agent

Every Agent can also carry its own rule list. These rules use the same format, minus the caller selectors (`agent`, `session`, `externalId`): they always apply to calls from that Agent.

For each tool call, Foxwarm checks the instance rules first, then the rule list of every Agent in the chain from the top-level Agent down to the calling one. **Every layer must allow the call.** Within an Agent's list, a call that matches no rule passes that layer, so end with `{ action: deny }` when you mean "only these":

```yaml
# rules for the ci-runner Agent
- node: build-box
  action: allow
- tool: { source: builtin, name: [send_to_session, wait] }
  action: allow
- action: deny
```

Agents get their rules when they are created (`create_agent` with `rules` and an optional `defaultNode`) and can have them replaced with `set_agent_rules`. Only an Agent's creators, or you as administrator, can change its rules, and a creator's own rules still apply on top. So an agent can set up a helper with less access than itself, but never more. See [Agents that create Agents](/docs/agents-sessions-memory/#agents-that-create-agents).

## Node trees

Nodes can have a parent. Granting a Node in a rule also covers the Nodes below it, so you can give an Agent "build-box and anything created under it" with one rule.

| Selector | Matches |
| --- | --- |
| `node: build-box` | `build-box` and its descendants |
| `node: { exact: build-box }` | Only `build-box` |
| `node: { current: true }` | The Session's currently selected Node |
| `node: { provider: development }` | Nodes from one Node provider |

A parent is set when a Node is created: a pairing credential made with a parent Node, or `parentNode` in a provider's configuration. Creating a Node under a parent requires permission for that parent, so an Agent limited to `build-box` can add Nodes beneath it but not elsewhere. Nodes with children cannot be removed until the children are removed, or removed together with them.

Adding a parent to an existing Node can change how earlier rules match, because a rule for the parent now also covers it. Review rule order when you introduce parents, and use `{ exact: ... }` for grants that should cover one Node only.

## Keep credentials out of an agent's reach

Model requests and MCP calls are made by the Foxwarm server on the agent's behalf. The agent never needs to see the keys. You can configure an Agent so that it uses models and MCP tools normally but has no tool that can read the files where those keys are stored:

```yaml
# rules for the helper Agent
- node: build-box                                  # files and commands only on build-box
  action: allow
- tool: { source: mcp, server: project-tools }      # use this MCP server's tools
  action: allow
- tool: { source: builtin, name: [send_to_session, wait] }
  action: allow
- action: deny                                     # nothing on master, no config tools
```

With these rules the helper cannot read or run anything on `master`, so it cannot reach `state/models.yaml`, `state/mcp.json` or other server files, and a prompt injection cannot make it print what it cannot read. `build-box` holds no Foxwarm keys. Anything you place on that Node yourself, such as environment variables or files, remains readable there.

## Scoped WebUI access

Your sign-in token is a full administrator credential. To let someone else chat with selected Sessions in their browser, add an identity in `state/config.yaml`:

```yaml
access:
  identities:
    alex:
      token: REPLACE_WITH_A_LONG_PRIVATE_TOKEN
      surfaces:
        webui:
          sessions:
            - support/main     # one Session
            - docs/*           # every Session of the docs Agent
```

Alex signs in with that token and sees only those Sessions: chat, history and tool results, without Setup, Code, Terminal or slash commands. Save the change through **Setup → Config** to apply it without a restart.

The Sessions still run with their own Agent's rules. If Alex should not see something, do not let that Session's tools return it.

## External MCP clients

Programs and other Foxwarm instances can call in through the inbound MCP endpoint with their own identity (`surfaces.mcp: {}`). They get no tools until instance rules allow them by `externalId`. See [Connect an external MCP client](/docs/mcp-inbound/).

## Webhooks

GitHub, Cloudflare and monitoring tools can notify one Session through a webhook identity (`surfaces.webhook`). A delivery is data for that Session and grants the sender no tools. See [Webhooks](/docs/webhooks/).
