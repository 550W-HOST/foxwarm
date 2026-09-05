# Unit: webui-small-components

Files: packages/webui/src/components/ContentHeader.tsx, packages/webui/src/components/ContextMenu.tsx, packages/webui/src/components/AgentCreationMenu.tsx, packages/webui/src/agentCreation.ts, packages/webui/src/components/CreateTabButton.tsx, packages/webui/src/components/CodeLaunchButton.tsx, packages/webui/src/components/NodeTargetSelect.tsx, packages/webui/src/launcherDraft.ts, packages/webui/src/components/ImageParts.tsx, packages/webui/src/components/ProcessingStatus.tsx, packages/webui/src/components/ReasoningCard.tsx, packages/webui/src/components/ReloadAppButton.tsx, packages/webui/src/components/Sidebar.tsx, packages/webui/src/components/SpecialBlock.tsx, packages/webui/src/components/SyntaxHighlightedText.tsx, packages/webui/src/components/ThreadLineButton.tsx, packages/webui/src/utils/languages.ts, packages/webui/test/processingStatus.test.mjs, packages/webui/test/imageParts.e2e.mjs, packages/webui/test/launcherDraft.test.mjs, packages/webui/test/specialBlocks.e2e.mjs
Secondary files: packages/webui/src/components/CollapsedSidebar.tsx, packages/webui/src/components/ModelThreadCard.tsx

## Purpose

A collection of small, reusable React UI components and utility functions for the Foxwarm web interface, providing layout primitives (headers, sidebars, context menus), display widgets (syntax highlighting, image previews, processing indicators), and language detection utilities.

## Key Exports

- `ContentHeader` — Page/section header with icon, title, optional back button and actions
- `ContextMenu` — Portal-based positioned context menu with keyboard/click-outside dismissal
- `CollapsedSidebar` — Fixed-width collapsed sidebar rail with expand/new-session controls and root-session avatar buttons
- `AgentCreationMenu` — Shared Agents `+` dropdown and simple new-agent/new-session modals, including inline validation/loading/error states
- `agentCreation` helpers — Client validation and request-body helpers that omit an empty session ID so the backend generates the existing random name
- `CreateTabButton` — Split button for creating terminal tabs with custom node/path options
- `CodeLaunchButton` — Sidebar split button for opening Code at a remembered node/path and controlling the global new-browser-tab default
- `NodeTargetSelect` — Shared capability-aware Code/terminal node selector
- `ImageParts` — Renders safe image attachments from legacy inline data or current authenticated blob URLs
- `ProcessingStatus` — Canonical thinking/tool/waiting status indicator plus queued/loading actions
- `ReasoningCard` — Collapsible card displaying AI reasoning/thinking content with markdown rendering through the shared model-thread-card chrome
- `ReloadAppButton` — Button that clears service workers and caches before hard-reloading
- `Sidebar` — Main application sidebar with session list, navigation, and settings
- `SyntaxHighlightedText` — Lightweight regex-based syntax highlighter for code snippets
- `ThreadLineButton` — Vertical thread-line toggle button for expand/collapse interactions
- `SpecialBlock` / `MermaidDiagram` — per-block rendered/raw/copy UI shared by display LaTeX and lazy strict Mermaid rendering
- `inferSimpleLanguage` — Maps file paths to a simplified language enum
- `getMonacoLanguage` — Maps file paths to Monaco editor language identifiers
- `SimpleLanguage` (type) — Union type of supported language identifiers

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `ContentHeader({ ... })` | ~15–55 | Renders a page header with icon, title, back button, and action slots |
| `ContextMenu({ ... })` | ~40–130 | Positioned dropdown menu with portal rendering and viewport clamping |
| `getSessionInitial(session)` | (CollapsedSidebar.tsx) | Derives a single visible initial/avatar from display name or session id |
| `CollapsedSidebar({ ... })` | (CollapsedSidebar.tsx) | Renders the compact rail with expand/new-session buttons and top root sessions |
| `AgentCreationMenu({ ... })` | (AgentCreationMenu.tsx) | Renders the creation dropdown plus agent/session modal flows shared by desktop and mobile expanded sidebars |
| `buildSessionCreationBody(agentId, sessionId)` | (agentCreation.ts) | Omits blank session IDs so random backend naming remains authoritative |
| `CreateTabButton({ ... })` | ~50–110 | Split button with dropdown form for custom terminal tab creation |
| `selectLauncherDraftNode(draft, nodeId)` | `launcherDraft.ts` | Preserve a same-node draft or reset a changed node's path to `/` |
| `ImageItem({ part, label })` | `ImageParts.tsx` | Resolves deployment-relative blob URLs, enforces safe-raster inline policy, and reports load failure |
| `ImageParts({ ... })` | `ImageParts.tsx` | Renders a grid of image thumbnails or download-only attachment links |
| `ProcessingStatus({ ... })` | ~15–145 | Shows canonical thinking/tool/waiting summaries, state-specific dots and queue actions, with legacy busy fallback |
| `extractOpenAIReasoningSummaryTitles(text)` | ~55–68 | Extracts bold-formatted summary titles from reasoning text |
| `getReasoningPreview(text)` | ~70–75 | Returns collapsed preview text for reasoning card header |
| `ReasoningCard({ ... })` | ~78–120 | Expandable card rendering markdown reasoning with debounce support |
| `hardReloadApp()` | ~5–15 | Unregisters service workers, clears caches, then reloads the page |
| `ReloadAppButton({ ... })` | ~18–35 | Button component wrapping hardReloadApp with loading state |
| `Sidebar({ ... })` | ~65–145 | Full sidebar layout with branding, nav buttons, tab creators, and session list |
| `buildCodeRegex(language)` | ~50–75 | Constructs a tokenizing regex for a given language |
| `classifyToken(language, value)` | ~77–90 | Determines token kind (keyword, string, comment, etc.) from matched text |
| `SyntaxHighlightedText({ text, filePath })` | ~92–115 | Tokenizes and wraps code text in colored spans |
| `ThreadLineButton({ ... })` | ~10–30 | Accessible full-height thread gutter toggle with a fixed aligned 2px line and responsive 14px/18px hit width |
| `SpecialBlock({ kind, label, raw, children })` | `SpecialBlock.tsx` | Reusable special-rendering surface with exact raw view/copy feedback |
| `MermaidDiagram({ source })` | `SpecialBlock.tsx` | Lazy static Mermaid rendering with pre-render network/interaction rejection, dedicated SVG sanitization, theme refresh, and bounded error recovery |
| `inferSimpleLanguage(filePath)` | ~30–95 | Maps file extension/name to a SimpleLanguage value |
| `getMonacoLanguage(filePath)` | ~97–110 | Converts SimpleLanguage to Monaco editor language string |
| `basename(filePath)` | ~25 | Extracts lowercase filename from a path |
| `extension(filePath)` | ~26–29 | Extracts file extension including the dot |
| `keywordPattern(words)` | ~30 | Builds a word-boundary alternation regex string from keyword list |

