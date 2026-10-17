# Thread: Mobile WebUI shell

## Scope and owners

- Shell and retained desktop workbench: [workbench](../units/webui-workbench.md), `App.tsx`.
- Mobile home and bounded Session rows: [session list](../units/webui-session-list.md).
- Shared `MobilePageHeader` and `ContentHeader`: [small components](../units/webui-small-components.md).
- [Tasks](../units/webui-tasks.md), [Setup](../units/webui-setup-view.md), and [history search](../units/webui-history-search.md) retain their existing data owners.
- Browser preferences: [settings menu](../units/webui-settings-menu.md).

## Design decisions

### D-mobile-shell-presentation

[2026-10-16] A root viewport below 768px uses a separately designed mobile shell. This policy is distinct from a narrow desktop Chat pane's container-responsive layout. Mobile hides the workbench tab strip without deleting tabs, layout, or processes. Sessions, Tasks, Search, and Settings are in-place primary tabs with one retained bottom navigation; visiting a tab does not create a desktop workbench page. Visited pages stay mounted, and returning from Chat retains the selected primary tab and its local state.

The navigation is centered, capped at 440px, and inset by 12px plus the effective bottom safe area. Navigation and the Sessions New session action use fixed positioning; this does not imply that their fixed viewport equals the large CSS viewport. Installed iOS (`navigator.standalone === true`) reserves only the safe-area band overlapping its dynamic viewport: `max(0px, safe-area-bottom + 100dvh - 100lvh)`. Other browser paths retain the full bottom inset. Both controls share this home-local value while keeping their ordinary 12px/88px offsets and in-scroller clearance. They stay inside the actual interactive viewport rather than extending toward a screen-sized coordinate. Global viewport/root sizing and Chat composer positioning remain unchanged. It uses a rounded translucent material matching the composer, not an opaque full-width footer. All four pages share the same element and material. Reserve the last content/action clearance inside the actual scroller, not in an opaque outer strip. Reduced transparency disables blur and uses an opaque semantic surface; forced colors use native readable boundaries.

Primary page headers have transparent backgrounds and progressively masked backdrop blur. Content scrolls behind them. `MobilePageHeader` observes its positive rendered height and publishes a parent-local CSS offset; hidden zero-sized pages do not erase the previous measurement. Initial content clears the blur tail. Search is a circular action that reveals a compact input, and Session display choices share a separate circular dropdown. Tasks and Settings expose their existing filters/sections through their corresponding controls. No page-wide colored header plate is added.

Chat has an independent circular Back action, a centered single-line Session name without a surrounding plate, and a small right-hand action capsule. New Session uses the existing creation path and current Agent. Find, Code, and Terminal remain in the Session menu. A long title truncates visually while retaining its accessible text. Search expansion participates in measured header clearance, and connection notices remain readable below the floating controls.

[2026-10-17] The mobile workbench pane retains the safe-area, fixed visual-viewport shell around its layout slot, just as the retained primary pages retain their own shell. `main.tsx` publishes visual-viewport height and top offset; the shell consumes both and applies top/left/right safe-area spacing. Root height alone handles shrinking but does not compensate viewport panning. The stable content host follows the measured slot through the existing layer-relative geometry owner, without another keyboard offset or a change to content ancestry. Keyboard dismissal restores the full pane and composer position.

The workbench's floating Chat header does not apply those safe-area insets again inside the already-inset slot. Independent Chat leaves retain their header-owned spacing because they have no safe-area shell. Actual header controls, not just the header wrapper or aligned portal rectangles, must clear the status area exactly once. Composer bottom spacing remains unchanged.

### D-mobile-list-and-chat-preferences

[2026-10-16] Mobile Session ordering defaults to Flat/recent activity and uses `foxwarm_session_list_mobile_view_mode_v1`; desktop preferences remain separate. Flat rows omit the tree disclosure placeholder but retain 12px content inset, aligned for selected and unselected rows. Pin/Unpin belongs in each row's menu on both desktop and mobile.

Mobile Timeline defaults to Conversation and stores explicit choices in `foxwarm_mobile_timeline_view_v1`. Desktop's `foxwarm_timeline_view_v1` and legacy grouping fallback remain unchanged. Shared preferences still synchronize across roots, but one viewport family's Timeline selection does not overwrite the other. Per-request usage, reasoning-token badges, and assistant Rendered/Raw/JSON/Copy action rows are hidden only by the root mobile policy; measurements and desktop preferences are retained. The ordinary composer hint is absent on mobile; missing-Session error text remains visible.

## Verification

Production `workbenchPreview.e2e.mjs` covers primary navigation, preserved desktop tabs, menus/forms, width capping, independent Timeline preferences, scoped metric hiding, and native focus behavior. `sessionListDensity.e2e.mjs` covers ordering, row inset, menu-owned pinning, tree preservation, and mouse/touch boundaries. Validate real built CSS and screenshots: a declared blur can disappear during CSS prefix/minification if prefixed declarations override standard ones. Native scroll/gesture probes choose hit-tested message/list content below the floating header, while narrow desktop metric probes keep a desktop root viewport and constrain only their content container. Embedded Chat coverage widens the viewport to verify its per-session subtitle after checking the compact name-only mobile header; desktop/embedded data requests remain unchanged.

`workbenchVisualViewport.e2e.mjs` loads the real built mobile App through `main.tsx`, not a standalone pane fixture. Its simulated viewport checks the pane, floating header and editor against the visible boundary as well as slot/host agreement: matching rectangles alone can conceal a shared offscreen origin. It covers height-only shrink, nonzero top offsets, safe-area spacing, native Timeline scrolling, pan and full restoration while preserving focused content identity and one history initialization. Optional screenshots and geometry records aid comparison. The shifted-origin model is Chromium simulation, not a native iOS keyboard test; a separate Chromium page-scale probe covers native scale changes.

A 440×956 console-theme probe applies a 62px top inset and checks the Back/action controls after one shell inset plus their ordinary inner spacing, including a keyboard-size/offset cycle and restoration. It also preserves the existing composer bottom spacing. A real popup Chat leaf checks that its independently owned header inset remains applied.

The home navigation regression keeps the real browser/fixed/hit-test viewport at 440×894. Its compiled-CSS fixture supplies independently measured large/dynamic unit values of 956px/894px, without inventing a taller clickable region. The 34px safe band no longer overlaps that dynamic viewport, so navigation ends at 882px and New session at 806px. It checks all four edges of each button, performs actual lower-edge clicks through every primary page, retains the same navigation instance, and preserves Chat header/composer geometry on a round trip. Ordinary browser and full-height installed cases keep their original safe-area offsets. These are controlled browser regressions, not native iOS rendering or touch validation.
