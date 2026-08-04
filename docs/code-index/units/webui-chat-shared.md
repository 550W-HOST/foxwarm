# Unit: webui-chat-shared

Files: packages/webui/src/components/chatShared.tsx, packages/webui/src/components/markdownRenderer.ts, packages/webui/test/markdownRenderer.test.mjs

## Purpose

Shared utilities, types, and rendering helpers for the chat UI components. Provides markdown rendering with sanitization, tool/function call formatting, slash-command autocompletion logic, diff/patch preview parsing, and reusable UI primitives for the chat interface.

## Key Exports

- `formatToolLabel` — generates human-readable labels for tool calls based on name and args, including current unified `call_tool` and hidden direct `call_mcp` compatibility history
- `renderMarkdown` — converts markdown text to sanitized HTML, with KaTeX math support for `\(...\)` and `\[...\]` only
- `renderMarkdownWithSanitizer` — testable markdown renderer variant that accepts an injected sanitizer
- `handleMarkdownLinkClick` — click handler that intercepts links with a confirmation dialog
- `IconToggleButton`, `MiniToggleButton` — small toggle button components
- `copyTextToClipboard` — clipboard utility with fallback
- `getSlashCommandCompletions` — produces autocomplete suggestions for slash commands
- `formatToolResponseSummary` — summarizes tool responses for display
- `parseApplyPatchPreview` — parses patch text into structured preview operations
- `buildPatchHunkSnippets` — extracts old/new text from a patch hunk
- `computeUnifiedDiffLines` — generates unified diff output from two strings
- `formatObject` / `formatCompactObjectPreview` — compact object serialization
- Interfaces: `Message`, `MessagePart`, `FunctionCall`, `FunctionResponse`, `SlashCommandOption`, `SlashCommandCompletion`, `PatchPreviewOperation`, `SessionStreamEvent`, `ViewMode`, `ToolViewMode`
- `ContextBlockMessageMeta` — frontend mirror of rendered CTX-BLOCK metadata placed on `message.__meta.contextBlock`
- `toolMeta` — metadata map (icon, color, label) for known tool names
- `Diff` — re-exported diff library

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `normalizeToolLabelValue(value)` | ~70 | Coerces a value to trimmed string or null |
| `formatToolLabel(name, args)` | ~80 | Builds display label for tool calls by name pattern |
| `sanitizeHtml(html)` | `markdownRenderer.ts` | DOMPurify wrapper with strict allow-lists for ordinary Markdown |
| `renderMarkdownWithSanitizer(text, sanitizer)` | `markdownRenderer.ts` | Parses Markdown, emits KaTeX placeholders, sanitizes ordinary HTML, then replaces placeholders with trusted KaTeX output |
| `renderMarkdown(text)` | `markdownRenderer.ts` | Production Markdown renderer using DOMPurify sanitization |
| `handleMarkdownLinkClick(e)` | ~180 | Intercepts anchor clicks with confirm dialog |
| `IconToggleButton(props)` | ~193 | Small icon toggle button component |
| `MiniToggleButton(props)` | ~200 | Tiny text toggle button component |
| `SessionHashLink({ sessionId })` / `renderSystemTextWithSessionLinks(text)` | ~210 | SPA hash links for recognized session-id text patterns |
| `copyTextToClipboard(text)` | ~207 | Copies text to clipboard with execCommand fallback |
| `formatStructuredSystemText(system)` | ~225 | Formats legacy system text with bracket prefix while passing through foxwarm metadata tag lines |
| `isSystemLikeText(text)` | ~229 | Checks if text looks like legacy system text or a foxwarm metadata tag line |
| `parseFoxwarmMetadataLine(text)` / `isLightweightFoxwarmMetadataLine(text)` | ~230 | Parses foxwarm tag attrs and decides whether metadata is lightweight vs collapsible-heavy |
| `getSystemMessagePreviewDescriptor(message)` / `getSystemMessageKind(message)` | ~255 | Extract the stable heavy-message tag and collapsed-preview metadata, preferring a system kind over non-channel wrappers and legacy fallbacks |
| `THREAD_CARD_HEADER_ROW_CLASS` / `THREAD_CARD_HEADER_PREVIEW_CLASS` | ~420 | Shared one-line collapsed header geometry for thread-card tags and previews |
| `isLightweightStructuredSystem(system)` | ~232 | Checks if system string is lightweight structured |
| `getSlashCommandCompletions(input, commands)` | ~260 | Tokenizes input and returns matching suggestions/hints |
| `formatToolResponseSummary(name, response)` | ~340 | Produces concise summary string for tool responses |
| `computeUnifiedDiffLines(oldText, newText)` | ~430 | Generates array of unified diff line objects |
| `extractPatchEnvelope(input)` | ~470 | Strips markdown fences from patch text |
| `parsePatchUpdateSection(lines, filePath)` | ~490 | Parses update hunks from patch section lines |
| `parsePatchAddSection(lines, filePath)` | ~530 | Parses add-file lines from patch section |
| `parseApplyPatchPreview(input)` | ~545 | Full patch parser returning structured operations |
| `buildPatchHunkSnippets(hunk)` | ~590 | Splits hunk lines into old/new text strings |

