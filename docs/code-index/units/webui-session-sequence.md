# Unit: webui-session-sequence

Files: packages/webui/src/sessionSequence.ts, packages/webui/src/components/SessionSequenceView.tsx, packages/webui/src/components/SessionSequenceCanvas.tsx, packages/webui/test/sessionSequence.test.mjs, packages/webui/test/mainHostSessionSequence.e2e.mjs
Secondary files: packages/webui/src/components/ArchitectureView.tsx, packages/webui/src/chatViewportState.ts, packages/webui/src/realtime.ts

## Purpose

Renders the Architecture **Sequence** surface defined by [D-session-sequence-view](../threads/session-sequence-view.md#d-session-sequence-view) over `POST /api/session-sequence`.

## Function index

| Symbol | Responsibility |
|---|---|
| `mergeSequenceData` | Append an incremental response: keyed events/links, queued deliveries replaced by their read side while keeping the sender anchor, advanced cursors |
| `unloadedSequencePeers` | Non-opaque Sessions referenced by links but not loaded; a new one triggers a full reload |
| `liveSequenceEvents` | Running model/tool bars from catalog runtime state, ending at the current time |
| `orderSequenceLanes` | Input lanes (You, Channels, Timers, System), Sessions in parent/child order with siblings by start time, then outside peers (opaque ones labelled "Other session") |
| `buildSequenceTimeScale` | Piecewise time-to-y mapping that compresses idle gaps into fixed break markers, with ticks |
| `chooseSequenceZoom` / `layoutSequence` | Automatic fit, lane x positions, lifeline start at creation, bar and arrow geometry with queue delay |
| `visibleSequenceItems` | Viewport culling for long windows |
| `SessionSequenceView` | Window/focus/zoom controls, initial and incremental loading, realtime subscription, follow-latest scrolling |
| `SequenceCanvas` / `SequenceDetails` | SVG drawing, keyboard-selectable bars/arrows, details and open actions |
| `openSessionAtSeq` | Store `seq-local-<seq>` viewport anchors for both history modes, then select the Session |

## Behavior

- Loading: a full request on window or focus change; Session-list deltas for loaded lanes update runtime fields immediately and schedule one coalesced `after`-cursor request. Without a focus, a 60 s visible-page refresh adds newly active Sessions.
- Opening at a message restores precisely in Conversation view (continuous Archive history); Detailed view honours the anchor when that message is in the loaded active context.
- Visible copy uses product terms: Sequence, Model request, Tool run, Message, Task, New session, Matched by time, Not read yet.

## Tests

`sessionSequence.test.mjs` covers lane order, gap compression, layout geometry, incremental merge and live bars. `mainHostSessionSequence.e2e.mjs` drives a real C# Main with a scripted provider: a parallel send and child creation, exact arrows, live append of a later delivery without reload, the details panel and opening the receiver. Set `FOXWARM_SEQUENCE_SCREENSHOT` to save a screenshot.
