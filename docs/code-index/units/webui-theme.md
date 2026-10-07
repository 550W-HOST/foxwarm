# Unit: Theme system and built-in themes

Files: `packages/webui/src/components/ThemeManager.tsx`, `packages/webui/src/theme/builtins/550a-mono.ts`, `packages/webui/src/theme/builtins/550a.ts`, `packages/webui/src/theme/builtins/default.ts`, `packages/webui/src/theme/builtins/index.ts`, `packages/webui/src/theme/builtins/paper.ts`, `packages/webui/src/theme/builtins/seaglass.ts`, `packages/webui/src/theme/builtins/shared.ts`, `packages/webui/src/theme/builtins/vector.ts`, `packages/webui/src/theme/index.ts`, `packages/webui/src/theme/integrations.ts`, `packages/webui/src/theme/manifest.ts`, `packages/webui/src/theme/runtime.ts`, `packages/webui/src/theme/storage.ts`, `packages/webui/src/theme/useTheme.ts`

## Purpose

Defines the built-in/manifest theme catalog, browser-local selection, runtime CSS token application, and integrations for Markdown, Code, thread cards, and controls.

## Stable symbols and callers

`ThemeManager`; `theme/manifest`; `theme/runtime`; `theme/storage`; `theme/integrations`; `useTheme`; built-in theme modules. App initializes this runtime before ordinary React surfaces; Markdown/timeline/Code consume integration tokens.

## Behavior and side effects

Manifest parsing accepts only the supported theme shape and safe token/reference values; malformed or unavailable manifest entries fall back to built-ins. Runtime application and built-in definitions share the same token semantics so light/dark/theme variants do not drift from integration surfaces. Selection/storage is browser-local and survives reload without becoming Session/catalog authority.

Theme controls expose the current catalog/selection and preserve local ownership; server branding is separate. Final surfaces allocate distinct semantic tones for standard/console thread cards, System, Tool, Reasoning, CTX-BLOCK, WebSearch, Markdown, and Code without letting a global color remap collapse their readability contracts.

## Tests

Theme manifest/storage/runtime, built-in theme, Markdown integration, and thread-card styling browser tests.
