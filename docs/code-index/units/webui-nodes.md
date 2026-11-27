# Unit: webui-nodes

Files: packages/webui/src/components/SystemNodes.tsx, packages/webui/src/components/NodeActionsModal.tsx, packages/webui/src/useNodeDirectory.ts
Secondary files: packages/webui/src/components/SystemView.tsx, packages/webui/src/components/NodePicker.tsx, packages/webui/src/App.tsx, packages/webui/src/components/WorkbenchStatusBar.tsx, packages/webui/src/PopupWebUiApp.tsx, packages/webui/src/popupWebUi.ts, packages/webui/src/workbench/utils.ts, packages/webui/test/nodeOnboarding.e2e.mjs, packages/webui/test/workbenchPreview.e2e.mjs, packages/webui/test/popupMove.e2e.mjs, packages/webui/test/mainHostSystem.e2e.mjs, packages/webui/test/mainHostNodeActions.e2e.mjs

## Purpose

Owns the Nodes section of the [System page](./webui-system-view.md): connected Node status, how many Sessions each Node holds, and explicitly invoked Node onboarding.

## Exports and function index

- `SystemNodes` — the Node table (a compact list below 640 px of pane width and on phones), Online/Total summary, pending approval count ("1 pending approval", "N pending approvals") and the New nodes action. Online/Total count only the `/nodes` directory; a pending pairing is not a Node until approved and appears only in the pending count (`nodeOnboarding.e2e.mjs`).
- `NodeActionsModal` — native modal dialog for editable existing launch commands, explicit one-time token reissue and descendant-aware deletion; owns abortable requests and secret lifetime.
- `useNodeDirectory` — directory-only initial read and visibility-aware 30-second refresh, with cancellation and request-identity publication fencing. System owns one instance and passes Node identities to the Nodes section, Session filters, the inspector and Agent isolation choices. The composer [Node picker](./webui-chat-composer.md#d-composer-session-node-picker) owns another, enabled only for a remote current Node; `enabled: false` performs no reads, and `loaded` reports whether any read has succeeded.

## Behavior and integration

- Opening Nodes: the System page's Nodes section, the status-bar Open Nodes action, `#nodes`, the former `#tab/system:nodes` route, a saved former Nodes tab (normalized to the System tab on Nodes) and the `nodes` popup leaf. Navigation uses ordinary system-tab activation, including same-ID reuse and activation of a collapsed pane.
- Status-bar Tasks retains its bounded preview. Nodes lists the complete directory in original order within a locally scrolling region; summary and navigation remain outside that region. Empty data and failed preview reads do not disable the Open actions.
- Summaries and the footer use Online/Total, counting `online === true` independently of protocol compatibility and including Master through the existing directory normalization. Rows also distinguish provider Unavailable/error state; canonical colon-bearing provider IDs remain visible. File/exec support does not imply Code/PTY launch support. Table rows and popup rows report Online/Offline with the [shared Tasks-style status badge](./webui-tasks.md#shared-status-badges), retaining a separate warning badge for Upgrade required and visible protocol explanations.
- [2026-11-27, user decision] Nodes lists no Sessions; the Sidebar's Node grouping is where Sessions are browsed by Node. Each row's Sessions cell shows the catalog count for that Node (`nodeCounts`) and the active Sessions among loaded rows, and opens Sessions (List) filtered to the Node. Placement IDs outside the directory get an Unavailable row. Row layout, expansion and the row menu are described in [the System view](./webui-system-view.md#nodes-section).
- The visible Nodes section owns the [pending approvals hook](./webui-node-onboarding.md). Leaving the section, document hiding or modal close preserve the hook/modal cancellation boundaries. Only explicitly opening New nodes mounts the onboarding modal; directory, pending and catalog reads never load setup credentials. Existing-Node token reissue has the separate mounted-dialog lifetime below.

## Existing Node actions

[Restart/revocation](./external-nodes.md#d-node-restart-and-revocation) governs the actions. Approved CLI and Shell rows offer Start command in their row menu; all native approved rows offer Delete. Master, Provider-owned and unavailable placement rows have no row menu. Opening a command reads only non-secret launch facts and the credential-free restart suggestion. Method, address and relevant paths remain editable until explicit reissue. Changing an input clears the stale command until Update command; no edit rotates credentials.

Reissue requires a second explicit confirmation. Its one-time response and copyable token live only in the mounted dialog, with input controls frozen to the issued command. Closing aborts pending requests and discards late responses without retry or implicit revocation. It tells the operator that the old token no longer works and the replacement is shown once. The native dialog supplies focus confinement and Escape cancellation; close restores the invoking control. No token enters browser storage or a request URL.

Deletion previews descendants and requires a checked cascade confirmation when children exist. A mixed Provider subtree disables deletion and directs the operator to its Provider. Successful reissue/deletion reuse the ordinary directory refresh; no new polling or realtime subscription is added. [Administrator API ownership](./external-nodes.md#administrator-node-maintenance) keeps authorization and revocation outside the UI.

## Tests

- `workbenchPreview.e2e.mjs` covers 15 directory entries with nine online (including one incompatible online Node), full-list order and native scrolling, no additional directory requests, theme contrast, both status-preview entries, dismissal, empty/failed previews, System reuse, collapsed-pane activation of a saved Nodes tab, route hydration, persistence/reload of the section, mobile rendering and sole-tab headers.
- `nodeOnboarding.e2e.mjs` runs `SystemView` against managed Main behind a recording proxy (`mainHostProxy.mjs`), with pending pairings from the official CLI Node client. It covers the section switch, per-section summaries, authenticated onboarding, pending pagination/approval, visibility pause, credential lifecycle and abort tests, and polling cleanup after unmount.
- `mainHostNodeActions.e2e.mjs` covers real native/JavaScript launch reports, stored-credential copy, Shell reissue, copy failure, cancel/reissue, secret disposal after close and an accepted delayed response, edited paths, single/cascade deletion and Provider exclusion.
- `popupMove.e2e.mjs` covers moving System on Nodes to the `nodes` leaf and in-place section switching in popup and embedded leaves. `mainHostSystem.e2e.mjs` covers the sections, the Nodes table and its Session-count link, and every former entry point against a real C# Main.

## Design decisions

### D-webui-nodes-workbench

[2026-10-14; superseded 2026-11-03 by [D-webui-system-page](./webui-system-view.md#d-webui-system-page), user decision] Nodes was a separate operational Workbench page. It is now the Nodes section of System. Setup continues to own configuration and authorization, and ordinary system-tab and popup navigation is still reused instead of another dashboard or host protocol.
