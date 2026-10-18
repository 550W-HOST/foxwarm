# Unit: src-node-providers

Files: src/nodes/providerRegistry.ts, src/nodes/providers.ts, src/nodes/executableProvider.ts, src/nodes/providerExecBackend.ts
Secondary files: src/nodeExecutionService.ts, src/nodes/manager.ts, src/nodeExecution.test.ts, src/nodes/executableProvider.test.ts, src/nodes/executableProviderTestFixture.ts, src/nodes/providerExec.test.ts, src/nodes/primitiveExecTestFixture.ts, src/nodes/providerExecRestartTestFixture.ts, docs/executable-node-provider-protocol.md

## Purpose

The Main-owned registry describes exact execution Nodes, derives canonical capabilities from filesystem/process primitives and routes optional provider lifecycle operations. Node is execution identity. Provider is its driver, not a tool source, credential boundary, Session placement or isolation guarantee.

Production has fixed master/authenticated-remote adapters plus startup-configured executable providers. Authenticated resident Nodes retain their existing complete-tool transport. External executable providers use the single `foxwarm-node-provider` JSON stdin/stdout contract; there is no old complete-exec adapter, protocol-version field or negotiation. The independent [Linux SSH reference](./example-linux-ssh-provider.md) consumes only that public protocol; Core has no SSH backend or dependency.

## Key exports and function index

| Export or operation | Responsibility |
|---|---|
| `NodeDescriptor`, `NodeProviderDescriptor`, `NodePrimitiveBackends` | Exact safe identity, optional label, type, ready/offline/unavailable/error state and primitive support; external providers omit model tool definitions |
| `NodeToolRequest` | Internal source Session/agent/routing snapshot, or the separate verified external-owner branch for authenticated CLI tools |
| `NodeFilesystemRequest` | Internal target primitive request; executable serialization strips Session/Agent/programmatic state and sends only target data and captured cwd |
| `NodeExecStartRequest` / `NodeExecPollRequest` | Public process inputs: exact Node plus command/optional cwd, or exact Node plus opaque execution ref |
| `NodeProviderDescription` / `NodeProviderSummary` | Full label/description/lifecycle/parameter-schema/retention discovery, or bounded ID/label/lifecycle list summary |
| `NodeLifecycleAction` and lifecycle DTOs | Existing authorized Main control-plane requests and exact result identities |
| `NodeProvider` | Optional describe, filesystem, start/poll and lifecycle methods; historical complete tools belong only to resident authenticated transports |
| `NodeProviderRegistry.initialize()` / `shutdown()` | Shared ordered initialization, reverse rollback and reverse idempotent shutdown |
| `listNodes()` / `resolveNode()` | Global duplicate detection, fixed-provider-first deferred lookup and exact ownership |
| `invokeTool()` / `readFile()` | Ready-capability checks and canonical composition; complete source reads never consume truncated model display |
| `execBackend()` | Rebind a persisted provider ID/Node ID directly to the same configured provider and target log filesystem |
| `inspectProvider()` / `listProviders()` | Structured discovery, including providers with no lifecycle; parameter schemas belong to full inspection |
| `createNode()` / `ensureNode()` / `inspectNode()` / `destroyNode()` | Existing provider-neutral lifecycle, requested-ID preflight and Main mutation lane |
| `MasterNodeProvider` | Describes Main; rejects RPC execution so the native bypass remains authoritative |
| `AuthenticatedRemoteNodeProvider` | Existing resident runtime tool/default-cwd/full-file adapters plus approved offline identity discovery |
| `ExecutableNodeProvider` | Bounded one-shot subprocess transport, strict envelopes/descriptors/observations, cached successful description and optional lifecycle dispatch |
| `createProviderExecBackend()` | Core-owned bridge to the existing persistent exec manager; never a second exec manager |
| `nodeProviderRegistry` | Production composition; Main's default exec runtime resolves persisted provider references through it |

## Capability, path and authority contracts

