# Unit: Theme system and built-in themes

Files: `packages/webui/src/components/ThemeManager.tsx`, `packages/webui/src/theme/builtins/550a-mono.ts`, `packages/webui/src/theme/builtins/550a.ts`, `packages/webui/src/theme/builtins/default.ts`, `packages/webui/src/theme/builtins/index.ts`, `packages/webui/src/theme/builtins/paper.ts`, `packages/webui/src/theme/builtins/seaglass.ts`, `packages/webui/src/theme/builtins/shared.ts`, `packages/webui/src/theme/builtins/vector.ts`, `packages/webui/src/theme/index.ts`, `packages/webui/src/theme/integrations.ts`, `packages/webui/src/theme/manifest.ts`, `packages/webui/src/theme/runtime.ts`, `packages/webui/src/theme/storage.ts`, `packages/webui/src/theme/useTheme.ts`

## Purpose

Defines persisted theme selection, runtime style application, integrations, manifest, and built-in theme catalog.

## Stable symbols and callers

`ThemeManager`; `theme/runtime`; `theme/storage`; `theme/manifest`; built-in theme modules.

Callers and boundary: App shell and Markdown/rendering integration.

## Behavior and side effects

`ThemeManager` loads the manifest/built-in theme catalog, applies runtime CSS variables, persists selected theme, and exposes integration tokens to Markdown/Code surfaces. Storage failures fall back to a built-in theme; theme state never changes Session authority.

## Tests

Theme system and theme Markdown style tests.
