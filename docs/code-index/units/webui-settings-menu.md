# Unit: webui-settings-menu

Files: packages/webui/src/components/GlobalUiSettingsMenu.tsx, packages/webui/src/components/SessionUiSettingsMenu.tsx, packages/webui/src/chatPreferences.ts, packages/webui/src/contextScrollbarSettings.ts, packages/webui/src/components/menuPositioning.ts, packages/webui/test/settingsMenuPosition.e2e.mjs, packages/webui/test/chatSettingsPlacement.e2e.mjs

## Purpose

Renders the global sidebar settings split button (gear opens Setup; attached dropdown holds color mode, reload, and Logs) plus the per-Chat session-header dropdown for browser-local input/chat display preferences and Debug.

## Key Exports

- `GlobalUiSettingsMenu` — default-exported React component rendering the Setup gear plus its attached settings dropdown
- `SessionUiSettingsMenu` — per-Chat header menu for send behavior, timeline view, usage badges, Full width, minimap visibility, direct-user metadata visibility, and Debug
- `clampAnchoredMenuHorizontally` — pure preferred-alignment + viewport-gutter clamp helper
- `readHorizontalViewportBounds` — intersects the layout/body bounds with the current visual viewport
- Both menus use the existing send-mode union (`'modEnter' | 'enter'`) at their component boundary.
- `TimelineView` — the single display-mode union shared by every Timeline consumer; `readChatPreferences` defaults to Conversation, reads valid viewport-specific modes before the supported desktop legacy grouping boolean, and `setTimelineView` writes only the current viewport family's key (`foxwarm_timeline_view_v1` or `foxwarm_mobile_timeline_view_v1`). App, popup, embedded and scoped identity Chat roots all use this hook; standalone Chat also defaults to Conversation. See [D-webui-timeline-view](../modules/webui-timeline.md#d-webui-timeline-view).
- `GlobalUiSettingsMenuProps` — props interface for the required Setup action, optional Logs action, `setupActive`, `toolbar`/`rail` variant, and preferred menu alignment/side

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `GlobalUiSettingsMenu(props)` | ~20–end | Split button: Setup gear, attached dropdown trigger, and dropdown panel |
| `SessionUiSettingsMenu(props)` | `SessionUiSettingsMenu.tsx` | Session-header Input/Chat preference menu with local minimap synchronization |
| `clampAnchoredMenuHorizontally(options)` | (menuPositioning.ts) | Keeps the preferred start/end placement when possible and otherwise clamps both horizontal edges |
| `readHorizontalViewportBounds()` | (menuPositioning.ts) | Reads body/layout/visual-viewport horizontal bounds for zoom-aware placement |

## Dependencies

- `./ReloadAppButton` — button component that triggers a full app reload

## Behavior

