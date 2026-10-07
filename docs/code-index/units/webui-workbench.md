# Unit: Workbench, Code launch, and VS Code Web frame

Files: `packages/webui/src/commitMarker.ts`, `packages/webui/src/components/CodeLaunchButton.tsx`, `packages/webui/src/components/CommitMarkerCard.tsx`, `packages/webui/src/components/DiffPreview.tsx`, `packages/webui/src/components/SimpleCodeEditor.tsx`, `packages/webui/src/components/VscodeWebFrameHost.tsx`, `packages/webui/src/components/WorkbenchLayout.tsx`, `packages/webui/src/components/WorkbenchPane.tsx`, `packages/webui/src/components/WorkbenchTabHeader.tsx`, `packages/webui/src/components/WorkbenchTabs.tsx`, `packages/webui/src/components/downloadShared.ts`, `packages/webui/src/vscodeWeb.ts`, `packages/webui/src/workbench/store.ts`, `packages/webui/src/workbench/types.ts`, `packages/webui/src/workbench/utils.ts`

## Purpose

Connects workbench tab/pane state to Code/VS Code Web, diff/editor views, typed commit markers, and deployment-relative launch/download helpers.

## Stable symbols and callers

`WorkbenchLayout`; `WorkbenchTabs`; `WorkbenchPane`; `VscodeWebFrameHost`; `CodeLaunchButton`; `commitMarker`; `vscodeWeb`; workbench store/types/utils. Callers are App shell, Code host routes, Chat commit-marker cards, and terminal/session navigation.

## Behavior and side effects

Workbench keeps Chat, Terminal, Agents, Setup, Tasks, and Code tabs in split-pane/store state. Closing an active tab advances to the store-selected fallback before hydration can recreate it; popout removes the source tab only after a window handle exists and does not invoke resource close. Code’s embedded frame is persistent for its visible tab, created only when displayed and destroyed when the last embedded tab closes; standalone URLs carry deployment-relative node/path/workspace targets.

`VscodeWebFrameHost` uses the nonce/source/channel/version bridge contract owned by the app shell. File-open requests become typed node/path/cwd selections, and controlled editor selection preserves explicit line/range state instead of letting unrelated parent rerenders reset the user selection. Commit markers are inert unless strict parser/route shape passes; malformed or user-authored marker text remains ordinary text. Diff/commit UI renders bounded Git payloads and does not perform filesystem/Git effects itself.

## Tests

Workbench/pane/tab, Code frame/launch, commit marker, diff/editor selection, and VS Code Web browser tests.
