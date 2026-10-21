# Unit: Shared artifact contracts

Files: packages/shared/src/artifacts/types.ts, packages/shared/src/artifacts/registry.ts, packages/shared/src/artifacts/chart.ts, packages/shared/src/artifacts/react.ts, packages/shared/src/artifacts/image.ts, packages/shared/src/artifacts/marker.ts

## Purpose

Defines the common display receipt and closed, independently versioned authoring schemas. Canonical decisions: [interactive artifacts](../threads/webui-artifacts.md).

## Symbols

- `ArtifactReceipt`, `ArtifactDocument`, `StoredArtifact`: immutable publication identities, authoring envelope and persisted source/compiled revision.
- `parseArtifactReceipt`: bounded closed projection for history display; never grants access.
- `artifactModules`, `validateArtifactDocument`: module dispatch and 2 MiB UTF-8 manifest bound.
- `validateChartDocument`: bounded rows, fields, layers, supported marks/encodings and host control/metric definitions; no URL/transform/expression execution.
- `validateReactDocument`: virtual source filenames, entry and per-package/per-file bounds.
- `validateImageDocument`: bounded raster metadata with no source URL/path.
- `parseArtifactMarker`, `formatArtifactMarker`: strict ID/revision reference syntax, independent of access checks.
- `object`, `keys`, `text`, `baseDocument`: reusable validation primitives.

## Integration and tests

Main validates before compilation/persistence. The chart renderer validates again before invoking Vega-Lite. Frontend projection independently parses only receipts. Validators return cloned plain JSON so callers cannot mutate the stored snapshot. Covered by backend artifact tests, frontend projection tests and skill examples.
