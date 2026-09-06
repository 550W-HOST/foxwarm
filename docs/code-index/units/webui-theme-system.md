# Unit: WebUI theme system

Files: packages/webui/src/theme/manifest.ts, packages/webui/src/theme/builtins/index.ts, packages/webui/src/theme/builtins/shared.ts, packages/webui/src/theme/builtins/default.ts, packages/webui/src/theme/builtins/550a.ts, packages/webui/src/theme/storage.ts, packages/webui/src/theme/runtime.ts, packages/webui/src/theme/useTheme.ts, packages/webui/src/theme/integrations.ts, packages/webui/src/theme/index.ts, packages/webui/src/components/ThemeManager.tsx, packages/webui/index.html, packages/webui/src/index.css, packages/webui/tailwind.config.js, packages/webui/test/themeSystem.test.mjs, packages/webui/test/themeMarkdownStyles.e2e.mjs, packages/webui/test/threadCardSurfaces.e2e.mjs
Secondary files: packages/webui/src/main.tsx, packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/src/components/SetupView.tsx, packages/webui/src/components/TerminalView.tsx, packages/webui/src/components/SimpleCodeEditor.tsx, packages/webui/src/components/SpecialBlock.tsx, docs/webui-themes.md, README.md

## Purpose

Defines the portable, browser-local WebUI theme contract, built-in registry, persistence and migration behavior, document-level runtime, Setup management UI, semantic CSS/Tailwind bridge, and renderer adapters.

## Public contract

- `ThemeManifest` is a strict version-2 JSON manifest with one complete `light` variant and one complete `dark` variant. Version-1 theme files are rejected rather than assigned guessed values for new semantic roles.
- Each variant supplies semantic colors—including dedicated `tool*`, syntax-role, and diff foreground families—typography, role-specific geometry, effects, a bounded composition recipe, a procedural background pattern, a bounded display effect, and a bounded `componentTreatment` (`standard` or `console`).
- `validateThemeManifest`, `parseThemeManifestJson`, and `serializeThemeManifest` validate and canonically serialize the portable file format.
- `BUILTIN_THEMES` contains immutable built-ins in the reserved `foxwarm.*` namespace, with one source file per built-in.
- `initializeThemeRuntime`, `setThemeSelection`, `subscribeThemeRuntime`, and `getThemeSnapshot` expose the external runtime store; `useTheme` is its React adapter.
- `themeVariantCssVariables` provides the semantic CSS-variable projection. `terminalThemeFromSnapshot`, `monacoThemeFromSnapshot`, and `mermaidThemeFromSnapshot` adapt the same resolved variant to third-party renderers.

## Behavior

- `main.tsx` initializes the selected theme before rendering React, avoiding a default-theme flash. The runtime applies the complete selected variant atomically to the document root.
- Theme family and color mode are separate preferences. Color mode is `auto`, `light`, or `dark`; `auto` follows `prefers-color-scheme` and reacts live.
- Existing `foxwarm_theme_selection_v1`, `themeMode`, and `foxwarm_ui_theme_style_v1` values migrate once into the versioned `foxwarm_theme_selection_v2` shape when no valid current selection exists. The separate V2 key prevents an older live WebUI bundle from overwriting a newly added built-in selection that its compiled registry does not recognize.
- Custom manifests are local to the current browser. Storage is bounded to 32 themes; malformed entries are skipped without breaking the built-in registry.
- Import validates before writing, rejects reserved IDs, and requires explicit replacement on ID conflict. Export is canonical JSON. Clone re-enters through the same validator/install path. Deleting the active custom theme falls back atomically to Default.
- Validation rejects unknown keys, incomplete variants, non-hex colors, arbitrary CSS/selectors/scripts, URLs, and unbounded string/numeric values. Core text/surface pairs produce contrast warnings.
- Setup's Appearance tab owns theme family selection and import/export/clone/delete, and places `Auto`, `Light`, and `Dark` directly above the active palette preview. The compact global UI menu exposes the same color-mode selection for quick access but no theme-family/file operations.
- Setup and Architecture use the same page-depth contract: their root workspace reads `canvas`, primary panels read `surface`, and nested controls may use raised/sunken roles. Setup does not substitute `surfaceSunken` in light mode or `canvasEdge` in dark mode.
- Semantic `--foxwarm-color-*` variables back `fw-*` Tailwind utilities and non-utility CSS. Components do not branch on a theme ID. Completed tool cards, tags, response separators, action controls, and ContextScrollbar activity segments all consume the same `tool`, `toolSurface`, `toolSurfaceStrong`, and `toolBorder` family; actual success notifications continue to consume `success*`. Lightweight code highlighting consumes explicit `syntax*` roles, while diff counts, headers, and refined tokens consume `diffAddedText`/`diffRemovedText` rather than borrowing accent/warning status colors.
- Semantic `*Surface` and `*SurfaceStrong` tokens carry the theme's named colors, including any alpha intentionally supplied by the manifest. Standard treatment may apply stable component-owned opacity composition for its established translucent visual grammar. Console treatment consumes named Tool status, Reasoning, and System surface pairs as final colors so a portable console theme is not diluted a second time; neutral console cards use the treatment's panel/hover pair because the manifest intentionally has no `neutralSurfaceStrong` field.
- `componentTreatment` is a small declarative treatment selector, not arbitrary CSS. The 550A built-in selects `console`; an exported and reimported manifest selecting `console` follows the same rendering path.
- `composition` independently selects bounded density (`compact|comfortable|airy`), card (`flat|outlined|elevated`), header (`integrated|banded|tab|plate`), control (`plain|soft|pill`), separator (`rail|line|segmented|chevron|chevron-right`), label, and icon recipes. Runtime exposes these choices as document data attributes; generic CSS recipes consume them without theme-ID branches.
- Role-specific radii and card gap/inset values let message bubbles, thread cards, controls, tags, and the composer develop separate silhouettes and balanced internal rhythm. Procedural `grid`, `dots`, `lines`, and `scanlines` patterns remain URL/asset-free.
- `displayEffect` is separate from flat canvas `backgroundPattern`. Its bounded `crt` recipe scopes an above-content raster/mask plus glass layer to the Chat display region, derives textures locally, keeps navigation controls and ContextScrollbar above the overlay, and disables refresh-roll animation under `prefers-reduced-motion`.
- xterm updates its palette when the runtime theme changes. Monaco redefines and applies its generated theme, including before lazy editor creation. Mermaid receives per-render variables from the active variant.
- Cross-window `storage` events, system color-mode changes, and local changes converge through the same runtime store and theme-change event.

