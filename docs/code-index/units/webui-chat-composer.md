# Unit: webui-chat-composer

Files: packages/webui/src/components/ChatComposer.tsx

## Purpose

A rich chat composer component for the web UI that handles text input with slash-command autocomplete, file attachments (drag-and-drop and picker), audio recording/transcription (live streaming and file upload), model selection, and message submission with draft persistence.

## Key Exports

- `ChatComposer` — memoized React component (default export) providing the full chat input experience
- `ModelOption` — type describing a selectable model (key, label, isDefault, contextLimit)

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `persistDraft(sessionId, value)` | ~62 | Saves or removes draft text in localStorage |
| `formatModelLabel(option, defaultModelKey)` | ~67 | Formats a model option label with default indicator |
| `ModelSelector(props)` | ~72–310 | Popup component for selecting current and child models or opening model settings |
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
- Opening the model popup requests a fresh `/api/models` list through Chat, so long-lived/multi-pane composers do not keep stale choices. Its `Configure models…` footer delegates to App rather than changing location itself.
- Adds semantic CSS hooks (`foxwarm-chat-composer-form`, `foxwarm-chat-composer-textarea`, `foxwarm-attachment-chip`) used by optional UI style layers such as 550A; these hooks should not change composer behavior or draft/attachment data flow.

## Integration

- Consumed by the chat view, receiving session state, model configuration, and callbacks for sending messages, changing models, and transcribing audio.
- Relies on `chatShared` utilities for slash-command logic and textarea auto-resize.
- Model changes propagate up through `onChangeModel`/`onChangeChildModel` to session management. Model refresh and settings navigation propagate through `onRefreshModels`/`onOpenModelSettings`; canonical navigation behavior is [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation).
- Attachments and text are bundled and sent via `onSend` to the parent message-handling layer.