# Behavior: Workbench and Chat

For developers and Agents changing browser navigation, pane layouts, Chat reading, Code, or Terminal. A tab record, a mounted component, a backend Session, a Code iframe, and a PTY have different lifetimes. Layout visibility is not a command to stop background work.

## Tabs select surfaces; panes arrange them

The Workbench keeps browser-local tab records, each pane's ordered tabs and active selection, focused pane, split sizes, and collapse state. Reload restores the supported layout, not a snapshot of every component or runtime. Chat drafts, reader positions, Code preferences, and backend state have their own owners.

| Action | Visible/state effect | Resource consequence |
| --- | --- | --- |
| Select a Session normally | Activates an existing kept Chat, or replaces/creates the reusable preview Chat. | Does not create another backend Session or run a model turn. Replaced Chat releases its mounted view. |
| Keep a preview | Clears its preview/reuse flag, retaining the same canonical `chat:<sessionId>` tab identity. | Does not fork history, duplicate a Session, or make the component permanently mounted. |
| Drag an ordinary preview tab / Session into a kept placement | Uses existing tab docking/selection and promotes the preview where applicable. | Same underlying Session; no runtime move. |
| Split, resize, move a tab, or dock a whole pane | Changes geometry and current pane context. A still-visible tab keeps its content instance. | No fresh Chat subscription/bootstrap, PTY, or iframe merely because its pane changed. |
| Collapse | Retains tab records, selection, and recorded expansion size; shows compact chrome and releases space. Selecting a collapsed tab expands it. | Ordinary contents unmount; Terminal detaches without deleting its PTY. Started Code and open History instances remain hidden. |
| Close Chat | Removes its browser tab and mounted view, navigating to a surviving tab or empty Workbench. | Does not delete the Session, stop its Agent, clear history, or cancel exec. |
| Close Terminal | Invokes the explicit backend terminal-delete lifecycle, then removes the tab. | Distinct from hiding, transport loss, reload, or collapse. |
| Close Code | Destroys its embedded iframe and resets the bridge lifecycle. | Reopening creates a fresh iframe, not the old browser workbench instance. Backend terminal survival is separate. |
| Move to new window | On successful popup open, removes the source through layout-only removal. A blocked popup leaves it intact. | A new independent leaf window, not shared component state; Terminal reattaches rather than deleting its PTY. Code launches a fresh standalone Code workbench. |

