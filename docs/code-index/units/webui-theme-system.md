# Unit: WebUI theme system

Files: packages/webui/src/theme/manifest.ts, packages/webui/src/theme/builtins/index.ts, packages/webui/src/theme/builtins/shared.ts, packages/webui/src/theme/builtins/default.ts, packages/webui/src/theme/builtins/550a.ts, packages/webui/src/theme/storage.ts, packages/webui/src/theme/runtime.ts, packages/webui/src/theme/useTheme.ts, packages/webui/src/theme/integrations.ts, packages/webui/src/theme/index.ts, packages/webui/src/components/ThemeManager.tsx, packages/webui/index.html, packages/webui/src/index.css, packages/webui/tailwind.config.js, packages/webui/test/themeSystem.test.mjs, packages/webui/test/themeMarkdownStyles.e2e.mjs
Secondary files: packages/webui/src/main.tsx, packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/src/components/SetupView.tsx, packages/webui/src/components/TerminalView.tsx, packages/webui/src/components/SimpleCodeEditor.tsx, packages/webui/src/components/SpecialBlock.tsx, docs/webui-themes.md, README.md

## Purpose

Defines the portable, browser-local WebUI theme contract, built-in registry, persistence and migration behavior, document-level runtime, Setup management UI, semantic CSS/Tailwind bridge, and renderer adapters.

## Public contract

- `ThemeManifestV1` is a strict, versioned JSON manifest with one complete `light` variant and one complete `dark` variant.
- Each variant supplies semantic colors, typography, shape/effects, a bounded background pattern, and a bounded `componentTreatment` (`standard` or `console`).
- `validateThemeManifest`, `parseThemeManifestJson`, and `serializeThemeManifest` validate and canonically serialize the portable file format.
- `BUILTIN_THEMES` contains immutable `foxwarm.default` and `foxwarm.550a` manifests. The `foxwarm.*` namespace is reserved.
- `initializeThemeRuntime`, `setThemeSelection`, `subscribeThemeRuntime`, and `getThemeSnapshot` expose the external runtime store; `useTheme` is its React adapter.
- `themeVariantCssVariables` provides the semantic CSS-variable projection. `terminalThemeFromSnapshot`, `monacoThemeFromSnapshot`, and `mermaidThemeFromSnapshot` adapt the same resolved variant to third-party renderers.

## Behavior

- `main.tsx` initializes the selected theme before rendering React, avoiding a default-theme flash. The runtime applies the complete selected variant atomically to the document root.
- Theme family and color mode are separate preferences. Color mode is `auto`, `light`, or `dark`; `auto` follows `prefers-color-scheme` and reacts live.
- Existing `themeMode` and `foxwarm_ui_theme_style_v1` values migrate once into the versioned `foxwarm_theme_selection_v1` shape when no valid new selection exists.
- Custom manifests are local to the current browser. Storage is bounded to 32 themes; malformed entries are skipped without breaking the built-in registry.
- Import validates before writing, rejects reserved IDs, and requires explicit replacement on ID conflict. Export is canonical JSON. Clone re-enters through the same validator/install path. Deleting the active custom theme falls back atomically to Default.
- Validation rejects unknown keys, incomplete variants, non-hex colors, arbitrary CSS/selectors/scripts, URLs, and unbounded string/numeric values. Core text/surface pairs produce contrast warnings.
- Setup's Appearance tab owns theme family selection and import/export/clone/delete, and places `Auto`, `Light`, and `Dark` directly above the active palette preview. The compact global UI menu exposes the same color-mode selection for quick access but no theme-family/file operations.
- Semantic `--foxwarm-color-*` variables back `fw-*` Tailwind utilities and non-utility CSS. Components do not branch on a theme ID.
- `componentTreatment` is a small declarative treatment selector, not arbitrary CSS. The 550A built-in selects `console`; an exported and reimported manifest selecting `console` follows the same rendering path.
- xterm updates its palette when the runtime theme changes. Monaco redefines and applies its generated theme, including before lazy editor creation. Mermaid receives per-render variables from the active variant.
- Cross-window `storage` events, system color-mode changes, and local changes converge through the same runtime store and theme-change event.

## Persistence keys

- `foxwarm_theme_selection_v1` — `{ version, themeId, colorMode }`.
- `foxwarm_custom_themes_v1` — bounded validated custom manifest registry.
- `themeMode`, `foxwarm_ui_theme_style_v1` — read-only legacy migration inputs.

## Tests

- `themeSystem.test.mjs` covers built-in validation, canonical round trips, strict rejection, legacy migration, bounded custom install/conflict/replace/export/delete, reserved IDs, and portable 550A clone equivalence.
- `themeMarkdownStyles.e2e.mjs` covers Default and console-treatment Markdown/code pairings.
- Setup E2E covers Appearance-tab selection, treatment activation, clone/delete, and keyboard tab behavior.
- Settings-menu E2E asserts that the compact menu contains color mode only.
- Existing Code overlay, editor, terminal, Mermaid, and component E2Es protect integration surfaces.

## Design decisions

### D-webui-theme-manifest-safety

[2026-09-03] Portable themes are declarative data, not executable styling packages. A manifest must be versioned, strictly validated, complete for light and dark, and limited to documented semantic tokens and bounded treatment options. Arbitrary CSS, selectors, scripts, and remote assets are outside the contract.

### D-webui-theme-runtime-parity

[2026-09-03] Built-in and imported themes use the same manifest validation, resolution, CSS-variable projection, component-treatment path, and renderer adapters. A component must not test for `foxwarm.550a` or another theme ID to decide how to render.

### D-webui-theme-controls

[2026-09-03] Theme-family management belongs in Setup's Appearance tab because it includes registry/file operations. Appearance also places `Auto`, `Light`, and `Dark` above the palette preview for in-context variant inspection. The compact global UI menu contains only that frequently changed color-mode control and does not duplicate theme-family/file operations.

### D-webui-theme-local-ownership

[2026-09-03] Theme packages and the current selection remain browser-local preferences. They are not instance configuration, server data, or Agent state.
