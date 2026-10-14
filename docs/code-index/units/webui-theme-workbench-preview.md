# Unit: WebUI theme workbench preview

Files: packages/webui/src/components/ThemeWorkbenchPreview.tsx, packages/webui/src/components/ThemeWorkbenchPreview.css
Secondary files: packages/webui/src/components/ThemeManager.tsx, packages/webui/test/workbenchPreview.e2e.mjs

## Purpose

Detailed, static workbench sample for the Appearance preview modal. The compact grid thumbnails remain a separate palette schematic; enlarging their placeholder bars is not the modal preview implementation.

## Public contract

- `ThemeWorkbenchPreview({ variant })` renders navigation, tabs, conversation text, highlighted code, a tool result, composer, and status bar from one validated `ThemeVariant`.
- `themeVariantCssVariables` is applied to the sample root only. Previewing another variant never installs a theme, changes global document variables, or reads live Session data.
- Sample controls are presentational elements, not nested live editor or tool instances. `role="img"` provides one accessible description; modal navigation and actions remain owned by ThemeManager.

## Behavior

- Filled headers use an inner radius reduced by the outer border width; their rounded parents clip child paint. Flat card headers remain square. This avoids rectangular header paint protruding at curved borders.
- Uses the manifest's chrome, user/assistant/tool, syntax, input, and accent-foreground roles. Font families, representative scaled font sizes, and role-specific radii reflect the candidate variant.
- Bounded card/header/density recipes are illustrated without theme-ID branches or arbitrary assets/styles. The scene is illustrative rather than a full nested application or renderer integration.
- Scoped selectors prevent the active application's light/dark classes and typography from recoloring the candidate sample.
- The desktop scene shows a sidebar; container queries hide it in narrow previews while preserving the conversation/composer. The conversation can scroll independently when the sample is shorter than its content.
- CSS is imported with the component; production fixtures must include lazy chunk CSS when mounting source fixtures outside the normal application build.

## Verification

Production workbench E2E checks local candidate palette projection, variant switching without global mutation, explicit theme application, and the narrow scene within the modal. Mock desktop/mobile screenshots are a review aid, not built-in aesthetic assertions.