- The control is a split button ([D-webui-settings-placement](../modules/webui.md#d-webui-settings-placement)): two separately focusable buttons inside one shared rounded border. The gear (`Open setup`, tooltip `Open setup`) calls `onOpenSetup` directly and closes an open dropdown. The narrower chevron part (`Open UI settings`, tooltip `UI settings`) has `aria-haspopup="dialog"`, `aria-expanded`, and `aria-controls` pointing at the open panel, which is a non-modal `role="dialog"` named `UI settings`. The `toolbar` variant places the chevron to the right of the gear at the 36px header height; the `rail` variant (collapsed sidebar) stacks a 16px chevron strip under a 32px gear.
- Manages open/closed state of the dropdown menu with click-outside and Escape key dismissal via document event listeners; Escape returns focus to the chevron part. The panel follows the chevron in DOM order, so Tab from the open chevron enters the menu.
- Provides only the frequent `Auto` / `Light` / `Dark` color-mode control. Setup's Appearance tab repeats color mode above its palette preview and exclusively owns theme-family and portable file management.
- The session-header menu provides the Detailed / Grouped / Conversation `timelineView` radio group, `showUsageBadge`, Conversation-only `Show inter-agent messages` and `Show commentary` switches (both default on), browser-local `Full width` (default on), `Show minimap`, and `Show user message metadata`. Conversation follows the [fixed scroll display](../modules/webui.md#d-webui-conversation-scroll-display), including its disabled/off minimap toggle. Detailed and Grouped disable that toggle only when minimap is the sole enabled context display, so their scrollbar/minimap preferences cannot become both disabled.
- The session-header menu detects macOS/iOS to display the correct modifier key label (Cmd vs Ctrl) for the send-key option, through `modifierKeyLabel` in `sendKey.ts`.
- The two Conversation switches appear in that order immediately above Full width and retain their values across Timeline changes. They use `useChatPreferences` and its storage-event synchronization across ordinary, popup and embedded roots, with no backend/Session settings. Off means folded into Activity, not deleted; commentary classification and communication authority follow [Timeline view](../modules/webui-timeline.md#d-webui-timeline-view).
- `Full width` is stored with the other browser-local Chat preferences and synchronized through storage events across App, popup, and embedded roots. Turning it off bounds and centers the common message column at 1100px; it does not resize the viewport, minimap, or individual timeline cards.
- `useChatPreferences` is the single browser-local owner used by ordinary and embedded Chat roots. Setters write the established keys and update their own root; `storage` events update other roots without writeback effects or stale echoes.
- Application rows are Reload WebUI, then Open logs (when available). Setup has no row; the gear is its entry. Tasks uses [direct navigation](./webui-tasks.md#d-webui-tasks-navigation) instead of a row here. Rows place the Reload refresh and Logs document icons before their labels; Reload has no trailing icon.
- The global menu closes automatically after color-mode change, Logs activation, or a gear click. Both menus close on Escape/outside click; opening Debug also closes the session menu.
- `menuAlign` remains the preferred start/end alignment rather than an absolute promise. While open, the component measures the trigger/menu against the body and visual viewport, preserves the preferred alignment when it fits, and translates the menu only enough to keep an 8px horizontal gutter on both edges.
- Horizontal placement stays live while the menu is open, so viewport resize, sidebar width/position changes, scroll, browser zoom/pinch zoom, and menu width changes are re-clamped without closing the menu. Menu height-only changes do not alter horizontal placement.
- The session-header menu uses the same placement helpers and intersects the viewport with its nearest Chat root, so a narrow split pane shrinks and clamps the menu inside the pane's clipping boundary.
- The menu keeps its existing in-tree absolute positioning and z-index rather than moving into a global portal, so Code iframe/stacking behavior and unrelated dropdowns/popovers are unchanged.
- The normal and Code-embedded sidebars prefer `menuAlign="end"`; the collapsed rail uses `variant="rail"` with `menuAlign="start"`. Placement is measured against the whole split control. When `setupActive` is true (App: Setup or Logs is the current view, expanded and collapsed; Code-embedded: Setup target), the gear gets the accent selected treatment and `aria-current="page"`, and the shared border turns accent; the chevron stays neutral.

## Integration

- `GlobalUiSettingsMenu` connects only the compact color-mode control to the shared browser-local runtime and delegates Setup/reload/Logs. Chat/App owns the session-header menu's existing browser-local preference state. Instance name/tab icon are server-backed WebUI settings edited in Setup Appearance.
- Theme-family and file-management ownership is documented in [D-webui-theme-controls](./webui-theme-system.md#d-webui-theme-controls).
- Delegates app reload to `ReloadAppButton`.
- Delegates the gear and `Open logs` through the corresponding callbacks, and labels reload `Reload WebUI`. Main expanded/collapsed/mobile sidebars open the singleton Logs tab; the Code-embedded sidebar opens the existing popup leaf. Logs ownership is documented in [WebUI Logs](./webui-logs.md).
- Code launch actions are intentionally not exposed here; the dedicated sidebar Code split button is the primary entry and owns launch-mode configuration.
- Designed to sit in a toolbar/header and align its dropdown via the `menuAlign` prop.
- Placement and authority are canonical in [D-webui-settings-placement](../modules/webui.md#d-webui-settings-placement).
- The browser preference fixture asserts the React root and visible session-options trigger before reading the effect-published preference probe; document `load` alone does not establish mounted-UI readiness.

## Design Decisions

- [2026-11-12] User decision: Setup is one click from the sidebar header through the gear's primary action rather than a menu row or another navigation row; canonical in [D-webui-settings-placement](../modules/webui.md#d-webui-settings-placement). Browser coverage: `workbenchPreview.e2e.mjs` (split geometry, accessible attributes, gear/menu/Logs/collapsed-rail flows; `FOXWARM_SETTINGS_SPLIT_SCREENSHOT_DIR` captures header screenshots) and `settingsMenuPosition.e2e.mjs`.

- [2026-07-22] Global UI settings placement is preferred-alignment plus viewport clamping: preserve the current start/end alignment when there is room, but if either horizontal edge would leave the body/visual viewport, shift the whole menu inside an 8px safe gutter even though it no longer aligns with the trigger corner. Apply this to ordinary desktop/mobile and Code-embedded sidebars without changing other popovers or iframe stacking.

Mobile-specific navigation, headers, and preferences follow the [mobile shell contract](../threads/webui-mobile-shell.md); desktop data and workbench owners remain unchanged.
