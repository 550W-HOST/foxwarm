# Unit: Realtime transport and event timing

Files: `packages/webui/src/realtime.ts`

## Purpose

Maintains the browser WebSocket/realtime transport and event timing used to merge host state/history/list updates with local UI state.

## Stable symbols and callers

`realtime.ts`; event subscription/ack and reconnect helpers.

Callers and boundary: Host `WebUiRealtime`; session list/chat/timeline state.

## Behavior and side effects

`realtime.ts` owns WebSocket connect/reconnect, subscription filters, event sequence/ack, and close/error state. It merges host revisions into session/chat/task/list stores and requests bounded refresh after gaps; browser listeners are isolated from optimistic draft state and do not mark a turn committed by receipt of a delta alone.

## Tests

Realtime transport, stream follow, live session list, and event-ack tests.
