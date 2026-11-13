# Unit: WebUI window frame

Files: `packages/webui/src/windowFrame.ts`, `packages/webui/src/components/WindowFrameEdges.tsx`, `packages/webui/public/manifest.json`, `packages/webui/test/windowFrame.test.mjs`, `packages/webui/test/windowFrameRects.e2e.mjs`, `packages/webui/test/windowFrame.e2e.mjs`, `dotnet/Foxwarm/DesktopFrameRegions.cs`, `dotnet/Foxwarm.Desktop/DesktopFrame.cs`, `dotnet/Foxwarm.Desktop.Mac/DesktopFrame.cs`, `dotnet/Foxwarm.Tests/Channels/DesktopFrameRegionsTests.cs`
Secondary files: `packages/webui/src/main.tsx`, `packages/webui/src/theme/browserChrome.ts`, `packages/webui/test/browserChrome.e2e.mjs`, `packages/webui/src/index.css`, `packages/webui/src/components/Sidebar.tsx`, `packages/webui/src/components/CollapsedSidebar.tsx`, `packages/webui/src/components/WorkbenchPaneDragArea.tsx`, `packages/webui/src/components/WorkbenchTabHeader.tsx`, `packages/webui/src/components/WorkbenchTabs.tsx`

## Purpose

Puts the WebUI into the window's title area for three frame providers: the Windows Desktop host, the macOS Desktop host, and an installed Chromium PWA in window-controls overlay. The rows that already sit at the top of the desktop layout become the title area; there is no separate title bar. Ordinary browser tabs, Safari, Firefox and mobile or standalone PWAs have no provider and render exactly as before.

## Contract

### D-window-frame

[2026-11-13] User decisions for the custom Desktop/PWA window frame.

