# Unit: WebUI Node data usage

Files: packages/webui/src/storage/NodeDataUsage.tsx, packages/webui/src/storage/dataUsage.css
Secondary files: packages/webui/src/components/NodesView.tsx, packages/webui/src/components/ArchitectureView.tsx, packages/webui/test/workbenchPreview.e2e.mjs

## Purpose and symbols

Canonical contract: [Node data usage](../threads/node-data-usage.md).

- `NodeDataUsage`: shared compact Data trigger; viewport/document-visibility-aware polling, transient per-Node cache and in-flight coalescing, generation fencing and explicit refresh.
- `Details`: native modal drawer with full-screen phone layout, Escape/focus return, totals/categories, workspace filtering, first-level disclosure and path copy. Existing Session selection is not changed.
- `dataSize`: byte formatting with binary units.

Only authenticated fixed Node endpoints are fetched. Parsed reports are validated before display; errors and unsupported states show no invented zero. Old reports retain measured timestamps; partial values are lower bounds. Native browser tests cover both callers, narrow/wide geometry, disclosure, copy controls, keyboard return and synthetic previews.
