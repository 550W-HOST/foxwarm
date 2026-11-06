# Unit: webui-nodes

Files: packages/webui/src/components/SystemNodes.tsx, packages/webui/src/useNodeDirectory.ts
Secondary files: packages/webui/src/components/SystemView.tsx, packages/webui/src/App.tsx, packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/workbench/utils.ts, packages/webui/test/nodeOnboarding.e2e.mjs, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/popupMove.e2e.mjs, packages/webui/test/mainHostSystem.e2e.mjs

## Purpose

Owns the Nodes section of the [System page](./webui-system-view.md): connected Node status, the Sessions placed on each Node, and explicitly invoked Node onboarding.

## Exports and function index

- `SystemNodes` — Node cards, Online/Total summary, pending approval count and the New nodes action.
- `NodeOverviewCard` — directory identity, type, online/protocol state, recent activity, service versions and the Sessions placed on the Node.
- `useNodeDirectory` — directory-only initial read and visibility-aware 30-second refresh, with cancellation and request-identity publication fencing. System owns one instance and passes Node identities to the Nodes section, Session filters, the inspector and Agent isolation choices.

## Behavior and integration

- Opening Nodes: the System page's Nodes section, the status-bar Open Nodes action, `#nodes`, the former `#tab/system:nodes` route, a saved former Nodes tab (normalized to the System tab on Nodes) and the `nodes` popup leaf. Navigation uses ordinary system-tab activation, including same-ID reuse and activation of a collapsed pane.
- Status-bar Tasks retains its bounded preview. Nodes lists the complete directory in original order within a locally scrolling region; summary and navigation remain outside that region. Empty data and failed preview reads do not disable the Open actions.
- Summaries and the footer use Online/Total, counting `online === true` independently of protocol compatibility and including Master through the existing directory normalization. Cards also distinguish provider Unavailable/error state; canonical colon-bearing provider IDs remain visible. File/exec support does not imply Code/PTY launch support. Cards and popup rows report Online/Offline with the [shared Tasks-style status badge](./webui-tasks.md#shared-status-badges), retaining a separate warning badge for Upgrade required and visible protocol explanations.
- Each card lists the loaded Sessions whose effective placement (active tool execution Node, otherwise current Node, otherwise master) is that Node: up to six with active ones first, then Show all within a capped scroll region. Placement IDs outside the directory get an Unavailable card so their Sessions stay visible. Selecting a Session switches System to Sessions and inspects it.
- The visible Nodes section owns the [pending approvals hook](./webui-node-onboarding.md). Leaving the section, document hiding or modal close preserve the hook/modal cancellation boundaries. Only explicitly opening New nodes mounts the credential-owning modal; directory, pending and catalog reads never load setup credentials.

## Tests

- `workbenchPreview.e2e.mjs` covers 15 directory entries with nine online (including one incompatible online Node), full-list order and native scrolling, no additional directory requests, theme contrast, both status-preview entries, dismissal, empty/failed previews, System reuse, collapsed-pane activation of a saved Nodes tab, route hydration, persistence/reload of the section, mobile rendering and sole-tab headers.
- `nodeOnboarding.e2e.mjs` covers the section switch, per-section summaries, unavailable placement cards, authenticated onboarding, pending pagination/approval, visibility pause, credential lifecycle and abort tests, and polling cleanup after unmount.
- `popupMove.e2e.mjs` covers moving System on Nodes to the `nodes` leaf and in-place section switching in popup and embedded leaves. `mainHostSystem.e2e.mjs` covers the sections, Session placement and every former entry point against a real C# Main.

## Design decisions

### D-webui-nodes-workbench

[2026-10-14; superseded 2026-11-03 by [D-webui-system-page](./webui-system-view.md#d-webui-system-page), user decision] Nodes was a separate operational Workbench page. It is now the Nodes section of System, which also shows where Sessions run. Setup continues to own configuration and authorization, and ordinary system-tab and popup navigation is still reused instead of another dashboard or host protocol.
