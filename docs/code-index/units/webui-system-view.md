# Unit: webui-system-view

Files: packages/webui/src/components/SystemView.tsx, packages/webui/src/components/SystemSessions.tsx, packages/webui/src/components/SystemShared.tsx, packages/webui/src/components/SystemSplit.tsx, packages/webui/src/components/SystemTimers.tsx, packages/webui/src/components/SystemWebhooks.tsx, packages/webui/src/components/SystemUsage.tsx, packages/webui/src/components/SystemActivity.tsx, packages/webui/src/activity.ts, packages/webui/src/architectureOperations.ts, packages/webui/src/systemTimers.ts, packages/webui/src/systemWebhooks.ts, packages/webui/src/usageOverview.ts, packages/webui/src/useUsageReport.ts, packages/webui/test/architectureOperations.test.mjs, packages/webui/test/systemTimers.test.mjs, packages/webui/test/systemWebhooks.test.mjs, packages/webui/test/usageOverview.test.mjs, packages/webui/test/activity.test.mjs, packages/webui/test/mainHostSystem.e2e.mjs, packages/webui/test/mainHostSystemTimers.e2e.mjs, packages/webui/test/mainHostSystemWebhooks.e2e.mjs, packages/webui/test/mainHostSystemUsage.e2e.mjs, packages/webui/test/mainHostSystemActivity.e2e.mjs, packages/webui/test/mainHostSystemMobile.e2e.mjs, packages/webui/test/mainHostSystemLayout.e2e.mjs
Secondary files: packages/webui/src/components/SystemNodes.tsx, packages/webui/src/components/SetupView.tsx, packages/webui/src/components/TokenUsageDetails.tsx, packages/webui/src/useNodeDirectory.ts, packages/webui/src/App.tsx, packages/webui/src/workbench/utils.ts, packages/webui/test/nodeOnboarding.e2e.mjs, packages/webui/test/boundedSessionReplay.test.mjs

## Purpose

The **System** page explains how Foxwarm is organized and running, in six sections: **Agents** (persistent workspaces), **Sessions** (runtime state, placement, usage and the collaboration timeline), **Nodes** (execution environments, their status and how many Sessions each holds), **Timers** (scheduled messages and scripts across all Sessions), **Webhooks** (configured inbound webhooks and their recent deliveries) and **Usage** (model requests, tokens and recorded cost across the installation). The Sidebar answers which Session to enter; System is diagnostic and administrative.

## Key Exports

