---
title: Connect an external MCP client
description: Enable Foxwarm's authenticated MCP endpoint and authorize exact tools, Nodes, and Sessions.
---

Foxwarm can serve its existing capabilities to an external MCP client over Streamable HTTP. Inbound MCP is separate from the MCP servers that Foxwarm itself connects to. Each external identity has its own Bearer token; authorization rules decide what that identity may discover and call.

## Enable the endpoint

Add this to your data directory's `state/config.yaml` (alongside your normal model and instance settings):

```yaml
bot:
  httpPort: 3001
  enableWebUI: false
  enableTrigger: false
mcpInbound:
  enabled: true
  identities:
    operatorA: { token: REPLACE_WITH_A_LONG_UNIQUE_PRIVATE_TOKEN_A }
    operatorB: { token: REPLACE_WITH_A_DIFFERENT_PRIVATE_TOKEN_B }
```

The WebUI and trigger can stay enabled in a normal installation. Turning both off leaves the same Foxwarm application serving MCP HTTP and Node pairing/WebSocket connections; it does not install a separate hub. Replace both example tokens with different private values before starting Foxwarm. Do not reuse the WebUI token or the Node pairing token. Omit `mcpInbound` or set `enabled: false` to keep the endpoint disabled. Configuration changes take effect on restart.

Point a Streamable HTTP MCP client at the deployment-relative `mcp` path. Provide `Authorization: Bearer <your-identity-token>` on **every** MCP request, including POST, GET, and DELETE. If a reverse proxy serves Foxwarm under a path prefix, retain that prefix in the base URL.

This JavaScript example uses the MCP SDK's Streamable HTTP client and a base URL ending in `/`:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.env.FOXWARM_BASE_URL ?? 'http://127.0.0.1:3001/');
if (!base.pathname.endsWith('/')) throw new Error('Base URL must end in /');
const token = process.env.FOXWARM_MCP_TOKEN;
if (!token) throw new Error('Provide the external identity token');
const transport = new StreamableHTTPClientTransport(new URL('mcp', base), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'example-external-client', version: '1.0.0' });
await client.connect(transport);
try {
  console.log((await client.listTools()).tools.map(tool => tool.name));
  const found = await client.callTool({
    name: 'foxwarm_discover',
    arguments: { sources: ['node'], nodeId: 'worker-one', query: 'read', limit: 5 },
  });
  if (found.isError) throw new Error('Discovery was denied or unavailable');
  const read = found.structuredContent?.tools?.find(tool => tool.name === 'read');
  if (read) {
    const result = await client.callTool({
      name: 'foxwarm_call', arguments: { toolId: read.toolId, args: { filePath: 'README.md' } },
    });
    console.log(result);
  }
} finally {
  await client.close();
}
```

Substitute an already-ready Node ID for `worker-one`. A discovered entry provides its canonical `toolId`; pass that ID unchanged to `foxwarm_call`. You can also discover `sources: ['mcp']` for configured outbound MCP servers or `sources: ['builtin']` for the two available Node pairing actions. Discovery is only a preview: each call checks the current rules again using its exact arguments and target.

## Grant the concrete capabilities

Create `state/tool-authorization.yaml` in the same data directory. For example, this version 1 policy grants `operatorA` a specific Node, one existing Session, one configured outbound MCP tool, and Node-pairing administration. `operatorB` has no matching allow rule:

```yaml
version: 1
defaultAction: deny
rules:
  - id: external-node-list
    match: { externalId: operatorA, tool: { source: builtin, name: node }, args: { action: list } }
    action: allow
  - id: external-node-select
    match: { externalId: operatorA, tool: { source: builtin, name: node }, targetNode: worker-one, args: { action: select, nodeId: worker-one } }
    action: allow
  - id: external-node-status
    match: { externalId: operatorA, tool: { source: builtin, name: node }, targetNode: worker-one, args: { action: status } }
    action: allow
  - id: external-node-tools
    match: { externalId: operatorA, tool: { source: node, name: [read, write, edit, apply_patch, exec] }, targetNode: worker-one }
    action: allow
  - id: external-session-list
    match: { externalId: operatorA, tool: { source: builtin, name: session }, args: { action: list } }
    action: allow
  - id: external-session-read
    match: { externalId: operatorA, tool: { source: builtin, name: get_session_messages }, args: { sessionId: existing-session-id } }
    action: allow
  - id: external-session-send
    match: { externalId: operatorA, tool: { source: builtin, name: send_to_session }, args: { sessionId: existing-session-id } }
    action: allow
  - id: external-outbound-tool
    match: { externalId: operatorA, tool: { source: mcp, server: configured-server, name: allowed_tool } }
    action: allow
  - id: external-pending-nodes
    match: { externalId: operatorA, tool: { source: builtin, name: node_pair_list } }
    action: allow
  - id: external-approve-node
    match: { externalId: operatorA, tool: { source: builtin, name: node_pair_approve }, args: { nodeId: new-worker } }
    action: allow
