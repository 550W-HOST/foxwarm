# Unit: Shared patches, config schemas, markup, and metadata

Files: `packages/shared/src/applyPatch.ts`, `packages/shared/src/applyPatch.test.ts`, `packages/shared/src/configSchemas.ts`, `packages/shared/src/foxwarmMarkup.ts`, `packages/shared/src/gitCommitDetails.ts`, `packages/shared/src/gitCommitDetails.test.ts`, `packages/shared/src/tokenCount.ts`, `packages/shared/src/webuiToolRendering.ts`, `packages/shared/src/webuiToolRendering.test.ts`

## Purpose

Owns shared patch application, configuration-schema exports, Foxwarm markup parsing/formatting, Git commit metadata, and token-count helpers used by WebUI, Code, and Node packages.

## Stable symbols and callers

`applyPatch`; `configSchemas`; `foxwarmMarkup`; `gitCommitDetails`; `tokenCount`. WebUI editor/commit markers and Code workbench consume the stable data shapes; the .NET host has separate server-side Code services.

## Behavior and side effects

Patch and metadata helpers preserve bounded, explicit errors and do not grant filesystem or Git authority by themselves. Keep protocol-visible formatting compatible when changing these functions.

## Tests

`applyPatch.test.ts`; `gitCommitDetails.test.ts`; WebUI rendering and workbench tests.
