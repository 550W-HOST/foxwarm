# Unit: webui-tool-timeline

Files: packages/webui/src/components/ToolTimelineItems.tsx, packages/webui/src/components/ToolExecText.tsx, packages/webui/src/components/ToolScriptProgressContext.tsx, packages/webui/src/components/legacyEditCounts.ts, packages/webui/test/toolCollapsedOverflow.e2e.mjs, packages/webui/test/toolArgsHeader.e2e.mjs, packages/webui/test/legacyEditCounts.test.mjs, packages/webui/test/legacyEditCounts.e2e.mjs
Secondary files: packages/webui/test/threadCardSurfaces.e2e.mjs

## Purpose

Renders tool call/response timeline items in the chat web UI, displaying function calls with their arguments, responses, diffs, execution commands/output, and progress indicators. Handles grouping, collapsing, syntax highlighting, and visual status (success/error/neutral) for tool interactions.

## Key Exports

- `InterleavedToolGroup` — renders grouped tool call/response pairs from adjacent messages
- `ToolCallsBlock` — renders tool calls from a single message (no responses yet)
- `ToolResponsesBlock` — renders tool responses from a single message (orphaned)
- `ToolGroupSummaryCard` — collapsed summary card for a group of tool calls
- `getToolResponseStatus` — determines success/error status of a tool response
- `OpenCodeFileHandler` / `ToolCodePath` — callback contract and plain-path wrapper with a keyboard-accessible Code icon action for supported direct file-tool paths
- `ExecCommandText` — syntax-highlighted shell command with heredoc support
- `ExecOutputText` — syntax-highlighted or ANSI-parsed command output
- `ToolScriptProgressContext` — React context providing tool script sub-call progress data

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `formatToolResponseText(resp)` | ~1 | Delegates to shared WebUI response formatter for the full response payload |
| `getSendFileDownload(call, resp)` | ~20 | Extracts download URL/filename for send_file tool responses |
| `ToolDownloadButton({ url, fileName })` | ~15 | Renders a styled download button that triggers browser download |
| `ToolGroupSummaryCard({ items, onExpand })` | ~15 | Collapsed card showing tool tags with expand toggle |
| `getToolDisplayLabel(call)` | ~1 | Formats a human-readable label for a tool call |
| `getToolResponseStatus(resp)` | ~8 | Returns 'success' or 'error' based on response content |
| `getToolPairStatus(responses, imageParts)` | ~7 | Derives tone (success/error/neutral) for a call-response pair |
| `truncatePreviewText(text, maxLength)` | ~3 | Truncates text with ellipsis at max length |
| `isLegacyDiffToolName(name)` | ~1 | Checks if tool name is legacy edit/edit_memory |
| `isPatchToolName(name)` | ~1 | Checks if tool name is apply_patch/apply_patch_memory |
| `hasLegacyDiffPayload(call)` | ~2 | Checks if call has oldText/newText args |
| `countLogicalPayloadLines(text)` | ~5 | Counts legacy edit payload lines without treating empty text or a trailing terminator as an extra line |
| `getLegacyEditLineCounts(oldText, newText)` | ~4 | Returns removed/added logical-line counts for a legacy edit preview |
| `isStreamingPartialToolCall(modelMessage)` | ~1 | Detects synthetic streaming assistant tool calls whose args are intentionally incomplete |
| `renderToolCallPreview(call)` | ~80 | Renders inline preview content for various tool types |
| `renderToolResponsePreview(call, resp)` | ~40 | Renders inline preview of tool response content |
| `ToolCallResponseItem({ call, responses, ... })` | ~120 | Main component rendering a single tool call with its response(s) |
| `ToolCallResponseItemInner({ call, responses, ... })` | ~100 | Inner content of a tool item (header, body, response details) |
| `ToolResponseBody({ call, resp, viewMode })` | ~60 | Renders response body with diff, exec output, or raw text |
| `ToolCallBody({ call, viewMode })` | ~50 | Renders call arguments body (diff preview, command, or raw JSON) |
| `ToolScriptSubCallsSection({ subCalls })` | ~30 | Renders nested sub-call progress items for tool scripts |
| `getGroupedToolEntries(msg, nextMsg, prefix)` | ~60 | Groups function calls with matching responses/images by toolUseId |
| `InterleavedToolGroup({ msg, nextMsg, ... })` | ~10 | Memo wrapper rendering grouped tool entries |
| `ToolCallsBlock({ msg })` | ~8 | Renders all function calls from a message |
| `ToolResponsesBlock({ msg })` | ~10 | Renders all function responses from a message |
| `getHeredocFilePathFromMarker(marker)` | ~12 | Maps heredoc marker string to a virtual file path for highlighting |
| `getHeredocFilePathFromCommand(line, marker)` | ~12 | Infers heredoc language from command context |
| `ExecCommandText({ command, heredocBodyBlock })` | ~40 | Parses command into shell/heredoc segments with syntax highlighting |
| `hasAnsiEscape(text)` | ~1 | Detects ANSI escape sequences in text |
| `extractCodeLikePaths(text)` | ~10 | Extracts file paths from text using regex |
| `inferExecOutputFilePath(command, output)` | ~20 | Heuristically determines output language for syntax highlighting |
| `ExecOutputText({ text, command })` | ~5 | Renders exec output with inferred syntax highlighting or ANSI parsing |

