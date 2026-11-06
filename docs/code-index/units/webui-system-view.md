# Unit: webui-system-view

Files: packages/webui/src/components/SystemView.tsx, packages/webui/src/components/SystemSessions.tsx, packages/webui/src/components/SystemAgents.tsx, packages/webui/src/components/SystemShared.tsx, packages/webui/src/components/AgentSettingsFields.tsx, packages/webui/src/architectureOperations.ts, packages/webui/test/architectureOperations.test.mjs, packages/webui/test/mainHostSystem.e2e.mjs
Secondary files: packages/webui/src/components/SystemNodes.tsx, packages/webui/src/components/TokenUsageDetails.tsx, packages/webui/src/useNodeDirectory.ts, packages/webui/src/App.tsx, packages/webui/src/workbench/utils.ts, packages/webui/test/nodeOnboarding.e2e.mjs, packages/webui/test/boundedSessionReplay.test.mjs

## Purpose

The **System** page explains how Foxwarm is organized and running, in three sections: **Agents** (persistent workspaces), **Sessions** (runtime state, placement, usage and the collaboration timeline) and **Nodes** (execution environments and the Sessions on them). The Sidebar answers which Session to enter; System is diagnostic and administrative.

## Key Exports

- `SystemView` — owns the bounded Session catalog, Node directory, Agent registry, section switching and filters; renders the three sections. `SystemSection` / `SYSTEM_SECTIONS` name them.
- `SessionFilterBar`, `SessionOperationRow`, `SessionInspector` (`SystemSessions.tsx`) — Sessions list controls, rows and inspector.
- `AgentRegistryCard`, `AgentRegistryInspector` (`SystemAgents.tsx`) — Agent registry.
- `SystemNodes` ([webui-nodes](./webui-nodes.md)) — Nodes section.
- `UsagePie` and formatting helpers (`SystemShared.tsx`).
- `getArchitectureSessionNodeId(session)` — effective placement: an active tool's exact execution node, otherwise the Session's current node, otherwise `master`.
- `getArchitectureSessionModel(session)` — model in use, otherwise the configured model.
- `filterArchitectureSessions(sessions, filter, query, { nodeId, model })` — canonical runtime-state filter, effective-node and model filters, and cross-field search.
- `groupArchitectureSessionsByNode` / `getArchitectureNodePreview` — per-Node grouping and a bounded preview that keeps preferred and active Sessions visible.

## Behavior

### Page and navigation

