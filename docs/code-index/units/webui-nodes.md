# Unit: webui-nodes

Files: packages/webui/src/components/NodesView.tsx, packages/webui/src/useNodeDirectory.ts
Secondary files: packages/webui/src/App.tsx, packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/test/nodeOnboarding.e2e.mjs, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/popupMove.e2e.mjs

## Purpose

Owns connected Node status and explicitly invoked Node onboarding independently of Architecture's Session topology and Agent registry.

## Exports and function index

- `NodesView` — standalone Node directory, status cards, pending approval count and New nodes action.
- `NodeOverviewCard` — real directory identity, type, online/protocol state, recent activity and service versions.
- `useNodeDirectory` — directory-only initial read and visibility-aware 30-second refresh, with cancellation and request-identity publication fencing. Architecture reuses it for execution-node identities and isolation choices.

## Behavior and integration

- Normal App opens or activates singleton `system:nodes` through the existing Workbench store/navigation path. Hash restore, browser-local layout persistence, close fallback, tab/pane movement and sole-tab header controls use the ordinary system-tab contracts, without a new storage version or layout reset.
- Architecture retains Topology and Agents only. Its Nodes summary enters the independent tab through App's callback; the former local Nodes mode was not persisted and has no migration.
- Status-bar Tasks retains its bounded preview. Nodes lists the complete existing directory in original order within a locally scrolling region; summary and navigation remain outside that region. Their explicit Open Tasks/Open Nodes actions dismiss the preview and use App navigation, including same-ID reuse and activation of a collapsed pane. Empty data and failed preview reads do not disable these actions.
- Nodes status summaries and the footer use Online/Total, counting `online === true` independently of protocol compatibility and including Master through the existing directory normalization. Cards and popup rows report Online/Offline with the [shared Tasks-style status badge](./webui-tasks.md#shared-status-badges), retaining a separate warning badge for Upgrade required and visible protocol explanations. Architecture executable-node metrics and launcher availability are unchanged.
- Nodes renders real `/nodes` entries only, never synthetic Session placements, Architecture forest queries or an Agent registry. Normal App's existing Sidebar/global-summary owners remain independent of this view.
- Visible Nodes owns the existing [pending approvals hook](./webui-node-onboarding.md). Document hiding, view unmount or modal close preserve the hook/modal cancellation boundaries. Only explicitly opening New nodes mounts the credential-owning modal; directory and pending reads never load setup credentials.
- Move to new window uses the existing versioned `nodes` popup leaf. Popup Architecture navigates to that leaf in its window; embedded Architecture opens it through the existing same-origin popup URL mechanism. Neither path mounts the main Workbench or adds a Code host editor/message type. Administrator and restricted identity root selection are unchanged.

## Tests

- `workbenchPreview.e2e.mjs` covers 15 directory entries with nine online (including one incompatible online Node), full-list order and native scrolling to later/final entries, fixed navigation access, no additional directory requests, Default light/dark section contrast and compact spacing, a console smoke case, and both status-preview entries, dismissal, empty/failed previews, singleton reuse, collapsed-pane activation, first route hydration, persistence/reload and close fallback, two Architecture modes and summary navigation, mobile rendering, sole-tab headers and real whole-pane movement.
- `nodeOnboarding.e2e.mjs` retains authenticated onboarding, pending pagination/approval, visibility pause, credential lifecycle and abort tests. An independent Nodes root verifies directory/pending-only reads and polling cleanup after unmount.
- `popupMove.e2e.mjs` covers the existing Move action's Nodes URL, popup restore, and Architecture popup/embedded summary navigation without a main shell or new Code host protocol. Popup parser and Workbench normalization tests include the new leaf/tab type.

## Design decisions

### D-webui-nodes-workbench

[2026-10-14] Nodes is a separate operational Workbench page for runtime status and Node access/onboarding. Architecture continues to own Session topology and Agent management; Setup continues to own configuration and authorization. Reuse ordinary system-tab and popup navigation instead of adding another dashboard or host protocol.

Node-local data accounting: [scope, service and UI](../threads/node-data-usage.md). It is independent of runtime connectivity and never scans arbitrary Session cwd directories.
