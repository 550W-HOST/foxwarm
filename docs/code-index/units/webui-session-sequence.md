# Unit: webui-session-sequence

Files: packages/webui/src/sessionSequence.ts, packages/webui/src/components/SessionSequenceView.tsx, packages/webui/src/components/SessionSequenceItems.tsx, packages/webui/test/sessionSequence.test.mjs, packages/webui/test/mainHostSessionSequence.e2e.mjs
Secondary files: packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/chatViewportState.ts, packages/webui/src/realtime.ts, packages/webui/src/components/SessionMessageCard.tsx, packages/webui/src/components/ToolTimelineItems.tsx, packages/webui/src/components/timelineTime.ts

## Purpose

Renders the Architecture **Sequence** surface defined by [D-session-sequence-view](../threads/session-sequence-view.md#d-session-sequence-view) over `POST /api/session-sequence`.

## Function index

| Symbol | Responsibility |
|---|---|
| `mergeSequenceData` | Append an incremental response: keyed events/links, queued deliveries replaced by their read side while keeping the sender anchor, advanced cursors |
| `unloadedSequencePeers` | Non-opaque Sessions referenced by links but not loaded; a new one triggers a full reload |
| `liveSequenceEvents` | Running model/tool work from catalog runtime state |
| `orderSequenceColumns` / `sequenceColumnState` | Session columns in parent/child order with running/waiting/idle state |
| `sequenceColumnItems` | Per-column items: input bubbles/tags, both halves of each delivery (a child creation merged with its first message or Task), assistant text with commentary/final, tool runs not already shown as cards, running work |
| `chooseSequenceBucket` / `buildSequenceRows` / `buildSequenceGrid` | Local-time buckets coarsened to at most 60 non-empty rows, idle buckets omitted, consecutive tool runs grouped per cell |
| `sequenceWaitMs` | Time between sending and reading a delivery |
| `SessionSequenceView` | Window/focus controls, loading, realtime subscription, follow-latest scrolling, column headers and time-separator rows |
| `SequenceCell` and item renderers | Chat-styled items, pairing highlight, wait/unread hints, open-at-message clicks |
| `openSessionAtSeq` | Store `seq-local-<seq>` viewport anchors for both history modes, then select the Session |

## Behavior

- Loading: a full request on window or focus change; Session-list deltas for loaded lanes update runtime fields immediately and schedule one coalesced `after`-cursor request. Without a focus, a 60 s visible-page refresh adds newly active Sessions.
- Opening at a message restores precisely in Conversation view (continuous Archive history); Detailed view honours the anchor when that message is in the loaded active context.
- Visible copy uses product terms: Sequence, Running/Waiting/Idle, To/From, Read after …, Not read yet, Matched by time.

## Tests

`sessionSequence.test.mjs` covers column order and state, item placement (input, both delivery halves, text phases, suppressed delivery tags), bucketing/coarsening/grouping, wait times and incremental merge. `mainHostSessionSequence.e2e.mjs` drives a real C# Main with a scripted coordinator and two workers: exact pairing highlight, tool groups and failures, commentary/final text, live append without reload and opening the receiver. It then renders a denser synthetic window (Tasks, timer, unread delivery, running work). Set `FOXWARM_SEQUENCE_SCREENSHOT` / `FOXWARM_SEQUENCE_DENSE_SCREENSHOT` to save screenshots.
