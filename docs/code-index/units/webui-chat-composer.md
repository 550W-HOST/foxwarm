# Unit: webui-chat-composer

Files: packages/webui/src/components/ChatComposer.tsx, packages/webui/src/components/modelFilter.ts, packages/webui/test/modelFilter.test.mjs
Secondary files: packages/webui/src/index.css, packages/webui/test/setupModels.e2e.mjs, packages/webui/test/systemTabs.e2e.mjs

## Purpose

A rich chat composer component for the web UI that handles text input with slash-command autocomplete, file attachments (drag-and-drop and picker), audio recording/transcription (live streaming and file upload), model selection, and message submission with draft persistence.

## Key Exports

- `ChatComposer` — memoized React component (default export) providing the full chat input experience
- `ModelOption` — type describing a selectable model plus allowed/default effort capability metadata
- `filterModelOptions` / `formatModelLabel` — exact natural-text filtering and visible-label formatting for model candidates

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `persistDraft(sessionId, value)` | ~62 | Saves or removes draft text in localStorage |
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
| `handleKeyDown(e)` | ~340 | Keyboard handler for send-on-enter/mod+enter and slash navigation |
| `handleInputChange(e)` | ~380 | Updates input state, resizes textarea, triggers slash completion |
| `handleSlashSelect(option)` | ~395 | Applies selected slash command suggestion into input |
| `handleAttach(e)` | ~405 | Processes file input selection into attachments state |
| `handleDrop(e)` | ~415 | Handles drag-and-drop file additions |
| `removeAttachment(index)` | ~425 | Removes an attachment by index |
| `startRecording()` | ~440 | Begins microphone capture with streaming transcription |
| `stopRecording()` | ~500 | Stops recording and finalizes transcription |
| `handleAudioFileUpload(e)` | ~530 | Uploads an audio file for server-side transcription |

## Dependencies

- `./chatShared` — `applySlashCommandSuggestion`, `getSlashCommandCompletion`, `resizeTextarea`, `SlashCommandOption`, `SlashCommandSuggestion`
- `../config` — `API_BASE_PATH` (used for slash-command fetch endpoint)

## Behavior

- Maintains local state for input text, attachments, slash-command suggestions, audio recording, waveform visualization, and drag-over status.
- Persists draft text to localStorage keyed by session ID; restores on mount or session change.
- Fetches slash-command completions from `API_BASE_PATH/commands` as the user types a `/` prefix.
- The ordinary attachment picker intentionally has no `accept` filter so users can choose any file type; audio transcription keeps its separate audio-only picker.
- Supports two send-key modes (`enter` and `modEnter`) for submitting messages.
- Audio recording uses `MediaRecorder` with streaming transcription via `onCreateStreamingTranscriber`; also supports file-upload transcription via `onTranscribeAudio`.
- Notifies parent of height changes via `onHeightChange` using ResizeObserver.
- Calls `onDraftEdited` whenever the draft text changes.
- Model selector renders as a portal-based fixed popup with outside-click and Escape dismissal.
- The model selector uses dialog focus semantics: every open clears and focuses its filter input, while Escape/outside dismissal restores the trigger before normal navigation proceeds.
- The filter performs a case-insensitive substring match against each candidate's currently visible label and model id without fuzzy reordering. The default/follow row and the server's option order/current/child semantics remain unchanged.
- Enter in the filter selects the current model only when exactly one actual candidate remains, reusing the existing current-model callback and closing the popup. Zero/multiple candidates and IME composition Enter are no-ops.
- Opening the model popup requests a fresh `/api/models` list through Chat, so long-lived/multi-pane composers do not keep stale choices. The footer's icon-only, labeled Configure Models button delegates to App rather than changing location itself; the adjacent filter owns the remaining width and the popup remains viewport-clamped on mobile.
- The trigger shows the effective current effort and shows the future-child pair when either a child model or child effort override exists. The popup integrates compact effort selects directly into the existing Current/Child column header instead of adding a detached form section; the shared column context supplies the labels and preserves more vertical space for the scrollable model list. Visible selected labels stay short (`High`, `Default`, `Follow`, `Per leaf`, or a stale `Max ⚠`), while native option text, control titles, and described-by accessibility text retain complete effective-default/stale semantics. Desktop controls intentionally override the global form anti-zoom rule to 11px; true narrow/mobile viewports restore 16px and rely on the short labels plus bounded native-arrow padding. Each select is limited to the freshly loaded selected/effective model capability (falling back to the session projection). Virtual unset is labeled `per leaf`, never as a synthetic `default` effort. If the backend returns a stale raw override outside the allowed set, the select keeps it visibly selected as a disabled warning option, states the authoritative effective fallback, and offers only valid recovery choices. Canonical semantics: [D-model-routing-effort](../threads/model-routing.md#d-model-routing-effort).
- Adds semantic CSS hooks (`foxwarm-chat-composer-inner`, `foxwarm-chat-composer-form`, `foxwarm-chat-composer-textarea`, `foxwarm-attachment-chip`) used by optional UI style layers such as 550A; these hooks should not change composer behavior or draft/attachment data flow. The inner wrapper keeps the ordinary centered 64rem composer geometry in wide panes; Chat-owned container CSS can reserve a desktop context-overview clearance in constrained per-pane layouts without altering mobile behavior.

## Integration

- Consumed by the chat view, receiving session state, model configuration, and callbacks for sending messages, changing models, and transcribing audio.
- Relies on `chatShared` utilities for slash-command logic and textarea auto-resize.
- Model/effort changes propagate up through paired callbacks to the existing session model and child-model endpoints. Model refresh and settings navigation propagate through `onRefreshModels`/`onOpenModelSettings`; canonical navigation behavior is [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation).
- Attachments and text are bundled and sent via `onSend` to the parent message-handling layer.

## Design decisions

### D-composer-model-filter

The model popup provides a fresh autofocus filter on every open. Filtering is an exact case-insensitive substring match over the current visible candidate label and id and preserves existing order/current/child/default behavior. Enter changes the current model and closes only when exactly one actual candidate remains; zero, multiple, and IME-composition Enter never select. Configure Models remains the same accessible Setup action but is displayed as an icon-only button immediately left of the width-filling filter.

### D-composer-model-effort-header

The Current and Child effort controls belong inside their existing model-column header cells, not in a separate labeled form block or model-by-effort matrix. Keep them compact, use short visible labels, preserve full default/virtual/stale meaning in native option text, control titles, and accessibility descriptions, and size the shared popup columns so ordinary desktop labels remain readable while mobile stays viewport-clamped. The controls intentionally use compact desktop typography but retain the global 16px anti-zoom size on true narrow/mobile viewports.
