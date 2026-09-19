# Unit: src-mcp-inbound-node-service

Files: `src/mcpInboundNodeService.ts`, `src/mcpInboundNodeService.test.ts`, `src/mcpInboundNodeOwnership.test.ts`
Secondary files: `src/mcpInboundCatalog.ts`, `src/mcpInboundHttp.ts`, `src/nodes/externalExecOwnership.ts`, `src/nodes/providerRegistry.ts`, `src/nodes/manager.ts`, `packages/cli-node/src/client.ts`, `src/toolAuthorization.ts`

## Purpose

Main-local entry from an HTTP-verified external principal and a generated live external context to a real authenticated CLI Node. It does not create a Foxwarm internal Session, Agent or synthetic sourceSessionId. The inbound catalog uses this service for `node` discovery/calls, Node selection and scoped command results.

## Exports and behavior

- `listExternalNodeTools` walks the authoritative provider registry and lists only ready authenticated remote Nodes with negotiated v3, explicit `externalToolOwner:1`, supported read/write/edit/patch/exec capabilities and potentially visible ordered external rules. Master, Docker, executable and browser-tool external effects are unsupported in this stage.
- `callExternalNodeTool` binds the verified identity and immutable context UUID, authorizes exact source `node`, target Node, full arguments and execution-derived file/patch/cwd path facts, then dispatches to the actual advertised capability. A disposed context fails before effect after async authorization/lookup and again at the Node's final send boundary. Exec reserves one real persistent exec ID and Main-signed capability before dispatch; error/timeout paths do not retry effects. Foreground and background results stay scoped to the original context, including after current-Node changes.
- `externalExecResult` lists at most 20 Main-owned records per context or inspects one exact real ID, rechecking the original `node:.../exec` rule and retained bounded arguments on each call. Completed output is bounded; running output is queried from the authenticated owning Node. Offline/expired/unavailable results do not switch providers or reconstruct authority from Node files.
- `externalNodeAction` authorizes the concrete `builtin:node` action with its normalized action arguments: list has no target Node fact, status uses the actually selected current Node, and select uses the validated requested Node rather than a synthetic `master` target. It then checks actual compatible capabilities. A new selection uses the Node-supplied default cwd rather than another Node's working directory. Completed commands update cwd only if the selection generation is unchanged.
- `releaseExternalNodeContext` synchronously fences its context, discards Main's live ownership records on DELETE/expiry/shutdown and sends best-effort release to every Node used by that context, including commands whose completed record has since been evicted. It does not kill running processes. Node-local artifacts are removed after the managed process exits.

## Tests and ownership

`mcpInboundNodeService.test.ts` pairs a real CLI Node and connects two real MCP SDK clients to Main: exact file capabilities, foreground/background commands with partial/final output and cwd, identity isolation, policy revocation, reconnect and interrupted POST recovery, DELETE without command termination, exited-artifact cleanup, and a negotiated-v2 Node rejected before tool dispatch. No shared Testing service is modified.

`mcpInboundNodeOwnership.test.ts` deterministically holds the capability and post-reservation provider lookups across release, asserts no late Node effects or records, and tests completed-record eviction versus all-active saturation. The real paired fixture separately proves that an already-started background process survives DELETE.

The cross-module protocol is canonical in [D-node-thread-core-protocol-compatibility](../threads/node-communication.md#d-node-thread-core-protocol-compatibility); authorization and wrapper behavior in [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge).
