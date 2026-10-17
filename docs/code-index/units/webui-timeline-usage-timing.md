# Unit: webui-timeline-usage-timing

Files: packages/webui/src/components/conversationTiming.ts, packages/webui/src/components/timelineTime.ts, packages/webui/src/usageTiming.ts, packages/webui/test/usageBadgeDetails.e2e.mjs, packages/webui/test/usageTiming.test.mjs, packages/webui/test/timelineTime.test.mjs, packages/webui/test/timelineTimeDividers.e2e.mjs, packages/webui/test/conversationWaitingDividers.e2e.mjs
Secondary files: packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/timelineRows.ts

## Purpose

Owns the timing and usage presentation rules for timeline rows: persisted request timing, token usage attribution and totals, API duration aggregation, and timeline time separators.

## Key Exports

- `deriveTimelineTimeMarkers(messages, isGroupedEvent, isVisibleUnitStart?, getVisibleUnitStart?)` / `formatTimelineTimeMarker(marker)` — request-start/timestamp selection, strict structured CTX range starts, and local English date/time presentation

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `readPersistedRequestTiming(value)` | `usageTiming.ts` | Reads validated persisted start/end/duration for own-duration attribution and logical-request display clocks. |
| `deriveRequestTimings(messages)` | `usageTiming.ts` | Validates each model request and exposes its own API duration without aggregating inter-request gaps. |
| `deriveTimelineTimeMarkers(messages, isGroupedEvent, isVisibleUnitStart?, getVisibleUnitStart?)` / `formatTimelineTimeMarker(marker)` | `timelineTime.ts` | Compare the next valid request start (timestamp fallback) with the preceding persisted timestamp, keep strict structured CTX range starts, accept Conversation unit-start selection without changing raw baselines, suppress non-independent tool/event dividers, and format the selected clock/date. |
| `formatCompactDuration` / `formatDetailedDuration` | `usageTiming.ts` | Format compact API durations and exact millisecond details. |
| `readConversationWorkInterval` | `conversationTiming.ts` | Existing finite execution endpoints shared by duration union and standalone tool clocks. |
| `getConversationActivityStart` / `getConversationLiveRequestStart` | `conversationTiming.ts` | CTX-local leading input/execution origins and authoritative requesting-model starts; exclude creation/maintenance and unknown earlier work. |
| `selectTimelineTimeMarker` | `timelineTime.ts` | Reuses the minute/date comparison for committed units and a presentation-only live request. |
| `applyConversationTiming` | `conversationTiming.ts` | Projected reply/user/display-cut elapsed ranges with reliable leading origins and pre-first-part live work, clipped/unioned measured and live busy evidence with a displayed-divider waiting floor and per-gap noise filtering, runtime-confirmed pending batch receipts with conservative missing-data fallback, untimed canonical compact maintenance, and final error/CTX cuts. |
| `isCompactCompletionMaintenanceMessage` | `packages/shared/src/sessionContinuation.ts` | Shares exact canonical marker/generated reminder recognition for timing without changing the continuation classifier's legacy/read behavior. |

## Dependencies

- `./chatShared` — shared message types and helpers.
- `./timelineRows` — row model consumed by the conversation timing pass; see [webui-timeline-rows](./webui-timeline-rows.md).
- `../chatHistoryState`, shared `sessionContinuation`, `../sessionRuntimeState` — history tail, compact-completion classification, and runtime state used as timing evidence.
- `./timelineTime` and `usageTiming.ts` — time-marker and request-timing helpers owned by this unit.

## Behavior

- A structured CTX-BLOCK uses its persisted `__meta.contextBlock.rawStartTimestamp` for the preceding time divider and adjacent comparisons, not the block creation timestamp; an absent/invalid range start suppresses that row’s divider and breaks the gap chain. Nested CTX timelines still add no dividers.
- Token usage is normalized across provider schemas. Detailed/Grouped use the floating model badge; Conversation uses in-flow process totals and request/usage attribution details under [D-webui-timeline-view](../modules/webui-timeline.md#d-webui-timeline-view). Its unexpanded `×/C/I/O` metrics and Cloud-marked API duration retain one quiet divider without a nested background. Expanded details show API, Time, Model and Seq with an independent copy action; neither badge state nor tooltip includes an inter-request Between metric. Missing or invalid legacy request timings remain unavailable/invalid. Logical request timing persistence is [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time); timeline date/time presentation is [D-webui-timeline-time-separators](../modules/webui-timeline.md#d-webui-timeline-time-separators).
- A collapsed tool-group badge aggregates token counts and each contributing model request’s API duration. Expanded attribution retains all unique routes, a local-time range, and explicit missing/invalid metadata so mixed calls are never presented as one route or one inferred request.
- Expanded usage details add one `Seq` value derived from each usage-bearing model message’s persisted sequence: one message displays its value, a grouped badge displays one inclusive range, and missing/invalid attribution remains unavailable. Its independent copy action uses the actual current session ID and does not change canonical data. Collapsed token/API presentation, badge setting gate, and nested CTX badge suppression remain unchanged.

Conversation's request-aware process statistics include each logical request's actual usage once, including completion suffixes and the final reply. Missing complete usage and active pending usage remain distinct in details. Pending alone never adds a partial label; a process with no actual usage has no trigger or placeholder. Commentary-only conservative cuts use recorded completion endpoints; unknown/idle unfinished tails do not grow a guessed clock. Worked retains its full measured range; Waited clips gaps to an actually displayed Activity divider before per-gap noise suppression, while an unmarked Activity retains leading idle. The canonical waiting-floor contract is [Activity timing: display-boundary scope](../modules/webui-timeline.md#activity-timing-display-boundary-scope). Compact-maintenance exclusion and Elapsed/counts-only fallback remain unchanged. `conversationWaitingDividers.e2e.mjs` exercises real row/marker derivation and rendered Conversation for overnight Task/inter-agent input, exact gap cutoffs, unmarked leading idle, pre-divider busy work, runtime-only/committed output, missing evidence and CTX.

## Design Decisions

- [2026-07-24] The usage badge is the canonical interaction boundary for token detail disclosure. Preserve its existing collapsed compact labels, external desktop lower-right placement/gap, setting gate, and aggregate totals; on mouse/keyboard activation only the badge expands to full labels plus persisted time and routing attribution. Desktop expansion prefers that same external anchor and clamps left only by the amount needed to keep its right edge within the nearest timeline boundary; mobile remains flow layout. A virtual route is displayed as `virtual → concrete`; route/time metadata is never inferred from mutable UI state. For grouped calls, retain aggregation but show all unique routes and a time range rather than assigning the aggregate to one call. [2026-09-26 update] Expanded-only `Seq` uses only positive safe-integer sequences from usage-bearing model messages, never tool IDs/responses: one message displays `123` and copies `sessionId=<id> msg#123`; grouped messages display one inclusive `123 ~ 130` and copy `sessionId=<id> msg#123-130` even when sequence numbers are not consecutive. Repeated calls in one model message contribute one sequence, and coincident valid endpoints use the single-message form. An aggregate with any missing/invalid model sequence displays `unavailable` without a copy action rather than claiming a partial range. Copy is a separate button, does not toggle badge or group, and has no message/API write side effect.

Persisted logical request-duration semantics remain governed by [D-pipeline-input-time](../threads/message-processing-pipeline.md#d-pipeline-input-time); this unit owns API badge presentation and independent timeline time markers under [D-webui-timeline-time-separators](../modules/webui-timeline.md#d-webui-timeline-time-separators).