## Dependencies

- `./chatShared` — shared types (`FunctionCall`, `FunctionResponse`, `Message`, `MessagePart`, `ToolScriptSubCall`, `ToolTagItem`, `ToolViewMode`), utilities (`formatToolLabel`, `formatCompactObjectPreview`, `parseApplyPatchPreview`, `buildPatchHunkSnippets`, `clampContentStyle`, `parseAnsi`), and UI components (`IconToggleButton`, `MiniToggleButton`, `ToolTag`, `ToolTagList`, `SessionHashLink`)
- `../../../shared/src/toolResponseFormatting` — `formatCompactObjectPreview`
- `../../../shared/src/webuiToolRendering` — pure helpers for streaming partial-tool guards and session-link text parsing tests
- `./ImageParts` — renders image message parts
- `./SyntaxHighlightedText` — code syntax highlighting component
- `./downloadShared` — `buildPathDownloadUrl`, `triggerBrowserDownload`
- `./DiffPreview` — renders diff/patch previews
- `./ThreadLineButton` — collapsible thread line toggle

## Behavior

- Tool items are collapsible: clicking the thread line or the top tag/call-summary row toggles expanded/collapsed state; the surrounding card, expanded call arguments, and result content are not collapse targets.
- View mode toggles between "preview" (formatted diff/command) and "raw" (JSON) display
- Default tool response rendering formats the whole `functionResponse.response` object via the shared WebUI formatter. Single-key objects (for example `{ output: "ok" }` or `{ error: "bad" }`) display the single value, while multi-key objects stay structured/YAML-like. Special renderers such as exec/read still use this formatter as their fallback for non-standard or error-shaped results.
- Streaming/partial tool calls are intentionally lightweight: when the parent model message is the synthetic streaming draft, call previews and expanded bodies show the latest raw argument text without parsing heavy or incomplete inputs (for example `apply_patch`). Provider updates are throttled to at most once per second, and rich patch/diff rendering remains deferred until the finalized tool call arrives.
- Inter-session tool responses link session ids in output text. `send_to_session` renders its literal `To` prefix as ordinary inherited tool-call text, links concrete target session ids from call args, and renders special aliases `<main>` / `<parent>` as monospace text rather than session links; `create_child_session` output such as `Child session created: \`...\`` is linkified in the response preview/body.
- `session` tool calls have a concise custom preview (`session status` or `session list start=N count=M`) and use compact raw-args rendering when expanded.
- `getGroupedToolEntries` correlates function calls with their responses and image parts by `toolUseId`, handling orphaned responses and unmatched images
- `ExecCommandText` parses shell commands to detect heredoc blocks and applies per-language syntax highlighting to heredoc bodies
- `ExecOutputText` infers output language from command context or content heuristics (JSON detection, import patterns, HTML tags)
- Tool script sub-calls are rendered via `ToolScriptProgressContext`, showing nested progress for composite tool operations
- Status-based theming (success/error/neutral) applies to thread lines, headers, and surface backgrounds. Standard treatment retains the established tone-specific opacity composition. Console treatment consumes the complete success/error surface pairs and uses its panel/hover pair for neutral cards and group summaries.
- Tool tags carry the shared `data-tool-tag-tone` hook even when they are rendered through `ToolTagList` and have no `.foxwarm-tool-tag` class. Standard tag classes remain unchanged; console treatment consumes final neutral/input, success, error, and system tag surfaces through the shared tone hook.
- Tool cards and diff previews expose semantic CSS hooks (`foxwarm-tool-card`, `foxwarm-tool-tone-*`, `foxwarm-tool-header`, `foxwarm-tool-tag`, `foxwarm-tool-thread-line`, `foxwarm-tool-action-buttons-*`, `foxwarm-diff-*`) so opt-in UI style layers can map success/error/neutral and diff added/removed states to alternate palettes without changing tool grouping or response rendering logic.
- Default-view call arguments remain inside the tone-specific `foxwarm-tool-header` region in both collapsed and expanded states. Collapsed arguments use the compact one-line summary; expanded arguments wrap below the tag row inside the same header background. Result previews and expanded results remain on the lighter card surface, without a call/result divider. Separators between multiple result items remain result-local.
- Finalized direct `read`, `write`, and `edit` cards render `filePath` as ordinary text. When the parent supplies a current-node handler, a compact native Code icon button immediately before that text is the only open-file action. Collapsed tool-call headers remain exactly one no-wrap line clipped inside their shrinkable flex slot with an ellipsis; the icon preserves bridge access without making the path intercept the normal header toggle. A `read` path consumes the shrinkable portion while its fixed `(lines …)` suffix stays visible on the same shared header baseline. Direct `apply_patch` uses the existing parsed operation list: single-file collapsed previews and expanded Update/Add headings use the same icon action, while multi-file summaries and deleted-file headings stay non-actionable. `read` forwards its one-based start/end lines. Memory tools and nested unified tool calls keep their existing plain rendering.
- Collapsed legacy `edit` and `edit_memory` headers count logical old/new payload lines independently: empty text is zero lines, LF/CRLF/CR terminators are equivalent, and a final terminator does not add a phantom line while terminator-only payloads preserve their blank lines. Zero-count sides and their separator are omitted; the path remains visible when both sides are zero. The separate parsed `apply_patch` summary contract is unchanged.

