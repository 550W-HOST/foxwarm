# Unit: WebUI interactive artifacts

Files: packages/webui/src/artifacts/ArtifactView.tsx, packages/webui/src/artifacts/ChartRenderer.tsx, packages/webui/src/artifacts/ReactRenderer.tsx, packages/webui/src/artifacts/ImageRenderer.tsx, packages/webui/src/artifacts/downloads.ts, packages/webui/src/artifacts/registry.ts, packages/webui/src/artifacts/projection.ts, packages/webui/src/artifacts/sandbox.ts, packages/webui/src/artifacts/artifacts.css, packages/webui/test/artifacts.test.mjs, packages/webui/test/artifacts.e2e.mjs
Secondary files: packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/index.css

## Purpose

Renders published content outside technical disclosure, using one common host and independently lazy-loaded modules. Canonical decisions: [interactive artifacts](../threads/webui-artifacts.md).

## Symbols and ownership

- `buildArtifactGroups`: bounded structured-result traversal, exact Session receipt filtering, ID/revision deduplication and input-bounded reply spans. It never parses stdout for receipts; it reuses the shared Markdown lexer only to suppress exact inline-reference duplicates. Main timelines own one host per revision; nested Activity does not duplicate it.
- `ArtifactView`, `RenderBoundary`: near-viewport authenticated fetch, receipt identity validation, download/expand header for interactive widgets, borderless image figures, renderer failure isolation, native-dialog expansion without reparenting content.
- `artifactRenderers`: lazy module registry. Unsupported types stay visible with source download.
- `ChartRenderer`: closed schema validation, Vega-Lite compile + interpreted Vega runtime, rejecting loader, responsive SVG, semantic theme updates, host trailing-mean/recent/layer controls, read-only metrics.
- `ImageRenderer`, `artifactResourceUrl`, `downloadImageArtifact`: scoped raster resources, existing full-screen image viewer and original-byte download.
- `ReactRenderer`: explicit start, ready/error state, Stop/Reset, source/channel validation, theme relay and browser-background teardown.
- `sandboxDocument`: nested opaque-origin frame documents. The trusted outer CSP limits inner navigation; the inner CSP limits execution/resources. No host capability bridge.

## Integration and verification

The API path is deployment-relative and carries no credentials in URLs. Loaded revisions preserve identity when streamed final text arrives. Native dialog top-layer placement avoids workbench clipping and supplies inert/focus behavior. The browser fixture exercises the real ChatTimeline in all modes with synthetic skill examples and hostile sandbox probes. CSS is loaded by the canonical stylesheet so existing standalone timeline fixtures need no asset-loader changes.