- Header: title System, a per-section subtitle and the Agents | Sessions | Nodes switch. There is no global summary-card row; each section shows only its own summary (Agents: count; Sessions: active / waiting / queued, which also set the status filter; Nodes: Online / Total).
- The Workbench tab keeps its persisted identity `system:agents` / type `agents` and stores the current `section`; App writes section changes back through `updateTab`, so reload restores the section. The tab title is System.
- Entry points: the Sidebar and mobile Workspace tools "System" button; `#agents`, `#architecture`, `#system` (System tab, current section); `#nodes`, `#tab/system:nodes` and the status-bar Open Nodes action (System on Nodes). The former `system:nodes` route settles on `#tab/system:agents`.
- Saved layouts are normalized on read: a former `nodes` tab becomes the System tab with `section: 'nodes'` in the same pane position, or is dropped when a System tab already exists. No layout reset or storage version change.
- Popup leaves: `agents` opens System, `nodes` opens System on Nodes. Moving the System tab to a new window uses the `nodes` leaf when it is on Nodes. Sections switch in place inside popup and embedded leaves.
- The Sessions Timeline renders [the session sequence view](./webui-session-sequence.md), lazily loaded because it shares Chat rendering pieces; it does not use the bounded catalog window.
- The sole-tab title/actions row uses the shared [empty-header pane movement](./webui-workbench.md#d-workbench-pane-drag) boundary.
- Cached/Input/Output rows and percentages use the shared [TokenUsageDetails](./webui-token-usage-details.md) renderer.

### Bounded catalog ownership

- System owns `/session-list/architecture`, `/session-list/children`, and exact `/session-list/by-id` requests; it never accepts an all-session array prop or performs the legacy global Session fetch.
- It retains atomic root/branch replay, shared presentation-revision fencing, per-row HTTP/SSE epochs, forced bounded focus paths, agent-owned forests, row pruning, and exact loaded-row realtime subscriptions.
- Section summaries and the global usage pie use backend-maintained catalog summaries even though the browser holds only a bounded window; the Sessions list states how many loaded rows match.
- Loading more roots extends the bounded window by 50. Selecting a session can materialize its child relationship window through the fixed children API; the inspector can continue that relationship window.

### Sessions list and inspector

- List and Timeline views. The list shows loaded Sessions, newest activity first, with state, duration, Agent, effective node, queue, model and a per-Session usage pie; "Load 50 more root sessions" extends the window.
- Filters: search (ID/name, Agent, effective node, model, active tool, wait kind), status (all, active, waiting, queued, isolated), Agent (backend-owned, reloads the window), effective node and model (local over loaded rows). The trailing global usage pie uses catalog summary totals.
- Usage pies split cached/input/output tokens and open a viewport-bounded detail popover; Session pies use row usage, Agent pies sum loaded rows. Pie interaction does not select its row.
- Clicking a row inspects it without navigation; Open enters the Session. The inspector shows runtime state/phase/model/queue, active tool and arguments, wait condition, Agent/node/CWD/isolation, messages/activity/tokens and parent/child relationships.
- The current Session is exact-loaded and initially inspected. A one-second clock runs only while a loaded Session is actively working.

### Nodes section

- Lists real directory Nodes plus unavailable cards for placement IDs outside the directory, each with the Sessions placed on it by effective placement. Selecting one switches to Sessions (List) with that Session inspected; there is no second inspector. Directory, pending-approval and onboarding ownership are in [webui-nodes](./webui-nodes.md).

### Agent registry

- The Agents summary counts real workspace directories, including valid zero-session Agents that do not appear in Session-derived catalog summaries.
- An `agentRequest` prop (`{ agent, nonce }`) switches to the Agents section and selects that Agent's inspector; the Sidebar's Agent group menu uses it for Agent settings.
- Registry cards show self-owned memory file count/recency plus session, active, queue, inheritance, and isolation summaries. Their order is independent of selection so clicking a card never moves it: `main` is first, followed by active Agents, other populated Agents, and empty workspaces, with IDs alphabetical inside each group.
- The registry reuses `AgentCreationMenu` for Agent and Session creation. Its shared `+` opens New session directly, with Agent tags and a trailing New agent tag in the same modal flow. Agent update changes only mutable inheritance, isolation and new-session default Node/working-directory metadata; Agent ID is not renamed because it is a durable namespace, permission scope, and archive identity component.
- The Agent inspector shows its header (ID, Memory, counts), then the shared Agent settings form ([D-webui-agent-settings-form](#d-webui-agent-settings-form)) with the inheritance chain and one Reset/Save pair enabled only for changes, then memory files and the danger zone. It loads a bounded, symlink-free Markdown manifest from self-owned `memory/`. Top-level `00_SYSTEM.md`, `MEMORY.md`, `SOUL.md`, and `USER.md` are prioritized, nested project files follow, and `archive/` is last. Folder/file actions open the exact Master path in Code without copying file content through the registry API.
- Agent deletion requires exact typed Agent-ID confirmation. `main` is immutable; Agents inherited by another Agent and Agents with active Sessions are rejected. Confirmation authorizes destructive removal of idle owned Sessions and any queued work through canonical Session deletion, then removes the self-owned workspace and Agent metadata; durable Session archives and their reserved identities remain.

## Integration

- `App` provides Session navigation/creation callbacks, Sidebar refresh, and embedded Code folder/file opening. The embedded Agents editor falls back to authenticated Agent/Session APIs and a new-window Code target.
- `SessionListCore.Session` remains the shared bounded projection DTO.
- `sessionRuntimeState.ts` owns canonical active/waiting/idle interpretation.
- `nodeTargets.ts` owns tolerant `/nodes` response normalization.
- The Sidebar remains the canonical surface for compact navigation, pinning, drag ordering, and branch disclosure; System intentionally does not duplicate those controls.

## Design Decisions

### D-webui-system-page

[2026-11-03, user decision] The former System Architecture page and the standalone Nodes page become one **System** page with Agents | Sessions | Nodes; Tasks stays a separate page. Topology is removed: its filters, search, usage pie and inspector move to Sessions, and per-Node Session placement moves to Nodes. The global summary row is replaced by per-section summaries. Former entry points (Nodes tab, hashes, status bar, popup leaf, saved layouts) open System on the right section by read-old/write-new normalization. This supersedes [D-webui-nodes-workbench](./webui-nodes.md#d-webui-nodes-workbench).

### D-webui-architecture-operational-topology

[2026-08-25; the node-lane layout is superseded by [D-webui-system-page](#d-webui-system-page), the placement and inspector rationale still applies] Architecture answers how Foxwarm is organized and running; Sidebar answers which Session the user wants to enter. Architecture therefore uses effective execution-node lanes plus a diagnostic entity inspector instead of a second recursive session-navigation tree. Keep current/active rows visible, preserve bounded backend ownership, cap expanded node bodies with local scrolling, and make navigation an explicit secondary action. This distinction prevents duplicated branch-order/collapse behavior while exposing placement, queue, wait, tool, model, token, and relationship information that Sidebar does not provide.

### D-webui-architecture-agent-registry

[2026-08-25] Persistent Agent CRUD belongs beside runtime topology because an Agent is a workspace/memory owner, not a Sidebar branch. Create and mutable metadata update are ordinary registry actions; rename is intentionally absent because Agent ID participates in Session namespace, permission scope, and retained archive identity. Memory navigation is manifest-only and path-confined, while destructive deletion uses typed confirmation and backend lifecycle blockers.

### D-webui-agent-settings-form

[2026-11-02, user decision] New agent and the Agents inspector use one `AgentSettingsFields` form, so creation and later editing offer the same settings with the same order, labels, choices and hints: Memory inheritance (excluding the Agent itself and isolated Agents), Session defaults (Node, `master` by default, and working directory) and Isolation. The master Node is shown by its Node name (`master`), not as "Main", which named the retired multi-process server role. New agent keeps Isolation collapsed until opened; creation sends only chosen settings through the existing `POST /api/agents` fields. An isolated Agent always runs on its isolation Node, so choosing one sets and locks the Session defaults Node, and saving writes it as the default Node too; that keeps the working directory effective, because it applies only on the default Node. New session shows the selected Agent's start location from its saved settings (`Starts on <Node> · <directory>`) but does not override it; the line is omitted when no placement is configured.

## Workbench header integration

The normal sole-tab header close/icon controls use [Single-tab headers](./webui-workbench.md#single-tab-headers). Standalone and embedded leaf roots retain their existing navigation and do not own Workbench tabs.
