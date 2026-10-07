# Unit: Sandbox Node runtime

Files: `packages/sandbox-node-runtime/src/invoke.ts`, `packages/sandbox-node-runtime/src/worktreeFileOperations.ts`, `packages/sandbox-node-runtime/src/worktreeFileOperations.test.ts`

## Purpose

Runs provider-backed sandbox invocation and constrained worktree file operations for a temporary execution environment.

## Stable symbols and callers

`invoke.ts` is the runtime entry; `worktreeFileOperations.ts` owns path/file operations and cleanup semantics. The package is consumed by its provider/build boundary, not by .NET Session authority directly.

## Behavior and side effects

Worktree operations remain bounded to the assigned sandbox root. This runtime does not confer Main tool authorization and does not replace the .NET `Tools/Authorization` boundary.

## Tests

`worktreeFileOperations.test.ts`; package build/test scripts.
