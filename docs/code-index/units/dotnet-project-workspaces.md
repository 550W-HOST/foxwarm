# Unit: managed Project workspaces

Files: `dotnet/Foxwarm/Projects/ProjectStore.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Projects.cs`
Secondary files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.cs`, `dotnet/Foxwarm/Sessions/SessionManager.AgentOps.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.cs`

## Contracts and ownership

Project mode is the shared browser's optional workspace shell, described in [Project workspaces](./webui-project-workspaces.md). A Project identifies a Node and normalized absolute directory; a work session groups resource tabs and is not a conversation Session or an Agent. All Project routes require the existing administrator boundary. Scoped WebUI identities cannot read or mutate Project membership.

`ProjectStore` owns `state/projects.sqlite`, using the retained Source tables, indices and version 2 schema. Version 1 records are read and gain the missing `agent_id` column. It stores names, archive flags, work sessions, tab membership, resource references and Agent request IDs. Conversation history, execution placement and model authority remain in the existing Session store. One connection serializes metadata operations; existing-Session reservation and association use one SQLite transaction. Archive and tab deletion do not delete conversations, files or PTYs.

`WebUIChannel.RegisterProjectRoutes` provides `GET/POST /api/projects`, directory resolution, Project/work-session updates, work-session creation, and tab create/update/delete. Lists retain the Source bounds of 100 Projects per page and 1000 work sessions/tabs per parent. The React shell loads pages and performs explicit refresh; there is no Project realtime topic.

## Execution placement and recovery

Directory resolution validates a directory on the selected Node. Master defaults to the main Agent directory. Native remote Nodes use the existing read-only `get_default_cwd` tool without allocating a Session, then the advertised `vscode-fs` stat/read-directory service. Explicit remote paths use the same fixed filesystem services. Both directory reads reuse one captured service target; replacing the connection between reads rejects the old target instead of admitting the new generation. Missing, offline or unsupported targets fail without Master fallback. Provider Nodes without these Code services are not made filesystem-capable by Project metadata.

Project roots use slash-based Code paths. On Windows Master, the existing drive mapping converts a stored `/C:/...` root to a native path for Session cwd, and converts native cwd back for association checks. Remote POSIX roots retain their wire representation.

Agent creation reserves a pending tab and deterministic Session ID before creation. `CreateNamedAsync(initialNode, initialCwd)` initializes both fields in the first authority image, before the first strict save and publication. Concurrent requests for the same pending tab share its creation. A retry reuses the reserved Agent and Session identity; it checks an existing Session's current placement and never resets it. Existing conversation association requires matching Node/cwd and unique membership. Session creation retains the ordinary exact-owner, identity admission, memory snapshot, strict-save and publication path.

Terminal creation/reattachment/explicit close use the existing terminal routes and router. The server Project record stores its resource ID; the browser additionally records an ID before a transient metadata-save failure. Code consumes a work-session ID through its existing bootstrap and persistent workspace boundary; see [Code services](./code-services.md).

## Verification

`ProjectWorkspaceTests` covers administrator/scoped authentication, path validation and defaults, initial saved placement, concurrent request identity, transactional existing association, pending recovery after directory unavailability, archive/resource preservation, populated Source version-1 membership/request migration and reopen, and native Node tool/service messages before the first Session.

`mainHostProjectTargets.e2e.mjs` uses a normal managed host, actual official CLI Node, local scripted Responses service and original React App for initial remote placement, a first-turn filesystem effect, remote Project terminal creation, restart membership, directory-failed pending reservation recovery across a genuine Main restart, idempotency and existing-conversation association. With the pinned official Code OSS assets it also exercises Project Agent file/commit actions through the auxiliary Code frame, an independent work-session Code descriptor, and actual Project/auxiliary versus hidden-classic unread acknowledgement. `projectWorkspaceApp.e2e.mjs` runs under the owned application harness for desktop/mobile Settings/Models/Agents/Nodes/History navigation, drafts, mode switching, reload, Code frame identity and ended-terminal handling. A frame's existence alone does not qualify the optional official Code editor; its filesystem/editor qualification is separate.
