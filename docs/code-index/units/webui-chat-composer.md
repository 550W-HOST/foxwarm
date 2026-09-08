# Unit: webui-chat-composer

Files: packages/webui/src/components/ChatComposer.tsx, packages/webui/src/components/InlineComposerEditor.tsx, packages/webui/src/composerDraft.ts, packages/webui/src/components/modelFilter.ts, packages/webui/src/messageAttachmentDrafts.ts, packages/webui/test/composerDraft.test.mjs, packages/webui/test/composerPastedText.e2e.mjs, packages/webui/test/modelFilter.test.mjs, packages/webui/test/modelSelectorTrigger.e2e.mjs, packages/webui/test/messageAttachmentDrafts.test.mjs, packages/webui/test/messageAttachmentDrafts.e2e.mjs
Secondary files: packages/webui/src/index.css, packages/webui/test/setupModels.e2e.mjs, packages/webui/test/systemTabs.e2e.mjs

## Purpose

A rich chat composer component for the web UI that handles ordered ordinary/pasted text editing, slash-command autocomplete, file attachments (drag-and-drop and picker), audio recording/transcription (live streaming and file upload), model selection, and message submission with versioned draft persistence.

## Key Exports

- `ChatComposer` — memoized React component (default export) providing the full chat input experience
- `InlineComposerEditor` — imperative contenteditable surface for native text flow plus atomic pasted-text segments
- `makeComposerDraft` / `serializeComposerDraft` / `loadComposerDraft` / `persistComposerDraft` — normalized segment model, canonical wrapper serialization, and versioned browser persistence with legacy plain-string reads
- `ModelOption` — type describing a selectable model plus allowed/default effort capability metadata
- `filterModelOptions` / `formatModelLabel` — exact natural-text filtering and visible-label formatting for model candidates
- `getMessageAttachmentDraft` / `setMessageAttachmentDraft` / `updateMessageAttachmentDraft` / `clearMessageAttachmentDraft` — page-memory attachment draft ownership keyed by exact Session ID

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `normalizeComposerDraftSegments(segments)` | composerDraft.ts | Merges adjacent text while retaining ordered atomic pasted-text segments |
| `serializeComposerDraft(draft)` | composerDraft.ts | Emits exact ordinary text and literal pasted-text wrappers |
| `canConvertPasteToBlock(text)` | composerDraft.ts | Applies the default 2,000-code-point or 20-line conversion threshold and delimiter guard |
| `InlineComposerEditor(props)` | InlineComposerEditor.tsx | Owns the live contenteditable DOM, chip operations, selection serialization, bounded history, and editable block modal |
| `formatModelLabel(option, defaultModelKey)` | ~67 | Formats a model option label with default indicator |
| `filterModelOptions(options, query, defaultModelKey?)` | modelFilter.ts | Case-insensitive visible-label/id substring filter that preserves server order |
| `ModelSelector(props)` | ~85–430 | Popup component for filtering/selecting current and child models, selecting their effort overrides, or opening model settings |
| `updatePopupPosition()` | ~97–120 | Calculates fixed positioning for the model selector popup |
| `applyCurrentModel(model)` | ~140 | Calls onChangeModel unless busy |
| `applyChildModel(model)` | ~145 | Calls onChangeChildModel unless busy |
| `renderCheckbox(checked, label)` | ~150 | Renders a styled checkbox indicator |
| `renderRow(row)` | ~157 | Renders a single model option row with current/child checkboxes |
| `ChatComposer(props)` | ~235–end | Main composer component with all input/send/attachment/audio logic |
| `handleSend(e)` | ~310 | Form submit handler; sends text + attachments, clears state |
| `handleCommandKeyDown(e)` | ChatComposer | Keyboard bridge for send-on-enter/mod+enter and plain-draft slash navigation |
| `handleSlashSelect(option)` | ~395 | Applies selected slash command suggestion into input |
| `handleAttach(e)` | ~405 | Processes file input selection into attachments state |
| `handleDrop(e)` | ~415 | Handles drag-and-drop file additions |
| `removeAttachment(index)` | ~425 | Removes an attachment by index |
| `startRecording()` | ~440 | Begins microphone capture with streaming transcription |
| `stopRecording()` | ~500 | Stops recording and finalizes transcription |
| `handleAudioFileUpload(e)` | ~530 | Uploads an audio file for server-side transcription |

