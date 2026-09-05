# WebUI Themes

Foxwarm WebUI themes are portable JSON files. Open **Setup → Appearance** to select a theme or import, export, clone, and delete custom themes. Appearance's palette preview includes **Auto**, **Light**, and **Dark** controls so variants can be inspected in place. The compact global settings menu exposes the same color-mode control for quick access and no theme-family/file operations.

Theme packages and the active selection are stored in the current browser. They do not modify Foxwarm server configuration and do not follow an Agent or Session to another browser.

## Built-ins

Foxwarm ships two immutable built-ins:

- `foxwarm.default` — the standard Foxwarm appearance.
- `foxwarm.550a` — the dense console-inspired appearance.

Both are ordinary version-1 manifests and use the same runtime as imported themes. Export either built-in from Appearance to obtain a complete starting file, then use **Clone** or edit the exported file with a new ID.

IDs beginning with `foxwarm.` are reserved. A custom theme ID must contain 3–64 lowercase letters, numbers, dots, underscores, or hyphens.

## Portable file contract

The conventional suffix is `.foxwarm-theme.json`. A version-1 file has this top-level shape:

```json
{
  "schemaVersion": 1,
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

- `colors` — semantic canvas, surface, border, text, accent, status, message, code, diff, scrollbar, and terminal colors;
- `typography` — UI/message/code font stacks, bounded sizes, and line heights;
- `shape` — bounded radii, border width, and control height;
- `effects` — bounded shadow, glow, press-offset, and transition values;
- `backgroundPattern` — `none` or a bounded semantic-color grid;
- `componentTreatment` — `standard` or `console`.

Exporting a built-in is the authoritative way to obtain all required version-1 fields. Export output is canonical JSON and can be imported into another Foxwarm browser.

## Safety and validation

Theme files are declarative data. Foxwarm rejects:

- unknown or missing fields;
- unsupported schema versions;
- arbitrary CSS, selectors, scripts, or remote assets;
- non-hex colors;
- out-of-range numeric values;
- oversized files and an oversized local custom-theme registry.

Validation also reports warnings for important low-contrast text/surface pairs. Import validates the entire file before changing browser storage. An existing custom ID requires explicit replacement. Deleting the selected custom theme activates Default atomically.

## Runtime behavior

The selected variant is applied before React renders. Auto mode follows the operating-system color preference and updates live. Other tabs/windows on the same origin converge through browser storage events.

Semantic theme tokens style the WebUI and are adapted to xterm.js, Monaco, and Mermaid. Components do not branch on a built-in theme ID. `componentTreatment` is a bounded layout/component grammar; it is not an arbitrary CSS injection surface. Consequently, an exported and reimported console theme follows the same rendering path as the 550A built-in.

## Troubleshooting

If a custom theme is malformed, Foxwarm skips it and keeps built-in themes available. If the selected theme no longer exists, the runtime falls back to Default. Use **Setup → Appearance → Export** before replacing or deleting a custom theme that you want to preserve.
