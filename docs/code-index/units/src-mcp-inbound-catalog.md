# Unit: src-mcp-inbound-catalog

Files: `src/mcpInboundCatalog.ts`, `src/mcpInboundIntegration.test.ts`
Secondary files: `src/mcpInboundHttp.ts`, `src/mcpInboundNodeService.ts`, `src/mcpInboundNodeService.test.ts`, `src/mcpInboundSessionService.ts`, `src/mcpInboundSessionService.test.ts`, `src/mcpExternalService.ts`, `src/mcpClient.ts`, `src/tools/resolvedTools.ts`, `src/tools/unifiedSearch.ts`, `src/toolAuthorization.ts`

## Purpose

Production catalog on the Main-owned authenticated Streamable HTTP endpoint. It registers the approved `foxwarm_discover`, `foxwarm_call`, `foxwarm_node`, `foxwarm_exec_result` and `foxwarm_session` wrappers over enabled outbound MCP servers, compatible first-party authenticated CLI Nodes and bounded Main-owned Session ingress. Wrappers are not concrete permission identities; it never invents an Agent or internal Session.

## Exports and behavior

- `McpInboundMcpCatalog.listTools` returns five fixed schemas/copy for a verified principal. `releaseContext` ends ephemeral Node-result authority when the transport ends without killing commands.
- `foxwarm_discover` lists visible `mcp` and `node` source tools using canonical unified IDs/ranking/order and actual Main registries. A conditional permission may be discoverable; each concrete call rechecks full policy. `builtin` is not advertised as a general external capability. The result has bounded schemas and summary, counts, truncation and partial-server visibility flags.
- `foxwarm_call` validates an exact canonical `mcp:server/tool` or `node:nodeId/tool` ID and structured arguments. MCP calls use the live outbound client and preserve original SDK text, structured data, images and remote `isError`, without changing metadata or ordinary result fields. Node calls go through [src-mcp-inbound-node-service](./src-mcp-inbound-node-service.md) and return bounded text plus structured data; errors before effect and unknown outcomes are not retried.
- `foxwarm_node` authorizes the exact `builtin:node` list/status/select action. `foxwarm_exec_result` rechecks the original concrete `node:.../exec` arguments and the live context, reporting bounded known IDs or a real running/completed/unavailable result. Both delegate rather than maintaining another owner map.
- `foxwarm_session` validates its list/read/send action-specific inputs, delegates to [src-mcp-inbound-session-service](./src-mcp-inbound-session-service.md), and returns an accepted-only send result after the Session's ordinary durable ingress. It grants no independent wrapper permission, Agent or internal source Session. Pre-admission denial is distinct from an unknown post-admission failure; neither retries an input automatically.
- Inbound HTTP and outbound MCP budgets are separate (8 MiB POST, 512 KiB discovery, 16 MiB result). MCP connection errors and post-effect failures distinguish not-sent from unknown outcome. Metadata echoing a configured token or recognized authentication-header value is omitted; results echoing such a value are withheld whole. Noncredential environment/path/schema values and binary media are preserved. Untyped environment variables, commands, transformed and encoded secrets cannot be inferred reliably; this does not promise universal secret filtering.

## Tests

A real inbound SDK client and independent loopback outbound SDK server cover two external identities, exact policy, text/structured/image/errors, absence of implicit Node facts on outbound MCP, bounded results, cancellations, no effect retries and repeated POSTs. A second paired CLI Node fixture checks registered Node wrappers through real SDK clients; a local/Worker Session fixture checks bounded catalog/read and ordinary durable send with two verified external identities. Source ownership is canonical in [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge); HTTP lifecycle in [D-mcp-inbound-http-transport](./src-mcp-inbound-http.md#d-mcp-inbound-http-transport).
