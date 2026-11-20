# Unit: webui-running-commands

Files: packages/webui/src/components/RunningCommands.tsx, packages/webui/src/components/execLinks.tsx, packages/webui/test/chatExecLinks.e2e.mjs

Secondary files: packages/webui/src/components/Chat.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/src/components/SystemSessions.tsx, packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/ToolTimelineItems.tsx

## Purpose

Shows a Session's [background commands](./tools-local-io.md#d-exec-list-stop) with a Stop action, and links each background receipt to its completion event.

## Key exports

- `RunningCommands` — the status-row trigger and popover; `RunningCommandList` — the list with Stop, also used by the System inspector; `useRunningCommands`, `fetchRunningCommands`, `stopRunningCommand` — the HTTP calls.
- `ExecIdLink`, `withLeadingExecLink`, `leadingExecId` — the leading `[execId]` link; `indexExecLinks`, `ExecLinkContext`, `findExecLink`, `flashExecLink`, `counterpartRole` — Chat's jump controller.

## Running background commands

**Directly requested (2026-11-18), design approved by the coordinator.** While a Session has [background commands](./tools-local-io.md#d-exec-list-stop), the runtime status row shows `N running commands` beside the runtime caption, also when idle (`ProcessingStatus` `backgroundControl`). Its popover lists each command (one-line command, full text on click, Node when not `master`, elapsed time) with a Stop action that reads `Stopping…` until the row disappears; refusals show inline (`This Node can't stop commands.` and similar) and can be retried. The count is the Session DTO's `runningExecs`; the list is fetched from `GET /api/sessions/{id}/execs` only while the popover is open and refreshed every 2 seconds, and Stop posts to `POST /api/sessions/{id}/execs/{execId}/stop`. Both routes resolve the Session like Session Stop and are not offered to scoped WebUI identities. The [System inspector](./webui-system-view.md) reuses `RunningCommandList` under "Running commands", shown only when the catalog row has a count, so inspecting a Session never loads it just to look for commands.

`Chat` also owns the [execId link](./webui-tool-timeline.md#exec-id-links) controller: `indexExecLinks` records which receipts and completion events loaded history contains, a mounted counterpart is scrolled to and flashed directly, and one hidden in a collapsed group or an older window is revealed through the same `searchTarget` path Search uses, then flashed once mounted. `chatExecLinks.e2e.mjs` covers both and the control.
