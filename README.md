# Foxwarm 🦊

Foxwarm is a lightweight, extensible AI assistant framework for development-oriented workflows. It combines WebUI chat, long-term memory, tool calling, agents/sessions, skills, channels, and optional remote nodes in a small TypeScript codebase.

## Features

- **WebUI + Channels**: WebUI, Telegram, Matrix, WeChat Work, Weixin, and external trigger support
- **Agents, Sessions, and Skills**: Separate long-lived memory/workspaces from runnable conversation threads
- **Tool Calling**: File operations, shell commands, browser/node tools, session management, and more
- **Persistent Memory**: Agent memory files plus LanceDB-based searchable history
- **Nodes**: Optional remote/browser/CLI/sandbox tool hosts
- **Queue + Compaction**: Serialized session work and context compaction for long-running conversations

## Quick Start: one-line install

The recommended first-time path is the installer script. It clones Foxwarm, builds it, starts it in the normal tmux mode, prints a WebUI URL with token, and attaches to the tmux session.

### Linux / macOS / WSL

```bash
curl -fsSL https://YOUR_PUBLIC_FOXWARM_HOST/install-foxwarm.sh | bash
```

Until the script is hosted publicly, run it from a checkout:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
./install-foxwarm.sh
```

Useful environment overrides:

```bash
FOXWARM_DIR="$HOME/foxwarm" \
FOXWARM_BRANCH=main \
FOXWARM_REPO=https://github.com/550W-HOST/foxwarm.git \
curl -fsSL https://YOUR_PUBLIC_FOXWARM_HOST/install-foxwarm.sh | bash
```

The installer expects Node.js 20+ and npm. If `tmux` is missing, it tries to install it with common package managers (`apt`, `pacman`, `dnf`, `yum`, `zypper`, `brew`).

After startup, the installer prints a URL like:

```text
http://localhost:3001/#token=...
```

It then attaches to tmux. Detach without stopping Foxwarm with:

```text
Ctrl-b then d
```

### Windows PowerShell

```powershell
irm https://YOUR_PUBLIC_FOXWARM_HOST/install-foxwarm.ps1 | iex
```

Until hosted publicly, run from a checkout:

```powershell
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
.\install-foxwarm.ps1
```

The Windows script checks for Git and Node.js/npm, builds Foxwarm, starts it in a new PowerShell window, and opens the WebUI token URL when available.

## Manual install / development start

Use this path if you are developing Foxwarm itself.

### Prerequisites

- Node.js 20+ and npm
- (Optional) Ollama for embeddings / vector memory
- (Optional) Chromium or a browser node for browsing features
- (Optional) tmux for the normal background start mode

### Install and build

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
npm run build-all
```

Do **not** copy `templates/models.example.yaml` into `state/models.yaml` for first-time setup unless you want to configure it manually. If `state/models.yaml` is missing, WebUI enters OOBE and helps create it.

### Start

Foreground:

```bash
npm run start:notmux
```

Normal tmux mode:

```bash
npm start
```

Then open `http://localhost:3001` and log in with the token from:

```bash
cat state/token
```

Other tmux helpers:

```bash
tmux attach -t foxwarm
npm run restart
npm run stop
```

Logs are written under:

```text
state/logs/
```

## Docker Compose

Docker Compose is still supported, but the recommended first-time UX is the installer + WebUI OOBE.

```bash
mkdir -p state agents skills
docker compose up -d --build
```

Open `http://localhost:3001` and use the token from `state/token` or container logs. The compose file mounts `state/`, `agents/`, and `skills/` so configuration and memory persist across rebuilds.

> Note: `.env` may still be useful for Docker Compose variables or legacy migration, but it is no longer the primary Foxwarm application configuration path for new users.

## First Run / OOBE Setup

Foxwarm enters **OOBE** (first-time setup) when:

```text
state/models.yaml
```

does not exist.

After logging into WebUI, the OOBE page cannot be closed until models are configured. Once models are saved, you can use WebUI or any configured channel to ask the agent how to explore Foxwarm.

OOBE/Setup supports:

1. **Models** — creates `state/models.yaml`
2. **Channels** — edits `state/config.yaml` and hot-reloads managed channels

You can later return to the same page from the WebUI setup/settings button.

## Configuration

Foxwarm's current primary configuration files are:

1. `state/config.yaml` — app settings and channels
2. `state/models.yaml` — model providers, model list, and default model
3. `agents/<agent>/memory/` — long-term memory for each agent
4. `skills/<skill>/` — reusable skill documents
5. `state/token` and `state/node_token` — WebUI and node pairing tokens

