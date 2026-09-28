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

## Separate .NET Chat experiment

This experiment branch can build a small shell around the **same** Chat, composer, timeline, and realtime client used by the normal WebUI. It is not an alternative full App, agent sidebar, Setup, or Code/Terminal UI. From this frontend worktree:

```sh
VITE_FOXWARM_EXPERIMENT_CHAT=1 npm --prefix packages/webui run build
```

Give the resulting `packages/webui/dist` path to a separate, explicitly configured `.NET Foxwarm.ExperimentHost` via `FOXWARM_EXPERIMENT_WEBUI_DIST`. Start the host on its configured loopback port, open `/` in a browser, enter the local host API token on the login form, then create or select a Session. The token is exchanged for an HTTP-only SameSite-Strict cookie; it does not appear in the URL, frontend bundle, localStorage, or provider request. This is local HTTP-only experimental authentication, not a public deployment recommendation.

The experiment-only build flag changes only the top-level entry. Ordinary builds retain the production App and all ordinary Chat capabilities by default. The experimental shell exposes text Chat, the fixed configured model label, actual session history and queued previews, live assistant/tool cards, and Stop. It hides attachment/ASR, Debug, model/child/effort changes, Setup/Agents/Code/Terminal, Run queued and Continue; unsupported slash commands receive an explicit error from the host rather than reaching the model. Pure browser-local display/input preferences remain.

For a single real-browser, local-scripted-Responses end-to-end run, set `DOTNET_ROOT` and `FOXWARM_EXPERIMENT_HOST_DLL` to the private SDK and built host, then run `node packages/webui/test/experimentHostChat.e2e.mjs` inside a bounded process-tree test runner. The driver owns a temporary authority/tool root, provider listener, two serial host processes and Chromium; no live provider endpoint is used. The host worktree README documents its exact environment/route subset. Do not point either experiment at an existing Foxwarm data directory.

## Architecture

- Frontend: React + Vite + Tailwind CSS
- Backend: Express HTTP API (port 3001)
- API endpoints:
  - POST /api/auth - Authenticate with token
  - GET /api/sessions - List all sessions
  - GET /api/sessions/:id/history - Get session history
  - POST /api/sessions/:id/message - Send message to session
