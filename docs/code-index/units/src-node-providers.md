# Unit: src-node-providers

Files: src/nodes/providerRegistry.ts, src/nodes/providers.ts, src/nodes/executableProvider.ts
Secondary files: src/nodeExecutionService.ts, src/nodes/manager.ts, src/nodeExecution.test.ts, src/nodes/executableProvider.test.ts, src/nodes/executableProviderTestFixture.ts, docs/executable-node-provider-protocol.md

## Purpose

Defines the small Main-owned provider and registry boundary for generic Nodes. A Node descriptor identifies the exact Node, its kind, provider, availability, derived capabilities, and safe optional routing metadata. Primitive providers expose filesystem/exec backends; Core composes canonical model file tools above them. Authenticated remote Nodes retain a separate complete-tool adapter.

Production installs the two fixed providers plus zero or more startup-configured executable providers:

- the colocated `master` provider, which describes canonical node-environment capabilities but preserves direct local execution;
- the authenticated remote provider, which adapts the existing connected-node manager and WebSocket tool transport without changing pairing, heartbeat, backend-service, file-transfer, or session-event internals.
- each configured executable provider launches one trusted command per `list`, filesystem primitive, complete exec, or lifecycle request and may advertise or manage one or more sandbox-kind Nodes without a resident Foxwarm Node process.
- each configured `docker-worktree` provider is a resident first-party provider described by [src-docker-worktree-provider](./src-docker-worktree-provider.md).

Executable providers use the fixed `foxwarm-node-provider@1` JSON stdin/stdout primitive-backend protocol. Lifecycle is provider-neutral; no concrete sandbox implementation, profile, or ownership model is built into Core.

## Key exports

- `NodeDescriptor`, `NodeProviderDescriptor`, `NodeCapabilityDescriptor`, `NodeKind`, `NodeAvailability` — safe generic Node metadata; primitive provider descriptors omit model tool definitions and registry materialization derives them.
- `NodeFilesystemRequest` / `NodeExecRequest` — fixed primitive filesystem and complete exec requests carrying exact source, Node, and bounded routing context; `NodeToolRequest` remains the authenticated-remote adapter DTO.
- `NodeLifecycleAction`, lifecycle request/result/summary types — bounded provider-neutral control-plane DTOs with exact source/agent context, optional exact requested Node ID for create/ensure, separate opaque parameters/details, and optional effect/data-retention descriptions.
- `NodeProvider` — fixed descriptor/list/lookup, primitive filesystem/exec, authenticated-remote adapter, and lifecycle boundary with optional startup/shutdown, default-cwd, and create/ensure/inspect/destroy methods.
- `NodeProviderRegistry` — aggregates a fixed provider set, awaits ordered initialization with reverse rollback, performs idempotent reverse shutdown, detects duplicate Node IDs, resolves exact provider authority, invokes only advertised ready capabilities, and routes optional lifecycle operations without fallback.
- `MasterNodeProvider` — descriptor-only production provider for the colocated master Node; RPC invocation is rejected so local bypass remains authoritative.
- `AuthenticatedRemoteNodeProvider` — production adapter over `nodesManager` for authenticated remote Node discovery, dynamic tools, default cwd, and complete WebSocket tool forwarding.
- `ExecutableNodeProvider` — bounded one-shot process adapter with strict request/response identity, descriptor/schema normalization, stdout/stderr/request/result limits, timeout/cancellation termination, and redacted abnormal-process failures.
- `EXECUTABLE_NODE_PROVIDER_PROTOCOL` and protocol request/response types — fixed external provider contract.
- `nodeProviderRegistry` — production registry containing master, authenticated-remote, and normalized configured executable and Docker-worktree providers.

## Invariants

