# Unit: WebUI Session messages

Files: packages/webui/src/components/sessionCommunications.ts, packages/webui/src/components/SessionMessageCard.tsx, packages/webui/test/sessionCommunications.test.mjs, packages/webui/test/conversationDisplaySettings.e2e.mjs
Secondary files: packages/webui/src/components/timelineRows.ts, packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/chatSessionSearch.ts, packages/webui/src/App.tsx, packages/webui/test/conversationTimeline.e2e.mjs

## Purpose and symbols

- `receivedSessionCommunication` recognizes a first-party system-backed inter-agent opening envelope, retains its decoded source ID, and removes only the outer wrapper.
- `projectSessionCommunications` derives ordered successful outgoing deliveries from paired calls or UI-only receipts and completed ToolScript subcalls. It never parses stdout, rewrites history or sends messages.
- `SessionMessageCard` renders direction, peer identity and the shared sanitized Markdown body in a distinct semantic card. `SessionMessageNamesContext` receives only already-loaded names from App. Unresolved legacy boundary aliases are not navigable destinations.

Conversation defaults to cards outside Activity and indexes their rendered body once. Disabling Show inter-agent messages renders both directions inside expanded Activity, retaining native call/result evidence and metadata-backed delivery bodies without Search hits. Cards share tool-result three-line clamping, actual-overflow fades and native thread-card height transitions; expansion and transient Search reveal show the full available body without altering history. Technical source records remain available in process details. Canonical behavior: [Session communication presentation](../threads/session-communication-presentation.md).
