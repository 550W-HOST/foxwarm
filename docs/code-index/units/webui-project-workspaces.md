# Unit: webui-project-workspaces

Files: packages/webui/src/components/ProjectWorkspace.tsx, packages/webui/src/projectWorkspace.ts, packages/webui/src/workspaceMode.ts, packages/webui/test/projectWorkspace.e2e.mjs
Secondary files: packages/webui/src/App.tsx, packages/webui/src/components/SetupView.tsx, packages/webui/src/components/ProjectCodeFrame.tsx, dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Projects.cs, dotnet/Foxwarm/Sessions/ProjectStore.cs, dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.Projects.cs

## Purpose

Present Projects and their work sessions as a browser-local alternative to the original workbench. Server-owned Project and tab records identify Node, root directory and resources; an Agent tab references an existing Foxwarm conversation. Selection and display mode are browser-local preferences.

Project metadata is stored in Main's `projects.sqlite`; Session runtime state remains authoritative in the existing Session store. The backend creates Agent tabs with the Project Node and root bound before the tab is ready, and resumes pending creations using the original request ID. See [Project workspace backend](./src-project-workspaces.md).

## Behavior

- A user creates a Project by selecting a Node and an absolute directory, or lets the server resolve and validate the Node's default. Remote directory browsing uses the existing authenticated filesystem service.
- A work session can contain multiple independent Agent and Terminal tabs and one Code tab. Tab creation goes through the Project API and retries incomplete Agent creation with its original request ID. Explicit association of an existing conversation requires matching execution target and does not rewrite its history.
- Previously visited tabs remain mounted while hidden across project/session switches; archiving removes an item from navigation without closing its views or terminating its resources. Explicit Terminal close waits for resource close before deleting the tab record. Code close asks the user to save open edits.
- The Unassigned section is a bounded list of currently loaded original conversations, excludes conversations already linked to any Project, and keeps History available for further discovery. Linking targets the selected work session and is validated by the backend without changing execution target.
- The selection of the current work session and active tab is persisted per browser. Switching to the original workbench preserves both Project state and existing classic layout. Setup's workspace-mode preference notifies the active App in the same browser and other browser tabs.
- Settings, Agents, Nodes and History open as browser-local tabs inside the Project shell. The model selector opens Settings directly at Models. Global navigation and unassigned conversations do not change the workspace experience or the saved original layout; closing a tool or selecting a work-session tab returns to the retained workspace. Hidden Agent views disable their search shortcuts, and each shell's settings editors have separate Monaco identities.
- Project Code requires a workspace-specific editor instance and persistent browser storage identity; the bridge and server asset contract are owned by [Code integration](../threads/code-integration.md).

## Tests

`projectWorkspace.e2e.mjs` runs the actual component against a synthetic Project API. It checks independent session selection, retaining hidden Agent drafts, Terminal and Code content across switches, idempotent Agent tab creation, selection restoration, explicit association of an existing conversation and Node default-directory resolution.

`projectWorkspaceApp.e2e.mjs` uses the owned managed application harness to verify real Agent and Terminal creation, model settings and management navigation within Project on desktop and mobile, draft and Code frame retention, mode switching, reload and missing-terminal behavior.