## Dependencies

- `./chatShared` — `applySlashCommandSuggestion`, `getSlashCommandCompletion`, `SlashCommandOption`, `SlashCommandSuggestion`
- `../composerDraft` and `./InlineComposerEditor` — canonical segment/persistence operations and the imperative editing surface
- `../config` — `API_BASE_PATH` (used for slash-command fetch endpoint)

## Behavior

- Maintains a versioned ordered draft of ordinary text and pasted-text segments plus attachments, slash-command suggestions, audio recording, waveform visualization, and drag-over status.
- Persists structured drafts to localStorage by exact Session ID, reads the former plain-string key as one ordinary text segment, and writes only the new versioned shape. Persistence/quota failures leave the live draft intact and show an actionable in-composer warning instead of silently losing it.
- The inline editor uses native text nodes for ordinary input and `contenteditable=false` pasted-text chips. Parent state updates do not rerender the live editing DOM; Session changes, accepted clears, slash completion, transcription append, undo/redo, and other external replacements use its imperative reset boundary.
- Firefox/browser-generated empty `<br>` or empty block scaffolds are canonical empty drafts rather than authored newlines. Transitioning to that state clears the live DOM so the overlaid pointer-transparent placeholder returns, and persistence removes both structured and legacy Session keys. Real text-node newlines remain authored content and are preserved.
- Editor-only caret anchors surround a leading/trailing chip and adjacent chips so mouse placement, Home, ArrowLeft from a focused chip, and atomic deletion can reach every canonical boundary. Their sentinel text has zero canonical selection width and is excluded from draft parsing, storage, send text, and copy; text entered through an anchor is promoted to an ordinary text node before emission.
- Plain clipboard text is inserted without HTML authority. Pasting at least 2,000 Unicode code points or 20 lines automatically creates a block unless the text contains the closing wrapper delimiter; smaller/colliding text remains ordinary. Hand-typed wrapper syntax is never auto-converted in the composer.
- Pasted blocks serialize at their exact ordered position as literal `<pasted-text>...</pasted-text>`. Their editable modal supports Save, Cancel, Copy, and Restore to text; delimiter collisions cannot be saved as a block but can be restored as ordinary text.
- Enter/Shift+Enter normalization owns exact newline insertion rather than accepting browser-specific block DOM. Copy/cut exports canonical plain text including wrappers, adjacent Backspace/Delete treats chips atomically, arrows cross native atomic boundaries, and range deletion may span text and chips.
- Undo/redo is one bounded whole-editor history (80 entries and two million stored UTF-8 bytes), coalesces contiguous ordinary typing, groups composition into one entry, and never mixes browser-native text undo with non-undoable structural chip insertion. Snapshots retain canonical anchor/focus offsets where text code units and each chip occupy one editor position, so middle carets and text-plus-chip selections are restored before continued typing. Ordinary input does not reset DOM or selection per key.
- While the composer is disabled, the editing root is noneditable, pasted-text chips leave the tab order and expose disabled semantics, and any open editable block modal closes. Paste, cut, undo/redo, chip keyboard/click actions, stale modal Save/Restore callbacks, and unexpected native input cannot mutate the canonical draft; read-only copy remains available. External authoritative updates such as an already-running transcription may still replace the visible disabled draft.
- Keeps ordinary message attachment drafts in one module-scoped, page-lifetime Map keyed by exact Session ID. Picker, pasted-image, drop, and removal mutations synchronously update that owner while preserving `File` identity and order; state restoration defensively copies arrays without serializing file content.
- Switching or unmounting never clears attachment drafts. Accepted sends clear only the submitted Session's attachment draft; rejected or failed sends retain it. Audio-transcription file selection remains separate and is never stored as a message attachment draft.
- Loads slash-command completion metadata from `API_BASE_PATH/commands` through the shared page-lifetime parsed-result Promise; typing a `/` prefix filters that cached list without refetching.
- The ordinary attachment picker intentionally has no `accept` filter so users can choose any file type; audio transcription keeps its separate audio-only picker.
- Supports two send-key modes (`enter` and `modEnter`) for submitting messages.
- Audio recording uses `MediaRecorder` with streaming transcription via `onCreateStreamingTranscriber`; also supports file-upload transcription via `onTranscribeAudio`.
- Notifies parent of actual composer-layout height changes via `onHeightChange` using ResizeObserver. Slash suggestions are absolutely overlaid above the form inside a positioned composer anchor, so opening, closing, or resizing suggestions does not change this measured layout height.
- Calls `onDraftEdited` with canonical serialized text whenever the draft changes. Slash completion runs only when the entire draft is one ordinary text segment; transcription appends to the active exact Session draft without rewriting pasted contents, and late transcription completion is fenced from a newly active Session.
- Model selector renders as a portal-based fixed popup with outside-click and Escape dismissal.
- The model selector uses dialog focus semantics: every open clears and focuses its filter input, while Escape/outside dismissal restores the trigger before normal navigation proceeds. In the console component treatment, that filter focus uses only the manifest's accent focus treatment and explicitly replaces the default blue ring/shadow.
- The filter performs a case-insensitive substring match against each candidate's currently visible label and model id without fuzzy reordering. The default/follow row and the server's option order/current/child semantics remain unchanged.
- Enter in the filter selects the current model only when exactly one actual candidate remains, reusing the existing current-model callback and closing the popup. Zero/multiple candidates and IME composition Enter are no-ops.
- Opening the model popup reuses the page-lifetime `/api/models` result already requested by Chat; it does not refresh the endpoint. This intentionally favors one request per page over live Setup-edit reflection, so reloading is the supported refresh boundary. The footer's icon-only, labeled Configure Models button delegates to App rather than changing location itself; the adjacent filter owns the remaining width. The desktop popup is 600px wide, shifts/clamps left before shrinking when the viewport cannot fit it, and retains bounded narrow/mobile behavior.
- Model header, option rows, and effort footer share exactly `minmax(0, 1fr) 100px 100px` tracks. The rows reserve the native scrollbar gutter from the start, so first scroll, refreshed options, and current/child selection do not change popup width or column geometry. Model ID and Current are one accessible current-selection button and hover/focus region; Child remains an independent button and hover/click region.
- The trigger shows the effective current effort and shows the future-child pair when either a child model or child effort override exists. It can use up to 30rem for long current/child labels, but its flex owner remains shrinkable and the labels ellipsize in narrow composers without creating horizontal overflow or hiding the Send control. Attachment/audio chips retain their own inner horizontal-scroll area instead of forcing the model trigger wider. The popup keeps a plain `Model ID | Current | Child` header, then places one compact table-aligned `Effort | current select | child select` row after the scrollable model rows and immediately above settings/filter footer. The effort row reuses the exact model-table grid tracks and cell boundaries, without separate Current/Child effort labels, cards, or gaps. Visible selected labels stay short (`High`, `Default`, `Follow`, `Per leaf`, or a stale `Max ⚠`), while native option text, control titles, and described-by accessibility text retain complete effective-default/stale semantics. Desktop controls intentionally override the global form anti-zoom rule to 11px; true narrow/mobile viewports restore 16px and rely on the short labels plus bounded native-arrow padding. Each select is limited to the freshly loaded selected/effective model capability (falling back to the session projection). Virtual unset is labeled `per leaf`, never as a synthetic `default` effort. If the backend returns a stale raw override outside the allowed set, the select keeps it visibly selected as a disabled warning option, states the authoritative effective fallback, and offers only valid recovery choices. Canonical semantics: [D-model-routing-effort](../threads/model-routing.md#d-model-routing-effort).
- Adds semantic CSS hooks (`foxwarm-chat-composer-inner`, `foxwarm-chat-composer-form`, `foxwarm-chat-composer-textarea`, `foxwarm-attachment-chip`) used by optional UI style layers such as 550A; these hooks should not change composer behavior or draft/attachment data flow. The inner wrapper keeps the ordinary centered 64rem composer geometry in wide panes; Chat-owned container CSS can reserve a desktop context-overview clearance in constrained per-pane layouts without altering mobile behavior.

## Integration

- Consumed by the chat view, receiving session state, model configuration, and callbacks for sending messages, changing models, and transcribing audio.
- Relies on `chatShared` utilities for slash-command logic; contenteditable height is native and remains bounded by the existing composer measurement owner.
- Model/effort changes propagate up through paired callbacks to the existing session model and child-model endpoints. Model refresh and settings navigation propagate through `onRefreshModels`/`onOpenModelSettings`; canonical navigation behavior is [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation).
- Attachments and text are bundled and sent via `onSend` to the parent message-handling layer.
- The composer keeps browser `File` objects unchanged; Chat owns upload reconciliation and builds optimistic attachment metadata from the corrected upload response through the shared descriptor formatter. Optimistic tags include only known name/MIME facts and never expose the temporary upload-spool path. Canonical grammar: [D-channel-file-descriptor](../modules/channels.md#d-channel-file-descriptor).

## Design decisions

### D-composer-model-filter

The model popup provides a fresh autofocus filter on every open while reusing the page-lifetime model list. Filtering is an exact case-insensitive substring match over the current visible candidate label and id and preserves existing order/current/child/default behavior. Enter changes the current model and closes only when exactly one actual candidate remains; zero, multiple, and IME-composition Enter never select. Configure Models remains the same accessible Setup action but is displayed as an icon-only button immediately left of the width-filling filter.

### D-composer-model-effort-footer

The model popup keeps a plain three-column header. Its effort controls belong in one compact footer row directly below the scrollable model table and directly above settings/search, using the same three grid tracks as every model row: `Effort | current select | child select`. Do not reintroduce a detached two-field form, duplicate Current/Child effort labels, or a model-by-effort matrix. Keep short visible labels and full default/virtual/stale meaning in native option text, control titles, and accessibility descriptions. The controls intentionally use compact desktop typography but retain the global 16px anti-zoom size on true narrow/mobile viewports.

### D-composer-popup-geometry-and-hit-regions

[2026-08-12] The desktop model selector is a fixed 600px popup; when that width cannot fit, horizontal positioning first shifts/clamps left and only then shrinks to the available viewport width. Header, every model row, and the effort footer use the same three tracks: remaining Model ID width plus fixed 100px Current and fixed 100px Child columns. Reserve scrollbar width so scrollability, refreshed options, and selection updates do not move those tracks. Model ID and Current form one accessible current-selection button and visual hover/focus region; Child is a separate button and hover/click region. True narrow/mobile controls retain 16px anti-zoom behavior. In the console component treatment, the focused model filter uses only the manifest-derived accent border/ring/glow rather than stacking the default blue focus treatment.

### D-composer-slash-overlay

[2026-08-12] Slash-command suggestions are a viewport-bounded overlay anchored immediately above the composer form. They never participate in composer layout measurement, so opening, closing, or changing suggestion height cannot displace the timeline, change the reserved composer spacer, or detach bottom-follow.

### D-composer-session-draft-lifetimes

[2026-08-25] Composer text and ordinary message attachments intentionally have different browser lifetimes. Text drafts remain localStorage-backed per Session. Selected, pasted, or dropped message attachment `File` objects live only in a module-scoped Map for the current browser page/JavaScript context, keyed by exact Session ID; Session switching restores the same `File` references and order, while reload/page close clears them naturally. Do not serialize, upload early, place in localStorage/IndexedDB, persist through Session state, or add cross-tab/cross-frame synchronization. Only an accepted send or explicit attachment removal clears the affected page-memory draft; rejected/failed sends and unmounts retain it.

### D-composer-pasted-text-editor

[2026-09-07] The composer owns a bounded ordered segment editor rather than a general rich-text document. Ordinary text remains native selectable text; pasted-text blocks are atomic inline presentation nodes whose canonical serialization is the literal wrapper in the same user message. Automatic conversion uses the implementation default of at least 2,000 Unicode code points or 20 lines and never converts image/file clipboard items or text containing the closing delimiter. Hand-typed wrappers remain ordinary composer text. Use one custom bounded undo/redo history across text and structural edits, group composition, preserve exact newline/plain-text copy semantics and canonical selection offsets, and do not reset the live contenteditable DOM on each input. Browser-only caret anchors may make atomic boundaries reachable, but they have zero canonical width and must never enter storage, send text, copy text, or undo serialization. Treat only browser-generated empty scaffolds as empty; preserve every authored newline. Disabled state blocks every editor-owned mutation path while still accepting authoritative external draft replacement. Structured browser drafts read the former plain-string key but write only the current version; canonical empty removes both keys, while storage failure must remain visible and keep the live draft editable. This decision does not define inline file-reference protocol or persistence.
