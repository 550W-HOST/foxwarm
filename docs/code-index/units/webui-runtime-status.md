# Unit: webui-runtime-status

Files: packages/webui/src/runtimeStatus.ts, packages/webui/src/sessionNotices.ts, packages/webui/src/components/RuntimeFox.tsx, packages/webui/src/components/SystemEventCard.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/test/processingStatus.test.mjs, packages/webui/test/runtimeStatus.e2e.mjs
Secondary files: packages/webui/src/components/FoxLoaders.css, packages/webui/src/sessionRuntimeState.ts, packages/webui/src/components/useChatConversationSync.ts, packages/webui/src/components/chatSessionSearch.ts, packages/webui/test/chatBottomStatus.e2e.mjs, packages/webui/test/conversationTimeline.e2e.mjs

## Purpose and stable symbols

- `getRuntimeStatusView`, `describeRuntimeTool`, `describeRuntimeWaiting` form one pure status/semantic-tone/detail mapping for Chat, Sidebar and Architecture. Tool presentation uses resolved metadata, not JSON guesses from truncated human argument previews. MCP names do not acquire builtin read/node semantics.
- `RuntimeFox` chooses request/wait illustrations and separate trotting, gathering, looking-back, raised-paw, resting, drooping-ear and head-tilt poses. Request and Waiting retain their existing artwork; new silhouettes use consistent strokes and no overlaid prop badges. `animated:false` and reduced motion suppress motion; historical error cards are static. Authored optical frames normalize visible extents and stroke weight without stretching poses or measuring the live DOM; the runtime slot remains 24px. Shared pose CSS remains owned by [fox loaders](./webui-fox-loaders.md).
- `ProcessingStatus` owns the single live status row and an anchored body-portaled details popover. Initial geometry is hidden until measured; focus follows visible positioning, Escape/outside interaction closes, and focus returns without scrolling. The popover chooses available above/below space and stays bounded on phones.
- `QueuedMessageStatus` is the independent message-aligned queue count/action. Stop remains in the composer. Submission does not replace an authoritative active tool/request/wait status.
- `getSessionNotice`, `getLastSessionFailure`, `createLocalSessionNotice` recognize trusted display-only events and represent local delivery uncertainty without inventing provider-visible messages.
- `SystemEventCard` renders a short semantic event panel with native closed diagnostics. Text stays escaped, selectable and bounded. Search can reveal the original diagnostic surface.

The chat synchronization hook correlates control request IDs, retains pending Stop/Continue until authoritative progress, ignores unrelated acknowledgements, and separates no-op/uncertain feedback from canonical history. Existing source data, replay, permission and queue behavior remain owned by their domains.

Native fixtures verify actual theme ink, distinct poses, keyboard details/focus, full phone bounds, reduced motion, request-caption timer cleanup, Stop/Send and queue geometry, feedback correlation, and event visibility/search in every timeline mode. Canonical contract: [Session runtime presentation](../threads/session-runtime-presentation.md).
