# Unit: Shared persistent execution helpers

Files: `packages/shared/src/persistentExec.ts`, `packages/shared/src/persistentExec.test.ts`

## Purpose

Provides the shared persistent-execution contract used by compatible TypeScript callers. It owns bounded process records, durable registry updates, output/status artifacts, reconciliation, and completion notification metadata.

## Behavior

Registry mutations are serialized, recovered records are reconciled on startup, and output formatting remains bounded and line-aware. Caller-assigned identifiers and completion metadata remain separate from process identifiers. The helper does not claim ownership of .NET Main execution or remote Node authorization; those boundaries are defined by their respective host contracts.

## Tests

Shared persistent-exec unit tests cover registry mutation ordering, recovery, bounded output, and completion behavior.
