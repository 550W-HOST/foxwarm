# Unit: .NET executable Node registry and files

Files: `dotnet/Foxwarm/Nodes/NodeProviderRegistry.cs`, `dotnet/Foxwarm/Nodes/ExecutableNodeProvider.cs`, `dotnet/Foxwarm/Nodes/ExecutableNodeProvider.Process.cs`, `dotnet/Foxwarm/Nodes/ProviderFileOperations.cs`

Secondary/integration references: `dotnet/Foxwarm/Nodes/NodeRoutes.cs`, `dotnet/Foxwarm/Tools/TargetFileOperations.cs`, `dotnet/Foxwarm/Tools/WorkspaceTools.Target.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Nodes.cs`, `dotnet/Foxwarm/Tools/ToolRegistry.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.ToolScript.cs`, `dotnet/Foxwarm/Sessions/SessionManager.NodeFiles.cs`, `packages/webui/src/nodeTargets.ts`

## Purpose and current boundary

Main owns startup executable-provider configuration, qualified identities, discovery and canonical file capabilities. Fixed Main/native resident adapters keep their existing path, credential, protocol, completion and service owners. The external executable implements the existing public primitive protocol in `docs/executable-node-provider-protocol.md`, not model tools or a new resident Node protocol.

This checkpoint connects files, selection, Agent binding and their actual consumers. Advertised process metadata is validated but does not derive an `exec` tool yet. Description parsing/caching is internal; provider lifecycle actions and structured provider inspection are not exposed as implemented operations. Persistent provider exec must join the existing `LocalExecManager` in a later checkpoint. No provider process/job persistence format or cross-runtime takeover is introduced here. The project scope is canonical in [delivery scope](../overview.md#d-dotnet-delivery-scope).

## Stable symbols and function index

| Symbol | Responsibility |
| --- | --- |
| `NodeProviderRegistry` constructor | Copies validated startup executable configurations; reserves fixed provider identities and shares the Session write-reference owner. No subprocess or hot reload occurs in construction. |
| `ListAsync` / `ResolveAsync` | Async discovery, duplicate checks and exact ownership. Fixed native lookup does not invoke optional executables. Executable local IDs are qualified once; calls remove exactly that provider prefix. |
| `Snapshot` / `Definitions` / `Online` / `DefaultCwd` | Synchronous presentation/capability projections only; no subprocess discovery or waiting under native connection locks. |
| `RefreshAsync` | Refreshes an exact executable target at async selection, search, tool-resolution and turn-start boundaries. Failed exact discovery removes that target's executable projection. Actual effects re-resolve availability/capability independently. |
| `ExecuteAsync` | Delegates resident complete tools unchanged; composes only implemented file tools for a real Session owner. Captured cwd is forwarded only for that exact selected target. |
| `ReadFileAsync` / `WriteFileAsync` | Native CLI transfer or primitive binary composition for copy, image export, delivery and attachment ingress. Relative primitive transfer paths use the adapter default, not Session cwd. |
| `ReadSourceAsync` | Complete source bytes under the captured target cwd and materialization budget; independent of ordinary displayed read output and nested live placement. |
| `TargetFileContent.ReadAsync` | Fixed bounded requests through the first short/empty response, followed by initial-stat byte-count equality. Retains materialization charging before allocation. |
| `PrimitiveTransferMime` | Source-compatible extension MIME for executable primitive transfers, carried through the existing `TransferFile` delivery metadata; native received MIME is unchanged. |
| `NodeRoutes.Register` | Generic Node lists and per-Node detail, decoding the encoded route identity locally for qualified IDs. Native administration and existing HTTP authorization stay with their original owners. |
| `ExecutableNodeProvider.RunAsync` | One fresh trusted executable per bounded request, strict identity/result/error envelopes, allowlisted environment and eight-call admission. No retries or fallback. |
| `DescribeAsync` / `ListAsync` | Bounded descriptor/schema validation and successful description caching; no business-schema validator. |
| `ProviderFileOperations` | Validates primitive stat/base64/parent/directory results and forwards only target data plus optional captured cwd. It carries no Session, Agent, programmatic hint or callback. |

## File and caller ownership

`ITargetFileOperations` supplies target-owned parent/stat/ranged-read/readdir/write/mkdir/remove primitives. The existing `WorkspaceTools` workflow owns argument handling, write references, exact replacement, parsed patch sequencing and partial-effect summaries for both native and executable files. `FileToolCore.ReadContent` and `FormatDirectory` share the existing scanner, byte/line budget, text formatting and programmatic data. `WorkspacePatch` and `ExactReplacement` remain the sole grammar/matcher owners. Native regular-file/path/publication checks and atomic writes stay in native branches; executable mutations use target `w`/`wx`/`a` rather than host temporary paths or rename.

Provider paths, home handling, separators, cwd and parent resolution remain opaque on Main. Leading native Agent variables are rejected before filesystem effects. Provider definitions override only the approved target-path descriptions; Main/CLI descriptions remain unchanged. Generic copy, delivery and image-export descriptions distinguish native Agent defaults from executable environment defaults. The registry does not fabricate a target Agent directory or Code/PTY/browser service capability.

`ToolRegistry.ResolveAsync` refreshes only actual Node capability targets, so a broken selected provider cannot block an explicitly Main-local builtin. Qualified tool IDs separate the tool name at the last slash. `SessionManager.SelectNodeAsync`, generic Agent binding and persisted selection admission accept Core IDs, while pairing/token/rename/removal validators remain native. The directory and Session picker use async generic discovery; the shared directory parser accepts the 193-character qualified bound without granting services.

Full-file consumers retain their actual authorization owners. Copy checks both endpoints; image and file delivery use builtin endpoint policy rather than synthetic primitive tool calls. Complete ToolScript source separately authorizes `read`, passes its captured target cwd directly and remains Main-local execution; nested calls resolve the live owner. Primitive ingress uses environment-default relative storage, not an Agent-specific root. Main retains image storage, delivery staging and receipts, including the full qualified source identity.

## Failure and partial-effect contracts

Transport request/operation/stdio limits and errors follow the public protocol. Direct-child termination is graceful-first and bounded; direct-child exit and closure of owned stdio are observed separately. Malformed/multiple/oversized stdout, unsafe envelopes, abnormal exit, timeout and cancellation fail without exposing launcher arguments or raw stderr. Provider-reported filesystem codes are preserved; only `ENOENT` is missing. Patch deletion checks target existence before remove, including for idempotent adapters; a missing delete retains earlier operations and prevents later effects without imposing native regular-file restrictions. The executable remains trusted administrator code, not an OS sandbox.

Primitive transfer requests contain at most 1 MiB of bytes. The initial write uses `w` or `wx`, including empty files; subsequent requests append. A failed later append retains the prefix without rollback, retry or a successful receipt. Complete source/transfer reads request the fixed chunk size until the first short/empty result and require the returned byte count to equal the initial stat size. A short final snapshot is not probed again for later appends; an exact chunk multiple requires the normal next read. Premature short data and bytes exceeding the initial size fail. This is not a whole-file stability or atomic-snapshot guarantee. Native CLI SHA-256 transfer receipts and correlation are unchanged. A lost ordinary write receipt can leave the actual effect; Core does not replay it.

## Tests

- `ExecutableNodeProviderTests.cs`: independent Python process fixture, qualified discovery, same local ID in two providers, maximum Core ID, capability derivation, fixed-owner bypass, successful describe caching, strict response identity, malformed/multiple/oversized output, bounded stderr, abnormal exit, inherited stdio, timeout/cancellation and eight-call admission.
- `ProviderFileConsumerTests.cs` and `.SourceDelivery.cs`: actual Session direct/unified/native ToolScript tools, URI and Windows-like target paths, line/directory/image presentation (including real nonregular entries without file-size labeling), write references, parent denial, canonical patch partial effects, binary/empty/multi-envelope/cross-provider transfer, failed append prefix, lost write receipt, complete source/cwd/live nested placement, source budget, premature short bytes, complete short snapshots followed by append and exact chunk boundaries, YAML delivery MIME, full-length source delivery receipts, image export, provider/current/all-endpoint policy and bound-Agent ingress.
- `ProviderFileConsumerTests.ImageHeaders.cs`: bounded primitive header recognition, extensionless images, text with an image extension, BMP recognition without decoding, and actual native ToolScript/outer-image normalization.
- `ProviderNodeRoutesTests.cs`: normal Main HTTP list/detail/selection for encoded qualified identities, fixed master and offline-native detail, not-found handling and scoped/anonymous administrator refusals.
- `experimentHostProviderFiles.e2e.mjs`: disposable Main and executable processes, original Node directory and composer picker, offline option, actual file-tool model request/effect, absent exec/services and persisted selection after a real process restart.
- Focused native file/patch/write-reference, official CLI policy/file-transfer, native cwd and authenticated exec-protocol tests retain their existing owners. Linux process/browser evidence is not Windows runtime or SSH/provisioning qualification.
