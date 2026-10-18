# Unit: WebUI Session navigation handoff

Files: packages/webui/src/preparedChatHistory.ts
Secondary files: packages/webui/src/App.tsx, packages/webui/src/components/useChatConversationSync.ts, packages/webui/src/components/WorkbenchContentHost.tsx, packages/webui/test/workbenchPreview.e2e.mjs

## Purpose and symbols

`prepareChatHistory` prepares one explicit target's active bootstrap plus an optional separate bounded original Archive window. It reuses existing authenticated routes and saved continuous viewport anchors. `peekPreparedChatHistory` and `peekPreparedChatArchive` are non-destructive during StrictMode initialization; `discardPreparedChatHistory` releases the handoff after consumption/cancellation. Entries are short-lived, bounded and never stored on disk.

App owns latest-intent cancellation, the synchronization hook owns normal reconciliation, and the stable content host owns only temporary inert/visual state. Canonical contract and native checks: [Session navigation](../threads/webui-session-navigation.md).