## Dependencies

- `../../../shared/src/toolResponseFormatting` — `formatCompactObjectPreview`
- `../../../shared/src/webuiToolRendering` — `parseSessionLinkText` shared with tests for session link text patterns

## Behavior

- Markdown rendering uses `marked` with GFM/breaks, then sanitizes ordinary HTML via DOMPurify with a strict allowlist (no images, scripts, iframes). Links get `target="_blank"` injected.
- GFM table markup stays semantic through rendering/sanitization; the shared `.foxwarm-markdown` CSS, rather than renderer-side HTML rewriting, makes the table itself horizontally scrollable. The renderer unit test guards the retained `<table>/<thead>/<tbody>` structure.
- LaTeX math rendering is implemented in `markdownRenderer.ts` using local `marked` inline/block extensions and KaTeX. Supported delimiters are only `\(...\)` for inline math and `\[...\]` for display math; `$...$` / `$$...$$` are intentionally not parsed. Standalone multiline `\[` / `\]` lines (up to three leading spaces and optional trailing horizontal whitespace) are claimed as one block before Markdown can interpret TeX lines as headings, lists, blockquotes, or other block constructs, including when the block directly follows ordinary paragraph text without a blank line; the existing inline display extension retains one-line and embedded compatibility. Unclosed, empty, trailing-text, and four-space-indented delimiter lines are not claimed as display blocks and do not split preceding paragraphs. The renderer inserts private-use placeholders for math, sanitizes ordinary Markdown output, then replaces placeholders with KaTeX output (`trust:false`, `throwOnError:false`) so normal Markdown does not need global `style`/SVG/MathML allowlist relaxation. Delimiter-like content enclosed by Markdown code spans or fenced code blocks stays inside code tokens and is never rendered as math.
- `getSlashCommandCompletions` tokenizes user input by spaces, walks an autocomplete tree, and returns matching suggestions plus contextual hints. Handles trailing-space logic for advancing to next token.
- `formatToolResponseSummary` has special-case formatting for many tool names (read_file, search, list_directory, bash, etc.), truncating or summarizing output.
- Tool response body rendering itself lives in `ToolTimelineItems`; its default path uses the shared WebUI response formatter on the full `functionResponse.response` payload, so single-key `{ output }` and `{ error }` both display their value while multi-key objects remain structured.
- `formatToolLabel` keeps explicit handling for `remote_node`, `call_tool`, `search_tools`, and persisted/runtime `call_mcp` calls. Current model guidance uses `call_tool` (`tool:mcp:...`), but the renderer still labels compatibility history accurately.
- Patch parsing (`parseApplyPatchPreview`) handles an envelope format (`*** Begin/End Patch`) with update/add/delete file sections, producing typed operation objects for UI rendering.
- `computeUnifiedDiffLines` wraps the `diff` library to produce line-level change objects with type annotations.
- `renderSystemTextWithSessionLinks` recognizes `sessionId: \`...\``, `session \`...\``, inter-session tool output like `Child session created: \`...\``, and only the `sourceSessionId` value of canonical inter-agent XML opening tags, so model/system text and tool renderers share link behavior without linking arbitrary attributes.
- System-like line classification is mixed-format: old `[SYSTEM:]`/`[FROM:]` prefixes remain supported, and new lines matching `^\s*</?foxwarm-(system|metadata|message)\b` are treated as metadata for small-text rendering. `parseFoxwarmMetadataLine` inspects the first line of both single-line and full multi-line wrappers so real direct channel wrappers (`<foxwarm-message type="channel" ...>`), closing tags, and time/session/channel-mode metadata remain lightweight, while non-channel source wrappers (`type="inter-agent"`, `timer`, `trigger`, etc.), `<foxwarm-system kind="event" ...>` wait/event tags, and `<foxwarm-system kind="snapshot" ...>` are heavy/collapsible like legacy non-direct `[SYSTEM:]` messages.
- `getSystemMessagePreviewDescriptor` scans every wrapper line in a heavy message. It skips lightweight system metadata (`time`, `session`, `channel-mode`) and then prefers the first valid heavy `foxwarm-system kind` even when corrupted history also contains a direct channel wrapper; otherwise it uses a non-channel `foxwarm-message type`, with `system` as the legacy/malformed fallback. It exposes only safe collapsed-preview prefixes: `From sourceSessionId` for inter-agent, session-boundary `event`, or event `type`, each only when non-empty. `getSystemMessageKind` returns the descriptor's stable kind/source pair for existing callers.
- `toolMeta`/`ToolTag` maps tool-like names to icons (lucide-react), colors, and display labels for consistent UI rendering. `ToolTag.iconName` lets non-tool timeline cards select dedicated system-kind icons without changing real tool mappings; source-generated heavy kinds cover event, session-boundary, goal/child reminders, managed/session events, system delivery, and BTW, while non-channel wrappers cover inter-agent, timer, trigger, background, and onboot. Snapshot/system-prompt compatibility cards also have stable icons. Unknown system icon names fall back to Bell; unknown real tools retain the Wrench fallback. The shared `system` tag tone uses the blue palette for all heavy timeline system cards; scoped 550A rules preserve that blue allocation rather than applying the global red-blue utility remap.
- The `send_to_session` tool tag uses the same `MessagesSquare` icon as the inter-agent system tag, while unrelated inter-session tool icon mappings remain unchanged.
- `THREAD_CARD_HEADER_ROW_CLASS` and `THREAD_CARD_HEADER_PREVIEW_CLASS` keep collapsed Tool, Reasoning, System, and CTX-BLOCK headers on the same 18px vertical rhythm while retaining each card's own tone and content styling.

