# Unit: Application shell, embedding, and transport configuration

Files: `packages/webui/src/App.tsx`, `packages/webui/src/EmbeddedWebUiApp.tsx`, `packages/webui/src/PopupWebUiApp.tsx`, `packages/webui/src/agentCreation.ts`, `packages/webui/src/config.ts`, `packages/webui/src/embeddedWebUi.ts`, `packages/webui/src/index.css`, `packages/webui/src/main.tsx`, `packages/webui/src/popupWebUi.ts`, `packages/webui/src/vite-env.d.ts`

## Purpose

Bootstraps React, popup/embedded variants, host configuration, and Session/Agent creation entry points.

## Stable symbols and callers

`App`; `EmbeddedWebUiApp`; `PopupWebUiApp`; `main.tsx`; `embeddedWebUi.ts`; `popupWebUi.ts`.

Callers and boundary: Static assets served by .NET `HttpServer`; host auth and route DTOs remain server-owned.

## Behavior and side effects

`App` chooses the embedded/popup/full host variant, initializes auth/config/session providers, and mounts shared navigation. `attachmentSend` and Agent creation entry points hand requests to host APIs; static asset/base-path handling stays deployment-relative. Startup failures remain visible setup/auth states rather than silently creating a local Session.

## Tests

setupModels, launcher, and app-shell tests.
