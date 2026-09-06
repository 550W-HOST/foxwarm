# Unit: webui-settings-menu

Files: packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/src/components/SessionUiSettingsMenu.tsx, packages/webui/src/contextScrollbarSettings.ts, packages/webui/src/components/menuPositioning.ts, packages/webui/test/settingsMenuPosition.e2e.mjs, packages/webui/test/chatSettingsPlacement.e2e.mjs

## Purpose

Renders the compact global UI dropdown for color mode, Setup, and reload plus the per-Chat session-header dropdown for browser-local input/chat display preferences and Debug.

## Key Exports

- `GlobalUiSettingsMenu` — default-exported React component rendering the global UI settings dropdown
- `SessionUiSettingsMenu` — per-Chat header menu for send behavior, tool grouping, usage badges, minimap visibility, direct-user metadata visibility, and Debug
- `clampAnchoredMenuHorizontally` — pure preferred-alignment + viewport-gutter clamp helper
- `readHorizontalViewportBounds` — intersects the layout/body bounds with the current visual viewport
- Both menus use the existing send-mode union (`'modEnter' | 'enter'`) at their component boundary.
- `GlobalUiSettingsMenuProps` — props interface for Setup activation and preferred menu alignment

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `GlobalUiSettingsMenu(props)` | ~32–end | Main component rendering the settings gear button and dropdown panel |
| `SessionUiSettingsMenu(props)` | `SessionUiSettingsMenu.tsx` | Session-header Input/Chat preference menu with local minimap synchronization |
| `clampAnchoredMenuHorizontally(options)` | (menuPositioning.ts) | Keeps the preferred start/end placement when possible and otherwise clamps both horizontal edges |
| `readHorizontalViewportBounds()` | (menuPositioning.ts) | Reads body/layout/visual-viewport horizontal bounds for zoom-aware placement |

## Dependencies

- `./ReloadAppButton` — button component that triggers a full app reload

## Behavior

- Manages open/closed state of the dropdown menu with click-outside and Escape key dismissal via document event listeners.
- Provides only the frequent `Auto` / `Light` / `Dark` color-mode control. Setup's Appearance tab repeats color mode above its palette preview and exclusively owns theme-family and portable file management.
- The session-header menu provides `groupTools`, `showUsageBadge`, browser-local `Show minimap`, and `Show user message metadata`. Minimap remains disabled only when it is the sole enabled context display, so scrollbar/minimap preferences cannot become both disabled.
- The session-header menu detects macOS/iOS to display the correct modifier key label (Cmd vs Ctrl) for the send-key option.
- The global menu closes automatically after color-mode change or Setup activation. Both menus close on Escape/outside click; opening Debug also closes the session menu.
- `menuAlign` remains the preferred start/end alignment rather than an absolute promise. While open, the component measures the trigger/menu against the body and visual viewport, preserves the preferred alignment when it fits, and translates the menu only enough to keep an 8px horizontal gutter on both edges.
- Horizontal placement stays live while the menu is open, so viewport resize, sidebar width/position changes, scroll, browser zoom/pinch zoom, and menu width changes are re-clamped without closing the menu. Menu height-only changes do not alter horizontal placement.
- The menu keeps its existing in-tree absolute positioning and z-index rather than moving into a global portal, so Code iframe/stacking behavior and unrelated dropdowns/popovers are unchanged.
- Both the normal and Code-embedded sidebars prefer `menuAlign="end"`. When `setupActive` is true, the gear trigger and Setup menu row use the same blue selected treatment.

## Integration

- `GlobalUiSettingsMenu` connects only the compact color-mode control to the shared browser-local runtime and delegates Setup/reload. Chat/App owns the session-header menu's existing browser-local preference state. Instance name/tab icon are server-backed WebUI settings edited in Setup Appearance.
- Theme-family and file-management ownership is documented in [D-webui-theme-controls](./webui-theme-system.md#d-webui-theme-controls).
- Delegates app reload to `ReloadAppButton`.
- Optionally triggers an external setup flow via `onOpenSetup` callback.
- Code launch actions are intentionally not exposed here; the dedicated sidebar Code split button is the primary entry and owns launch-mode configuration.
- Designed to sit in a toolbar/header and align its dropdown via the `menuAlign` prop.
- Placement and authority are canonical in [D-webui-settings-placement](../modules/webui.md#d-webui-settings-placement).

## Design Decisions

- [2026-07-22] Global UI settings placement is preferred-alignment plus viewport clamping: preserve the current start/end alignment when there is room, but if either horizontal edge would leave the body/visual viewport, shift the whole menu inside an 8px safe gutter even though it no longer aligns with the trigger corner. Apply this to ordinary desktop/mobile and Code-embedded sidebars without changing other popovers or iframe stacking.
