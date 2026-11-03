# Thread: Session sequence view

Shows recent activity of several Sessions side by side: each Session's input, assistant text and tool runs, and the deliveries between Sessions (messages, child creation, Task notifications) with their send and read times.

```text
Sender model message (committed, seq N) with tool calls
  -> SessionToolExecutor assigns deliverySeq from (N, call position, ToolScript subcall)
  -> SessionManager.SendAsync writes deliverySeq on the receiver wrapper
     and the sender records it in __meta.sessionMessages / subcall.sessionMessage
  -> Archive rows of both Sessions
  -> POST /api/session-sequence projects lanes, events and paired links on demand
  -> System > Sessions > Timeline pages newest first, renders minute-bucketed Session columns
     and appends live rows incrementally
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

[2026-11-02, revised 2026-11-03 for newest-first paging, user decision] `POST /api/session-sequence` is a read-only, on-demand projection; there is no derived table, index or persistent store. Measurements on a synthetic 21-day Archive with 2,000 long-lived idle Sessions did not require one (see the projection unit).

- **Pages, newest first:** a request without `after` returns one page of rows older than the `before` cursor (the newest page when absent), merged across all visible Sessions in `(timestamp, sessionId, seq)` order. After `limit` rows (default 400, max 2000) the page completes its oldest minute, so a minute bucket is never split; the response carries `range` `{from, to}`, `next` (`{at}` at the minute boundary) and `hasMore`. Only a single minute holding more than four times the limit is split, with a full `{at, sessionId, seq}` row cursor.
- **Candidates:** a Session takes part at scan position T when T lies within the span of its own Archive rows, [first own row, last own row]. The span is cached in Main memory per Session: the first row never changes, and the last row is re-read only when the catalog's last-message time, busy flag or message count changed. The catalog's last-message time alone is not the upper bound, because it marks input and a turn's later rows can follow it by hours. Sessions join the k-way merge when the scan reaches their last row; a Session already open at the cursor starts from a binary search on `seq` (timestamps are monotonic per Session).
- **Events:** `llm` (with bounded assistant text preview and `phase`; text rows without request timing are included) and `tool` (name, argument preview, status/error) items from each Session's own Archive rows only (fork lineage is not expanded). SQLite `json_extract` returns only small fields and bounded previews; tool outputs never leave the database. Details are read through the existing exact history routes when the user opens a Session.
- **Pairing:** exact by `(sourceSessionId, deliverySeq)`; older rows without an ID pair by source, target, wrapper send time (second resolution, ±3 s) and body prefix and are marked `pairing: "inferred"`. Wrapper `time` is the send time, the receiving row timestamp is the read time; a send whose read half is not in the response is `state: "queued"` (receiver visible; newer pages load first, so it has not been read) or `"unread"`. A read half whose sending row lies before the page is marked `pending: "older"`; both halves share one link key, so the client completes the link when that page loads.
- **Live append:** `after` (Session ID to last seen `seq`) with `since` returns rows after each cursor plus Sessions without a cursor that have rows at or after `since`; responses return `cursors`. Running work comes from catalog runtime state, not Archive.
- **Authorization:** administrators see everything. A scoped WebUI identity only gets lanes in its `access.identities.<id>.surfaces.webui.sessions` scope; any other endpoint becomes an opaque `external:<hmac>` peer without name, agent or content, and Task titles are omitted. The route is admitted for scoped identities in `WebUiAccess` and rechecks the binding after projection.

## D-session-sequence-view

[2026-11-02, revised after the first review; scrolling and columns revised 2026-11-03 by user decision] The view is the Timeline of the System page's Sessions section (it was first the Sequence surface of System Architecture; the System restructure of 2026-11-03 moved it). It is a multi-column narrow timeline, not a sequence diagram: no proportional time scale and no lines between columns.

- **Columns:** one 300 px column per Session in parent/child tree order, with horizontal scrolling. Columns are dynamic: a Session's column appears when it has items within one viewport of the visible rows and disappears only when it has none within two viewports (hysteresis). Width changes animate, and the first column in view keeps its horizontal position when others are inserted or removed. When the Timeline is opened from a Session, that Session is pinned as the first column and never removed. The header shows the name and the current state (running / waiting / idle). There are no separate input lanes. Input from you appears in the receiving column as a one-line user bubble; channel, timer and other input appears as a compact system tag.
- **Items** reuse Chat primitives, without embedding a ChatTimeline:
  - Assistant text is a three-line preview. Commentary is muted, using the Conversation phase rule: an explicit phase wins, otherwise text in a request with tool calls is commentary.
  - Consecutive tool runs in a cell collapse into the counted tool-group summary (failures counted separately) and expand to tags with argument previews.
  - Running work shows a pulsing tag from runtime state.
  - Deliveries use the To/From session-message card with a three-line preview in both the sender's and the receiver's column. Task events use the same card with a caption. A child creation merges with its initial message or Task assignment into one "New session" card on both sides, which keeps that delivery's pairing and open-at-message target; a creation without a message stays a plain "New session" card. A tool call shown as a card is not repeated as a tag.
- **Rows:** fixed one-minute local-time buckets. Empty buckets are omitted, so idle time disappears. Each row begins with the quiet centered Chat time separator, and the row height is the tallest cell. Rows are virtualized (the viewport plus one viewport above and below); unmeasured rows use an estimate.
- **Scrolling:** the Timeline opens at the newest activity and follows new items only while the user stays at the bottom, using the Chat follow-intent rule (wheel, keys, touch or scrollbar drag away from the bottom leave it; returning to the bottom rejoins). Older pages load as the top comes near, keeping the first visible row at the same screen position; the next load is decided from that kept position, so one approach to the top loads one page. With several pages that add nothing to show (for example under Connected), automatic loading pauses behind a "Load earlier activity" button. Distant older pages are dropped once the user returns to the newest activity. There are no time-window presets.
- **Correlation** needs no lines. Hovering or focusing either half of a delivery highlights the other half (same link key, exact or inferred) and shows how long it waited before it was read. Unread deliveries say so. Clicking an item opens its Session positioned at that message.
- **Scope:** "All" or "Connected to <Session>" (the pinned Session plus Sessions that exchanged deliveries, creation or Tasks with it within the loaded range), defaulting to Connected when opened from a Session. Live updates use the Session-list realtime subscription for loaded columns, Session-list change notices and a slow visible refresh, each scheduling one coalesced `after` request.

## Owners and checks

- [Session sequence projection](../units/dotnet-session-sequence.md) owns `deliverySeq` assignment, the projection and the route.
- [Session sequence view](../units/webui-session-sequence.md) owns layout and rendering.
- [Session communication presentation](./session-communication-presentation.md) owns the communication cards that read the same wrappers.

## Open questions

- Whether the projection should later read Task store events (create/update/complete times) as separate events rather than only the notifications delivered to Sessions.
- Whether the user wants a dedicated workbench tab or a Session header entry in addition to the System Timeline.