## Dependencies

- `./chatShared` — `MessagePart` type, `getCollapsedReasoningPreview`, `handleMarkdownLinkClick`, `renderMarkdown`, `ToolTag`
- `./SessionListCore` — `SessionListCore` component and `Session` type
- `./GlobalUiSettingsMenu` — Settings menu component used in Sidebar
- `./AgentCreationMenu` / `../agentCreation` — Shared creation menu/modals and request validation helpers
- `../utils/languages` — `inferSimpleLanguage`, `SimpleLanguage` type
- `../config` — deployment-relative `makeApiUrl` for authenticated blob delivery

## Behavior

- `ContextMenu` uses `createPortal` to render outside the component tree, calculates position with `useLayoutEffect`, and auto-dismisses on outside click, Escape, or resize. Captured scroll keeps point-anchored menus open at their viewport position and dismisses rect-anchored menus whose trigger can move.
- `CollapsedSidebar` filters to unarchived root sessions, shows at most 20 avatars, highlights the active session, displays the canonical runtime-state dot at top-right, and independently displays unread idle completion at bottom-right with accessible title/name text. The unread contract is canonical in [webui-session-list](./webui-session-list.md#design-decisions).
- `ReasoningCard` debounces content updates, detects OpenAI-style bold summary titles for collapsed preview, and renders full markdown when expanded. Its chrome comes from the shared `ModelThreadCard` owned by [webui-chat-timeline](./webui-chat-timeline.md).
- `ReasoningCard` exposes semantic CSS hooks (`foxwarm-reasoning-card`, `foxwarm-reasoning-card-*`, `foxwarm-reasoning-thread-line`, `foxwarm-reasoning-header`, `foxwarm-reasoning-tag`, `foxwarm-reasoning-preview`, `foxwarm-reasoning-body`) so optional UI style layers can retheme reasoning surfaces without duplicating reasoning rendering logic.
- `ThreadLineButton` keeps its negative-left placement and 2px line aligned to the card edge while using a 14px hit width below `sm` and 18px at `sm` and above. The outer strip remains clickable; the 2px removed from the card/text side reduces accidental interception. Its shared overflow and interaction contract is canonical in [D-webui-timeline-overflow-boundary](./webui-chat-timeline.md#d-webui-timeline-overflow-boundary).
- `ImageParts` renders PNG/JPEG/GIF/WebP through direct same-origin authenticated URLs with lazy loading, exposes active/unsafe formats as download links, and shows an explicit unavailable state for transport-marked legacy failures or load errors. Canonical persistence and transport behavior: [image blob lifecycle](../threads/image-blob-lifecycle.md).
- `ProcessingStatus` uses the shared runtime summary, but presents the requesting-model label as `Thinking...`: thinking is blue and animated, running tools are purple and animated, and waiting is amber with one static dot and no Stop action. Active states retain Stop, queued work retains Run queued and explains whether insertion follows the current tool call/model response or session resume, and idle queued work stays a pending action. An idle incomplete turn is an amber static `Turn interrupted` status with Continue; when queue work also exists it keeps the pending count, Run queued, and queued preview. Continue never appears while loading, active, or waiting. The loading indicator remains independent and unchanged.
- In the console component treatment, both finished and processing Reasoning cards use the neutral panel/input/hover/border/text grammar; processing may use the stronger neutral hover surface but does not claim the blue semantic allocation reserved for System cards. The canonical color allocation is [D-webui-thread-card-color-allocation](./webui-chat-timeline.md#d-webui-thread-card-color-allocation).
- `hardReloadApp` performs a destructive cache/service-worker purge before triggering `window.location.reload()`.
- `SyntaxHighlightedText` performs client-side regex tokenization without external highlighting libraries; classification is heuristic-based per language.
- `SpecialBlock` owns only per-block disclosure, copy state, and format-specific compact chrome, while its rendered child owns the format-specific work. Its LaTeX variant is transparent and borderless and removes the nested KaTeX display margin; Mermaid retains the labeled panel chrome. `MermaidDiagram` dynamically imports Mermaid on demand and keeps malformed model output recoverable through the parent block's exact Raw view. The canonical parser, security, header, spacing, and control-visibility contract is [D-webui-assistant-special-blocks](./webui-chat-shared.md#d-webui-assistant-special-blocks).
- `CreateTabButton` manages local dropdown state with click-outside detection and syncs terminal defaults from props via effects; it no longer displays a session/default-context hint because terminal creation is cwd/node-based.
- Its fixed 20rem dropdown also has a viewport-relative maximum width so the same split button remains usable inside the narrow Code-embedded sidebar.
- Main `CreateTabButton` and `CodeLaunchButton` selectors show approved offline/incompatible nodes disabled, preserve a stale selected node as unavailable, and apply service-specific requirements through `NodeTargetSelect`. The Code-embedded leaf does not receive the selectable node list because its fixed host message has no target fields.
- Selecting a different node in either main launcher dropdown updates the local draft node and resets its draft path to `/`; switching again resets again, while rerenders, node-list refreshes, same-node selections, and external default synchronization do not trigger this reset or persist the draft. Code also clears its local path error on an actual node change.
- `CodeLaunchButton` validates absolute POSIX paths before opening, shows inline errors for invalid input, and exposes controlled node/path/open-mode callbacks so `App` owns global persistence.

## Integration

- `Sidebar` composes `SessionListCore`, `AgentCreationMenu`, `CreateTabButton`, and `GlobalUiSettingsMenu` to form the app's primary navigation surface; `CollapsedSidebar` is the desktop collapsed-state counterpart wired by `App.tsx` to the same session open/new-session callbacks.
- `ReasoningCard` and `ThreadLineButton` are used within chat message rendering to display collapsible AI thinking blocks.
- `ProcessingStatus` and `ImageParts` plug into the chat view to show session activity and inline images.
- `ContentHeader` is a generic layout primitive used across detail/settings pages.
- `inferSimpleLanguage` / `getMonacoLanguage` are shared by both `SyntaxHighlightedText` and the Monaco-based code editor elsewhere in the app.

## Design Decisions

### D-context-menu-scroll-policy

[2026-08-14] Point-anchored context menus keep their captured viewport position through scroll events, including unrelated background streaming scroll. Rect-anchored menus close on scroll because their trigger geometry can move. Both forms continue to close on outside interaction, Escape, and viewport resize.
