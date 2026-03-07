# Foxwarm 🦊

Foxwarm is a lightweight, extensible AI assistant framework for development-oriented workflows. It combines multi-channel chat, long-term memory, tool calling, agent/session separation, and optional multi-node execution in a small TypeScript codebase.

## Features

- **Multi-Channel Support**: Telegram, Matrix, WeChat Work, WebUI, and TUI
- **Agents, Sessions, and Skills**: Separate long-lived knowledge from runtime conversation threads
- **Persistent Memory**: Long-term context storage with LanceDB-based retrieval
- **Tool Calling**: File operations, shell commands, browsing, session management, and more
- **Queue + Compaction**: Serialized session work with manual/history compaction support
- **WebUI + TUI**: Browser and terminal interfaces for the same backend


## Quick Start

### Prerequisites

- Node.js 20+ and npm
- (Optional) Ollama for local embeddings
- (Optional) Chromium for browsing features

### Installation

```bash
# Clone the repository
git clone <your-repo-url> foxwarm
cd foxwarm

# Install backend dependencies
npm install

# Build WebUI (optional, for browser access)
cd packages/webui
npm install
npm run build
cd ../..

# Create local configuration
cp .env.example .env
mkdir -p state
cp templates/models.example.yaml state/models.yaml

# Edit .env and state/models.yaml
npm run build
```

### Running Foxwarm

**Option 1: Direct run (foreground)**
```bash
npm run start:notmux
```

**Option 2: Background run with tmux**
```bash
npm start

# Attach to the running process
tmux attach -t foxwarm

# Restart
npm run restart

# Stop
npm run stop
```

Logs are written to:

```bash
tail -f state/logs/foxwarm.log
```

## First Run

On first startup, Foxwarm will:

1. Create or load runtime state in `state/`
2. Load or create the main agent in `agents/main`
3. Load model definitions from `state/models.yaml`
   - if missing, it falls back to `templates/models.example.yaml`
4. Load session metadata and agent memory
5. Start configured channels (Telegram / Matrix / WeChat Work / WebUI / TUI)
6. Run `ONBOOT.md` if present and show `BOOTSTRAP.md` guidance for first-time setup

## Configuration

Foxwarm configuration has four main entry points:

1. `.env` — secrets, ports, feature flags, provider defaults
2. `state/models.yaml` — available models and default model key
3. `agents/<agent>/memory/` — long-term memory for each agent
4. `skills/<skill>/` — reusable skill memory packs that can be attached to agents

### Models Configuration

The runtime resolves model definitions in this order:

1. `MODELS_CONFIG_PATH` (if set)
2. `state/models.yaml`
3. `templates/models.example.yaml`

Minimal example:

```yaml
default: openai/gpt-4.1-mini
models:
  openai:
    provider: openai
    model:
      - gpt-4.1-mini
      - gpt-4o

  anthropic:
    provider: anthropic
    model:
      - claude-3-7-sonnet-latest
```

### Provider Credentials

**OpenAI / OpenAI-compatible**
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` (optional, default `https://api.openai.com/v1`)

**Anthropic**
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL` (optional, default `https://api.anthropic.com`)

See:
- [OpenAI LLM Configuration](docs/openai-llm.md)
- [Anthropic LLM Configuration](docs/anthropic-llm.md)

### Channels and Server

- `HTTP_PORT` — WebUI + trigger server port (default `3001`)
- `TELEGRAM_BOT_TOKEN` / `ALLOWED_USER_ID`
- `MATRIX_HOMESERVER` / `MATRIX_ACCESS_TOKEN` / `MATRIX_USER_ID`
- `WEWORK_WEBHOOK_URL`
- `ENABLE_WEBUI`
- `ENABLE_TRIGGER`

## Core Concepts

### Agent
A long-lived workspace + memory container.

### Session
A runnable conversation thread bound to exactly one agent.

### Skill
A reusable memory/capability pack attached explicitly to an agent.

### `agent.inherit`
Shared-memory composition between agents. It is **not** a reporting hierarchy.

## Common Commands

- `/session` — list, create, fork, move, archive, isolate, index
- `/agent` — list, create, inherit, delete
- `/model` — inspect or switch the current model
- `/skill` — list, attach, detach, inspect skills
- `/node` — list or switch the current execution node
- `/compact` / `/compress` — compact session history

## Channels

Foxwarm supports multiple channels at the same time:

- **Telegram**
- **Matrix**
- **WeChat Work** — [Setup Guide](docs/wework-webhook.md)
- **WebUI** — browser-based interface
- **TUI** — terminal interface via `npm run tui`

All channels share the same agents, sessions, and memory backend.

## Project Structure

```text
foxwarm/
├── src/                  # TypeScript source
├── lib/                  # Compiled JavaScript
├── agents/               # Agent workspaces and memory
├── skills/               # Optional skill definitions
├── state/                # Runtime state, logs, models, sessions, db
├── templates/            # Tracked starter templates
├── packages/webui/       # Browser frontend
├── test/                 # Local test environment
├── scripts/              # Start/restart/stop helpers
└── docs/                 # Documentation
```

## Documentation

- [Docs Index](docs/README.md)
- [Session Management](docs/session-management.md)
- [Multi-Agent Guide](docs/multi-agent.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [WebUI Guide](docs/webui-guide.md)


## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Run TUI
npm run tui
```

## License

MIT