- Node IDs are globally unique exact routing identities, using bounded slash-free ASCII `[A-Za-z0-9][A-Za-z0-9._:-]*`; executable providers cannot claim reserved `master`. Capabilities remain `source=node`, independent of provider kind.
- Primitive filesystem access derives `read` or the complete canonical `read/write/edit/apply_patch` set. Exec additionally requires a readable filesystem, `startExec` and `pollExec`; its output must be readable at the returned target path. Unsupported combinations fail without Main fallback.
- Core/shared owns read formatting, exact replacement and patch grammar/partial effects. Providers own target-relative path resolution, home/URI/separator/symlink semantics, errors and actual restrictions. Main does not resolve opaque target paths or invent a target Agent directory. Leading native Agent tokens are rejected; see [D-dispatch-native-agent-paths-and-code-targets](../threads/tool-dispatch-node-execution.md#d-dispatch-native-agent-paths-and-code-targets).
- Core authorizes the original raw call and exact Node once. Internal primitive operations are not new model calls, statistics or history entries. The source facade separately authorizes complete ToolScript `read` and uses one exact routing snapshot.
- External executable file/process primitives contain only immutable target data, not a Session, Agent, callback, programmatic flag, notification address or Main environment/credentials. Lifecycle retains its bounded authorized Main source/context envelope. The executable itself is trusted administrator-configured code, not a security boundary.
- The verified external-owner `NodeToolRequest` branch remains supported only by authenticated CLI complete tools. Primitive tools reject it before effect; no new inbound MCP provider authority is added.
- Fixed master/authenticated-remote lookup precedes deferred executable discovery, so a broken optional adapter does not block an exact connected native/CLI owner. Full listing still detects duplicate identities. Approved disconnected CLI Nodes appear offline with no executable tools; incompatible connected Nodes retain structured error/protocol information and no execution capability.

## Process integration

External start/poll DTOs map into the existing `PersistentExecManager` and same Main registry. Provider references remain private; model-visible exec IDs come from Core. Native records and normal CLI version negotiation/completion ACK semantics are unchanged. See [shared-persistent-exec](./shared-persistent-exec.md) for canonical tracking, output and expiration ownership.

- Start is called once, returns a durable ref and target log path, and must not wait for the command. An uncertain start receipt reports unknown and explicitly forbids automatic replay.
- Ordinary Stop is checked before effect and subsequently releases waiting without aborting start or killing the command. Independent owner-loss/deadline cancellation remains available to bound the one-shot RPC; a missing post-dispatch start receipt is still unknown.
- Poll is read-only, capped at `min(configured timeout, 5 seconds)` and shared by foreground/reconciliation per exec. Foreground timeout/Stop is independent of the query. Transient query failure retains tracking; lost becomes an unknown exit, never success. Completion for other entries is not serialized behind a slow provider query.
- Logs use target `FileOperations`, the same display formatter and the inclusive 1 MiB programmatic snapshot budget. Missing/unreadable output is reported separately from real exit status. Core does not create another Main log cache or expose the adapter ref as a PID.
- Known target cwd becomes a private exact-Node result marker. Only the exact owner applies it while still selecting that Node, including deferred parallel-exec replay. Target whitespace is preserved through both injected Worker-owner persistence and the loaded Main owner when ordinary Main batches have no persistence hook. Catalog stubs/detached contexts cannot become exact cwd owners, and the selected Node is rechecked at mutation. Ordinary Session settings/native string normalization is unchanged. Native cwd and existing Node-selection entry points are not changed.
- Recovery binds the original configured provider/ref directly, without new start or fallback to another provider. Provider configuration removal retains tracking until recovery or ordinary expiration.

## Discovery and lifecycle

`describe` returns label, description, a possibly empty lifecycle list, optional create/ensure schemas and lifecycle/retention descriptions. Successful executable descriptions are cached for the configured lifetime. Core bounds and copies plain schema data but does not add a business-schema validation engine.

Programmatic `node(list)` returns structured Nodes/provider summaries. `node(inspect,providerId=...)` returns the full description; it is mutually exclusive with Node inspection and does not accept lifecycle parameters. List summaries omit parameter schemas; full inspection is their canonical discovery path.

Create/ensure resolve an exact configured provider, check a supplied requested ID before effect, and retain post-result global duplicate validation. Inspect/destroy resolve all owners for the exact existing Node. Declared unsupported actions fail explicitly. Returned Node/provider IDs cannot redirect an operation. One registry-owned mutation lane still covers create/ensure/destroy ownership/effect/result windows; inspect remains read-only and concurrent. Cancelled queued calls recheck before effect. No rollback or retry is implied.

Lifecycle success describes concrete effects and retained data, not a generic deletion or isolation guarantee. Create/ensure do not select a Node, create an Agent or assign work. Destroy adds no implicit kill/busy policy. Existing isolated-source restrictions and exact destroy confirmation remain authoritative.

## Transport bounds

Configured command/args use `shell:false` and the existing allowlisted environment. Request/response identity, plain JSON and field/byte limits are strict. List/process metadata is at most 256 KiB; filesystem output 8 MiB; description/lifecycle output 512 KiB; request 4 MiB; stderr 64 KiB; active requests eight; Node count 100; configured deadlines 1–300 seconds. Schema fields remain separately bounded. Stdout must be exactly one JSON response.

Malformed/multiple/oversized responses, identity mismatch, invalid primitive results, abnormal process exit, timeout, cancellation and inherited-stdio close failures end that call without fallback or replay. Direct-child termination is graceful-first and bounded through kill confirmation; raw stderr and launcher paths are not returned. An uncertain effectful start is not classified as definitely unstarted.

## Integration and tests

- `src/nodeExecutionService.ts` owns source/reverse fences, authorization, isolation, bounded topology/summary disclosure and Main provider routing. Session workers use the same service; selection mutates only the exact Session owner after validation.
- `src/tools/resolvedTools.ts` routes all non-master capability targets generically and handles the exact-Node cwd result marker without provider-type branching. `nodesManager` remains the resident transport owner, not a new generic-provider process manager.
- Both WebUI directory and Session picker consume generic provider topology; approved offline labels/state are retained. File/exec primitives do not imply Code, PTY, browser or copy support. Credential revocation remains distinct from provider destroy.
- `nodeExecution.test.ts` covers canonical file composition over opaque paths, capability/source/isolation fences, snapshots and no fallback. `nodeLifecycle.test.ts` covers lifecycle identity, mutation ordering, confirmations, structured discovery, schema/DTO bounds and Main/Worker routing.
- `executableProvider.test.ts` uses actual subprocess envelopes for discovery, filesystem, source loading, lifecycle and transport failures. `providerExec.test.ts` uses an independent process fixture for native/provider tracking coexistence, Stop, uncertain start, hard owner loss, transient/slow poll, lost state, missing provider, output loss, bounded raw logs, exact source/permission fences and reattachment without replay.
- SSH transport, account-authenticated filesystem/process work and reattachment across actual Core process exits are independently covered by [example-linux-ssh-provider](./example-linux-ssh-provider.md).
