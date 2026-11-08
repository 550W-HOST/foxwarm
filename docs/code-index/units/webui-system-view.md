# Unit: webui-system-view

Files: packages/webui/src/components/SystemView.tsx, packages/webui/src/components/SystemSessions.tsx, packages/webui/src/components/SystemAgents.tsx, packages/webui/src/components/SystemShared.tsx, packages/webui/src/components/SystemTimers.tsx, packages/webui/src/components/SystemWebhooks.tsx, packages/webui/src/components/SystemUsage.tsx, packages/webui/src/components/AgentSettingsFields.tsx, packages/webui/src/architectureOperations.ts, packages/webui/src/systemTimers.ts, packages/webui/src/systemWebhooks.ts, packages/webui/src/usageOverview.ts, packages/webui/src/useUsageReport.ts, packages/webui/test/architectureOperations.test.mjs, packages/webui/test/systemTimers.test.mjs, packages/webui/test/systemWebhooks.test.mjs, packages/webui/test/usageOverview.test.mjs, packages/webui/test/mainHostSystem.e2e.mjs, packages/webui/test/mainHostSystemTimers.e2e.mjs, packages/webui/test/mainHostSystemWebhooks.e2e.mjs, packages/webui/test/mainHostSystemUsage.e2e.mjs
Secondary files: packages/webui/src/components/SystemNodes.tsx, packages/webui/src/components/TokenUsageDetails.tsx, packages/webui/src/useNodeDirectory.ts, packages/webui/src/App.tsx, packages/webui/src/workbench/utils.ts, packages/webui/test/nodeOnboarding.e2e.mjs, packages/webui/test/boundedSessionReplay.test.mjs

## Purpose

The **System** page explains how Foxwarm is organized and running, in six sections: **Agents** (persistent workspaces), **Sessions** (runtime state, placement, usage and the collaboration timeline), **Nodes** (execution environments and the Sessions on them), **Timers** (scheduled messages and scripts across all Sessions), **Webhooks** (configured inbound webhooks and their recent deliveries) and **Usage** (model requests, tokens and recorded cost across the installation). The Sidebar answers which Session to enter; System is diagnostic and administrative.

## Key Exports

- `SystemView` — owns the bounded Session catalog, Node directory, Agent registry, section switching and filters; renders the six sections. `SystemSection` / `SYSTEM_SECTIONS` name them.
- `SessionFilterBar`, `SessionOperationRow`, `SessionInspector` (`SystemSessions.tsx`) — Sessions list controls, rows and inspector.
- `AgentRegistryCard`, `AgentRegistryInspector` (`SystemAgents.tsx`) — Agent registry.
- `SystemNodes` ([webui-nodes](./webui-nodes.md)) — Nodes section.
- `SystemTimers`, `SessionTimersSection` (`SystemTimers.tsx`) — Timers section and the Session inspector's Timers section; `systemTimers.ts` owns their pure list projection, filters, ordering and edit-request building.
- `SystemWebhooks` (`SystemWebhooks.tsx`) — read-only Webhooks section; `systemWebhooks.ts` owns its labels, outcome tones, loopback-address check and ordering.
- `SystemUsage` (`SystemUsage.tsx`) — Usage section; `usageOverview.ts` owns the `/api/usage` contract types, local-time period boundaries, group labels and chart series; `useUsageReport.ts` owns report loading, the `usage-changed` refresh and the local-midnight clock shared with the status bar Total.
- `UsagePie` and formatting helpers (`SystemShared.tsx`).
- `getArchitectureSessionNodeId(session)` — effective placement: an active tool's exact execution node, otherwise the Session's current node, otherwise `master`.
- `getArchitectureSessionModel(session)` — model in use, otherwise the configured model.
- `filterArchitectureSessions(sessions, filter, query, { nodeId, model })` — canonical runtime-state filter, effective-node and model filters, and cross-field search.
- `groupArchitectureSessionsByNode` / `getArchitectureNodePreview` — per-Node grouping and a bounded preview that keeps preferred and active Sessions visible.