### Legacy `.env`

`.env` is legacy/compatibility configuration. On startup, if `state/config.yaml` does not exist and `.env` does, Foxwarm can migrate legacy settings into `state/config.yaml`.

For new installs, prefer WebUI Setup or direct edits to:

```text
state/config.yaml
state/models.yaml
```

## Models (`state/models.yaml`)

The WebUI OOBE page can create a basic model config. You can also edit `state/models.yaml` manually.

Preferred schema:

```yaml
default: openai/gpt-5.2-codex
providers:
  openai:
    providerType: openai-completions
    baseUrl: https://api.openai.com/v1
    apiKey: your-openai-key
    models:
      - gpt-5.2-codex
      - gpt-5.3-codex
```

Provider notes:

- `openai-completions` uses `/chat/completions`
- `openai` and `openai-responses` use `/responses`
- `anthropic` uses Anthropic-compatible requests
- OpenAI-compatible local gateways can be configured by changing `baseUrl`, `apiKey`, and model ids

The runtime resolves model definitions in this order:

1. `MODELS_CONFIG_PATH` if set
2. `state/models.yaml`
3. `templates/models.example.yaml` fallback

The template fallback is mainly a fallback for development and diagnostics; OOBE treats missing `state/models.yaml` as first-time setup.

## Channels (`state/config.yaml`) and hot reload

Channels are configured under `channels:` in `state/config.yaml`.

Example Telegram channel:

```yaml
channels:
  telegram:
    type: telegram
    enabled: true
    botToken: "123456:telegram-token"
    mainAttachUser: "your-telegram-user-id"
    allowedUsers:
      - "your-telegram-user-id"
```

Example Weixin channel:

```yaml
channels:
  weixin:
    type: weixin
    enabled: true
    baseUrl: "https://ilinkai.weixin.qq.com"
    token: "token-from-login"
    allowAllUsers: false
```

WebUI Setup can edit channels and then reload them without restarting Foxwarm. The reload flow stops registered managed channels and starts the enabled/configured channels again.

Managed channel types currently include:

- `telegram`
- `matrix`
- `wework`
- `weixin`

Slash-command alternatives are available for runtime inspection and manual control:

```text
/channel status
/channel start <channel-id>
/channel stop <channel-id>
/channel restart <channel-id>
```

## Core Concepts

### Agent

A long-lived workspace + memory container. Agent memory lives under:

```text
agents/<agent>/memory/
```

### Session

A runnable conversation thread bound to an agent. A single agent can have many sessions.

### Skill

A reusable instruction/documentation pack under `skills/<skill>/`. The bundled `about-foxwarm` skill explains Foxwarm concepts after models are configured.

### Tool

An action the assistant can call, such as file operations, shell commands, memory search, session management, or node operations.

### Node

An execution host for tools. `master` is the default local node; remote/browser/CLI/sandbox nodes can be paired and approved.

## Node quick start

From a running Foxwarm WebUI or chat command, inspect node pairing help:

```text
/node pair-help
```

Detailed docs are in:

```text
docs/node-client.md
```

## Common Commands

```text
/session     list, create, fork, move, archive, isolate, index
/agent       list, create, inherit, delete
/model       inspect or switch the current model
/skill       list, attach, detach, inspect skills
/node        list/switch nodes, approve pairings, show pair-help
/channel     inspect and reload channel runtime state
/compact     compact session history
```

## Project Structure

```text
foxwarm/
├── src/                  # TypeScript backend source
├── lib/                  # Compiled JavaScript
├── packages/webui/       # Browser frontend
├── packages/browser-node/# Browser node extension
├── packages/cli-node/    # CLI / interactive node client
├── agents/               # Agent workspaces and memory (runtime data)
├── skills/               # Skill definitions
├── state/                # Runtime state, config, tokens, sessions, logs, db
├── templates/            # Starter templates
├── scripts/              # Start/restart/stop helpers
├── docs/                 # Detailed documentation
└── examples/             # Examples, including ToolScript
```

## Documentation

- [Architecture](docs/architecture.md)
- [Session Management](docs/session-management.md)
- [Multi-Agent Guide](docs/multi-agent.md)
- [Node Client](docs/node-client.md)
- [Vector Memory](docs/vector-memory.md)
- [Development](docs/development.md)
- [ToolScript examples](examples/toolscript/README.md)

## Development

```bash
npm run build        # backend/shared/cli-node build
npm run build-all    # install + build backend and WebUI
npm run dev          # TypeScript watch mode
npm run start:notmux # build + foreground backend start
npm start            # build + tmux start
```

## License

MIT
