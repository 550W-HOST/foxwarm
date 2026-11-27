# Unit: quality-scripts

Files: scripts/quality/unused-check.mjs
Secondary files: package.json

## Purpose

Provides lightweight, no-new-dependency quality gates for repeatable TypeScript unused-code checking across the TypeScript packages.

## Key Exports / Commands

- `npm run quality:unused` — runs `scripts/quality/unused-check.mjs`.
- `scripts/quality/unused-check.mjs` — sequentially invokes local `npx --no-install tsc` checks for:
  - `packages/shared/tsconfig.json` with `--noEmit --noUnusedLocals --noUnusedParameters`;
  - `packages/artifact-runtime/tsconfig.json` with the same unused flags;
  - `packages/cli-node/tsconfig.json` with the same unused flags;
  - `packages/webui/tsconfig.json` with `--noEmit` only, because WebUI already enables `noUnusedLocals` and `noUnusedParameters` in its tsconfig.

## Behavior

- The script is read-only: it uses TypeScript `--noEmit` and does not run package installs or generated builds. The shared and CLI Node checks also pass `--incremental false` so their build-enabled tsconfigs cannot write compiler caches during this gate.
- It fails fast on the first failing project and prints the failing phase label.
- It intentionally uses existing TypeScript tooling only; ESLint/Knip/unused-export/tiny-wrapper scanning are left for later phases.

## Integration

- Intended as Phase 0/1 code-quality baseline after cleaning current `tsc` unused diagnostics.
- Complements `npm run build`: `quality:unused` catches unused locals/imports/parameters without writing `lib/` or package `dist/`, while `build` remains the compile/package-output gate.

## Design Decisions

- [2026-07-05] Phase 0/1 code quality governance starts with no-new-dependency TypeScript unused checks before introducing ESLint/Knip. Shared, artifact-runtime and cli-node are checked with explicit `--noUnusedLocals --noUnusedParameters`; WebUI relies on its existing strict tsconfig unused settings. Tiny single-call wrapper detection and unused-export/dependency scans remain report-only/future work, not part of this gate.

### D-infrastructure-quality-baseline

The baseline unused-code gate uses TypeScript `--noEmit` checks without adding a linter dependency. Broader linting, dependency analysis, and unused-export checks remain separate work.
