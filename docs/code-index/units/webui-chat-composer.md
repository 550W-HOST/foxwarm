# Unit: Chat composer, attachments, and session draft state

Files: `packages/webui/src/attachmentRefs.ts`, `packages/webui/src/attachmentSend.ts`, `packages/webui/src/chatHistoryState.ts`, `packages/webui/src/chatPreferences.ts`, `packages/webui/src/chatViewportState.ts`, `packages/webui/src/components/Chat.tsx`, `packages/webui/src/components/ChatComposer.tsx`, `packages/webui/src/components/InlineComposerEditor.tsx`, `packages/webui/src/components/PastedTextBlock.tsx`, `packages/webui/src/components/chatShared.tsx`, `packages/webui/src/composerDraft.ts`, `packages/webui/src/launcherDraft.ts`, `packages/webui/src/messageAttachmentDrafts.ts`, `packages/webui/src/nodeTargets.ts`, `packages/webui/src/pastedText.ts`, `packages/webui/src/sessionContinuation.ts`, `packages/webui/src/sessionHeader.ts`, `packages/webui/src/sessionNode.ts`, `packages/webui/src/sessionRuntimeState.ts`, `packages/webui/src/streamingAssistantDraft.ts`, `packages/webui/src/utils/chatOptimistic.ts`

## Purpose

Owns draft state, attachment/pasted-text preparation, optimistic send state, session header/runtime coordination, and composer components.

## Stable symbols and callers

`ChatComposer`; attachment draft/send helpers; `chatHistoryState`; `streamingAssistantDraft`; `sessionContinuation`.

Callers and boundary: `Chat`; realtime/session state; host session and attachment routes.

## Behavior and side effects

`ChatComposer`/`InlineComposerEditor` own draft text, slash/launcher continuation, model/node target selection, pasted text, and attachment refs. `attachmentSend` uploads/normalizes refs before enqueue; `chatOptimistic` marks pending UI only until host ack/realtime. `sessionContinuation` and `streamingAssistantDraft` reconcile committed history with in-flight assistant deltas without writing authority.

## Tests

Attachment, pasted-text, launcher-draft, and composer integration tests.
