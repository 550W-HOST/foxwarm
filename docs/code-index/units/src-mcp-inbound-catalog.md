# Unit: src-mcp-inbound-catalog

Files: `src/mcpInboundCatalog.ts`, `src/mcpInboundIntegration.test.ts`
Secondary files: `src/mcpInboundHttp.ts`, `src/mcpExternalService.ts`, `src/mcpClient.ts`, `src/tools/resolvedTools.ts`, `src/tools/unifiedSearch.ts`, `src/toolAuthorization.ts`

## Purpose

Implements the two approved inbound MCP discovery/call wrappers for actual enabled outbound MCP servers. The production Main process installs this catalog into the identity-bound Streamable HTTP service. It does not advertise builtin/Node tools, invent an internal Session, or expose Agent, Node, filesystem, or messaging operations.

## Key exports

- `McpInboundMcpCatalog.listTools(context, principal)` — returns only `foxwarm_discover` and `foxwarm_call` with fixed tool/parameter schemas and descriptions. The supplied principal is the trusted HTTP verifier result, not reconstructed from mutable context fields or RPC data.
- `McpInboundMcpCatalog.callTool(context, name, args, signal, principal)` — validates wrapper arguments and dispatches discovery or one exact canonical `toolId`. The context ID is passed only as an external `session` policy fact; Node selection and cwd are not used for outbound MCP.

## Discovery and calls

- `foxwarm_discover` asks Main's canonical live MCP server registry for enabled servers, retrieves SDK-listed tools through the external-specific Main facade, and filters each item through potentially visible generic policy rules. An allow conditioned on call arguments may appear here; the exact call must still pass policy. Server/tool identities with no visibility are omitted. The implementation uses the unified resolver's tool ID builder/parser and unified search's query scoring/tie-break ordering, without parsing human-readable output or inventing a pagination framework.
- The result contains structured tool entries with source/server/toolId/name/description and optional input schema/annotations plus a bounded text summary, returned count, visible total, truncation flag, and whether all considered server totals were known. Schema-bearing discovery is capped independently at 512 KiB: oversized schemas may be omitted with `schemaOmitted`, otherwise remaining items are truncated. Server lookup failures do not expose a denied server's tool names or error details.
- `foxwarm_call` admits only exact `mcp:server/tool` IDs, validates the selected actual source, forwards the HTTP-authenticated principal and external context ID to Main, and returns original SDK content (text, structured, image) within a separate 16 MiB transport limit. Pre-effect policy/lookup rejection, SDK `isError` results, and remote failures are distinguishable; a remote failure/cancellation/transport limit after invocation warns that the outcome may be unknown and is never automatically retried. Configuration secrets in remote result strings and error messages are redacted at the Main boundary.
- Client-supplied `externalId`, `session`, `targetNode`, or guessed tool IDs in arguments are not authorization facts. Missing exact allow is deny even if the internal policy default is allow; a non-Node MCP call supplies no `targetNode` fact.

## Tests

One real SDK client connects through inbound Foxwarm to an independent loopback SDK server configured in Main's live MCP registry. Two external identities have different ordered policies; tests cover generic allow/conditional discovery, actual external session ID, denied/guessed tools, spoofed argument identity, typed text/structured/image output, 100 KiB real text round-trip, remote `isError`, secret redaction, instance-token rejection, cross-identity handle rejection, 20 repeated POSTs without response listener growth, a cancelled remote call with no retry, and the configured outbound SDK tool timeout with no repeated effect. The fake server and registry are local test fixtures, not runtime replacements.

## Design decisions

The cross-module capability and authorization contract is canonical in [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge). The SDK transport contract is canonical in [D-mcp-inbound-http-transport](./src-mcp-inbound-http.md#d-mcp-inbound-http-transport).