## Integration

- Consumed by chat UI components (message rendering, tool call display, input autocomplete). `chatShared.tsx` re-exports the Markdown renderer from `markdownRenderer.ts` to keep existing imports stable.
- Re-exports `formatCompactObjectPreview` from the shared package for use by UI consumers.
- Provides the data structures (`Message`, `SessionStreamEvent`, `PatchPreviewOperation`) that define the chat protocol between frontend and backend.
- `Message.__meta` includes optional `contextBlock`, `contextFrontierItem`, and `preservedFromBlockId` fields so WebUI rendering can use structured layered-context metadata without parsing text as the primary path.
- `toolMeta` drives icon/color rendering in tool call bubbles across the chat interface.

## Design Decisions

- [2026-07-06/2026-07-07] New Foxwarm XML-ish metadata tag lines are display metadata, not Markdown/HTML. `chatShared` should recognize `<foxwarm-system>`, `<foxwarm-metadata>`, `<foxwarm-message>`, closing message tags, and full multi-line wrappers by their first line while preserving old `[SYSTEM:]`/`[FROM:]` rendering compatibility. Do not classify all foxwarm-system tags as lightweight: snapshot/system-prompt tags and event tags such as wait timeouts must trigger left-side system-card rendering. Similarly, only `<foxwarm-message type="channel">` is a lightweight/direct-user wrapper; non-channel foxwarm-message wrappers represent system-delivered/non-direct content and should render left/system-like.
