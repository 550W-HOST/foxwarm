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

## Architecture

- Frontend: React + Vite + Tailwind CSS
- Backend: Express HTTP API (port 3001)
- API endpoints:
  - POST /api/auth - Authenticate with token
  - GET /api/sessions - List all sessions
  - GET /api/sessions/:id/history - Get session history
  - POST /api/sessions/:id/message - Send message to session
