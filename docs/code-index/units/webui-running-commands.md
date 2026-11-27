# Unit: webui-running-commands

Files: packages/webui/src/components/RunningCommands.tsx, packages/webui/src/components/execLinks.tsx, packages/webui/test/chatExecLinks.e2e.mjs

Secondary files: packages/webui/src/components/Chat.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/src/components/SystemSessions.tsx, packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/ToolTimelineItems.tsx

## Purpose

Shows a Session's [background commands](./tools-local-io.md#d-exec-list-stop) with a Stop action, and links each background receipt to its completion event.

## Key exports

- `RunningCommands` — the status-row trigger and popover; `RunningCommandList` — the list with Stop, also used by the System inspector; `runningCommandLabel` — a row's collapsed text (summary or first command line); `useRunningCommands`, `fetchRunningCommands`, `stopRunningCommand` — the HTTP calls.
- `ExecIdLink`, `withLeadingExecLink`, `leadingExecId` — the leading `[execId]` link; `indexExecLinks`, `ExecLinkContext`, `findExecLink`, `flashExecLink`, `counterpartRole` — Chat's jump controller.

## Running background commands

**Directly requested (2026-11-18), design approved by the coordinator.** While a Session has [background commands](./tools-local-io.md#d-exec-list-stop), the runtime status row shows `N running commands` beside the runtime caption, also when idle (`ProcessingStatus` `backgroundControl`). Its popover lists each command (Node when not `master`, elapsed time) with a Stop action that reads `Stopping…` until the row disappears; refusals show inline (`This Node can't stop commands.` and similar) and can be retried. The count is the Session DTO's `runningExecs`; the list is fetched from `GET /api/sessions/{id}/execs` only while the popover is open and refreshed every 2 seconds, and Stop posts to `POST /api/sessions/{id}/execs/{execId}/stop`. Both routes resolve the Session like Session Stop and are not offered to scoped WebUI identities. The [System inspector](./webui-system-view.md) reuses `RunningCommandList` under "Running commands", shown only when the catalog row has a count, so inspecting a Session never loads it just to look for commands.

**Directly requested (2026-11-22).** A collapsed row shows the exec call's `summary` (the purpose the collapsed exec card shows), or the command's first non-blank line in monospace when the call gave none (`runningCommandLabel`). Tapping or clicking the row (a chevron marks it; no hover-only controls) expands the full command, rendered like the expanded [exec tool card](./webui-tool-timeline.md): `ExecCommandText` with inline-marked, language-highlighted heredoc bodies, in a bounded scrolling block. The summary stays as the row heading; Node, elapsed time and Stop are unchanged. On coarse pointers the row toggle and Stop are at least 40px tall. The summary comes from the list rows' additive `summary` field ([D-exec-list-stop](./tools-local-io.md#d-exec-list-stop)). `chatExecLinks.e2e.mjs` covers the summary and first-line fallback, the expanded highlighted heredoc, Stop on a row, and tap expand/collapse on a phone viewport.

**Directly requested (2026-11-22).** The popover opens above its trigger and stays inside the viewport on phones in portrait and landscape, also with a row expanded and when the trigger sits at the right end of the status row. While open it follows the trigger each frame: the shared `clampAnchoredMenuHorizontally` shifts it sideways inside the Chat pane and the viewport (the same placement the Session settings menu uses), and its height is capped at the room above the trigger below the top safe area, so a long list scrolls inside it. It stays hidden until placed. `chatExecLinks.e2e.mjs` checks the bounds at 360×780 and 844×390 with the trigger pushed to the right edge, collapsed and expanded.

`Chat` also owns the [execId link](./webui-tool-timeline.md#exec-id-links) controller: `indexExecLinks` records which receipts and completion events loaded history contains, a mounted counterpart is scrolled to and flashed directly, and one hidden in a collapsed group or an older window is revealed through the same `searchTarget` path Search uses, then flashed once mounted. `chatExecLinks.e2e.mjs` covers both and the control.
