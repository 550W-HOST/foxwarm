# Unit: Workbench, Code launch, and VS Code Web frame

Files: `packages/webui/src/commitMarker.ts`, `packages/webui/src/components/CodeLaunchButton.tsx`, `packages/webui/src/components/CommitMarkerCard.tsx`, `packages/webui/src/components/DiffPreview.tsx`, `packages/webui/src/components/SimpleCodeEditor.tsx`, `packages/webui/src/components/VscodeWebFrameHost.tsx`, `packages/webui/src/components/WorkbenchLayout.tsx`, `packages/webui/src/components/WorkbenchPane.tsx`, `packages/webui/src/components/WorkbenchTabHeader.tsx`, `packages/webui/src/components/WorkbenchTabs.tsx`, `packages/webui/src/components/downloadShared.ts`, `packages/webui/src/vscodeWeb.ts`, `packages/webui/src/workbench/store.ts`, `packages/webui/src/workbench/types.ts`, `packages/webui/src/workbench/utils.ts`

## Purpose

Connects workbench tabs to Code/VS Code Web, diff/editor views, commit markers, and launch/download helpers.

## Stable symbols and callers

`WorkbenchLayout`; `WorkbenchTabs`; `VscodeWebFrameHost`; `CodeLaunchButton`; commit marker cards.

Callers and boundary: Host `CodeWorkbench` routes; `packages/vscode-web` assets.

## Behavior and side effects

`WorkbenchLayout` and `WorkbenchTabs` coordinate Code panes and VS Code Web frame lifecycle; `CodeLaunchButton` chooses the deployment-relative host target. Diff/editor and commit-marker components render bounded Code/Git payloads and keep pending launch/commit UI separate from host-side filesystem/Git effects.

## Tests

Code-frame, workbench, VS Code Web, and commit-marker tests.
