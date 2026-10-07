# Unit: Application shell, embedding, and transport configuration

Files: `packages/webui/src/App.tsx`, `packages/webui/src/EmbeddedWebUiApp.tsx`, `packages/webui/src/PopupWebUiApp.tsx`, `packages/webui/src/agentCreation.ts`, `packages/webui/src/config.ts`, `packages/webui/src/embeddedWebUi.ts`, `packages/webui/src/index.css`, `packages/webui/src/main.tsx`, `packages/webui/src/popupWebUi.ts`, `packages/webui/src/vite-env.d.ts`

## Purpose

Bootstraps React, popup/embedded leaves, host configuration, bounded Session-list invalidation, workbench tab lifecycle, and deployment-relative Code/terminal navigation.

## Stable symbols and callers

`App`; `EmbeddedWebUiApp`; `PopupWebUiApp`; `main.tsx`; `embeddedWebUi.ts`; `popupWebUi.ts`; `API_BASE_PATH`; `makeApiUrl`; `makeWebSocketUrl`; bounded-list request gates; Code/commit-marker URL and message helpers.

## Shell and route contracts

`main.tsx` mounts one normal App or a strict nonce-bearing embedded/popup leaf; leaves do not initialize a hidden full App. Popup/embedded routing is deployment-relative and does not transfer opener state. Setup OOBE is server-controlled: missing model configuration routes to the singleton `system:setup` tab, and close is ignored while setup is required. Hash aliases remain inbound readers while new tab state uses the current singleton IDs.

Tab close/popout updates route state before hydration can recreate a closed active tab; a canceled/no-op drag leaves preview state unchanged. Chat preview/kept state is Session-derived and editing/sending a draft does not keep a preview. The singleton Tasks view and workbench split panes remain store-owned.

## Session list, Code, and authentication boundaries

The normal App uses bounded root/child/exact/search Session-list calls with coalesced generation gates; stale root/child/exact/search responses cannot overwrite newer snapshots. Reconnect/session invalidation coalesces the same refresh intent. The collapsed desktop rail creates its separate bounded 20-root controller only while mounted; expanded desktop/mobile surfaces do not create a second hidden scheduler/subscription.

Code uses a persistent embedded frame/typed nonce bridge and deployment-relative standalone URLs. Exact source/channel/version/nonce checks gate bridge messages; auth tokens never travel in postMessage. A Code frame is created only when its tab is actually displayed, and closing the last embedded Code tab destroys it. Strict commit markers outside code fences become typed open-commit cards; malformed/user text remains text.

Browser auth storage reads only the supported token key. Server branding and node summaries remain authoritative; missing/incompatible selected remote IDs stay unavailable rather than being reassigned to Master. Terminal defaults follow the focused Session/target.

## Tests

`dotnet/Foxwarm.Tests/Channels/WebUiStartupTests.cs` is the host-side counterpart; browser setup/launcher, bounded-session-list, workbench, Code-frame, commit-marker, popup/embedded, and OOBE tests cover this boundary.