- Node IDs are exact global routing identities. Two providers advertising the same ID fail closed.
- `source=node` remains the capability source for every Node kind; provider identity is routing metadata, not a new tool source.
- Unsupported or unavailable capabilities fail at provider resolution and never fall back to master.
- The master provider is present in discovery but cannot execute through the non-master Node RPC path.
- The authenticated remote adapter preserves the current dynamic advertised-tool boundary and forwards the existing exact cwd snapshot only when supplied by the canonical resolver.
- Provider descriptors expose no credentials, WebSocket objects, launch commands, environment variables, or private provider state.
- Provider default cwd strings are presence-checked without normalization and returned exactly; leading/trailing whitespace may be significant in an opaque target namespace.
- Executable provider commands and fixed arguments come only from startup config, run with `shell:false`, and receive an allowlisted child environment. Primitive payloads contain exact source/agent/Node/operation/path-or-exec/routing context but no mutable Session, callback, provider launch command, or credential. Advertised Node IDs use bounded slash-free ASCII `[A-Za-z0-9][A-Za-z0-9._:-]*` and cannot claim `master` in any letter case, preserving canonical `node:<node-id>/<tool>` round trips.
- Executable stdout contains exactly one protocol payload. Protocol/provider/request/operation mismatches, malformed or multiple payloads, invalid/oversized descriptors or primitive results, process failures, timeouts, cancellation, stream limits, and exited children whose inherited stdio does not close fail without retry or master fallback. Terminal paths destroy owned stdio as needed and bound direct-child close confirmation; provider stderr and launch paths are not returned to callers.
- Fixed master/authenticated-remote lookup is resolved before deferred executable discovery, so a broken executable provider cannot block an already-owned master/connected-remote capability. Full topology listing still detects duplicate Node IDs across all providers.
- Create/ensure resolve an exact configured provider because the Node may not exist. A supplied canonical requested Node ID is preflighted before provider effect: create rejects any owner, while ensure permits the selected provider or no owner and rejects another provider. The returned descriptor must match a supplied ID; provider-generated IDs retain post-result global duplicate checks. Inspect/destroy resolve all providers for one exact existing Node ID so duplicate ownership and descriptor mismatches fail closed. Unsupported provider methods reject explicitly and never fall back to master.
- One registry-owned async mutation lane serializes every create/ensure/destroy resolution, preflight, provider effect, result validation, and post-result duplicate check in the Main process. Inspect does not acquire it. Queued calls recheck cancellation before provider effect, every terminal path releases the lane, and no retry or rollback is implied.
- Lifecycle parameters/details are bounded plain JSON. Safe effect and data-retention fields are provider descriptions only; Core does not infer deletion, erasure, isolation, or security guarantees. Unknown in-process provider exceptions are replaced by a bounded generic lifecycle-provider failure so private launch/configuration data cannot cross the service boundary.
- The registry is a narrow Node boundary, not a generic plugin or service registry.
- Core awaits the registry lifecycle only after Session catalog/ingress readiness. Provider initialization is ordered and shared across concurrent callers; any failure shuts down the failing provider plus earlier providers in reverse order and remains observable. Registry shutdown is reverse-order and idempotent.

## Tests

`src/nodeExecution.test.ts` includes a deterministic in-memory primitive provider proving read-only/read-write derivation plus canonical read/write/edit/patch execution over opaque URI paths. `src/nodeLifecycle.test.ts` proves exact provider/Node lifecycle routing, unsupported/duplicate/mismatched results, confirmation, Main/Worker source fences, isolated mutation, awaited initialization/rollback, and idempotent shutdown. `src/nodes/executableProvider.test.ts` uses a deterministic Node-process fixture to prove production startup-config loading, multi-Node discovery, derived direct/unified/ToolScript file tools, fixed exec, provider-local URI-like cwd, lifecycle persistence/envelopes, exact source/isolation/rules, partial backends, no fallback, malformed/oversized/error/exit handling, cancellation/timeout cleanup, and fixed-provider independence. The fixture defines no production sandbox or path semantics.

## Integration

- `src/nodeExecutionService.ts` owns authorization, RPC validation/bounds, visibility filtering, and authoritative Main-side provider resolution.
- `src/tools/resolvedTools.ts` carries the exact `executionNode`; it does not classify remote or sandbox implementations.
- `src/nodes/manager.ts` remains the authenticated remote transport/runtime owner behind `AuthenticatedRemoteNodeProvider`.
- Model-facing list/select/lifecycle paths use the Node execution facade so Main-local and Session-worker behavior share provider resolution. Slash commands remain list/select-only.
