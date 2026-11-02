# Unit: webui-session-sequence

Files: packages/webui/src/sessionSequence.ts, packages/webui/src/components/SessionSequenceView.tsx, packages/webui/src/components/useSequencePaging.ts, packages/webui/src/components/SessionSequenceItems.tsx, packages/webui/test/sessionSequence.test.mjs, packages/webui/test/mainHostSessionSequence.e2e.mjs
Secondary files: packages/webui/src/components/SystemView.tsx, packages/webui/src/chatViewportState.ts, packages/webui/src/realtime.ts, packages/webui/src/components/SessionMessageCard.tsx, packages/webui/src/components/ToolTimelineItems.tsx, packages/webui/src/components/timelineTime.ts

## Purpose

Renders the System Sessions **Timeline** defined by [D-session-sequence-view](../threads/session-sequence-view.md#d-session-sequence-view) over `POST /api/session-sequence`.

## Function index

| Symbol | Responsibility |
|---|---|
| `mergeSequenceData` | Merge an older page or a live update: keyed events/links, the two halves of a delivery from different pages or responses joined (send anchor and read time kept, `pending` cleared), widened row bounds, advanced cursors |
| `liveSequenceEvents` | Running model/tool work from catalog runtime state |
| `orderSequenceColumns` / `sequenceColumnState` | Session columns in parent/child order with running/waiting/idle state |
| `sequenceColumnItems` | Per-column items: input bubbles/tags, both halves of each delivery (a child creation merged with its first message or Task), assistant text with commentary/final, tool runs not already shown as cards, running work |
| `buildSequenceRows` / `loadedSequenceRows` | Fixed one-minute local-time buckets, idle buckets omitted, consecutive tool runs grouped per cell; rows before the oldest loaded page hidden |
| `connectedSequenceSessions` | The pinned Session and its delivery, creation and Task peers in the loaded data |
| `nextSequenceColumns` / `sequenceRowSessions` | Column hysteresis over the near (±1 viewport) and far (±2 viewports) row bands, tree order, pinned first |
| `sequenceRowOffsets` / `sequenceRowWindow` / `estimateSequenceRow` | Virtualization: cumulative measured-or-estimated row offsets and the rendered row range |
| `stepSequenceWidths` / `sequenceScrollLeftShift` | Column width animation and the horizontal scroll change that keeps visible columns in place |
| `trimSequenceData` | Drop activity before a page boundary, keeping links whose newer half remains |
| `sequenceWaitMs` | Time between sending and reading a delivery |
| `useSequencePaging` | Newest page, older pages by `next` cursor, live `after` requests (cursor count bounded), Session-list subscription and page trimming |
| `SessionSequenceView` | All/Connected filter, bottom follow with Chat intent rules, visual-anchor preservation, older-page triggering, virtualized rows, animated dynamic columns, pinned column |
| `SequenceCell` and item renderers | Chat-styled items, pairing highlight, wait/unread hints, open-at-message clicks |
| `openSessionAtSeq` | Store `seq-local-<seq>` viewport anchors for both history modes, then select the Session |

## Behavior

- Anchor preservation: while not following, the first visible row and its offset are captured on user scrolls and after each render, and restored after every render (prepended pages, measured heights, column changes). When rows were inserted above and the anchor row is not rendered yet, the position comes from row offsets and is corrected from the rendered row on the next frame. `overflow-anchor` is disabled so the browser does not adjust as well.
- Live: Session-list deltas for loaded columns update runtime fields immediately; deltas, list change notices and a 30 s visible refresh schedule one coalesced `after` request, which also brings in newly active Sessions.
- Opening at a message restores precisely in Conversation view (continuous Archive history); Detailed view honours the anchor when that message is in the loaded active context.
- Visible copy uses product terms: Running/Waiting/Idle, This session, To/From, Read after …, Not read yet, Matched by time, Load earlier activity, Start of history, Newest.

## Tests

`sessionSequence.test.mjs` covers column order and state, item placement (input, both delivery halves, text phases, suppressed delivery tags), fixed minute buckets and grouping, wait times, live and older-page merges (a delivery completed by an older page), loaded-range rows and trimming, column hysteresis, row windows, width animation with scroll compensation, and Connected. `mainHostSessionSequence.e2e.mjs` drives a real C# Main with a scripted coordinator and two workers: exact pairing highlight, tool groups and failures, commentary/final text, live append without reload and opening the receiver. It then renders a denser synthetic window (Tasks, timer, unread delivery, running work) and a six-hour synthetic paged history: bottom start and follow, older pages loading with the visible row kept in place, a column appearing and another leaving on scroll and returning at the newest activity, and no render loop once settled. Screenshot variables: `FOXWARM_SEQUENCE_SCREENSHOT`, `FOXWARM_SEQUENCE_DENSE_SCREENSHOT`, `FOXWARM_SEQUENCE_BOTTOM_SCREENSHOT`, `FOXWARM_SEQUENCE_SCROLLED_SCREENSHOT`.
