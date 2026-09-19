# Unit: src-mcp-inbound-node-service

Files: `src/mcpInboundNodeService.ts`, `src/mcpInboundNodeService.test.ts`
Secondary files: `src/mcpInboundCatalog.ts`, `src/mcpInboundHttp.ts`, `src/nodes/providerRegistry.ts`, `src/nodes/manager.ts`, `packages/cli-node/src/client.ts`, `src/toolAuthorization.ts`

## Purpose

Provides a Main-local, verified-principal path to a real authenticated CLI Node without creating a Foxwarm Session or Agent. In the initial owner-seam stage the service is exercised directly in the paired-Node integration fixture; it is **not yet registered as a model-facing inbound MCP tool**. Actual inbound catalog wiring and external exec ownership are separate work in the same feature phase.

## Exports and behavior

- `listExternalNodeTools` walks authority from the Node provider registry and returns only ready authenticated remote Nodes with negotiated core v3, explicit `externalToolOwner:1`, supported file capabilities and a potentially visible ordered external rule. Master, Docker and executable-provider external operations are not claimed as supported.
- `callExternalNodeTool` binds the HTTP-verified externalId and server-created context UUID, evaluates exact source `node`, targetNode, complete argument and execution-derived file/patch path facts before effect, confirms exact ready advertised capability, and routes a disjoint external owner through the same Node registry. Neither sourceSessionId nor Agent is synthesized. Only file primitives are executable at this first seam stage.
- `externalNodeAction` checks the existing `builtin:node` authorization for list/status/select and examines the actual external-support flag. Status reports an unsupported current master without inventing a fallback. Select requires a ready exact supported Node and requests that real Node's default cwd; switching Nodes clears previous context cwd.

The paired test connects a real official `NodeClient` to an authenticated WebSocket, runs exact read/write/edit/apply_patch over the provider, and proves a second external identity cannot use the first identity's Node allowance. It runs under the official bounded test environment and does not start the shared Testing service.

## Canonical ownership

The external-owner protocol boundary belongs to [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility); external tool policy and live context belong to [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge).