```

Replace example identities, IDs, server and tool names with your own. `new-worker` must be an unassigned ID for the pending Node, not the ID of an already-ready Node. Rules are evaluated **in order**, using the first matching rule. `foxwarm_discover`, `foxwarm_call`, `foxwarm_node`, and `foxwarm_session` are inbound wrapper names, **not** the tool names to put in `match.tool`. A Node tool call uses `source: node` and its exact `targetNode`; `foxwarm_node` list has no target, while select checks the requested Node and status checks the currently selected Node. Pairing list and approval do not claim a `master` target. A Session send uses the ordinary `send_to_session` authorization with a real `sessionId`, not the permissions of a newly fabricated Agent. External calls without a matching allow rule are denied even when the policy's internal default action is `allow`. A missing or unreadable policy does not give an external caller access.

The example grants all five file/exec tools on `worker-one`; narrow tool names, target Node, Session ID, and argument matches to your actual needs. Tool rules do not themselves restrict the Node process, create a sandbox, or start a Node. A Docker-worktree Node also enforces its configured worktree/root and symlink checks, but it is not a malicious-code security boundary.

## Work with Nodes and Sessions

- **First-party CLI Nodes:** an operator obtains the *existing* Node pairing token from the master's private local `state/node_token` file and supplies it privately to the Node. The token is never returned by inbound MCP. After that Node requests pairing, an external operator with the two pairing rules above may discover/call `builtin:node_pair_list` and `builtin:node_pair_approve`. An authenticated CLI Node must negotiate core protocol v3 and advertise external-owner support before its `read`, `write`, `edit`, `apply_patch`, or `exec` is available externally. Pairing approval does not automatically grant Node tool rules.
- **First-party Docker-worktree Nodes:** a previously created, configured, **ready** Docker-worktree Node exposes the same five file/exec tools under exact Node rules. It is a local resident provider, not a paired CLI Node. External MCP does not create, ensure, inspect, or destroy the container; an internal administrator must prepare it first. External file reads cannot open the provider's execution-artifact directory. A Node tool may still change an authorized worktree or run a command there.
- **Session input:** `foxwarm_session` supports `list`, `read`, and `send`. For example, call `client.callTool({ name: 'foxwarm_session', arguments: { action: 'send', sessionId: 'existing-session-id', message: 'Please check the build.' } })` after granting that exact Session send rule. An accepted send confirms ordinary durable queue admission, not a reply or completion. The receiving Session continues under its own Agent and existing permissions. Read is a bounded message preview, not a raw queue or current prompt dump.
- **Background commands:** `foxwarm_call` on `node:<nodeId>/exec` returns a real `execId`. While the **same live MCP connection context** remains available, use `foxwarm_exec_result` with that ID to inspect bounded running/completed output, or omit the ID to list the retained jobs. At most 20 records are retained per context; a new command evicts the oldest completed record when full, while 20 unresolved commands reject another command before effect. Idle contexts expire after about 15 minutes, and closing a connection or restarting Foxwarm loses result ownership. Closing a connection does **not** kill a command that already started; it also does not guarantee that a call whose response was lost did not take effect. Do not retry an uncertain mutation automatically.

The external endpoint does not currently execute tools on the colocated `master` Node or startup-configured executable providers, use browser tabs, copy between Nodes, run Node lifecycle mutations, or expose general internal-Session/Agent-affine builtins. A configured outbound MCP server's permitted tools remain callable; there is no built-in model-hosted web search endpoint.