- `SystemView` — owns the bounded Session catalog, Node directory, Agent registry, section switching and filters; renders the six sections. `SystemSection` / `SYSTEM_SECTIONS` name them.
- `SessionFilterBar`, `SessionRows`, `SystemSessionsList`, `SessionInspector` (`SystemSessions.tsx`) — Sessions list controls, rows, the list/detail split and the inspector; the inspector lists [running background commands](./webui-running-commands.md#running-background-commands) with Stop when the row's `runningExecs` count is nonzero.
- `SystemAgents` — Agents section ([webui-system-agents](./webui-system-agents.md)).
- `SystemSplit`, `useSystemSplit` (`SystemSplit.tsx`) — the shared list/detail layout ([layout](#list-and-detail-layout)).
- `SystemNodes` ([webui-nodes](./webui-nodes.md)) — Nodes section.
- `SystemTimers`, `SessionTimersSection` (`SystemTimers.tsx`) — Timers section and the Session inspector's Timers section; `systemTimers.ts` owns their pure list projection, filters, ordering and edit-request building.
- `SystemWebhooks` (`SystemWebhooks.tsx`) — read-only Webhooks section; `systemWebhooks.ts` owns its labels, outcome tones, loopback-address check and ordering.
- `SystemUsage` (`SystemUsage.tsx`) — Usage section; `usageOverview.ts` owns the `/api/usage` contract types, local-time period boundaries, group labels and chart series; `useUsageReport.ts` owns report loading, the `usage-changed` refresh and the local-midnight clock shared with the status bar Total.
- `UsagePie` and formatting helpers (`SystemShared.tsx`).
- `getArchitectureSessionNodeId(session)` — effective placement: an active tool's exact execution node, otherwise the Session's current node, otherwise `master`.
- `getArchitectureSessionModel(session)` — model in use, otherwise the configured model.
- `filterArchitectureSessions(sessions, filter, query, { nodeId, model })` — canonical runtime-state filter, effective-node and model filters, and cross-field search.

## Behavior

### Page and navigation

- Header: title System, a per-section subtitle and the Agents | Sessions | Nodes | Timers | Usage | Activity switch, with Webhooks last once a webhook exists or when a route opens that section ([D-webui-system-webhooks](#d-webui-system-webhooks)). The Agents subtitle is "Agent workspaces, inheritance and memory." There is no global summary-card row; each section shows only its own summary (Agents: count; Sessions: active / waiting / queued, which also set the status filter; Nodes: Online / Total; Timers: timers / paused / failing; Webhooks: webhooks / need attention; Usage: cost, tokens and requests for the chosen period).
- Phones (root viewport below 768 px, outside a Workbench tab header) use the [mobile page header](../threads/webui-mobile-shell.md#d-mobile-shell-presentation) instead: a circular Back action, the title System, the header badges and the section switch, over content that scrolls beneath it. The switch keeps every section in one row that scrolls sideways and brings the selected section into view; the page itself never scrolls sideways. The scroller clears the shell's bottom safe band. The per-section subtitle is desktop only; Agents has no separate registry heading on either layout. Section grids, filter rows and inspectors stack in one column at that width. [2026-11-22, user request] Crossing 768 px restyles the page in place: the open section, its modals (such as New nodes) and their local state stay mounted; `nodeOnboarding.e2e.mjs` checks this with the modal open.
- The Workbench tab keeps its persisted identity `system:agents` / type `agents` and stores the current `section`; App writes section changes back through `updateTab`, so reload restores the section. The tab title is System.
- Entry points: the Sidebar and mobile Workspace tools "System" button; `#agents`, `#architecture`, `#system` (System tab, current section); `#nodes`, `#tab/system:nodes` and the status-bar Open Nodes action (System on Nodes); `#timers` (System on Timers); `#webhooks` (System on Webhooks); `#usage` and the status-bar Total's "Open in System › Usage" (System on Usage, the latter with its period); the Session inspector's "View in Timers" (Timers filtered to that Session). The former `system:nodes` route settles on `#tab/system:agents`.
- Saved layouts are normalized on read: a former `nodes` tab becomes the System tab with `section: 'nodes'` in the same pane position, or is dropped when a System tab already exists. No layout reset or storage version change.
- Popup leaves: `agents` opens System, `nodes` opens System on Nodes. Moving the System tab to a new window uses the `nodes` leaf when it is on Nodes. Sections switch in place inside popup and embedded leaves.
- The Sessions Timeline renders [the session sequence view](./webui-session-sequence.md), lazily loaded because it shares Chat rendering pieces; it does not use the bounded catalog window.
- The sole-tab title/actions row uses the shared [empty-header pane movement](./webui-workbench.md#d-workbench-pane-drag) boundary.
- Cached/Input/Output rows and percentages use the shared [TokenUsageDetails](./webui-token-usage-details.md) renderer.

### List and detail layout

[2026-11-27, user decision, direction A of the System redesign] Agents, Sessions (List), Timers and Webhooks are split views: a compact list and an always-visible detail pane for the selection.

- On desktop the System header (title, subtitle, section switch) stays put and only the content below it scrolls (`data-system-scroll`). In a split section the list and the detail pane fill that area and scroll separately (`data-system-pane-scroll="list|detail"`), so selecting a row far down a long list shows its details at the top of the detail pane without moving the list. Usage, Activity, Nodes and the Sessions Timeline scroll as one page below the header.
- A scroll pane clips at its edges, and list rows sit flush with them so they align with the toolbar above. A row's selection and focus decoration is therefore drawn inside its own box: in-box borders (Timers, Webhooks), an inset ring (Agents) or a background with an inset focus ring (Sessions), never an outset ring or shadow.
- The layout follows the width of the section's own pane, not the viewport (`useSystemSplit` observes it with a `ResizeObserver` through a callback ref, because the wide and narrow trees have different roots). Below 760 px (`SYSTEM_SPLIT_MIN_WIDTH`), and always on phones, the section shows the list alone; selecting a row opens its details as a page (`data-system-split-layout="detail"`) that starts at its top, with a Back link (`data-system-split-back`) that returns to the list at its previous scroll position. Selection highlights are not shown on the narrow list.
- Entry points that target a selection (`agentRequest`, the Agent inspector's Session links, Nodes, Timers and Webhooks links into Sessions) also open the details page on a narrow pane.
- Opening a file in Code replaces the System tab's content. The inspected Agent and its tab are kept in module memory while System is unmounted, and an `agentRequest` applies once (by nonce), so returning restores the Agent rather than replaying the request.

### Bounded catalog ownership

- System owns `/session-list/architecture`, `/session-list/children`, and exact `/session-list/by-id` requests; it never accepts an all-session array prop or performs the legacy global Session fetch.
- It retains atomic root/branch replay, shared presentation-revision fencing, per-row HTTP/SSE epochs, forced bounded focus paths, agent-owned forests, row pruning, and exact loaded-row realtime subscriptions.
- Section summaries and the global usage pie use backend-maintained catalog summaries even though the browser holds only a bounded window; the Sessions list states how many loaded rows match.
- Loading more roots extends the bounded window by 50. Selecting a session can materialize its child relationship window through the fixed children API; the inspector can continue that relationship window.

### Sessions list and inspector

- List and Timeline views. The list shows loaded Sessions, newest activity first, one compact row each: state dot, short name (the ID part after the Agent), current/archived marks, runtime state text with duration while working, a failed request in the danger tone, or the queue length, Agent, effective Node when not `master`, child mark, and last activity time; Open enters the Session. Its footer states how many loaded rows match, the catalog total and "Load 50 more root sessions", which extends the window.
- Filters: search (ID/name, Agent, effective node, model, active tool, wait kind), status (all, active, waiting, queued), Agent (backend-owned, reloads the window), effective node and model (local over loaded rows). The trailing global usage pie uses catalog summary totals and is labelled Conversation turns; its popover states that it covers conversation turns of existing sessions and that System › Usage counts every model request.
- The global usage pie splits cached/input/output tokens and opens a viewport-bounded detail popover. Rows carry no usage pies; the inspector shows the Session's tokens.
- Clicking a row inspects it in the detail pane without navigation; Open enters the Session. The inspector shows runtime state/phase/model/queue, active tool and arguments, wait condition, Agent/node/CWD, messages/activity/tokens and parent/child relationships.
- The current Session is exact-loaded and initially inspected. A one-second clock runs only while a loaded Session is actively working.

### Nodes section

- A table of real directory Nodes plus rows for placement IDs outside the directory (Unavailable): name (with the ID in mono only when it differs, and a protocol explanation under it when there is one), status (Online/Offline, with separate Unavailable and Upgrade required warnings beside it), type (only when it differs from both), last seen, Sessions and a row menu. Below 640 px of pane width (and on phones) it becomes a list of compact rows. There are no Session lists: the Sessions cell shows the Node's count from the architecture payload's `nodeCounts` (every Session per stored current Node, from the catalog) plus the active ones among loaded rows, and opens Sessions (List) filtered to that Node. The Sidebar's Node grouping is the place to browse Sessions by Node.
- A row expands (`data-node-details`) to its service versions. Nodes with managed credentials have a row menu (the shared `ContextMenu` with a "More actions for {name}" trigger, `data-node-menu`) with Start command (CLI and Shell Nodes) and Delete, which open the existing Node actions dialog. Directory, pending-approval and onboarding ownership are in [webui-nodes](./webui-nodes.md).

### Timers section

- Lists every ordinary timer from `GET /api/timers` (internal wait timeouts excluded): action icon and summary (message text, inline script first line or script file), state (Scheduled, Paused, Not scheduled), schedule (cron with next run, or one-time time, in local time with a relative hint), owner Session and the latest result. Order: scheduled by next run, then unscheduled, then paused.
- Filters: search (ID, owner ID/name, message, cron, script code/file/Node, new-Session Agent/prefix), Agent (owner's catalog Agent, falling back to the ID prefix), action (Message, ToolScript), state (Scheduled, Paused, Last run failed, Not scheduled), and a removable Session chip set by the inspector link. Owner names and Agents come from the exact `/session-list/by-id` lookup.
- The inspector shows schedule (repeats/once, next run, last fired), owner (inspect in Sessions when loaded, otherwise open; separate open action), Agent, action, target (owner Session, new Session with Agent/prefix, or the owner for scripts), script file/source Node/timeout/inline code or the full message, and the recent results with errors. A result's run ID opens the run's diagnostics (`get_toolscript_run` projection) in the JSON inspector.
- Actions: Pause/Resume; Edit (schedule kept, cron, date-time or delay; message for message timers, or the complete script settings as JSON for ToolScript timers), validated again by `update_timer`; Delete after an inline confirmation. A paused one-time timer past its time notes that resuming fires it once. There is no run-now action.
- Live updates: the section and the inspector's Timers list reload (debounced) on the realtime `timers-changed` event and on socket reopen; no polling. A 30-second clock refreshes relative times only while mounted.
- The Session inspector's Timers section lists up to five of that Session's timers from `GET /api/timers?sessionId=` with a "View in Timers" link.
- Narrow panes and phones open the inspector as a details page ([layout](#list-and-detail-layout)) without horizontal overflow.

### Usage section

- Reads installation-wide usage from `GET /api/usage` ([usage ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger)): every recorded successful model request of every purpose, including deleted Sessions. It does not use the bounded Session catalog or Session stats, which count normal turns of current Sessions only.
- Period: Today (hourly buckets), This week (Monday start), This month, or a Custom inclusive date range of up to 400 days (daily buckets). The browser computes the local-time boundaries, so day and week edges follow the viewer's time zone; daylight-saving repeats collapse to strictly increasing boundaries. The choice persists in `localStorage` and moves with the local date at midnight.
- Group by Agent, Session tree, Session, Model, Provider or Purpose. Purpose rows use product labels (Conversation turns, Context compaction, Session titles, Side questions, ToolScript model calls, Setup checks, Command line, Other requests, and Older conversation turns for the legacy `normal` key) with the recorded key as detail. Requests outside any Session form "Outside sessions"; Session requests whose Agent cannot be attributed form "Unattributed sessions"; deleted Sessions are pooled as "Deleted sessions" under the Agent their Archive records. Agents are attributed when the report is read: a moved Session's usage follows its current Agent. Clicking an Agent row filters to that Agent and switches to Session trees, whose roots are then that Agent's own top Sessions rather than another Agent's coordinator; Session rows open their Session.
- Summary cards: recorded estimated cost (with the count of requests that have no price), tokens with the shared [TokenUsageDetails](./webui-token-usage-details.md) breakdown, and model requests. A stacked bar chart shows cost (or tokens) per bucket for the largest groups plus Other; groups with nothing to draw stay out of the legend. The table lists up to 100 groups ordered by cost, then tokens. A group without any priced request shows "Tokens only"; a partly priced group marks its cost.
- Phones keep the same tables in their own horizontal scrollers, not the page: the first column takes the room the figures leave, truncates its labels above a 7 rem minimum and stays in view while the figures scroll; the cost heading reads Cost. Desktop keeps the fixed column widths and the share bar. The chart labels at most six buckets on a phone.
- Requests recorded before pricing was configured stay tokens-only; no current price is applied to them ([D-model-usage-cost](../threads/model-request-and-streaming.md#d-model-usage-cost)). While the startup backfill is still adding older requests the section says so; when records start after the period's first day it shows when they begin.
- Live updates: reloads (debounced) on the realtime `usage-changed` event and on socket reopen; no polling. The previous report stays visible, dimmed, until a new selection's report arrives. A failed or malformed response shows an inline error with Retry.

### Activity section

- Reads `POST /api/activity` from the [activity index](./activity-index.md): calls from every Session, unattended timer/webhook scripts and external MCP clients, newest first, 100 per page with "Show earlier activity".
- Defaults to the last 7 days and **Changes**, which hides reads, internal calls and script containers; the kind menu offers All calls, each kind, or Reads. Further filters: result (Not completed, Completed, Failed, Denied by a rule, Approval rejected, Approval expired, Cancelled), source (Session turns, Timer scripts, Webhook scripts, External MCP clients) and a debounced search over summaries and tool names.
- Lists from 960 px show columns: time, Session (title, execution-time and current Agent, deleted mark), Node, call (tool with MCP server and action, "in script" for ToolScript calls, argument summary), result with approval status, and who started the turn. Narrower lists (down to 390 px) stack each call. Labels come from `activity.ts`. Clicking a Session, Agent, Node or tool adds a removable filter chip. Open jumps to the call's row in its Session (`openSessionAtSeq`). The list width is measured before the first paint and a zero width is ignored, so a newly opened section never draws the column table in a narrow pane first.
- Expanding a row shows the recorded detail: arguments, tool, Node, cwd, files, exec ID, deliveries, rules, approval, error, both Agents, script run, duration.
- The Session inspector links to the selected Session tree's activity ("View activity"). `#activity` opens the section.
- Live updates: `activity-changed` and socket reopen (debounced) refetch the first page and merge it above loaded rows (`mergeActivity`), keeping earlier pages; a filter change starts over. No polling. It notes when older history is still being indexed.

### Agents section

Owned by [webui-system-agents](./webui-system-agents.md): the creator-tree list and the Agent inspector with its Overview, Prompt, Rules and Settings tabs.

## Phone layout verification

`mainHostSystemMobile.e2e.mjs` opens every section over a real Main host at 360×780, 390×844 and 844×390 with touch, in light and dark themes, with long Session, Agent, timer and webhook names, priced, unpriced and redacted usage and a recorded tool call. It fails when any visible element reaches past the viewport outside a horizontal scroller, when the System scroller scrolls sideways, or when the selected section tab is clipped; for both Usage tables it checks that the scroller fits the viewport, the first column is at least 100 px and does not move when the table scrolls to its end, and the first row starts below the header. On Agents it checks that the section subtitle appears only in the desktop header, that there is no separate registry heading, and that the allowlist Agent's row shows it; at 390×844 it opens an Agent and a Session as details pages that start below the header and returns with Back. It then checks the desktop layout at 1500 px. `FOXWARM_SYSTEM_SCREENSHOT_DIR` saves screenshots.

`mainHostSystemLayout.e2e.mjs` checks the split layout at 1600 and 1100 px (selecting the last row of a 30-Session list keeps the tabs, the selected row and the inspector header in view while only the list scrolls), the creator-tree order, that the selected and keyboard-focused first Agent row draws its ring inside the list pane's client box, the Prompt layers (framework prompt dialog for a model-dependent prompt, Create in Code writing the empty installation file and opening Code) and the Rules layers (installation and creator layers read-only, a server rejection shown inline with the layer unchanged, a save that replaces the layer, Edit in Setup opening Authorization).

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

[2026-11-26, user decision 2 on the OOBE review] Most installations have no webhook, so the Webhooks tab is hidden until `GET /api/webhooks` lists one; it is then the last tab. `#webhooks` and the Setup › Config link still open the section, which shows the tab while it is selected.

### D-webui-system-activity

[2026-11-09, user decision] Audit is a seventh, administrator-only System section, Activity, over the derived [activity index](./activity-index.md#d-activity-index). It defaults to changes, shows execution-time and current Agent, rule IDs and the WebUI sender, links each call to its Session, and has no cost, alerting or compliance features.

### D-webui-system-usage

[2026-11-09, user decision] Installation usage is a read-only System section, Usage, backed by the journal's derived [usage ledger](../threads/llm-request-journal.md#d-llm-request-journal-usage-ledger) rather than Session stats: all request purposes count and are labelled by purpose; grouping by Agent, Session tree, Session, model, provider and purpose with daily (hourly for today) buckets; periods today, this week, this month and a custom range. There are no budgets, limits or usage configuration. Recorded costs are shown as recorded; requests from before pricing show tokens only. The status bar Total uses the same ledger for a selectable period ([TokenUsageDetails](./webui-token-usage-details.md)); Session usage pies stay per-Session. The route is administrator-only.

### D-webui-system-timers

[2026-11-07, user decision] Global timers are a fourth System section, Agents | Sessions | Nodes | Timers, rather than a separate page, and the Session inspector shows that Session's timers with a link into the section. The section offers the read-only list, recent results, pause/resume, edit and delete; run-now was deliberately not included. Changes go through the timer tools' own operations ([timer persistence](./tasks-timers.md#d-timers-pause-and-recent-runs)); the routes are administrator-only. Refresh is event-driven over the existing realtime list subscription instead of polling.

### D-webui-system-split-view

[2026-11-27, user decision] System is reorganized for acting rather than reading (direction A of the redesign prototypes). Rows carry only what a user needs to pick the right item: Agents as a creator tree with rule state, memory source, start Node, Session count and last activity; Sessions as one compact line each; Nodes as a table with a Session count instead of Session lists. Details live in an inspector that is always visible beside the list on a wide pane and is a separate page with Back on a narrow pane or phone, chosen by pane width so split Workbench panes behave like small windows. The System header stays fixed. The Agent inspector shows the prompt chain (framework → installation additions → inherited memory → own memory, files opening in Code; the framework prompt in a read-only dialog because it is not an installation file) and the rule chain (installation policy → creator ancestors, read-only with who may change them → the Agent's own layer, edited as YAML and saved through the existing Agent rules API). The alternatives, full-width tables with a closable side sheet and a full Agent page, were not chosen. Timers and Webhooks use the same split.

### D-webui-system-page

[2026-11-03, user decision] The former System Architecture page and the standalone Nodes page become one **System** page with Agents | Sessions | Nodes; Tasks stays a separate page. Topology is removed: its filters, search, usage pie and inspector move to Sessions, and per-Node Session placement moves to Nodes (Session lists under Nodes were later replaced by counts, [D-webui-system-split-view](#d-webui-system-split-view)). The global summary row is replaced by per-section summaries. Former entry points (Nodes tab, hashes, status bar, popup leaf, saved layouts) open System on the right section by read-old/write-new normalization. This supersedes [D-webui-nodes-workbench](./webui-nodes.md#d-webui-nodes-workbench).

### D-webui-architecture-operational-topology

[2026-08-25; the node-lane layout is superseded by [D-webui-system-page](#d-webui-system-page), the placement and inspector rationale still applies] Architecture answers how Foxwarm is organized and running; Sidebar answers which Session the user wants to enter. Architecture therefore uses effective execution-node lanes plus a diagnostic entity inspector instead of a second recursive session-navigation tree. Keep current/active rows visible, preserve bounded backend ownership, cap expanded node bodies with local scrolling, and make navigation an explicit secondary action. This distinction prevents duplicated branch-order/collapse behavior while exposing placement, queue, wait, tool, model, token, and relationship information that Sidebar does not provide.

## Workbench header integration

The normal sole-tab header close/icon controls use [Single-tab headers](./webui-workbench.md#single-tab-headers). Standalone and embedded leaf roots retain their existing navigation and do not own Workbench tabs.
