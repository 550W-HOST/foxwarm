# Thread: Session sequence view

Shows recent activity of several Sessions side by side: each Session's input, assistant text and tool runs, and the deliveries between Sessions (messages, child creation, Task notifications) with their send and read times.

```text
Sender model message (committed, seq N) with tool calls
  -> SessionToolExecutor assigns deliverySeq from (N, call position, ToolScript subcall)
  -> SessionManager.SendAsync writes deliverySeq on the receiver wrapper
     and the sender records it in __meta.sessionMessages / subcall.sessionMessage
  -> Archive rows of both Sessions
  -> POST /api/session-sequence projects lanes, events and paired links on demand
  -> Architecture > Sequence renders time-bucketed Session columns and refreshes incrementally
```

## D-session-delivery-seq

[2026-11-02, user-approved format] Every inter-session delivery caused by a Session's model tool call carries a `deliverySeq` correlation ID derived from the sender's committed model message, so the sending call and the receiving message pair exactly.

- **Anchor:** the `seq` of the sender's committed model message that contains the delivering call. Turn hosts commit it before tool execution (`BeginBatch`); the later tool-result row does not exist yet when the receiver wrapper is committed, so it cannot be the anchor.
- **Format:** `<seq>` for a batch with exactly one call that is not a script call; `<seq>.<k>` for the k-th call (1-based batch position) otherwise, including a single-call `run_script` batch; ToolScript subcalls append their 1-based subcall position, `<seq>.<k>.<n>`. Position numbering is deterministic and restart-safe; no in-memory counter exists.
- **No model call:** a ToolScript slice without an anchoring model call (for example a timer-started run) uses `ts:<runId>.<n>`, where `n` is the 1-based subcall position across the whole run, kept in the persisted run record (`subCallTotal`) so it survives restart and continues across slices. Anchored slices keep slice-local `n` because each slice has its own anchor. User/WebUI-originated Task notifications and self-sends carry no ID.
- **Claude Code runtime:** each external tool request commits its own single-call model row before execution, so the same rule yields `<seq>` reliably.
- **Identity** is always `(sourceSessionId, deliverySeq)`; forks copy seqs, so the ID alone is not unique. Re-executing an interrupted batch may deliver twice with the same ID; the view shows both.
- **Placement:** an extra `deliverySeq` attribute on the receiver's `<foxwarm-message type="inter-agent">` and `type="task"` wrappers (after `sourceSessionId`), and a `deliverySeq` field in sender delivery evidence (`__meta.sessionMessages[]`, ToolScript `subcall.sessionMessage`). The model-visible change is that attribute only; trusted-wrapper parsing in the WebUI ignores unknown attributes.
- Covered sends: `send_to_session`, `create_child_session` initial message and Task assignment, and Task notifications caused by a Session's `task` call. The scope is an `AsyncLocal` set per attributed call and is applied only when the delivering source is the same Session.

## D-session-sequence-projection

[2026-11-02] `POST /api/session-sequence` is a read-only, on-demand projection; there is no derived table or persistent store. Measurements on a synthetic 2.2 GiB Archive did not require one (see the projection unit).

- **Selection:** catalog Sessions with `last_message_time >= since` or busy, newest first, bounded by `sessionLimit` (default 30, max 80); `focusSessionId` selects the collaboration component instead (parent/child relations, creators and peers seen in loaded deliveries); `sessionIds` selects exact lanes for incremental refresh.
- **Events:** `llm` (with bounded assistant text preview and `phase`; text rows without request timing are included) and `tool` (name, argument preview, status/error) items from each Session's own Archive rows only (fork lineage is not expanded), the window start found by binary search on `seq` because timestamps are monotonic per Session, newest `eventLimit` rows (default 400, max 2000) per Session. SQLite `json_extract` returns only small fields and bounded previews; tool outputs never leave the database. Details are read through the existing exact history routes when the user opens a Session.
- **Pairing:** exact by `(sourceSessionId, deliverySeq)`; older rows without an ID pair by source, target, wrapper send time (second resolution, ±3 s) and body prefix and are marked `pairing: "inferred"`. Wrapper `time` is the send time, the receiving row timestamp is the read time; sends not yet read are `state: "queued"` (receiver fully loaded) or `"unread"`.
- **Incremental refresh:** `after` maps Session IDs to the last seen `seq`; responses return `cursors`. Link keys are stable across both halves, so the client replaces a queued delivery when its read side arrives. Running work comes from catalog runtime state, not Archive.
- **Authorization:** administrators see everything. A scoped WebUI identity only gets lanes in its `access.identities.<id>.surfaces.webui.sessions` scope; any other endpoint becomes an opaque `external:<hmac>` peer without name, agent or content, and Task titles are omitted. The route is admitted for scoped identities in `WebUiAccess` and rechecks the binding after projection.

## D-session-sequence-view

[2026-11-02, revised after the first review] The view is the **Sequence** surface of System Architecture, beside Topology and Agents (the name avoids the Chat Timeline modes and Activity terms). It is a multi-column narrow timeline, not a sequence diagram: no proportional time scale and no lines between columns.

- **Columns:** one 300 px column per Session in parent/child tree order, with horizontal scrolling. The header shows the name and the current state (running / waiting / idle). There are no separate input lanes. Input from you appears in the receiving column as a one-line user bubble; channel, timer and other input appears as a compact system tag.
- **Items** reuse Chat primitives, without embedding a ChatTimeline:
  - Assistant text is a three-line preview. Commentary is muted, using the Conversation phase rule: an explicit phase wins, otherwise text in a request with tool calls is commentary.
  - Consecutive tool runs in a cell collapse into the counted tool-group summary (failures counted separately) and expand to tags with argument previews.
  - Running work shows a pulsing tag from runtime state.
  - Deliveries use the To/From session-message card with a three-line preview in both the sender's and the receiver's column. Child creation and Task events use the same card with a caption. A tool call shown as a card is not repeated as a tag.
- **Rows:** time buckets, one minute by default, coarsened (2, 5, 10 … 720 minutes) until at most 60 non-empty rows remain. Empty buckets are omitted, so idle time disappears. Each row begins with the quiet centered Chat time separator, and the row height is the tallest cell.
- **Correlation** needs no lines. Hovering or focusing either half of a delivery highlights the other half (same link key, exact or inferred) and shows how long it waited before it was read. Unread deliveries say so. Clicking an item opens its Session positioned at that message.
- **Scope:** 1h/6h/24h windows; "All active" or "Connected to <Session>", defaulting to the current Session's component. Live updates use the Session-list realtime subscription for loaded columns plus incremental requests.

## Owners and checks

- [Session sequence projection](../units/dotnet-session-sequence.md) owns `deliverySeq` assignment, the projection and the route.
- [Session sequence view](../units/webui-session-sequence.md) owns layout and rendering.
- [Session communication presentation](./session-communication-presentation.md) owns the communication cards that read the same wrappers.

## Open questions

- Whether the projection should later read Task store events (create/update/complete times) as separate events rather than only the notifications delivered to Sessions.
- Whether the user wants a dedicated workbench tab or a Session header entry in addition to the Architecture surface.
