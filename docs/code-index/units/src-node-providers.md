# Unit: src-node-providers

Files: src/nodes/providerRegistry.ts
Secondary files: src/nodeExecutionService.ts, src/nodes/manager.ts, src/nodeExecution.test.ts

## Purpose

Defines the small Main-owned provider and registry boundary for generic Nodes. A Node descriptor identifies the exact Node, its kind, provider, availability, capability definitions, and safe optional routing metadata. Providers execute complete Node capability calls inside their own environment boundary.

Production currently installs two providers:

- the colocated `master` provider, which describes canonical node-environment capabilities but preserves direct local execution;
- the authenticated remote provider, which adapts the existing connected-node manager and WebSocket tool transport without changing pairing, heartbeat, backend-service, file-transfer, or session-event internals.

No production sandbox provider or provider configuration protocol exists in this unit.

## Key exports

- `NodeDescriptor`, `NodeCapabilityDescriptor`, `NodeKind`, `NodeAvailability` — safe generic Node metadata.
- `NodeToolRequest` — complete capability request carrying exact source session, exact Node ID, tool name, arguments, and bounded routing context.
- `NodeProvider` — fixed descriptor/list/lookup/invoke boundary with optional default-cwd discovery.
- `NodeProviderRegistry` — aggregates a fixed provider set, detects duplicate Node IDs, resolves exact provider authority, and invokes only advertised ready capabilities.
- `MasterNodeProvider` — descriptor-only production provider for the colocated master Node; RPC invocation is rejected so local bypass remains authoritative.
- `AuthenticatedRemoteNodeProvider` — production adapter over `nodesManager` for authenticated remote Node discovery, dynamic tools, default cwd, and complete WebSocket tool forwarding.
- `nodeProviderRegistry` — production registry containing the master and authenticated-remote providers.

## Invariants

- Node IDs are exact global routing identities. Two providers advertising the same ID fail closed.
- `source=node` remains the capability source for every Node kind; provider identity is routing metadata, not a new tool source.
- Unsupported or unavailable capabilities fail at provider resolution and never fall back to master.
- The master provider is present in discovery but cannot execute through the non-master Node RPC path.
- The authenticated remote adapter preserves the current dynamic advertised-tool boundary and forwards the existing exact cwd snapshot only when supplied by the canonical resolver.
- Provider descriptors expose no credentials, WebSocket objects, launch commands, environment variables, or private provider state.
- The registry is a narrow Node boundary, not a generic plugin or service registry.

## Tests

`src/nodeExecution.test.ts` includes a deterministic in-memory sandbox-kind provider. It proves that Main can list, select, and invoke a complete Node capability without a WebSocket and that the request retains exact source, Node, arguments, agent, and cwd routing context. The fixture is test-only and does not define production sandbox lifecycle or path semantics.

## Integration

- `src/nodeExecutionService.ts` owns authorization, RPC validation/bounds, visibility filtering, and authoritative Main-side provider resolution.
- `src/tools/resolvedTools.ts` carries the exact `executionNode`; it does not classify remote or sandbox implementations.
- `src/nodes/manager.ts` remains the authenticated remote transport/runtime owner behind `AuthenticatedRemoteNodeProvider`.
- Model-facing and slash-command list/select paths use the Node execution facade so Main-local and Session-worker behavior share provider resolution.
