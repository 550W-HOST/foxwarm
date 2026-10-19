# Unit: Shared .NET native primitives

Files: `dotnet/Foxwarm.NodePrimitives/Foxwarm.NodePrimitives.csproj`, `dotnet/Foxwarm.NodePrimitives/AssemblyInfo.cs`, `dotnet/Foxwarm.NodePrimitives/BoundedTextExcerpt.cs`, `dotnet/Foxwarm.NodePrimitives/ExecDuration.cs`, `dotnet/Foxwarm.NodePrimitives/ExecPetnames.cs`, `dotnet/Foxwarm.NodePrimitives/NativeProcessFacts.cs`, `dotnet/Foxwarm.NodePrimitives/ExactReplacement.cs`, `dotnet/Foxwarm.NodePrimitives/FileToolCore.cs`, `dotnet/Foxwarm.NodePrimitives/FileToolCore.Scanner.cs`, `dotnet/Foxwarm.NodePrimitives/JsonStringQuoting.cs`, `dotnet/Foxwarm.NodePrimitives/NativeFileKind.cs`, `dotnet/Foxwarm.NodePrimitives/RasterImageMime.cs`, `dotnet/Foxwarm.NodePrimitives/TargetFileStat.cs`, `dotnet/Foxwarm.NodePrimitives/WorkspacePatch.cs`, `dotnet/Foxwarm.NodePrimitives/CodeFileOperations.cs`, `dotnet/Foxwarm.NodePrimitives/CodeGitOperations.cs`, `dotnet/Foxwarm.NodePrimitives/CodeGitOperations.Commit.cs`, `dotnet/Foxwarm.NodePrimitives/CodeServiceException.cs`

## Purpose and consumers

A small BCL-only .NET 10 class library owns mechanisms actually used by Main and the [headless CLI Node](./dotnet-cli-node.md). Main and CLI both reference this library. Internal friend assemblies retain a narrow first-party boundary; this is not a public plugin/NuGet API or a split of Main's full runtime.

Main keeps authorization, Session/cwd policy, cached-write references, interpreter budgets, native atomic writes, Provider adaptation and caller-specific filesystem effects. CLI keeps startup roots, credential/connection ownership and its Source-native effect/publication wrapper. Native Code filesystem and read-only Git mechanisms are also shared; Main keeps HTTP/authentication, capability/URI presentation and environment ownership, while CLI keeps fixed service framing and native argument/error adaptation. No exec manager, provider registry, Session runtime, PTY service or image decoder is moved into this library. The agreed native process/access facts, duration formatting and petname vocabulary are shared; Main/CLI launch, environment, registry, ownership and output policies remain separate.

## Stable symbols

| Symbol | Responsibility |
|---|---|
| `CodeFileOperations` | Native Code stat/link/list/read/write/mkdir/delete/rename, inclusive 50 MiB limits and partial effects, independent of model-file defaults. |
| `CodeGitOperations` | Optional external Git execution, bounded status/content and immutable commit details; no staging/commit/push API. |
| `CodeServiceException` | Fixed Code error code/status values; Main and CLI retain caller-specific unavailable/error presentation. |
| `FileToolCore.Read`, `ReadContent`, `FormatDirectory`, `NativeSize` | Native/target text and directory reads, target-following native size inspection before opening, bounded materialization and programmatic data publication. |
| `FileToolCore.Scanner`, range collector | Exact byte/line endings and bounded selected-range samples. |
| `BoundedTextExcerpt.Format`, `AnalyzeSamples`, `BinaryPreview` | Shared bounded sample classification/rendering, with caller-specific file/exec metadata. |
| `ExecDuration.Format`, `Shell`; `ExecPetnames` | Source-compatible process duration and public identity vocabulary, without allocation/retention policy. |
| `NativeProcessFacts.ReadIdentity`, `Access` | Native process identity and directory readability/searchability syscalls, without Session or launch policy. |
| `ExactReplacement.Apply` | Ordinal nonoverlapping match counting and literal unique replacement; callers retain replacement-string and error policies. |
| `WorkspacePatch.Parse`, `Update` | Source envelope/action parsing, matching/anchor/EOF semantics, line-ending restoration and bounded failed-hunk diagnostics, without effects. |
| `JsonStringQuoting.Append`, `Quote` | JSON.stringify-compatible string quoting, including lone surrogates; also consumed by Main journal/download identity code. |
| `RasterImageMime.Detect` | Signature-only PNG/JPEG/WebP/GIF/BMP classification from at most twelve bytes. |
| `TargetFileStat` | Neutral file/directory entry values for shared read formatting; no Provider dependency. |
| `NativeFileKind.Read`, `TryReadLinux` | Native file/directory/symlink/other classification; shared Linux statx type check also serves Main path, policy and opened-handle checks. |

The patch engine is the single canonical implementation for Main native/Provider tools, memory patches, compact-plan repair and CLI file calls. Its Source diagnostic copy, repeated-anchor cursor rule and EOF search are deliberate parity corrections, not behavior-free relocation. Parsing completes before caller effects; operations and partial-failure reporting remain caller-owned. Context mismatch feedback includes only the original failed hunk and stays within 1,600 characters.

Native directory listings classify entries without following symlinks. Linux uses the existing fixed-layout statx mode field because BCL FileAttributes does not distinguish FIFO/device/socket entries from regular files; non-Linux classification uses BCL attributes and link resolution. This is a narrow type primitive, not a general native filesystem layer. Main retains its regular-file admission, policy errno handling and opened-handle flags. Native text reads inspect file size before opening, so a zero-size entry produces the shared empty-file result without opening a FIFO. This does not impose regular-file admission on CLI ordinary reads or add an open-time race guarantee.

Code operations retain Source-native flags and result shapes. Confirmed parity corrections include owner-write permissions, broken-link listing fallback, ENOTDIR, nonrecursive directory deletion, working Git content ignoring base refs, porcelain-v2 unmerged-row omission and normalized Git paths/refs. Git base content normalizes repository-relative paths without applying the working-tree child check, so committed literal `..`-prefixed names remain readable. Working content applies that check before stat; missing paths and ENOTDIR return empty, while raw stat failures retain Git's Unknown/500 projection rather than filesystem-service permission codes. Main's Code URI adaptation, pre-dispatch content-ref validation and optional-Git unavailable response remain in its wrappers; CLI missing-Git errors follow its actual service caller, including empty failed base content. Native rename does not copy across volumes or restore an already removed overwrite destination.

## Validation

Existing Main file/Provider/image and compact-repair tests exercise the relocated implementations through their actual callers. `WorkspacePatchTests` covers bounded failed-hunk feedback and ordinary Main repeated-anchor/EOF/malformed-patch effects. `CliNodeFileTests` and the Source/new-client native corpus retain the distinct caller effect and replacement-string contracts. See the [CLI unit](./dotnet-cli-node.md#validation-and-limits) for real process interoperability.

`IsAotCompatible` enables library trim/AOT analysis. Actual native publication and platform qualification remain executable-level work, not a consequence of this managed library boundary.
