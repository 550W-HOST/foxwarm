# Unit: Shared file and local execution primitives

Files: `packages/shared/src/execCwd.ts`, `packages/shared/src/fileOperations.ts`, `packages/shared/src/fileToolCore.ts`, `packages/shared/src/fileToolCore.test.ts`, `packages/shared/src/toolResponseFormatting.ts`, `packages/shared/src/toolResponseFormatting.test.ts`

## Purpose

Composes canonical file/read/write/edit/patch and cwd validation tools from target-local filesystem primitives, plus structured tool-response formatting. Persistent exec and bounded excerpting have dedicated units.

## Stable symbols and callers

`nativeFileOperations`; `readWholeFile`; `readFileToolPath`; `writeFileToolPath`; `findWriteParentIssue`; `formatWriteParentIssueMessage`; `resolveValidatedExecCwd`; `toolResponseFormatting`; and Node tool wrappers `read`, `write`, `edit`, `apply_patch`, `exec`, `get_default_cwd`.

## File/cwd contracts

`ExactLineScanner`/`readFileToolPath` preserve LF/CRLF/bare-CR boundary metadata, exact requested line ranges, directory pagination, image detection, and bounded large-file output; callers must not normalize away requested boundary information. `writeFileToolPath` attempts the real write first and only then enriches missing/non-directory parent failures; `createDirs` is explicit. `resolveValidatedExecCwd` validates normalized target cwd before process launch and does not invent a fallback outside the caller’s namespace.

`FileOperations` is the target-local stat/ranged-read/list/write/mkdir/remove seam. It does not grant authorization or isolation: Main/Node callers provide path namespace, owner, and capability context. Response formatters preserve structured multi-key outputs while applying bounded model/UI presentation only at the caller-selected boundary.

## Tests

`packages/shared/src/fileToolCore.test.ts`; CLI/Node file-operation tests; tool-response formatting and cwd tests.