## Persistence keys

- `foxwarm_theme_selection_v2` — `{ version, themeId, colorMode }`; V1 is migration input only.
- `foxwarm_custom_themes_v2` — bounded validated version-2 custom manifest registry, isolated from stale live bundles.
- `themeMode`, `foxwarm_ui_theme_style_v1` — read-only legacy migration inputs.

## Tests

- `themeSystem.test.mjs` covers built-in validation, canonical round trips, strict rejection, legacy migration, bounded custom install/conflict/replace/export/delete, reserved IDs, and portable 550A clone equivalence.
- `themeMarkdownStyles.e2e.mjs` covers Default and console-treatment Markdown/code pairings.
- `threadCardSurfaces.e2e.mjs` mounts every thread-card family and verifies raw plus visibly composited body/header and ToolTag colors through Default and representative imported standard/console manifests. Its contrast helper composites foreground alpha before measuring. The fixture protects standard treatment's established opacity contract, built-in Default System-tag contrast, console treatment's final-surface contract, Tool Group tone hooks, named Reasoning-token use, and semantic wiring (not a universal AA guarantee). Built-ins are not given separate visual test matrices; registry-wide validation plus representative synthetic manifests test the theme engine, while individual built-in aesthetics remain a review concern.
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

### D-webui-theme-final-surfaces

[2026-09-03] Surface composition is treatment-owned. Standard treatment retains its established component opacity layers. Console treatment treats named Tool status, Reasoning, and System surface pairs as final colors because a portable console manifest may already encode intentional translucency; applying the standard opacity layer again would make those cards depend incorrectly on their parent background. Neutral console cards use the bounded treatment-level panel/hover pair rather than adding a manifest field or branching on a theme ID. Console Reasoning must use `reasoningSurface`/`reasoningSurfaceStrong`, not generic panel/hover aliases, so imported themes can choose a distinct reasoning palette.

[2026-09-06] Theme schema V2 separates ordinary tool-operation color from success status through the required `tool`, `toolSurface`, `toolSurfaceStrong`, and `toolBorder` family. Tool cards, ToolTags, tool controls, separators, and ContextScrollbar activity use that family across both component treatments. Default explicitly preserves its historical success-colored tool values, while redesigned and imported V2 themes can coordinate tools with their own palette. V1 theme files are rejected with validation details rather than guessed or conditionally migrated. This avoids theme-ID and treatment conditionals while keeping Default pixel-compatible.

[2026-09-06] V2's visual grammar was expanded before publication rather than creating a migration-bearing V3. The immutable registry was reduced to five deliberately differentiated built-ins: Default, 550A, Paper, Sea Glass, and Vector. Density, surface/header/control/separator recipes—including a borderless role-tinted `plate` header—role-specific geometry and card gaps, label/icon treatment, elevation, and safe procedural patterns now complement semantic color. Default retains its previous measurements and composition, while imported manifests use the identical recipe path.

[2026-09-06] 550A was redesigned as restrained industrial instrumentation rather than a generic red CRT theme. Its light variant emphasizes a gray-white enclosure, the dark variant uses neutral equipment-bay graphite, and ordinary Tool/System/Success surfaces stay achromatic; red is reserved for the accent/focus path and the active composer send control, rendered by the portable `console` treatment as a bordered sensor beacon. Page-wide scanlines were removed: the light chassis stays texture-free, while the dark display may use the bounded background `scanlines` recipe beneath content. A role-tinted, edge-free `plate` header adds material hierarchy without enclosing every row. Representative imported console manifests—not a 550A-specific visual matrix—protect the treatment contract.

[2026-09-04] Built-in Default System/Event tag text must not reuse `systemAccent`, whose direction and contrast are intentionally suitable for low-emphasis thread lines rather than compact label text. Keep the existing standard System tag background, derive its foreground with a bounded `info`/`systemText` mix, and use `infoBorder`. The wiring remains portable because it depends only on semantic tokens, but custom manifests determine the derived contrast and the validator's warnings remain advisory; this decision does not promise AA for every legal token combination. Console treatment retains its separate exact override.
