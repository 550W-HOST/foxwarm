# Unit: Project workspaces

Files: src/projectStore.ts, src/channels/webuiProjects.ts, src/channels/webuiProjects.test.ts
Secondary files: src/channels/webuiChannel.ts, src/session/agentOps.ts, src/nodes/manager.ts

The maintained .NET implementation and its runtime qualification are documented in [managed Project workspaces](./dotnet-project-workspaces.md). This unit describes the retained TypeScript reference.

## Purpose

Stores Main-owned Project, workspace-session and tab membership independently of Session authority. Admin-only WebUI endpoints create and archive the presentation records, resolve a Node and directory, and bind an Agent tab to a distinct existing or new Session. Frontend behavior is owned by [Project workspaces](./webui-project-workspaces.md).

## Behavior

- `state/projects.sqlite` owns workspace metadata with a versioned schema; it never replaces `catalog.sqlite` or Session JSON. Node identity and normalized absolute POSIX root identify a Project. Creating an existing target restores its archived Project.
- Project creation checks the actual target directory on the selected Node. An omitted path uses that Node's default cwd; offline, unsupported, invalid, and missing directories fail rather than falling back. Master defaults to the existing main Agent directory. A Session-free read-only cwd probe permits setup before any Session exists.
- Workspace tabs reference resources instead of copying conversations. Existing Agent Sessions can be attached only when their current Node and cwd match, and the reserve/attach operation is one transaction. A Session belongs to at most one workspace tab.
- New Agent tab creation persists a request ID, intended Agent and deterministic Session identity before creating the Session. The initial Session authority includes the target Node and cwd. Retrying the same request resumes a pending creation without duplicating a Session and refuses to reset a target changed since creation. Archive and tab removal never delete the underlying Session or terminal.
- Projects and workspace lists are bounded; session history remains separately served by existing runtime APIs. Routes use ordinary admin authentication.

## Verification

The project HTTP fixture covers authentication, directory validation, Node-qualified identities, Agent target initialization, concurrent request idempotency, recovery after directory unavailability, transactional existing-session association, archive and persistence. Node protocol tests cover the unbound cwd probe and ensure arbitrary unbound exec remains forbidden.
