# Unit: Chat composer, attachments, and session draft state

Files: `packages/webui/src/attachmentRefs.ts`, `packages/webui/src/attachmentSend.ts`, `packages/webui/src/chatHistoryState.ts`, `packages/webui/src/chatPreferences.ts`, `packages/webui/src/chatViewportState.ts`, `packages/webui/src/components/Chat.tsx`, `packages/webui/src/components/ChatComposer.tsx`, `packages/webui/src/components/InlineComposerEditor.tsx`, `packages/webui/src/components/PastedTextBlock.tsx`, `packages/webui/src/components/chatShared.tsx`, `packages/webui/src/composerDraft.ts`, `packages/webui/src/launcherDraft.ts`, `packages/webui/src/messageAttachmentDrafts.ts`, `packages/webui/src/nodeTargets.ts`, `packages/webui/src/pastedText.ts`, `packages/webui/src/sessionContinuation.ts`, `packages/webui/src/sessionHeader.ts`, `packages/webui/src/sessionNode.ts`, `packages/webui/src/sessionRuntimeState.ts`, `packages/webui/src/streamingAssistantDraft.ts`, `packages/webui/src/utils/chatOptimistic.ts`

## Purpose

Owns the browser composer’s ordered draft model, rich contenteditable editing, attachment File lifetime, streamed transcription, optimistic send state, and Session header/runtime presentation.

## Stable symbols and callers

- `normalizeComposerDraftSegments`, `makeComposerDraft`, `makePlainComposerDraft`, `serializeComposerDraft`, `getPlainComposerDraftText`, `canConvertPasteToBlock`, `loadComposerDraft`, `persistComposerDraft`, and `clearComposerDraft` own versioned segment/storage behavior.
- `createMessageAttachmentDrafts`, `getMessageAttachmentFile`, `setMessageAttachmentFile`, `getMessageAttachmentDraft`, `setMessageAttachmentDraft`, `removeMessageAttachmentDraft`, and `clearMessageAttachmentDraft` own exact-Session page-memory `File` references.
- `InlineComposerEditor` exposes its imperative draft/reset, selection, undo/redo, attachment, composition, and transcription boundary to `ChatComposer`; `ChatComposer` owns send/record/model-selector UI; `attachmentSend.uploadReferencedFiles` and `postReferencedMessage` are called by `Chat` only on accepted send.
- `buildStreamingAssistantMessage`, `applyModelStreamEvent`, `applyModelStreamSnapshot`, `reconcileCommittedModelDraft`, `shouldClearDraftForCommittedModel`, and `isSessionTurnIncomplete` keep provisional model output distinct from committed history.
- `Chat` provides a browser find surface with Ctrl/Cmd+F, IME-safe query entry, bounded recent-query history, and match navigation over the loaded Session timeline.

## Draft and attachment contract

The draft is a versioned ordered segment list: ordinary text, atomic `<pasted-text>` blocks, and attachment references. `persistComposerDraft` stores metadata/segments in `localStorage` under the exact Session ID; browser `File` objects are not serializable and remain in the page-memory `messageAttachmentDrafts` map. A missing File is rendered as a reattach/remove state rather than a fake persisted upload.

The composer does not upload when a file is selected, dropped, pasted, or restored. `ChatComposer.handleSend` resolves the exact current draft; `Chat` then calls `uploadReferencedFiles` and only after successful upload calls `postReferencedMessage`. Rejected upload/message requests retain the complete draft and page-memory Files; accepted send clears the submitted Session’s draft, attachment ownership, and storage.

## Editor, IME, undo, and transcription contract

`InlineComposerEditor` keeps native text nodes and atomic chips in the live DOM. Parent React updates do not recreate the editor on every key. Caret anchors/scaffolds normalize browser empty blocks and hard-line boundaries without turning soft wraps into authored newlines. Copy, range deletion, chip insertion/removal, and paste operate on canonical segment order.

IME composition owns the live DOM and selection: interim composition input does not reconcile anchors or emit partial drafts. Finalization waits for committed input after `compositionend` (with a frame fallback where browser ordering requires it), promotes text once, and records one composition undo entry. Undo/redo is bounded by 80 entries and 2,000,000 stored UTF-8 bytes; contiguous typing coalesces while structural chip edits use the editor’s canonical history boundary.

The inline streaming-transcription contract captures a caret/ordinary-text region before streaming, updates that one region in place, and commits one undo step on finalization. A pointer action that blurs an in-progress composition flushes committed text before reserving the transcription position. Stale finalization frames cannot overwrite a newer draft; final send reads the exact current draft synchronously before validation.

Large plain clipboard text becomes a pasted block at the established 2,000-code-point or 20-line threshold unless wrapper delimiters collide. Hand-typed wrapper syntax is not auto-converted. Pasted segments remain editable/restorable and are serialized in their exact position.

## Tests

`packages/webui/test/composerDraft.test.mjs`; `composerPastedText.e2e.mjs`; `messageAttachmentDrafts.test.mjs`; `messageAttachmentDrafts.e2e.mjs`; `attachmentSend.test.mjs`; `attachmentRefs.test.mjs`; model-selector and streaming-transcription coverage.
