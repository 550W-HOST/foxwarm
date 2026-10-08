# Unit: WebUI history search

Files: `packages/webui/src/components/HistorySearchView.tsx`, `packages/webui/test/historySearchViewer.e2e.mjs`

## Purpose

Provides a read-only workbench view over host-returned history search results and opens exact message references in Chat.

## Behavior

Search results are bounded presentation data. Opening a result navigates to the owning Session and message reference without mutating Session history, queue state, or the host search index.
