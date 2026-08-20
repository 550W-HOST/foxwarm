# Unit: src-node-providers

Files: src/nodes/providerRegistry.ts, src/nodes/providers.ts, src/nodes/executableProvider.ts
Secondary files: src/nodeExecutionService.ts, src/nodes/manager.ts, src/nodeExecution.test.ts, src/nodes/executableProvider.test.ts, src/nodes/executableProviderTestFixture.ts, docs/executable-node-provider-protocol.md

## Purpose

Defines the small Main-owned provider and registry boundary for generic Nodes. A Node descriptor identifies the exact Node, its kind, provider, availability, capability definitions, and safe optional routing metadata. Providers execute complete Node capability calls inside their own environment boundary.

Production installs the two fixed providers plus zero or more startup-configured executable providers:

- the colocated `master` provider, which describes canonical node-environment capabilities but preserves direct local execution;
- the authenticated remote provider, which adapts the existing connected-node manager and WebSocket tool transport without changing pairing, heartbeat, backend-service, file-transfer, or session-event internals.
- each configured executable provider launches one trusted command per `list`, `invoke`, or lifecycle request and may advertise or manage one or more sandbox-kind Nodes without a resident Foxwarm Node process.

Executable providers use the fixed `foxwarm-node-provider@1` JSON stdin/stdout protocol. Lifecycle is provider-neutral; no concrete sandbox implementation, profile, or ownership model is built into Core.

## Key exports

- `NodeDescriptor`, `NodeCapabilityDescriptor`, `NodeKind`, `NodeAvailability` — safe generic Node metadata.
- `NodeToolRequest` — complete capability request carrying exact source session, exact Node ID, tool name, arguments, and bounded routing context.
- `NodeLifecycleAction`, lifecycle request/result/summary types — bounded provider-neutral control-plane DTOs with exact source/agent context, optional exact requested Node ID for create/ensure, separate opaque parameters/details, and optional effect/data-retention descriptions.
- `NodeProvider` — fixed descriptor/list/lookup/invoke boundary with optional default-cwd and create/ensure/inspect/destroy methods.
- `NodeProviderRegistry` — aggregates a fixed provider set, detects duplicate Node IDs, resolves exact provider authority, invokes only advertised ready capabilities, and routes optional lifecycle operations without fallback.
- `MasterNodeProvider` — descriptor-only production provider for the colocated master Node; RPC invocation is rejected so local bypass remains authoritative.
- `AuthenticatedRemoteNodeProvider` — production adapter over `nodesManager` for authenticated remote Node discovery, dynamic tools, default cwd, and complete WebSocket tool forwarding.
- `ExecutableNodeProvider` — bounded one-shot process adapter with strict request/response identity, descriptor/schema normalization, stdout/stderr/request/result limits, timeout/cancellation termination, and redacted abnormal-process failures.
- `EXECUTABLE_NODE_PROVIDER_PROTOCOL` and protocol request/response types — fixed external provider contract.
- `nodeProviderRegistry` — production registry containing master, authenticated-remote, and normalized configured executable providers.

## Invariants

- Node IDs are exact global routing identities. Two providers advertising the same ID fail closed.
- `source=node` remains the capability source for every Node kind; provider identity is routing metadata, not a new tool source.
- Unsupported or unavailable capabilities fail at provider resolution and never fall back to master.
- The master provider is present in discovery but cannot execute through the non-master Node RPC path.
- The authenticated remote adapter preserves the current dynamic advertised-tool boundary and forwards the existing exact cwd snapshot only when supplied by the canonical resolver.
- Provider descriptors expose no credentials, WebSocket objects, launch commands, environment variables, or private provider state.
- Executable provider commands and fixed arguments come only from startup config, run with `shell:false`, and receive an allowlisted child environment. Complete invocation payloads contain exact source/agent/Node/tool/args/routing context but no mutable Session, callback, command, or credential. Advertised Node IDs use bounded slash-free ASCII `[A-Za-z0-9][A-Za-z0-9._:-]*` and cannot claim `master` in any letter case, preserving canonical `node:<node-id>/<tool>` round trips.
- Executable stdout contains exactly one protocol payload. Protocol/provider/request/operation mismatches, malformed or multiple payloads, invalid/oversized descriptors and schemas, process failures, timeouts, cancellation, stream limits, and exited children whose inherited stdio does not close fail without retry or master fallback. Terminal paths destroy owned stdio as needed and bound direct-child close confirmation; provider stderr and launch paths are not returned to callers.
- Fixed master/authenticated-remote lookup is resolved before deferred executable discovery, so a broken executable provider cannot block an already-owned master/connected-remote capability. Full topology listing still detects duplicate Node IDs across all providers.
- Create/ensure resolve an exact configured provider because the Node may not exist. A supplied canonical requested Node ID is preflighted before provider effect: create rejects any owner, while ensure permits the selected provider or no owner and rejects another provider. The returned descriptor must match a supplied ID; provider-generated IDs retain post-result global duplicate checks. Inspect/destroy resolve all providers for one exact existing Node ID so duplicate ownership and descriptor mismatches fail closed. Unsupported provider methods reject explicitly and never fall back to master.
- One registry-owned async mutation lane serializes every create/ensure/destroy resolution, preflight, provider effect, result validation, and post-result duplicate check in the Main process. Inspect does not acquire it. Queued calls recheck cancellation before provider effect, every terminal path releases the lane, and no retry or rollback is implied.
- Lifecycle parameters/details are bounded plain JSON. Safe effect and data-retention fields are provider descriptions only; Core does not infer deletion, erasure, isolation, or security guarantees. Unknown in-process provider exceptions are replaced by a bounded generic lifecycle-provider failure so private launch/configuration data cannot cross the service boundary.
- The registry is a narrow Node boundary, not a generic plugin or service registry.

## Tests

`src/nodeExecution.test.ts` retains the deterministic in-memory provider seam test. `src/nodeLifecycle.test.ts` proves exact provider/Node lifecycle routing, unsupported/duplicate/mismatched results, confirmation, Main/Worker source fences, and the isolated mutation boundary. `src/nodes/executableProvider.test.ts` uses a deterministic Node-process fixture to prove production startup-config loading, multi-Node discovery, selection, direct/unified/ToolScript invocation, provider-local URI-like cwd, lifecycle persistence/envelopes, exact source/isolation/rules, partial capabilities, no fallback, malformed/oversized/error/exit handling, cancellation/timeout cleanup, and fixed-provider independence. The fixture defines no production sandbox or path semantics.

## Integration

- `src/nodeExecutionService.ts` owns authorization, RPC validation/bounds, visibility filtering, and authoritative Main-side provider resolution.
- `src/tools/resolvedTools.ts` carries the exact `executionNode`; it does not classify remote or sandbox implementations.
- `src/nodes/manager.ts` remains the authenticated remote transport/runtime owner behind `AuthenticatedRemoteNodeProvider`.
- Model-facing list/select/lifecycle paths use the Node execution facade so Main-local and Session-worker behavior share provider resolution. Slash commands remain list/select-only.
