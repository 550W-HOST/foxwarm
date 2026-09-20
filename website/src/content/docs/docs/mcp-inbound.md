---
title: Connect an external MCP client
description: Enable Foxwarm's MCP endpoint and grant an external client access to selected tools, Nodes, or Sessions.
---

Foxwarm exposes a Streamable HTTP MCP endpoint at `/mcp` on the **same HTTP port as the WebUI**. Each external identity has its own token, and tool rules determine what it can use. The endpoint is disabled by default.

This page is for clients connecting **to Foxwarm**. To connect Foxwarm to another tool server, see [outbound MCP](/docs/tools-skills-mcp/#connect-an-mcp-tool-server).

## Configure an identity

Add this block to `state/config.yaml` in your data directory:

```yaml
mcpInbound:
  enabled: true
  identities:
    editor:
      token: REPLACE_WITH_A_LONG_PRIVATE_TOKEN
```

Replace the token before starting Foxwarm. For another client identity, add another named entry with a different token. Do not reuse the WebUI or Node pairing token. These credentials are read from YAML, not from environment variables.

Restart Foxwarm after changing the configuration. With the default port, the endpoint is `http://localhost:3001/mcp`. Behind a reverse proxy, retain the deployment prefix, for example `https://your-host.example/foxwarm/mcp`. Use HTTPS when sending credentials over an untrusted network.

Configure the client to send `Authorization: Bearer <token>` on every request. WebUI cookies are not used for MCP authentication.

## Grant a capability

Add rules to `state/tool-authorization.yaml`. For an existing policy, preserve its rules and default action; do not replace it with a sample policy.

The following complete example grants `editor` only the `read` tool on a ready Node named `worker-one`. The default action remains `allow` for unmatched **internal** calls; unmatched **external** calls are always denied.

```yaml
version: 1
defaultAction: allow
rules:
  - id: editor-read-worker
    match:
      externalId: editor
      tool: { source: node, name: read }
      targetNode: worker-one
    action: allow
```

Rules use the first matching entry. A broad existing allow rule can also match external callers, so review the whole policy before enabling the endpoint. A missing policy gives external clients no access, and an unreadable policy fails closed.

The MCP entry points are not separate permission identities. A call through `foxwarm_call` is checked against the concrete tool, its arguments, and its target. Node tools use the actual `targetNode`; Session operations and pairing administration do not have a Node target.

## Connect and call a tool

The example below uses `@modelcontextprotocol/sdk`. Supply your own base URL and token in the client application:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL('http://localhost:3001/');
const token = 'REPLACE_WITH_THE_EDITOR_TOKEN';
const transport = new StreamableHTTPClientTransport(new URL('mcp', base), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'example-client', version: '1.0.0' });
await client.connect(transport);
try {
  const found = await client.callTool({
    name: 'foxwarm_discover',
    arguments: { sources: ['node'], nodeId: 'worker-one', query: 'read', limit: 5 },
  });
  if (found.isError) throw new Error('Tool discovery failed');
  const read = found.structuredContent?.tools?.find(tool => tool.name === 'read');
  if (!read) throw new Error('No permitted read tool found');

  const result = await client.callTool({
    name: 'foxwarm_call',
    arguments: { toolId: read.toolId, args: { filePath: 'README.md' } },
  });
  console.log(result);
} finally {
  await client.close();
}
```

Keep a trailing slash on the base URL, including any deployment prefix. Replace `worker-one` with your Node ID and choose a file on that Node. Pass the discovered `toolId` unchanged; discovery does not guarantee that different arguments will be authorized.

## Available entry points

| MCP tool | Purpose |
| --- | --- |
| `foxwarm_discover` | Find supported tools and inspect their inputs |
| `foxwarm_call` | Call a concrete tool by its `toolId` |
| `foxwarm_node` | List, inspect the current selection, or select a Node |
| `foxwarm_exec_result` | Read command status and bounded output for the current MCP context |
| `foxwarm_session` | List internal Sessions, read a bounded preview, or queue a message |

`foxwarm_discover` accepts `sources: ['node']`, `['mcp']`, or `['builtin']`. The supported builtins are currently the two Node pairing actions.

### Additional rule examples

Each row below describes a separate rule. Put the listed fields under `match` alongside `externalId`, then set the rule's `action` to `allow`. Grant only the operations the client needs.

| Operation | Concrete tool match | Other match fields |
| --- | --- | --- |
| List Nodes | `{ source: builtin, name: node }` | `args: { action: list }` |
| Select a Node | `{ source: builtin, name: node }` | `targetNode: worker-one`, `args: { action: select, nodeId: worker-one }` |
| Inspect the current Node | `{ source: builtin, name: node }` | `targetNode: worker-one`, `args: { action: status }` |
| Run a command | `{ source: node, name: exec }` | `targetNode: worker-one` |
| Call an outbound MCP tool | `{ source: mcp, server: configured-server, name: allowed_tool }` | No Node target |
| List Sessions | `{ source: builtin, name: session }` | `args: { action: list }` |
| Read a Session | `{ source: builtin, name: get_session_messages }` | `args: { sessionId: existing-session-id }` |
| Send to a Session | `{ source: builtin, name: send_to_session }` | `args: { sessionId: existing-session-id }` |
| List pending pairings | `{ source: builtin, name: node_pair_list }` | No Node target |
| Approve a pairing | `{ source: builtin, name: node_pair_approve }` | `args: { nodeId: new-worker }`; no Node target |

Session-list permission exposes a bounded global catalog, not a list filtered by separate per-Session read permissions. Pairing approval grants trust to a Node and should be reserved for an operator. It does not automatically grant permission to call that Node's tools.

## Send work to a Session

After granting a send rule for the target, call:

```js
await client.callTool({
  name: 'foxwarm_session',
  arguments: {
    action: 'send',
    sessionId: 'existing-session-id',
    message: 'Please check the build.',
  },
});
```

A successful result confirms that the message was queued, not that the Session has read or answered it. The Session runs under its own Agent and existing permissions. Reading the response requires a separate read permission and `foxwarm_session` call with `action: 'read'`.

## Background commands

An `exec` call returns its actual `execId`. While the same MCP context is alive, pass that ID to `foxwarm_exec_result` to inspect output. Omit the ID to list retained commands. Result reads recheck permission for the original command and Node.

Each context retains up to 20 command records. Starting a new command can evict the oldest completed record; 20 unresolved commands block another start. Contexts expire after 15 minutes of inactivity. Deleting the context or restarting Foxwarm also loses result ownership.

A dropped HTTP connection does not mean the command was cancelled. Already-started commands are not killed when their context is deleted. If a mutation's outcome is unknown, do not automatically repeat it.

## Run without a WebUI

For a headless installation, add these settings to the same app configuration:

```yaml
bot:
  enableWebUI: false
  enableTrigger: false
```

With inbound MCP enabled, Foxwarm still starts its HTTP server and Node connections. You can leave both settings enabled when MCP shares a normal WebUI installation.

To pair a CLI Node, an administrator supplies the existing token from the instance's private `state/node_token` file to that Node. An authorized MCP operator can then discover and call `node_pair_list` and `node_pair_approve`. The MCP endpoint never returns the bootstrap token. See [Nodes](/docs/nodes/) for client setup.

## Supported execution environments

- **First-party CLI Nodes:** must negotiate protocol v3 and advertise external-owner support. Update older clients before using them through MCP.
- **First-party Docker-worktree Nodes:** must already be configured, created, and ready. Creation and destruction remain internal administrative operations.
- **Configured outbound MCP servers:** expose only tools permitted by the external identity's rules.

The supported Node tools are `read`, `write`, `edit`, `apply_patch`, and `exec`. The endpoint does not currently expose execution on `master` or executable providers, browser tabs, cross-Node copy, Node lifecycle changes, or general internal Session/Agent tools. Model-hosted search is not a Node capability.

Tool rules do not provide operating-system isolation. Granting `exec` permits commands in the selected environment; review its files, mounts, credentials, and network access accordingly.