- **Model.** `html[data-foxwarm-frame="windows"|"macos"|"overlay"]` plus `--foxwarm-frame-left|right|top` (CSS px) describe the window-control zones at the top corners. Layout reads only these. `html[data-foxwarm-window~="inactive|maximized|fullscreen"]` mirrors the host's window state; nothing is styled with it (no inactive-window styling).
- **Desktop hosts → page.** At document creation, for the top-level document of the owned origin only, the host defines `window.foxwarmFrame = { platform, left, right, top, state }`. On a change it replaces the object and dispatches `foxwarm-frame` on `window`.
- **Page → Desktop hosts.** One one-way message, `{ type: "frame-regions", regions: [[x, y, w, h], …], colorScheme: "light" | "dark" }`, at most 128 rectangles in viewport CSS px, sent only when a host channel exists, at most once per animation frame and only when it changes. Windows: `IsWebMessageEnabled` with `WebMessageReceived`, accepting only messages whose source is the owned origin. macOS: one `WKScriptMessageHandler` named `foxwarmFrame`, main frame and owned origin only. Both hosts reject anything that does not match the exact schema (`DesktopFrameRegions.Parse`). There are no host objects, no replies and no other capabilities. This is the only exception to the hosts' no-bridge contracts ([Windows](./host-runtime.md#desktop-boundary), [macOS](./desktop-macos.md#native-shell-and-security)).
- **PWA.** `manifest.json` declares `display_override: ["window-controls-overlay"]` with `display: "standalone"` as fallback. Under `(display-mode: window-controls-overlay)` the module sets `data-foxwarm-frame="overlay"` and `index.css` derives the insets from `env(titlebar-area-*)`; drag surfaces are CSS `app-region: drag`. Switching the overlay off removes the attribute and every frame rule. The browser paints the overlay controls on `theme-color`, so while the overlay is on the live `meta[name=theme-color]` is the surface under the controls (`frameSurfaceColor`: the topmost page element at the middle of the larger control zone, composited over its ancestors' backgrounds). It is re-read on every theme change and frame layout. The `foxwarm_canvas` cookie, and with it the manifest's `theme_color` and `background_color`, stays the canvas, which is also the launch background (`setFrameChromeColor` in `browserChrome.ts`).
- **Title rows.** Rows opt in with `data-frame-row`: `stack` for the sidebar and the collapsed rail (content moves below the controls when the column is under them), `inline` for a pane's tab strip or sole-tab content header (it reserves the overlap plus a 40 px drag gap). A row that doesn't intersect a control zone is unchanged.
- **Drag surfaces** are `[data-frame-drag]` inside an in-band row, minus interactive descendants and every floating layer (menus, dialogs, listboxes, tooltips). The window drags from the sidebar brand row, the band above the sidebar or rail, and the 40 px gap beside the window controls. Blank tab-strip space keeps moving the pane where pane drag applies ([D-workbench-pane-drag](./webui-workbench.md#d-workbench-pane-drag)); a lone pane's strip drags the window.
- **Edges.** A drag surface near the window's top, left or right edge (within 24 px of shell gutter, panel border and padding) is extended to that edge by fixed fill elements, provided the extension covers only chrome: no text, media or interactive element. The 6 px top gutter above a drag row is part of the drag band. Operating-system resize borders stay with the system.
- **Narrow windows** (< 768 px) keep the mobile shell. A canvas-coloured drag strip of `--foxwarm-frame-top` height sits above it, and `--foxwarm-safe-area-top` is raised by the same amount.
- **Accessibility.** Spacers and fills are `aria-hidden` and add no focus stops. Under `forced-colors: active` the strip paints `Canvas`. Keyboard window control stays native.

### Hosts

- Windows ([host](./host-runtime.md#desktop-boundary)): `ExtendsContentIntoTitleBar` with the standard 32 px caption. Insets are `TitleBar.LeftInset/RightInset/Height` divided by the XAML rasterization scale; updates follow `AppWindow.Changed`, `XamlRoot.Changed` and activation. Every report sets explicit `InputNonClientPointerSource` caption rectangles, scaled and clipped against the caption-button zone, and an empty list when there are none, because WinUI's default caption band swallows clicks and the WinUI WebView2 control ignores `app-region`. Caption button colours follow `colorScheme` with transparent backgrounds, except under high contrast. `Window.Title` follows `document.title`.
- macOS ([host](./desktop-macos.md#native-shell-and-security)): `fullSizeContentView`, a transparent title bar with a hidden title, and an empty toolbar in the compact unified style for the 38 px title area. `left` is the zoom button's right edge plus 12 px; in full screen the toolbar is hidden and all insets are 0. A transparent view above the web view takes a press only inside a reported rectangle and never over the lights: mouse-down calls `performWindowDrag`, a double-click follows `AppleActionOnDoubleClick`, and wheel and secondary clicks are forwarded to the page. `colorScheme` sets `window.appearance`; `NSWindow.title` follows `document.title` for accessibility and the Window menu.

## Function index

- `initializeWindowFrame()` — called once from `main.tsx`; detects the provider and starts or stops the frame runtime. Without a provider it installs only the `foxwarm-frame` and overlay media listeners.
- `readHostFrame(value)` — validates `window.foxwarmFrame`.
- `frameRowLayout(row, zones, kind)` — in-band flag and padding for one row.
- `frameEdgeFillCandidates(surface, width)`, `computeFrameEdgeFills(document)` — edge extensions and their chrome-only check by hit testing.
- `collectFrameDragRects(document)` — the rectangles reported to the hosts.
- `FrameEdges`, `FrameBand` — spacers inside inline and stack rows.
- `frameSurfaceColor(document, zones)` — overlay `theme-color` source.
- `DesktopFrameRegions.Parse/Clip` — host-side schema validation and device-pixel clipping, shared by both hosts.

## Tests

- `windowFrame.test.mjs`: host-state validation, rectangle subtraction, row avoidance for Windows and macOS geometry, edge-fill candidates.
- `windowFrameRects.e2e.mjs`: fixture DOMs in Chromium; regions exclude interactive descendants, floating layers and out-of-band rows; edge fills extend through gutter and padding but never across controls or text; the overlay surface colour composites translucent layers and ignores frame fills.
- `windowFrame.e2e.mjs`: the demo build with an injected `window.foxwarmFrame` and a recording host channel (no reported rectangle covers a visible control, no control under the window controls, brand row and gap reach the window edges, split panes keep pane drag, menus stay clickable, full screen reports nothing, 700 px strip and 800 px desktop layout), a stubbed overlay media query and inset variables for the PWA (headless Chromium emulates neither), where `theme-color` follows the strip surface across a theme change while the cookie keeps the canvas, and an unchanged page without a provider.
- `browserChrome.e2e.mjs`: the frame colour overrides only the live `theme-color`; clearing it restores the canvas.
- `DesktopFrameRegionsTests.cs`: message schema and limits, clipping.
