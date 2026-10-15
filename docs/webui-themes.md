# WebUI Themes

Foxwarm WebUI themes are portable JSON files. Open **Setup → Appearance** to browse preview cards. Click a card to apply it to its Light/Dark slot; use its separate preview control to inspect its light/dark variants, apply it to either mode, or export it. Custom themes can also be deleted there. Import validates the file and opens its preview before applying. There is no clone action because the UI does not include a theme editor. **Auto** uses independently selected Light and Dark themes; manual **Light** or **Dark** uses the corresponding choice. The compact global settings menu exposes the same color-mode control for quick access and no theme-family/file operations.

Theme packages and the active selection are stored in the current browser. They do not modify Foxwarm server configuration and do not follow an Agent or Session to another browser.

## Built-ins

Foxwarm ships eight immutable built-ins, including distinct visual families and a Default-style warm palette:

- `foxwarm.default` — the standard Foxwarm appearance.
- `foxwarm.foxwarm` — Foxwarm: Default's layout, typography, and geometry with warm-neutral light surfaces, neutral-charcoal dark surfaces, and restrained fox-orange emphasis.
- `foxwarm.550a` — a dense monospace console with a red accent, green tool activity, blue system information, amber warnings, violet special content, and a subtle grid.
- `foxwarm.550a-mono` — 550A Mono: restrained machine-console instrumentation with pale industrial housings, graphite equipment bays, rectilinear panel seams, and a single red sensor beacon.
- `foxwarm.paper` — a warm outlined parchment/editorial theme with serif reading text.
- `foxwarm.seaglass` — a structured teal workspace with moderate-radius outlined panels, banded headers, right-side disclosure, and a dotted depth field.
- `foxwarm.vector` — Vector: VS Code Light Modern / Dark Modern-inspired neutral editor surfaces, blue emphasis, compact system-font controls, integrated outlined cards, and no background pattern.
- `foxwarm.catppuccin` — Catppuccin: Latte light / Mocha dark with Mauve emphasis, tinted user messages, softly outlined cards, and pastel syntax colors.

Vector uses the VS Code Modern palettes as a visual reference. Catppuccin uses the [official palette](https://catppuccin.com/palette/); light-mode status foregrounds are adapted for small-label contrast. These are Foxwarm adaptations, not exact replicas of another application's chrome or editor theme.

All are ordinary version-3 manifests and use the same runtime as imported themes. Export any built-in from Appearance to obtain a complete starting file, then edit the exported file with a new ID.

IDs beginning with `foxwarm.` are reserved. A custom theme ID must contain 3–64 lowercase letters, numbers, dots, underscores, or hyphens.

## Portable file contract

The conventional suffix is `.foxwarm-theme.json`. A version-3 file has this top-level shape:

```json
{
  "schemaVersion": 3,
  "id": "example.my-theme",
  "name": "My Theme",
  "description": "Optional description",
  "author": "Optional author",
  "variants": {
    "light": { "...": "complete variant" },
    "dark": { "...": "complete variant" }
  }
}
```

Each variant is complete and contains:

- `colors` — semantic canvas, surface, border, text, accent, status, tool-operation, message, code/syntax, diff, scrollbar, and terminal colors. V3 additionally requires `sidebarSurface`, `tabBarSurface`, `workbenchHeaderSurface`, `statusBarSurface`, and `accentText`. The workbench header color joins active tabs to their content header. The footer remains transparent, with `statusBarSurface` used only as an interaction highlight base; `accentText` is the foreground on a filled accent control, distinct from generic inverse text;
- `typography` — UI/message/code font stacks, bounded sizes, and line heights;
- `shape` — bounded general plus role-specific message/card/control/tag/composer radii, card gap/inset, border width, and control height;
- `effects` — bounded shadow, glow, press-offset, and transition values;
- `composition` — bounded density, card, header, control, separator, label, and icon treatments;
- `backgroundPattern` — `none`, `grid`, `dots`, `lines`, or `scanlines`, generated locally from semantic colors;
- `displayEffect` — either `none` or a bounded CRT display treatment with validated scan, phosphor-mask, bloom, glass, vignette, reflection, and refresh-roll parameters;
- `componentTreatment` — `standard` or `console`.

Exporting a built-in is the authoritative way to obtain all required version-3 fields. Export output is canonical JSON and can be imported into another Foxwarm browser. Version-1 and version-2 files are rejected with a visible validation error rather than receiving guessed values for newly introduced semantic roles.

## Safety and validation

Theme files are declarative data. Foxwarm rejects:

- unknown or missing fields;
- unsupported schema versions;
- arbitrary CSS, selectors, scripts, or remote assets;
- custom shaders, textures, or executable display effects;
- non-hex colors;
- out-of-range numeric values;
- oversized files and an oversized local custom-theme registry.

Validation also reports warnings for important low-contrast text/surface pairs. Import validates the entire file before changing browser storage. An existing custom ID requires explicit replacement. Deleting the selected custom theme activates Default atomically.

## Runtime behavior

The selected variant is applied before React renders. Auto mode follows the operating-system color preference and updates live. Other tabs/windows on the same origin converge through browser storage events.

Semantic theme tokens style the WebUI and are adapted to xterm.js, Monaco, and Mermaid. Components do not branch on a built-in theme ID. `componentTreatment` is a bounded layout/component grammar; it is not an arbitrary CSS injection surface. Consequently, an exported and reimported console theme follows the same rendering path as the 550A and 550A Mono built-ins.

## Troubleshooting

If a custom theme is malformed, Foxwarm skips it and keeps built-in themes available. If the selected theme no longer exists, the runtime falls back to Default. Use **Setup → Appearance → Export** before replacing or deleting a custom theme that you want to preserve.

## Color-mode choices and upgrade behavior

Light and Dark theme IDs are browser-local independent choices. Auto follows the system color scheme and activates the corresponding family and variant; editing or previewing the other choice does not switch the current appearance. Manual Light and Dark keep both stored choices and select the appropriate one. Export includes both complete variants, regardless of the variant being previewed.

V3 uses isolated `foxwarm_theme_selection_v3` and `foxwarm_custom_themes_v3` storage. Existing V1/V2 selection preferences seed both choices with the previous theme ID; this migrates a preference, not a portable manifest. Older custom packages remain preserved under their original keys but are not given guessed V3 roles. Missing or unavailable choices render Default without silently rewriting either stored choice. Deleting a custom theme resets only slots referencing it.