## Integration

- Consumed by the chat message rendering pipeline to display tool use within conversation threads
- `ToolScriptProgressContext` is provided by a parent component and consumed here to show real-time tool script progress
- Relies on `chatShared` for the core message/part type system and formatting utilities shared across the chat UI
- `DiffPreview` and `SyntaxHighlightedText` handle rich code rendering within tool bodies
- Download functionality connects to the authenticated `/download?path=...` route used by WebUI `send_file` results

## Design Decisions

### D-webui-tool-call-region

The tool tag, action controls, and call arguments form one continuous tone-specific header region in the default view, regardless of collapse state. Expanding changes the arguments from the one-line ellipsized preview to the existing rich wrapping renderer inside that header; it does not move arguments into the result surface. Only the top tag/call-summary row and thread line advertise and handle collapse toggling; the surrounding header/card and call/result content keep ordinary cursors and are not toggle targets. Hovering the toggle row does not recolor or brighten its normal tone/text colors; distinct hover feedback remains local to Code links, buttons/actions, and the thread-line control. Tool results retain the lighter card surface and are separated by background contrast rather than a divider between call and result. Preserve the existing view modes, status tones, result-local separators, Code actions, and ToolScript progress behavior.

- [2026-09-03] Tool surface composition follows the selected component treatment. Standard keeps its longstanding semantic-plus-opacity classes. Console overrides neutral body/header to panel/hover and consumes success/error `Surface`/`SurfaceStrong` directly, avoiding a second dilution of manifest alpha while keeping the call/header region visibly distinct from the result region. Canonical theme contract: [D-webui-theme-final-surfaces](./webui-theme-system.md#d-webui-theme-final-surfaces).
- [2026-09-04] ToolTag tone allocation is shared across individual tools and Tool Group summaries. Do not depend on `.foxwarm-tool-tag`: `data-tool-tag-tone` is the stable boundary that lets console treatment consume final tag colors while Default retains its existing declarations.

- [2026-09-03] Diff rendering uses semantic removed/added tokens for line surfaces, stronger inline token surfaces, counts, and headers. The console component treatment retains its orange/green grammar through `foxwarm-diff-*` hooks, but colors originate in the selected manifest; no rule branches on the 550A theme ID. Canonical theme contract: [D-webui-theme-runtime-parity](./webui-theme-system.md#d-webui-theme-runtime-parity).
- [2026-09-03] WebUI streaming tool cards show bounded raw partial arguments at the model-stream emitter's one-second cadence, while avoiding heavy or semantic parsing of incomplete inputs. Rich patch/diff rendering and validation remain deferred until finalized call arguments are present.
- [2026-06-17] `create_child_session` tool output should link the created child session id in the same SPA hash-link style used by `send_to_session` and model/system text session links.
- [2026-07-02] `send_to_session` special aliases `<main>` and `<parent>` should not be rendered as clickable session links because they are not literal session IDs; render them as alias text in both preview and expanded views.
- [2026-07-25] Direct current-node `read`, `write`, `edit`, and actionable `apply_patch` paths remain ordinary non-action text. When a current Code handler exists, render one small native keyboard-accessible Code/open-file icon immediately before the path; only the icon stops propagation and opens Code, preserving read ranges. The path itself participates in the normal collapsed header toggle. Keep memory/nested-tool paths non-actionable until those namespaces have exact resolution support. Expanded path text continues to wrap without widening the card; collapsed call-args headers remain one line with container-local `overflow:hidden` + ellipsis, and the icon/path pair shrinks within that boundary.
