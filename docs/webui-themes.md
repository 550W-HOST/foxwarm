# WebUI Themes

Foxwarm WebUI themes are portable JSON files. Open **Setup → Appearance** to select a theme or import, export, clone, and delete custom themes. Appearance's palette preview includes **Auto**, **Light**, and **Dark** controls so variants can be inspected in place. The compact global settings menu exposes the same color-mode control for quick access and no theme-family/file operations.

Theme packages and the active selection are stored in the current browser. They do not modify Foxwarm server configuration and do not follow an Agent or Session to another browser.

## Built-ins

Foxwarm ships six immutable built-ins. The registry stays intentionally small so each option has a distinct visual grammar rather than being a palette-only variation:

- `foxwarm.default` — the standard Foxwarm appearance.
- `foxwarm.550a` — a dense monospace console with a red accent, green tool activity, blue system information, amber warnings, violet special content, and a subtle grid.
- `foxwarm.550a-mono` — 550A Mono: restrained machine-console instrumentation with pale industrial housings, graphite equipment bays, rectilinear panel seams, and a single red sensor beacon.
- `foxwarm.paper` — a warm outlined parchment/editorial theme with serif reading text.
- `foxwarm.seaglass` — a structured teal workspace with moderate-radius outlined panels, banded headers, right-side disclosure, and a dotted depth field.
- `foxwarm.vector` — Vector: a modern technical workbench with restrained geometry, integrated headers, right disclosure, cyan operations, and magenta system signals.

All are ordinary version-2 manifests and use the same runtime as imported themes. Export any built-in from Appearance to obtain a complete starting file, then use **Clone** or edit the exported file with a new ID.

IDs beginning with `foxwarm.` are reserved. A custom theme ID must contain 3–64 lowercase letters, numbers, dots, underscores, or hyphens.

## Portable file contract

The conventional suffix is `.foxwarm-theme.json`. A version-2 file has this top-level shape:

```json
{
  "schemaVersion": 2,
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

- `colors` — semantic canvas, surface, border, text, accent, status, tool-operation, message, code/syntax, diff surface/text, scrollbar, and terminal colors. Version 2 gives tool operations, activity/minimap segments, syntax roles, and diff foregrounds dedicated families instead of borrowing status colors;
- `typography` — UI/message/code font stacks, bounded sizes, and line heights;
- `shape` — bounded general plus role-specific message/card/control/tag/composer radii, card gap/inset, border width, and control height;
- `effects` — bounded shadow, glow, press-offset, and transition values;
- `composition` — bounded density, card, header, control, separator, label, and icon treatments;
- `backgroundPattern` — `none`, `grid`, `dots`, `lines`, or `scanlines`, generated locally from semantic colors;
- `displayEffect` — either `none` or a bounded CRT display treatment with validated scan, phosphor-mask, bloom, glass, vignette, reflection, and refresh-roll parameters;
- `componentTreatment` — `standard` or `console`.

Exporting a built-in is the authoritative way to obtain all required version-2 fields. Export output is canonical JSON and can be imported into another Foxwarm browser. Version-1 files are rejected with a visible validation error rather than receiving guessed values for newly introduced semantic roles.

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
