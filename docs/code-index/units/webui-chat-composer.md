# Unit: WebUI Chat composer

Files: `packages/webui/src/components/ChatComposer.tsx`, `packages/webui/src/attachmentRefs.ts`, `packages/webui/src/attachmentSend.ts`, `packages/webui/src/chatPreferences.ts`, `packages/webui/src/chatViewportState.ts`, `packages/webui/src/streamingAssistantDraft.ts`

## Purpose

Owns browser draft editing, model and effort controls, attachments, autocomplete, speech input, and send admission for one Chat surface.

## Behavior

The composer keeps draft and attachment state local until a send is accepted. Experimental host modes can restrict text and attachment behavior through explicit props. Model settings and canonical validation remain host-owned; the browser only presents options and submits user changes.

## Tests

Composer, attachment, model selector, and setup-model fixtures exercise the supported browser paths.
