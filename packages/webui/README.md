# Foxwarm WebUI

Web interface for Foxwarm.

## Setup

1. Install dependencies:
```bash
cd packages/webui
npm install
```

2. Configure the Foxwarm backend from the repository root through WebUI OOBE,
   or edit the active data directory's `state/models.yaml` and
   `state/config.yaml`. The default backend port is 3001.

3. Start the backend from the Foxwarm repository root:
```bash
npm start
```

4. Start WebUI dev server:
```bash
cd packages/webui
npm run dev
```

5. Open browser: http://localhost:3000

6. Login with your token (in file `state/token`)

## Features

- Token-based authentication
- Session list (left sidebar)
- Chat interface (right panel)
- "main" session is the default session for ONBOOT and channels
- Real-time message history

## Production Build

```bash
cd packages/webui
npm run build
npm run preview
```

## Local .NET host

Build the original App, Sidebar and Workbench for the separate .NET host from the repository root:

```sh
VITE_FOXWARM_DOTNET=1 npm --prefix packages/webui run build
```

Build `dotnet/Foxwarm.sln`, set `FOXWARM_EXPERIMENT_WEBUI_DIST` to this checkout's `packages/webui/dist`, and start the host on its configured loopback port. The small login gate exchanges the local API token for an HTTP-only SameSite-Strict cookie before rendering the ordinary frontend. It does not put credentials into localStorage, URLs, provider requests or the bundle.

The frontend keeps the original Agent/session creation menu, bounded Sidebar/list search/realtime, Chat, composer, timeline, preview/Keep tabs, splits and stored routing. The flag adds login and reuses the existing text-only Chat option. It does not introduce a second App, dynamic capability detection or a feature-hiding layer. Unsupported Setup/Code/Terminal/Agent-management operations may report normal HTTP errors. Ordinary builds retain their original authentication and entry paths.

`experimentHostAgents.e2e.mjs` is the concentrated original-App browser workflow. `experimentHostModelCompact.e2e.mjs` also covers exact model Archive navigation, shared original block expansion, read purity and old-result restart. `experimentHostObservation.e2e.mjs` covers original Chat/name UI, selected-page previews and interval-goal compaction/restore. `experimentHostKnowledge.e2e.mjs` covers original Agent creation/Architecture settings, inherited memory and layered skills across clean restart. `experimentHostWait.e2e.mjs` covers the original Continue button, declared collaboration/exec waits, strict deferred admission and clean-idle restart. Existing Chat/dev-tool/model-compaction drivers use the same entry. Run these manual .NET experiments with a configured .NET 10 SDK and a hard process-tree test limit; they own disposable data/workspaces, localhost scripted Responses listeners, hosts and Chromium. See [the host README](../../dotnet/README.md) for exact boundaries and the [source-port map](../../docs/code-index/units/dotnet.md#source-port-map) for module ownership. Do not use an existing Foxwarm data directory.

## Architecture

- Frontend: React + Vite + Tailwind CSS
- Backend: Express HTTP API (port 3001)
- API endpoints:
  - POST /api/auth - Authenticate with token
  - GET /api/sessions - List all sessions
  - GET /api/sessions/:id/history - Get session history
  - POST /api/sessions/:id/message - Send message to session
