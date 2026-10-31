# Unit: Project workspaces

Files: `dotnet/Foxwarm/Sessions/ProjectStore.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Projects.cs`, `dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.Projects.cs`
Secondary files: `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.cs`, `src/projectStore.ts`, `src/channels/webuiProjects.ts`, `src/channels/webuiProjects.test.ts`, `src/channels/webuiChannel.ts`, `src/session/agentOps.ts`, `src/nodes/manager.ts`

## Purpose

Stores Main-owned Project, workspace-session and tab membership independently of Session authority. Admin-only WebUI endpoints create and archive the presentation records, resolve a Node and directory, and bind an Agent tab to a distinct existing or new Session. Frontend behavior is owned by [Project workspaces](./webui-project-workspaces.md).

## Behavior

- `state/projects.sqlite` owns workspace metadata with a versioned schema; it never replaces `catalog.sqlite` or Session JSON. Managed Main reads the Source schema in place, adds a missing Agent column from version 1, and retains all Project, work-session, tab and request identities. Node identity and normalized absolute Code root identify a Project. Windows Main maps drive paths at the Code boundary and retains native Session cwd. Creating an existing target restores its archived Project.
- Project creation checks the actual target directory on the selected Node. An omitted path uses that Node's default cwd; offline, unsupported, invalid, and missing directories fail rather than falling back. Master defaults to the existing main Agent directory. A Session-free read-only cwd probe permits setup before any Session exists.
- Workspace tabs reference resources instead of copying conversations. Existing Agent Sessions can be attached only when their current Node and cwd match, and the reserve/attach operation is one transaction. A Session belongs to at most one workspace tab.
- New Agent tab creation persists a request ID, intended Agent and deterministic Session identity before creating the Session. `SessionManager.CreateNamedAsync` accepts an initial cwd and commits it together with the target Node in the first Session authority. Retrying the same request resumes a pending creation without duplicating a Session and refuses to reset a target changed since creation. A channel-owned asynchronous gate serializes reservation, runtime creation and removal. Archive and tab removal never delete the underlying Session or terminal.
- Projects and workspace lists are bounded; session history remains separately served by existing runtime APIs. Routes use ordinary admin authentication.

## Verification

The managed HTTP fixture covers administrator-only access, directory validation, the first committed Agent target, concurrent request idempotency, pending creation recovery after a Main restart, transactional existing-session association, archive and persistence. A connected Node fixture resolves its default cwd through the advertised tool, validates the remote filesystem, and verifies the first persisted Agent target. The catalog fixture opens an existing Source version-1 database and verifies that membership and request identities survive migration and reopening. Retained Source HTTP and Node protocol fixtures cover its compatibility implementation and unbound cwd probe through the explicit reference suite.
