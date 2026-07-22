# Module: WebUI

## Responsibility

Owns the browser application and WebUI-facing server surface: workbench/session navigation, chat/history streaming, message/tool rendering, composer/ASR, setup/settings, terminal client, and optional Code integration.

## Units

- [webui-app](../units/webui-app.md) — entry, routing, global list state, embedded leaf roots, URL helpers, and Code frame host.
- [webui-session-list](../units/webui-session-list.md) — hierarchy, search, order, pinning, and drag behavior.
- [webui-architecture-view](../units/webui-architecture-view.md) — agent/session architecture.
- [webui-chat](../units/webui-chat.md) — per-session history, SSE, sending/commands, ASR, and viewport state.
- [webui-chat-composer](../units/webui-chat-composer.md) — draft/input, autocomplete, attachments, and model controls.
- [webui-chat-shared](../units/webui-chat-shared.md), [timeline](../units/webui-chat-timeline.md), [tool timeline](../units/webui-tool-timeline.md) — sanitized rendering and progress/tool cards.
- [webui-workbench](../units/webui-workbench.md) — persisted tab/pane layout and compatibility normalization.
- [webui-setup-view](../units/webui-setup-view.md), [webui-settings](../units/webui-settings.md), [settings menu](../units/webui-settings-menu.md).
- [webui-terminal](../units/webui-terminal.md) — xterm browser client.
- [webui-editor](../units/webui-editor.md), [small components](../units/webui-small-components.md).
- [src-channels-webui](../units/src-channels-webui.md) — authenticated HTTP/SSE/upload/setup/terminal routes.
- [VS Code Web routes](../units/src-vscode-web-routes.md) and [extensions](../units/vscode-web-extensions.md).

## URL and transport boundaries

- `API_BASE_PATH` is the current page pathname (without trailing slash) plus `/api`.
- REST and EventSource paths normally append to `API_BASE_PATH`.
- `makeApiUrl` returns a URL object; `makeWebSocketUrl` changes its protocol to `ws:`/`wss:`.
- Code routes remove the `/api` suffix and append deployment-relative `/vscode-web/`.
- Main WebUI and the persistent Code frame validate exact origin plus window source. Nested Foxwarm leaf iframes post to their parent with `'*'`; the outer Code extension validates exact source plus channel/version/random nonce (not `event.origin`), then sends outer-to-inner messages to the exact leaf `frameOrigin`. These bridges are not API URL transport.
- Download and extension routes preserve reverse-proxy prefixes and do not assume site root.

## State ownership

- Mounted Chat owns one session's history and per-session SSE/runtime state.
- App/Sidebar/Architecture own global list data and the independent global stream; overlapping list requests are latest-wins.
- Workbench store owns tab/pane/split layout. Chat viewport state is ephemeral in-memory state keyed by canonical session ID.
- Browser-only theme/layout/draft/Code preferences remain local; instance name/icon are server settings.

## Invariants

- Markdown is sanitized; math supports only documented delimiters with trusted rendering disabled.
- Strict commit markers are model-only standalone lines outside code fences and stay inert until clicked.
- CTX-BLOCK expansion is local read-only preview and never mutates session/frontier/queue.
- Chat/tool/markdown containers remain shrinkable; only intentional inner table/output surfaces own horizontal scrolling.
- Browser terminals are identified by node and cwd, not chat session ID.
- Optional official Code assets remain outside the main WebUI bundle.
- Missing model configuration forces the singleton Setup tab and prevents it from closing until setup status clears.

## Canonical threads

- [streaming pipeline](../threads/streaming-pipeline.md)
- [context compaction and recall](../threads/context-compaction-and-recall.md)
- [Code integration](../threads/code-integration.md)
- [node communication](../threads/node-communication.md)

## Compatibility

- Supported legacy bracketed system/source history remains renderable.
- Old workbench `workspace`/`file` tabs are removed during read normalization; current writes never recreate them.
- Old `#agents`/`#architecture` and `#setup`/`#oobe` hashes hydrate current singleton system tabs.

## Design decisions

### D-webui-dynamic-base-path

All REST, SSE, WebSocket, download, Code, extension, and embedded URLs derive from the active deployment path/origin. Site-root assumptions are invalid.

### D-webui-workbench-shell

Chat, terminal, Agents, Setup, and Code use one tab/pane workbench. Agents and Setup are singleton tabs; forced initial Setup is non-closable.

### D-webui-session-stream-ownership

Mounted Chat owns per-session state/stream. Global list streaming remains for list-wide UI and never substitutes for Chat runtime state.

### D-webui-removed-workspace

The former custom workspace/file browser remains removed. Persisted records are discarded; Code is the supported browser editing integration.

## Canonical ownership

Commit marker ownership: [D-code-model-commit-marker](../threads/code-integration.md#d-code-model-commit-marker). Chat follow ownership: [D-chat-user-follow-intent](../units/webui-chat.md#d-chat-user-follow-intent).
