# Unit: webui-settings-menu

Files: packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/src/components/menuPositioning.ts, packages/webui/test/settingsMenuPosition.e2e.mjs

## Purpose

Renders a dropdown settings menu for the web UI that allows users to configure theme style, light/dark/auto color mode, input send-key mode, chat display options (tool grouping, usage badges), instance name, tab icon, and provides access to setup and app reload actions.

## Key Exports

- `GlobalUiSettingsMenu` — default-exported React component rendering the global UI settings dropdown
- `clampAnchoredMenuHorizontally` — pure preferred-alignment + viewport-gutter clamp helper
- `readHorizontalViewportBounds` — intersects the layout/body bounds with the current visual viewport
- `ThemeMode` — type alias (`'auto' | 'light' | 'dark'`)
- `SendKeyMode` — type alias (`'modEnter' | 'enter'`)
- `GlobalUiSettingsMenuProps` — props interface for the component, including controlled `uiThemeStyle` / `onUiThemeStyleChange` for client-only visual style selection

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `GlobalUiSettingsMenu(props)` | ~32–end | Main component rendering the settings gear button and dropdown panel |
| `submitInstanceName(name)` | ~97–108 | Async handler that persists instance name and handles errors |
| `submitTabIcon(nextTabIcon)` | ~110–121 | Async handler that persists tab icon and handles errors |
| `clampAnchoredMenuHorizontally(options)` | (menuPositioning.ts) | Keeps the preferred start/end placement when possible and otherwise clamps both horizontal edges |
| `readHorizontalViewportBounds()` | (menuPositioning.ts) | Reads body/layout/visual-viewport horizontal bounds for zoom-aware placement |

## Dependencies

- `./ReloadAppButton` — button component that triggers a full app reload

## Behavior

- Manages open/closed state of the dropdown menu with click-outside and Escape key dismissal via document event listeners.
- Provides a `Theme style` selector (`Default` / `550A`) independent from the existing color mode selector (`auto` / `light` / `dark`). Changing theme style calls the parent callback and closes the menu.
- Provides toggle switches for `groupTools` and `showUsageBadge` settings, calling parent callbacks on change.
- Supports inline editing of instance name and tab icon with optimistic draft state, async save, and error display.
- Detects macOS/iOS to display the correct modifier key label (Cmd vs Ctrl) for the send-key option.
- Closes the menu automatically after theme change, successful name/icon save, or setup open.
- `menuAlign` remains the preferred start/end alignment rather than an absolute promise. While open, the component measures the trigger/menu against the body and visual viewport, preserves the preferred alignment when it fits, and translates the menu only enough to keep an 8px horizontal gutter on both edges.
- Horizontal placement stays live while the menu is open, so viewport resize, sidebar width/position changes, scroll, browser zoom/pinch zoom, and menu width changes are re-clamped without closing the menu. Menu height-only changes do not alter horizontal placement.
- The menu keeps its existing in-tree absolute positioning and z-index rather than moving into a global portal, so Code iframe/stacking behavior and unrelated dropdowns/popovers are unchanged.
- Both the normal and Code-embedded sidebars prefer `menuAlign="end"`. When `setupActive` is true, the gear trigger and Setup menu row use the same blue selected treatment.

## Integration

- Receives all settings values and change handlers as props from a parent layout/app shell component, acting as a pure controlled UI. Client-only preferences such as UI theme style are owned/persisted by `App`, while instance name/tab icon are server-backed WebUI settings.
- Delegates app reload to `ReloadAppButton`.
- Optionally triggers an external setup flow via `onOpenSetup` callback.
- Code launch actions are intentionally not exposed here; the dedicated sidebar Code split button is the primary entry and owns launch-mode configuration.
- Designed to sit in a toolbar/header and align its dropdown via the `menuAlign` prop.

## Design Decisions

- [2026-07-22] Global UI settings placement is preferred-alignment plus viewport clamping: preserve the current start/end alignment when there is room, but if either horizontal edge would leave the body/visual viewport, shift the whole menu inside an 8px safe gutter even though it no longer aligns with the trigger corner. Apply this to ordinary desktop/mobile and Code-embedded sidebars without changing other popovers or iframe stacking.