## Behavior

### Page and navigation

- Header: title System, a per-section subtitle and the Agents | Sessions | Nodes | Timers | Webhooks | Usage switch. There is no global summary-card row; each section shows only its own summary (Agents: count; Sessions: active / waiting / queued, which also set the status filter; Nodes: Online / Total; Timers: timers / paused / failing; Webhooks: webhooks / need attention; Usage: cost, tokens and requests for the chosen period).
- The Workbench tab keeps its persisted identity `system:agents` / type `agents` and stores the current `section`; App writes section changes back through `updateTab`, so reload restores the section. The tab title is System.
- Entry points: the Sidebar and mobile Workspace tools "System" button; `#agents`, `#architecture`, `#system` (System tab, current section); `#nodes`, `#tab/system:nodes` and the status-bar Open Nodes action (System on Nodes); `#timers` (System on Timers); `#webhooks` (System on Webhooks); `#usage` and the status-bar Total's "Open in System › Usage" (System on Usage, the latter with its period); the Session inspector's "View in Timers" (Timers filtered to that Session). The former `system:nodes` route settles on `#tab/system:agents`.
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
- Filters: search (ID/name, Agent, effective node, model, active tool, wait kind), status (all, active, waiting, queued, isolated), Agent (backend-owned, reloads the window), effective node and model (local over loaded rows). The trailing global usage pie uses catalog summary totals and is labelled Conversation turns; its popover states that it covers conversation turns of existing sessions and that System › Usage counts every model request.
- Usage pies split cached/input/output tokens and open a viewport-bounded detail popover; Session pies use row usage, Agent pies sum loaded rows. Pie interaction does not select its row.
- Clicking a row inspects it without navigation; Open enters the Session. The inspector shows runtime state/phase/model/queue, active tool and arguments, wait condition, Agent/node/CWD/isolation, messages/activity/tokens and parent/child relationships.
- The current Session is exact-loaded and initially inspected. A one-second clock runs only while a loaded Session is actively working.

### Nodes section

- Lists real directory Nodes plus unavailable cards for placement IDs outside the directory, each with the Sessions placed on it by effective placement. Selecting one switches to Sessions (List) with that Session inspected; there is no second inspector. Directory, pending-approval and onboarding ownership are in [webui-nodes](./webui-nodes.md).

### Timers section

