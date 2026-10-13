# Unit: WebUI Workbench content hosts

Files: packages/webui/src/components/WorkbenchContentHost.tsx, packages/webui/src/contentResize.ts
Secondary files: packages/webui/src/App.tsx, packages/webui/src/components/WorkbenchPane.tsx, packages/webui/src/components/Chat.tsx, packages/webui/src/components/VscodeWebFrameHost.tsx, packages/webui/src/components/HistorySearchView.tsx, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/workbenchTabErrorBoundary.e2e.mjs

## Purpose

Keeps tab content independent of the mutable pane/split tree while preserving existing semantic visibility and resource lifecycles. Layout, tabs, persistence, and DND actions remain in [Workbench](./webui-workbench.md); App decides content admission and projects the current pane callbacks.

## Exports and functions

- `WorkbenchContentProvider` owns one geometry manager and keeps its context beside the changing desktop/mobile shell in the same DND context.
- `WorkbenchContentSlot` registers the actual expanded pane rectangle without rendering its tab.
- `WorkbenchContentLayer` portals stable tab children to one fixed document-body target.
- `WorkbenchContentHost` supplies positioning, current-pane header/menu/focus/drop behavior, and tab error isolation around the real renderer.
- `ContentBeforeResizeContext` and `useContentBeforeResize` provide one leaf-local pre-resize callback; independent popup/embedded leaves have no provider.

| Function | File | Description |
|----------|------|-------------|
| `createContentPositions()` | WorkbenchContentHost.tsx | Owns slot/host refs, one ResizeObserver, batched rectangle reads/style writes, and viewport/scroll events |
| `WorkbenchContentProvider(props)` | WorkbenchContentHost.tsx | Keeps geometry ownership stable across desktop/mobile branches and measures committed slot replacements before paint |
| `WorkbenchContentSlot(props)` | WorkbenchContentHost.tsx | Registers one expanded pane content rectangle without mounting the tab |
| `WorkbenchContentLayer(props)` | WorkbenchContentHost.tsx | Portals the stable content list to a fixed document-body target in the same DND context |
| `useContentBeforeResize(callback)` | contentResize.ts | Lets one mounted leaf capture its local viewport before the host writes a changed size; independent leaf roots have no provider |
| `WorkbenchContentHost(props)` | WorkbenchContentHost.tsx | Positions one tab-keyed content instance and projects its current pane header/actions, focus, drop overlays, and boundary |

## Dependencies and integration

App builds one stable host per admitted tab, keyed by tab ID rather than pane ID. The shared geometry manager owns no layout or tab state. Pane chrome provides slots; the same `PaneDropTargets` component supplies expanded overlays in the positioned content region and collapsed/empty overlays in chrome. Sole-tab headers reuse `WorkbenchTabHeaderProvider`, `WorkbenchPaneToolbar`, and `useWorkbenchTabMenu`. `WorkbenchTabErrorBoundary` encloses the real content evaluator. Chat alone consumes the lightweight pre-resize callback to preserve its own viewport; Terminal retains its own sizing observer and Code retains App's bridge controller.

### D-workbench-stable-content

[2026-10-13] Layout chrome and content instances have separate owners. App admits content by tab/layout/presentation facts, not by the availability of a DOM slot. Its tab-keyed content list has stable React ancestry beside the changing desktop/mobile shell inside the same DND context, with one fixed portal target. A visible tab therefore retains its component, DOM, subscriptions, loaded Timeline range/disclosures/scroll intent, draft, iframe browsing context, or Terminal attachment through splits, last-sibling normalization, cross-pane tab moves, and whole-pane docking. A temporary slot unregister/register only changes geometry; it is not Close or semantic hiding. Pane identity only updates projected props/context, never the content or error-boundary key.

Ordinary tabs keep their existing unmount policy when genuinely inactive, collapsed, or hidden by the mobile list. History keeps every open instance; Code starts only on first actual visibility, then retains the same iframe while hidden. Closing/popout/preview replacement releases the relevant instance through App's existing route/resource contracts. Collapse does not delete a PTY, and no layout operation creates a second subscriber, new PTY, or iframe. Popup and Code-embedded leaf roots remain independent of the full Workbench. Code's bridge ownership remains in App so a first open request can queue before the lazy iframe exists.

A single geometry manager measures every visible slot rectangle before writing any host style. Layout commits and newly mounted drag overlays measure synchronously after their refs settle; shared ResizeObserver, viewport/visual-viewport resize, and captured scroll events coalesce continuous updates into a single animation frame. Before changed-size writes, a lightweight leaf callback lets Chat capture and retain its local message anchor through its existing observer and width-band commit; new user scroll input cancels that correction. Geometry never enters App React state, recomputes split percentages, reparents an iframe, or polls per host. The host follows its actual pane-sized slot, including desktop corner clipping, so Chat retains its own width/container-query boundary. Hidden hosts are inert and pointer-disabled; the viewport layer's empty regions never intercept input. Pointer/focus entering content explicitly activates its current pane, including iframe focus; pane/Close/menu controls retain their own navigation rather than queuing an activation that undoes Collapse. Expanded pane drop overlays follow the measured whole-pane rectangle, including its tab strip, above a separately clipped content region; collapsed/empty targets remain in layout chrome. Both use the same existing pane IDs, sensors, collision rules, and DragOverlay. Iframe pointer events are disabled during dragging.

The tab-owned host supplies sole-tab header/menu callbacks for its current pane and wraps the real renderer in a tab-keyed error boundary. Moving a tab does not reset a failure; explicit Retry or a genuinely different tab instance does. Shared theme tokens, pane-width queries, tab menus, and popup layers remain in their existing owners.

## Tests

- Actual App browser probes first reproduce the split regression on the prior layout-owned renderer (different Chat DOM plus another initialization history read), then assert stable Chat/Timeline DOM, loaded range, tool disclosure, draft, scroll intent, and uninterrupted logical session presence through split/normalization. Existing cross-pane and whole-pane probes also check original Chat DOM and initialization reads. Terminal probes assert stable DOM/connection counts during resize/docking plus ordinary explicit DELETE; Code probes check iframe/window/load identity, drag pointer handling, lazy first visibility, initial queued file requests, Close/reopen, and desktop/mobile hiding. The boundary fixture mounts the real shared host and verifies failure/Retry after pane reassignment.
- `workbenchPreview.e2e.mjs` also exercises sole-tab actions after movement, drag highlights/cancellation, pointer regions, iframe focus, picker/menu layers, pane-width container queries, and semantic ordinary-tab unmounting on mobile-list hiding. Existing History tests retain independent query/result/scroll state and legacy tab identities; the standalone viewer suite covers paging, disclosures, and request invalidation.
- Fixtures serve the real built App with controlled HTTP/WebSocket responses and a real same-origin Code iframe; they do not replace the content components with mount counters.
