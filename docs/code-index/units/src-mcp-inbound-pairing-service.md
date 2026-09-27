# Unit: src-mcp-inbound-pairing-service

Files: `src/mcpInboundPairingService.ts`, `src/mcpInboundPairingService.test.ts`
Secondary files: `src/mcpInboundCatalog.ts`, `src/tools/definitions.ts`, `src/tools/nodeTools.ts`, `src/nodes/registry.ts`, `src/nodes/websocket.ts`, `packages/cli-node/src/client.ts`

## Purpose

Admits only the existing Main-owned Node pending-pair listing and approval builtins from a verified external MCP identity. This service does not create an internal Session/Agent, mint a Node pairing token, expose bootstrap information, or add a generic builtin dispatcher.

## Behavior and integration

- `listExternalPairingDefinitions` filters only `node_pair_list` and `node_pair_approve` through source-aware potential visibility for the real external identity/context. It returns their unchanged first-party definitions and schemas for canonical `builtin:` discovery.
- `callExternalPairingTool` validates each action's bounded arguments, evaluates the exact concrete `builtin` permission with those arguments and no fabricated `targetNode`, and rechecks live context before calling the existing Main-local Node tool handlers with no internal ToolContext. Approval additionally rechecks the live context and policy at the Node registry's final pre-mutation boundary after asynchronous reads/ID allocation. Unknown or unauthorized requests cannot approve a Node. The normal approval response excludes the newly issued Node authentication token; the authenticated Node receives credentials through its existing WebSocket pairing handshake. A failure after beginning approval has an unknown outcome and is not retried automatically.
- The disposable headless fixture starts one HTTP/Node WebSocket/MCP server without WebUI, supplies the existing pairing token to a first-party CLI Node out of band, checks two external identities and exact conditional policy, lists/approves the pending request via real MCP SDK, observes the Node reconnect authenticated, and invokes real file tools through that Node. It verifies neither pairing nor outbound Node effects create a Foxwarm Session.

The cross-module authorization and source-selection contract is [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge); Node handshake ownership is [node communication](../threads/node-communication.md#pairing-and-authentication).
