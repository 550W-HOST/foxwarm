# Unit: Shared file, exec, and output primitives

Files: `packages/shared/src/boundedTextExcerpt.ts`, `packages/shared/src/execCwd.ts`, `packages/shared/src/fileOperations.ts`, `packages/shared/src/fileToolCore.ts`, `packages/shared/src/fileToolCore.test.ts`, `packages/shared/src/outputTruncation.ts`, `packages/shared/src/outputTruncation.test.ts`, `packages/shared/src/persistentExec.ts`, `packages/shared/src/persistentExec.test.ts`, `packages/shared/src/processOperations.ts`, `packages/shared/src/toolResponseFormatting.ts`, `packages/shared/src/toolResponseFormatting.test.ts`

## Purpose

Provides shared bounded file operations, cwd normalization, persistent/parallel exec support, process lifecycle helpers, output truncation, and tool-response formatting consumed by Node packages and compatibility callers.

## Stable symbols and callers

`fileToolCore`; `fileOperations`; `persistentExec`; `execCwd`; `outputTruncation`; `boundedTextExcerpt`; `toolResponseFormatting`; `processOperations`.

## Behavior and side effects

These are protocol-adjacent primitives, not authorization owners. They preserve bounded output and explicit process/file failure shapes; caller-side isolation and authorization remain in the Main or Node host. Tests cover retries, truncation boundaries, cwd semantics, and persistent process lifecycle.

## Tests

The paired shared tests listed above; CLI Node PTY/process tests; .NET local-tool contracts are indexed separately.
