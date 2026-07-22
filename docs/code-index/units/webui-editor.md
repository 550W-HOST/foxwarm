# Unit: webui-editor

Files: packages/webui/src/components/SimpleCodeEditor.tsx, packages/webui/src/components/DiffPreview.tsx

## Purpose

Provides reusable code editing and diff visualization components for the WebUI. `SimpleCodeEditor` lazy-loads Monaco for configuration/code editing surfaces, and `DiffPreview` renders side-by-side or unified diffs with syntax highlighting.

## Key Exports

- `SimpleCodeEditor` — Async-loading Monaco editor wrapper with configurable height and placeholder support
- `DiffPreview` — Memoized diff visualization component supporting unified and split view modes

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `currentTheme()` (SimpleCodeEditor) | ~22 | Returns 'vs-dark' or 'vs' based on document class |
| `SimpleCodeEditor({ value, onChange, ... })` | ~25–120 | Async-loads Monaco and creates an editor with dynamic language/value sync |
| `start()` (inside SimpleCodeEditor useEffect) | ~47–87 | Dynamically imports Monaco, creates model and editor |
| `DiffPreview({ oldText, newText, diffViewMode, filePath })` | ~10–145 | Renders unified or split diff with word-level highlighting |
| `handleOldScroll(e)` | ~15–24 | Syncs scroll position from old pane to new pane |
| `handleNewScroll(e)` | ~26–35 | Syncs scroll position from new pane to old pane |

## Dependencies

- `../utils/languages` — `getMonacoLanguage` for file-path-to-language mapping
- `./chatShared` — `Diff` (line/word diff algorithm)
- `./SyntaxHighlightedText` — `SyntaxHighlightedText` component for token-level highlighting in diffs

## Behavior

- **SimpleCodeEditor** lazily imports Monaco inside a `useEffect`, uses refs to capture the latest value/placeholder so the model is created with current data even if imports resolve late. Supports configurable height and language switching.
- **DiffPreview** computes line-level diffs via `Diff.diffLines`, then refines adjacent removed+added pairs with `Diff.diffWords` for inline highlighting. Split mode synchronizes horizontal and vertical scroll between the two panes using a debounce-style ref guard.

## Integration

- `SimpleCodeEditor` is used in setup/configuration surfaces where a Monaco-backed inline editor is needed without adding Monaco to the initial bundle.
- `DiffPreview` is used in chat and review flows to show file change proposals before acceptance.
- The former full-page WebUI file editor (`FileEditorView` + `MonacoFileEditor`) was removed with the WebUI workspace feature on 2026-07-06.
