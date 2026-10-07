# Unit: Shared patches, config schemas, markup, and metadata

Files: `packages/shared/src/applyPatch.ts`, `packages/shared/src/applyPatch.test.ts`, `packages/shared/src/configSchemas.ts`, `packages/shared/src/foxwarmMarkup.ts`, `packages/shared/src/gitCommitDetails.ts`, `packages/shared/src/gitCommitDetails.test.ts`, `packages/shared/src/tokenCount.ts`, `packages/shared/src/webuiToolRendering.ts`, `packages/shared/src/webuiToolRendering.test.ts`

## Purpose

Owns shared patch parsing/application, configuration-schema exports, Foxwarm markup escaping, Git commit metadata, WebUI tool-rendering helpers, and token-count utilities consumed by WebUI, Code, Node packages, and compatibility callers.

## Stable symbols and callers

`extractPatchEnvelope`, `parseApplyPatchInput`, `applyUpdatePatch`, `buildAddedFileContent`, `countApplyPatchOperationLines`, and `formatApplyPatchOperationSummary` own the patch envelope/chunk/count/summary contract. `configSchemas`, `foxwarmMarkup`, `gitCommitDetails`, `parseSessionLinkText`, `shouldUseStreamingToolPlaceholder`, and `tokenCount` provide shared data/format helpers.

## Patch behavior

Patch processing normalizes CRLF to LF, restores the original line-ending style, accepts explicit or bare envelopes, uses `@@` anchors with trimmed fuzz fallback, validates non-overlapping chunks, and leaves file I/O to callers. Successful add/update summaries include Git-style inserted/deleted counts derived from patch content; context/headers do not count, delete summaries remain deletions. This per-operation summary is shared by Main and Node tool paths.

## Other boundaries

Markup helpers distinguish flattened attribute escaping from nested text that preserves line boundaries; WebUI session-link parsing links only approved session/source attributes; config/metadata helpers do not grant filesystem or Git authority. Protocol-visible formatting remains compatible across .NET/TypeScript/Node callers.

## Tests

`packages/shared/src/applyPatch.test.ts`; `gitCommitDetails.test.ts`; `webuiToolRendering.test.ts`; Node/Code workbench integration tests.
