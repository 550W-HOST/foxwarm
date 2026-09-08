# Unit: webui-pasted-text

Files: packages/webui/src/pastedText.ts, packages/webui/src/components/PastedTextBlock.tsx, packages/webui/test/pastedText.test.mjs, packages/webui/test/pastedTextBlocks.e2e.mjs
Secondary files: packages/webui/src/components/ChatTimeline.tsx, packages/webui/src/components/InlineComposerEditor.tsx

## Purpose

Provides the exact user-text wrapper parser and compact read-only history presentation for pasted text without changing canonical message content or authority.

## Key exports

- `parsePastedTextSegments(text)` — returns ordered ordinary/pasted segments only when every recognized wrapper is complete and non-nested.
- `getPastedTextPreview(text, maxCharacters?)` — returns the bounded first non-empty display line.
- `countPastedTextCharacters(text)` — counts Unicode code points for the visible character count.
- `PastedTextBlock` — renders the inline history preview/count trigger and owns its read-only modal lifetime.
- `PastedTextModal` — shared focus-contained modal, read-only for history and editable with Save/Restore actions for composer-owned blocks.

## Behavior

- Exact `<pasted-text>...</pasted-text>` wrappers in ordinary user text become compact inline chips at their original position among surrounding text and authored blank lines.
- Preview text uses the first non-empty trimmed line and a bounded ellipsis; count uses Unicode code points rather than UTF-16 code units.
- Opening a history chip mounts a focus-contained modal with the complete unchanged inner text in a read-only textarea. Composer blocks reuse the modal in editable mode with Save/Cancel and optional Restore to text. The shared dialog occupies approximately 80% of the dynamic viewport in both dimensions, keeps header/footer controls visible, and gives remaining height to the textarea while retaining a 1rem mobile viewport margin. Copy writes the current complete inner text; Escape, backdrop activation, and Close dismiss and restore trigger focus.
- Valid wrappers typed manually receive the same history presentation. Unclosed, malformed, or nested wrappers remain one literal text segment.
- `ChatTimeline` applies parsing only to ordinary user text parts. Model text and structured system parts remain unchanged. Valid pasted content is excluded from heavy-system and lightweight-metadata classification, so examples inside the block neither promote the row nor disappear when user metadata is hidden.
- Parsing/rendering is presentation-only. The canonical persisted/provider text and message role are never rewritten.

## Integration

- `ChatTimeline.CollapsibleUserText` renders parsed segments through the existing user line/blank-space renderer and `PastedTextBlock`.
- `ChatTimeline.isHeavySystemLikeMessage` classifies only ordinary text segments around valid blocks.
- `InlineComposerEditor` reuses the preview/count helpers and editable modal, while composer segment/persistence/undo authority remains in [D-composer-pasted-text-editor](./webui-chat-composer.md#d-composer-pasted-text-editor).

## Design decisions

### D-webui-user-pasted-text-display

[2026-09-07] User-history pasted-text blocks are presentation only. Recognize only complete exact non-nested `<pasted-text>...</pasted-text>` wrappers within ordinary user text parts, preserve canonical persisted/provider text unchanged, and show a compact inline first-line preview plus Unicode character count with a read-only full-text modal. The shared history/composer modal uses approximately 80% of the dynamic viewport width and height, reserves its header and optional footer, and lets the textarea fill the remaining bounded area. A valid wrapper typed manually receives the same display. Malformed, unclosed, or nested text remains literal; model, tool, heavy-system, and structured-system parts remain unchanged. Wrapper contents never gain system/developer authority and never participate in user metadata hiding or heavy-system classification.