- Lists every ordinary timer from `GET /api/timers` (internal wait timeouts excluded): action icon and summary (message text, inline script first line or script file), state (Scheduled, Paused, Not scheduled), schedule (cron with next run, or one-time time, in local time with a relative hint), owner Session and the latest result. Order: scheduled by next run, then unscheduled, then paused.
- Filters: search (ID, owner ID/name, message, cron, script code/file/Node, new-Session Agent/prefix), Agent (owner's catalog Agent, falling back to the ID prefix), action (Message, ToolScript), state (Scheduled, Paused, Last run failed, Not scheduled), and a removable Session chip set by the inspector link. Owner names and Agents come from the exact `/session-list/by-id` lookup.
- The inspector shows schedule (repeats/once, next run, last fired), owner (inspect in Sessions when loaded, otherwise open; separate open action), Agent, action, target (owner Session, new Session with Agent/prefix, or the owner for scripts), script file/source Node/timeout/inline code or the full message, and the recent results with errors. A result's run ID opens the run's diagnostics (`get_toolscript_run` projection) in the JSON inspector.
- Actions: Pause/Resume; Edit (schedule kept, cron, date-time or delay; message for message timers, or the complete script settings as JSON for ToolScript timers), validated again by `update_timer`; Delete after an inline confirmation. A paused one-time timer past its time notes that resuming fires it once. There is no run-now action.
- Live updates: the section and the inspector's Timers list reload (debounced) on the realtime `timers-changed` event and on socket reopen; no polling. A 30-second clock refreshes relative times only while mounted.
- The Session inspector's Timers section lists up to five of that Session's timers from `GET /api/timers?sessionId=` with a "View in Timers" link.
- Narrow widths stack the inspector below the list without horizontal overflow.

### Usage section

- Reads installation-wide usage from `GET /api/usage` ([usage ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger)): every recorded successful model request of every purpose, including deleted Sessions. It does not use the bounded Session catalog or Session stats, which count normal turns of current Sessions only.
- Period: Today (hourly buckets), This week (Monday start), This month, or a Custom inclusive date range of up to 400 days (daily buckets). The browser computes the local-time boundaries, so day and week edges follow the viewer's time zone; daylight-saving repeats collapse to strictly increasing boundaries. The choice persists in `localStorage` and moves with the local date at midnight.
- Group by Agent, Session tree, Session, Model, Provider or Purpose. Purpose rows use product labels (Conversation turns, Context compaction, Session titles, Side questions, ToolScript model calls, Setup checks, Command line, Other requests, and Older conversation turns for the legacy `normal` key) with the recorded key as detail. Requests outside any Session form "Outside sessions"; Session requests whose Agent cannot be attributed form "Unattributed sessions"; deleted Sessions are pooled as "Deleted sessions" under the Agent their Archive records. Agents are attributed when the report is read: a moved Session's usage follows its current Agent. Clicking an Agent row filters to that Agent and switches to Session trees, whose roots are then that Agent's own top Sessions rather than another Agent's coordinator; Session rows open their Session.
- Summary cards: recorded estimated cost (with the count of requests that have no price), tokens with the shared [TokenUsageDetails](./webui-token-usage-details.md) breakdown, and model requests. A stacked bar chart shows cost (or tokens) per bucket for the largest groups plus Other; groups with nothing to draw stay out of the legend. The table lists up to 100 groups ordered by cost, then tokens. A group without any priced request shows "Tokens only"; a partly priced group marks its cost.
- Requests recorded before pricing was configured stay tokens-only; no current price is applied to them ([D-model-usage-cost](../threads/model-request-and-streaming.md#d-model-usage-cost)). While the startup backfill is still adding older requests the section says so; when records start after the period's first day it shows when they begin.
- Live updates: reloads (debounced) on the realtime `usage-changed` event and on socket reopen; no polling. The previous report stays visible, dimmed, until a new selection's report arrives. A failed or malformed response shows an inline error with Retry.

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

### Webhooks section

- Lists every identity with a `webhook` surface from administrator `GET /api/webhooks` ([contract](./host-runtime.md#d-host-inbound-webhooks)): action icon, ID, verification, target Session and the latest delivery outcome. Webhooks whose target is unavailable or whose latest delivery failed come first, then by ID.
- Inspector: copyable address with a hint to set `url` in Setup › Config when it is a loopback address; verification and GitHub events; target Session (opens its inspector, or explains that deliveries are refused while it is missing); action, and for handlers the script source, Node, timeout and waiting count; passive deliveries refused because the unread backlog was full, and requests that could not be verified; the newest deliveries with outcome, event/action, delivery ID, a payload-omitted note, error and a handler run link that opens the run record in the JSON inspector.
- Read-only: webhooks are added and changed in Setup › Config. History is process memory and empty after a restart.
- Live updates: reloads (debounced) on the realtime `webhooks-changed` event and on socket reopen; no polling.

## Design Decisions

### D-webui-system-webhooks

[2026-11-08, user decision] Webhooks are configured only in the YAML access configuration; System gains a fifth, read-only Webhooks section for status rather than a structured editor. It shows where each webhook delivers, whether its target exists, the address to give the sending service and recent results, so a misconfigured source can be diagnosed without reading logs. Secrets never reach the page.

### D-webui-system-usage

[2026-11-09, user decision] Installation usage is a read-only System section, Usage, backed by the journal's derived [usage ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger) rather than Session stats: all request purposes count and are labelled by purpose; grouping by Agent, Session tree, Session, model, provider and purpose with daily (hourly for today) buckets; periods today, this week, this month and a custom range. There are no budgets, limits or usage configuration. Recorded costs are shown as recorded; requests from before pricing show tokens only. The status bar Total uses the same ledger for a selectable period ([TokenUsageDetails](./webui-token-usage-details.md)); Session usage pies stay per-Session. The route is administrator-only.

### D-webui-system-timers

[2026-11-07, user decision] Global timers are a fourth System section, Agents | Sessions | Nodes | Timers, rather than a separate page, and the Session inspector shows that Session's timers with a link into the section. The section offers the read-only list, recent results, pause/resume, edit and delete; run-now was deliberately not included. Changes go through the timer tools' own operations ([timer persistence](./tasks-timers.md#d-timers-pause-and-recent-runs)); the routes are administrator-only. Refresh is event-driven over the existing realtime list subscription instead of polling.

### D-webui-system-page

[2026-11-03, user decision] The former System Architecture page and the standalone Nodes page become one **System** page with Agents | Sessions | Nodes; Tasks stays a separate page. Topology is removed: its filters, search, usage pie and inspector move to Sessions, and per-Node Session placement moves to Nodes. The global summary row is replaced by per-section summaries. Former entry points (Nodes tab, hashes, status bar, popup leaf, saved layouts) open System on the right section by read-old/write-new normalization. This supersedes [D-webui-nodes-workbench](./webui-nodes.md#d-webui-nodes-workbench).

### D-webui-architecture-operational-topology

[2026-08-25; the node-lane layout is superseded by [D-webui-system-page](#d-webui-system-page), the placement and inspector rationale still applies] Architecture answers how Foxwarm is organized and running; Sidebar answers which Session the user wants to enter. Architecture therefore uses effective execution-node lanes plus a diagnostic entity inspector instead of a second recursive session-navigation tree. Keep current/active rows visible, preserve bounded backend ownership, cap expanded node bodies with local scrolling, and make navigation an explicit secondary action. This distinction prevents duplicated branch-order/collapse behavior while exposing placement, queue, wait, tool, model, token, and relationship information that Sidebar does not provide.

### D-webui-architecture-agent-registry

[2026-08-25] Persistent Agent CRUD belongs beside runtime topology because an Agent is a workspace/memory owner, not a Sidebar branch. Create and mutable metadata update are ordinary registry actions; rename is intentionally absent because Agent ID participates in Session namespace, permission scope, and retained archive identity. Memory navigation is manifest-only and path-confined, while destructive deletion uses typed confirmation and backend lifecycle blockers.

### D-webui-agent-settings-form

[2026-11-02, user decision] New agent and the Agents inspector use one `AgentSettingsFields` form, so creation and later editing offer the same settings with the same order, labels, choices and hints: Memory inheritance (excluding the Agent itself and isolated Agents), Session defaults (Node, `master` by default, and working directory) and Isolation. The master Node is shown by its Node name (`master`), not as "Main", which named the retired multi-process server role. New agent keeps Isolation collapsed until opened; creation sends only chosen settings through the existing `POST /api/agents` fields. An isolated Agent always runs on its isolation Node, so choosing one sets and locks the Session defaults Node, and saving writes it as the default Node too; that keeps the working directory effective, because it applies only on the default Node. New session shows the selected Agent's start location from its saved settings (`Starts on <Node> · <directory>`) but does not override it; the line is omitted when no placement is configured. When `GET /api/nodes` reports an installation `agentDefaultNode` other than master, the Node choice separates unset (`Installation default (<Node>)`) from an explicit `master`, and the start location and directory placeholder use that default for Agents without their own.

## Workbench header integration

The normal sole-tab header close/icon controls use [Single-tab headers](./webui-workbench.md#single-tab-headers). Standalone and embedded leaf roots retain their existing navigation and do not own Workbench tabs.
