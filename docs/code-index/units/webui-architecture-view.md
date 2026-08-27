# Unit: webui-architecture-view

Files: packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/architectureOperations.ts, packages/webui/test/architectureOperations.test.mjs
Secondary files: packages/webui/test/boundedSessionList.test.mjs, packages/webui/test/boundedSessionReplay.test.mjs

## Purpose

Renders a bounded system-operations dashboard and persistent Agent registry for Foxwarm. Unlike the Sidebar's session navigation hierarchy, Architecture explains runtime placement and operational state, and owns explicit Agent lifecycle, inheritance, isolation, and memory-workspace controls.

## Key Exports

- `ArchitectureView` — owns the bounded Architecture catalog, node-status fetch, filters, execution-node lanes, and selected-session inspector.
- `getArchitectureSessionNodeId(session)` — resolves effective placement, preferring an active tool's exact execution node over the Session's configured current node and then `master`.
- `filterArchitectureSessions(sessions, filter, query)` — applies canonical runtime-state filters and cross-field operational search.
- `groupArchitectureSessionsByNode(sessions)` — groups the loaded presentation window into effective execution-node lanes without changing server row order.
- `getArchitectureNodePreview(sessions, preferredIds, limit)` — produces a bounded lane preview that keeps current/selected and active sessions visible before ordinary server-ordered rows.

## Behavior

### Bounded catalog ownership

- Architecture owns `/session-list/architecture`, `/session-list/children`, and exact `/session-list/by-id` requests; it never accepts an all-session array prop or performs the legacy global Session fetch.
- It retains atomic root/branch replay, shared presentation-revision fencing, per-row HTTP/SSE epochs, forced bounded focus paths, agent-owned forests, row pruning, and exact loaded-row realtime subscriptions.
- Global cards use backend-maintained catalog summaries even though the browser holds only a bounded window. The UI states the loaded/global counts explicitly.
- Loading more roots extends the bounded window by 50. Selecting a session can materialize its child relationship window through the fixed children API; the inspector can continue that relationship window.

### Operational topology

- The primary surface is execution-node lanes, not a second recursive navigation tree.
- Effective placement is the active tool's `executionNode`, otherwise `currentNode`, otherwise `master`. This makes cross-node tool execution visible while it is occurring.
- `/nodes` supplies Master/CLI Node identity, online state, type, display name, and service count. Unknown placement IDs remain visible as unavailable node lanes rather than disappearing.
- Each lane reports loaded, active, and waiting counts. A preview shows at most six rows while prioritizing current/selected and active sessions; expanding a large lane exposes all loaded rows inside a node-owned scroll region capped at 360px so one busy node cannot push every later node far down the page.
- Empty nodes remain as compact headers, preserving system topology without tall empty placeholder bodies.

### Operations and inspector

- Summary cards expose agents, sessions, active, waiting, queued, online nodes, and managed-session count. Active/waiting/queued summary cards also set the local status filter.
- One compact topology control bar replaces unbounded Agent/status chip clouds: search and bounded Agent/status selects occupy the primary control area, while total/cached/input/output token traffic forms one read-only trailing group. Agent selection remains backend-owned. Local filters cover all, active, waiting, queued, and isolated rows; search matches session ID/name, agent, effective node, model, active tool, and wait kind.
- Clicking a session selects it for inspection without navigation. The explicit Open control enters the chat Session.
- The inspector shows canonical runtime state/phase/model/queue, active tool and arguments, wait condition and pending targets, agent/node/CWD/isolation, messages/activity/tokens, and loaded parent/child relationships.
- The current Session is exact-loaded and initially inspected, but catalog replay does not force-expand a duplicate session tree. Background refresh therefore cannot override a nonexistent tree-collapse intent.
- A one-second clock runs only while a loaded Session is actively requesting a model or running a tool, keeping elapsed runtime labels current without treating waiting as busy.

### Agent registry

- The Topology/Agents surface switch separates runtime Session placement from persistent Agent management. The Agents summary counts real workspace directories, including valid zero-session Agents that do not appear in Session-derived catalog summaries.
- Registry cards show self-owned memory file count/recency plus session, active, queue, inheritance, and isolation summaries. Their order is independent of selection so clicking a card never moves it: `main` is first, followed by active Agents, other populated Agents, and empty workspaces, with IDs alphabetical inside each group.
- The registry reuses `AgentCreationMenu` for Agent and Session creation. Agent update changes only mutable inheritance/isolation metadata; Agent ID is not renamed because it is a durable namespace, permission scope, and archive identity component.
- The Agent inspector displays the complete inheritance chain, allows an isolation Node selection, and loads a bounded, symlink-free Markdown manifest from self-owned `memory/`. Top-level `00_SYSTEM.md`, `MEMORY.md`, `SOUL.md`, and `USER.md` are prioritized, nested project files follow, and `archive/` is last. Folder/file actions open the exact Master path in Code without copying file content through the registry API.
- Agent deletion requires exact typed Agent-ID confirmation. `main` is immutable; Agents inherited by another Agent and Agents with active Sessions are rejected. Confirmation authorizes destructive removal of idle owned Sessions and any queued work through canonical Session deletion, then removes the self-owned workspace and Agent metadata; durable Session archives and their reserved identities remain.

## Integration

- `App` provides Session navigation/creation callbacks, Sidebar refresh, and embedded Code folder/file opening. The embedded Agents editor falls back to authenticated Agent/Session APIs and a new-window Code target.
- `SessionListCore.Session` remains the shared bounded projection DTO.
- `sessionRuntimeState.ts` owns canonical active/waiting/idle interpretation.
- `nodeTargets.ts` owns tolerant `/nodes` response normalization.
- The Sidebar remains the canonical surface for compact navigation, pinning, drag ordering, and branch disclosure; Architecture intentionally does not duplicate those controls.

## Design Decisions

### D-webui-architecture-operational-topology

[2026-08-25] Architecture answers how Foxwarm is organized and running; Sidebar answers which Session the user wants to enter. Architecture therefore uses effective execution-node lanes plus a diagnostic entity inspector instead of a second recursive session-navigation tree. Keep current/active rows visible, preserve bounded backend ownership, cap expanded node bodies with local scrolling, and make navigation an explicit secondary action. This distinction prevents duplicated branch-order/collapse behavior while exposing placement, queue, wait, tool, model, token, and relationship information that Sidebar does not provide.

### D-webui-architecture-agent-registry

[2026-08-25] Persistent Agent CRUD belongs beside runtime topology because an Agent is a workspace/memory owner, not a Sidebar branch. Create and mutable metadata update are ordinary registry actions; rename is intentionally absent because Agent ID participates in Session namespace, permission scope, and retained archive identity. Memory navigation is manifest-only and path-confined, while destructive deletion uses typed confirmation and backend lifecycle blockers.