Whole-pane movement preserves the pane's ID, ordered tabs, active tab, collapse state, and preview flags; it does not Keep previews or merge panes through a center drop. Ordinary tab movement remains a different action. A pane's collapse direction follows its direct split parent. Close-pane behavior is not synonymous with collapsing: a terminal-only pane closes its terminals through the delete path; mixed panes retain their ordinary tab-migration behavior. See [Workbench actions](../units/webui-workbench.md), [pane movement](../units/webui-workbench.md#d-workbench-pane-drag), and [Terminal panel](../units/webui-workbench.md#d-workbench-terminal-panel).

Preview is a reuse policy, not an unsaved Session or disposable history. Canonical preview tabs survive reload alongside kept tabs. Tab-level pinning is removed; Session-list pinning is a different feature. Agents, Setup, Logs, Tasks, and Nodes use singleton tabs; independent History instances retain their own queries/results. Forced initial Setup cannot close until configuration is sufficient. Unsupported former workspace/file tabs are discarded during restore; Code is the editing integration. Owners: [Workbench persistence](../units/webui-workbench.md) and [App](../units/webui-app.md).

## Mounted, visible, and running are independent

**Governing lifetime distinction; directly clarified for tabs, Code and Terminal.** Hiding/rearranging a surface must not silently recreate its component or terminate its backend work. Stable hosts, visibility admission and explicit Close handling are derived mechanisms; their DOM or layout implementation is not another resource owner.

A pane can have several tab records but show only its active tab. Desktop split panes may show several Chats at once. Each mounted Chat owns its own synchronization/subscription, while the page shares the physical realtime transport. A list/status update is not a replacement for that Chat's exact runtime state.

| Surface | When genuinely hidden/inactive/collapsed | When merely moved/resized while visible |
| --- | --- | --- |
| Chat and ordinary tabs | Unmount their content. Draft/File ownership and stored reader state retain their separately defined lifetimes. | Preserve component/DOM identity, loaded rows/disclosures, draft, reader intent, and logical subscription. |
| History viewer | Every open instance remains mounted but hidden/inert, preserving its independent search/results/reader state. | Same instance at the new pane geometry. |
| Embedded Code | Does not start until first actual visibility in an expanded displayed pane. Once started, keeps its iframe hidden/inert across inactivity, collapse, or mobile list hiding. | Same iframe browsing context and workbench state; no reload/reparenting. |
| Terminal | Browser component/socket cleanup detaches; backend PTY may continue. | Same mounted emulator and attachment; fitting/resizing changes terminal dimensions. |

Mobile list hiding is semantic hiding for ordinary tabs, not a pane move. Temporary removal/replacement of a layout slot is geometry only and must not be mistaken for semantic hiding or Close. Hidden retained hosts cannot take pointer input or focus. One tab's render error is contained to that tab with explicit Retry/Close; moving it does not reset the failure or start an automatic retry loop. See [stable content ownership](../units/webui-workbench-content.md#d-workbench-stable-content).

Changing another pane's subscriptions does not start a new lifetime for a Chat that remains subscribed. A temporary command reply already buffered for that retained Chat remains eligible for delivery after the current initialization snapshots, even when a newer subscription revision supersedes the earlier initialization. Unlike canonical messages, these replies have no history row from which to recover. This is an in-process subscription rule, not durable replay through disconnect, page refresh, or process loss. [Multiplexed realtime](../threads/streaming-pipeline.md#d-webui-multiplexed-realtime) owns revision/buffer ordering; [temporary command rows](../threads/streaming-pipeline.md#d-streaming-optimistic-message-identity) retain their browser-local lifetime.

None of these browser states establishes backend completion. Unmounting Chat ends that browser subscription, not the Session's turn, timers, background exec, or tool effects. A kept tab is not a background Agent supervisor, and a visible idle Terminal is not proof a model tool completed. Turn/process/wait meanings stay in [execution and waiting](./execution-and-waiting.md).

## Navigation must not recreate what the user just closed

Explicit Session navigation and passive metadata/route synchronization are different events. Desktop target selection prepares bounded initial history before replacing the outgoing Chat/preview: the old body remains visible but inert, with a delayed Opening indicator for slow reads. A later selection cancels the previous intent; late responses cannot select the abandoned target. Failure falls back to normal Chat loading/error handling, not an invented successful view. This handoff is not all-Session prefetch, a persistent whole-history cache, or a second subscriber.

Explicit navigation activates/expands the target and reveals its tab even when it was already selected offscreen. Manual tab-strip scrolling remains through metadata changes, pane focus, split resizing, or closing an inactive tab. Route hydration responds to actual route/target changes rather than treating ordinary title/focus updates as new navigation. Closing or replacing a routed tab fences the old route so it cannot immediately recreate the closed tab; bulk close applies normal per-tab lifecycle and publishes a surviving destination or empty route. See [prepared Session navigation](../threads/webui-session-navigation.md), [tab-strip navigation](../units/webui-workbench.md#d-workbench-tab-navigation), and [route-close coordination](../units/webui-app.md#d-webui-app-route-close).

Popout windows do not mount/persist the full Workbench or synchronize state back; closing them does not restore the source tab. Setup/Agents popout warns about unsaved component state. Chat can restore its browser-persisted draft metadata, but page-memory Files are not transferred. Terminal popout is unavailable before a backend terminal ID exists. URLs preserve the current deployment path; authentication tokens do not travel in popup target parameters. Popup and Code-embedded leaf roots have their own lifetimes and do not acquire Workbench pane controls.

## Chat follows user intent, not incoming token volume

**Governing interaction constraint; directly requested and repeatedly clarified.** Reading and explicit navigation outrank passive output/reflow. Follow latches, anchors and disclosure measurement implement that intent; tests of a geometry workaround cannot replace the user's selected behavior.

Follow is a reader state, not a runtime state. At the actual bottom, new content follows. Explicit upward navigation detaches follow; downward scrolling while still away from the bottom stays detached. Token growth, disclosure animation, image/layout growth, and viewport resizing must not override that intent. Rejoin happens at the actual bottom or through the explicit latest/bottom action.

| Event | Reader consequence |
| --- | --- |
| New assistant text while detached | Does not force the reader to the tail. A follow/latest action remains available. |
| Split/pane resize or ordinary layout growth | Preserves current bottom-follow or local anchor; it is not new user navigation. New user scroll input takes priority over pending correction. |
| Disclosure expansion while detached | Preserves scrollTop subject to unavoidable native clamp when content shrinks. |
| Manual expansion of a tall card while following | Can detach to keep the card's heading readable rather than jumping into its distant bottom. Later growth/resize cannot silently reattach. |
| Switch away and return | Restores an ephemeral bottom-or-message-anchor state keyed by canonical Session and history mode. It is not a persisted page copy or local-storage scroll log. |
| Return to latest across unloaded history | Loads the recent window rather than draining every missing historical page. |

The detailed viewport rules remain in [Chat follow intent](../units/webui-chat.md#d-chat-user-follow-intent), [tall-card behavior](../units/webui-chat.md#d-chat-tall-card-follow), and [ephemeral viewport state](../units/webui-chat.md#d-chat-ephemeral-viewport). History projection, loaded/mounted windows, Search scope, and model-context differences belong to [conversation and history](./conversation-and-history.md); do not infer them from how far the scrollbar moved.

[Composer draft and attachment ownership](files-images-and-attachments.md#from-draft-to-retained-input) persists metadata by Session, but browser File bytes remain page-local; an accepted send clears only its submitted owner, while rejection/unmount retains it. [Sending while the Agent is busy](messages-and-turns.md#what-happens-when-input-arrives-while-the-session-is-busy) does not clear an independent in-progress model draft. Those lifetimes are separate from bottom-follow, optimistic message display, and turn completion. See [composer ownership](../units/webui-chat-composer.md#d-composer-session-draft-lifetimes) and [active draft send](../units/webui-chat.md#d-webui-active-draft-send).

Published charts, figures, and interactive previews have their own [authored-data and publication boundary](files-images-and-attachments.md#published-content-is-application-data), not the conversation Message projection or the lifetime of an editor file.

## Code and Terminal do not inherit arbitrary Chat authority

Code is an optional official browser workbench with a persistent embedded multi-root workspace. Opening later folders/files through its fixed bridge does not replace the iframe or discard existing editors. Filesystem resources identify an explicit Node and absolute POSIX path; tool-result actions use the operation's actual resolved path/Node rather than a later Chat selection. Remote filesystem, Git, and PTY require their corresponding versioned services. The Code launcher preference is browser-local; it is not the [Session execution Node](nodes-workspaces-and-permissions.md#selection-routes-operations-not-the-whole-session). Read-only SCM/commit viewing does not add staging/commit/push authority. See [Code integration](../threads/code-integration.md).

Terminal is an **interactive PTY**, not `exec` with a different renderer. It accepts keystrokes and terminal control sequences and retains a backend terminal ID/backlog. Model `exec` instead captures a command result/log with its own execution identity and completion semantics; closing a Terminal is not a way to cancel that exec, and an `execId` is not a terminal ID.

- Browser Terminal reuse requires an exact normalized Node/cwd target, not a Chat Session ID. Changing Chat selection does not relocate an existing terminal.
- Main launchers require the advertised relevant Code/PTY services. Offline, incompatible, and unavailable selected targets remain disabled/visible rather than silently becoming `master`. The Chat terminal launcher uses that Session's current Node/cwd.
- Reload, socket close, tab inactivity, and collapse detach from the backend PTY without deleting it. Explicit Close requests deletion. PTY exit is distinct from a disconnected browser.
- Unexpected disconnect keeps PID/Node metadata and offers manual Reconnect. There is no automatic reconnect loop. Reconnect reuses the remembered ID when present, fences stale sockets/listeners, and retains the existing lookup/list/create behavior if the terminal is missing. A closed/exited or disposed view must not create a replacement after an awaited lookup.
- Local and remote PTYs depend on their backend's lifecycle and availability; detachment is not a promise of survival through host shutdown or Provider destruction.

Terminal input/resize/backlog details belong to [browser Terminal](../units/webui-terminal.md) and [backend routing](../units/src-terminal-router.md). Code's fixed service paths are separate from model tool approval and do not grant runtime Agents extra filesystem rights. Scoped WebUI identity mode is a restricted Chat root, not a hidden full Workbench: it does not mount Code, Terminal, Setup, management, popup, or embedded administrator surfaces. See [WebUI access scope](../modules/webui.md#d-webui-identity-session-scope).
