# Foxwarm 🦊

Foxwarm is a lightweight, extensible AI assistant framework for development-oriented workflows. It combines multi-channel chat, long-term memory, tool calling, agent/session separation, and optional multi-node execution in a small TypeScript codebase.

## Features

- **Multi-Channel Support**: Telegram, Matrix, WeChat Work, and WebUI
- **Agents, Sessions, and Skills**: Separate long-lived knowledge from runtime conversation threads
- **Persistent Memory**: Long-term context storage with LanceDB-based retrieval
- **Tool Calling**: File operations, shell commands, browsing, session management, and more
- **Queue + Compaction**: Serialized session work with manual/history compaction support

## Quick Start

### Prerequisites

- Node.js 20+ and npm
- (Optional) Ollama for embeddings
- (Optional) Chromium for browsing features

### Installation

```bash
# Clone the repository
git clone <your-repo-url> foxwarm
cd foxwarm

# Create local config files
cp .env.example .env
mkdir -p state
cp templates/models.example.yaml state/models.yaml

# Install + build backend and WebUI in one step
npm run build-all
```

Then edit `state/models.yaml` and choose the models you actually want to use.

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

### Running with Docker Compose

```bash
cp .env.example .env
mkdir -p state agents skills
cp templates/models.example.yaml state/models.yaml

docker compose up -d --build
```

Then open `http://localhost:3001` and use the token from `state/token` to log in.

Useful commands:

```bash
docker compose logs -f
docker compose down
```

The bundled `docker-compose.yml` mounts `state/`, `agents/`, and `skills/` from the host so your config, logs, and agent data persist across rebuilds. By default it also points `OLLAMA_BASE_URL` at `http://host.docker.internal:11434`; change that in `.env` if your embedding service runs elsewhere.

## First Run

On first startup, Foxwarm will:

1. Create or load runtime state in `state/`
2. Load or create the main agent in `agents/main`
3. Load model definitions from `state/models.yaml`
   - if missing, it falls back to `templates/models.example.yaml`
4. Load session metadata and agent memory
5. Load or generate runtime auth tokens:
   - `state/token`
   - `state/node_token`
6. Start configured channels (Telegram / Matrix / WeChat Work / WebUI)
7. Run `ONBOOT.md` if present and show `BOOTSTRAP.md` guidance for first-time setup

## Configuration

Foxwarm configuration has four main entry points:

1. `.env` — app-level settings, ports, feature flags, and channel tokens
2. `state/models.yaml` — available models and default model key
3. `agents/<agent>/memory/` — long-term memory for each agent
4. `skills/<skill>/` — reusable skill memory packs that can be attached to agents

### Models Configuration

The runtime resolves model definitions in this order:

1. `MODELS_CONFIG_PATH` (if set)
2. `state/models.yaml`
3. `templates/models.example.yaml`

Foxwarm's public setup flow is **YAML-first**: put each provider's connection settings and model list directly in `state/models.yaml`.

Example:

```yaml
default: openai/gpt-5.2-codex
models:
  openai:
    provider: openai-completions
    baseUrl: https://api.openai.com/v1
    apiKey: your-openai-key
    model:
      - gpt-5.2-codex
      - gpt-5.3-codex
      - gpt-5.4

  anthropic:
    provider: anthropic
    baseUrl: https://api.anthropic.com
    apiKey: your-anthropic-key
    model:
      - claude-sonnet-4-5
      - claude-sonnet-4-6
      - claude-sonnet-4-5-thinking
      - claude-sonnet-4-6-thinking
```

Provider routing semantics:

- `openai` -> OpenAI Responses API (`/responses`)
- `openai-responses` -> OpenAI Responses API (`/responses`)
- `openai-completions` -> legacy chat/completions API (`/chat/completions`)

You can also replace those provider entries with a local OpenAI-compatible endpoint if you want to use your own hosted model.

### Embeddings

Vector memory uses Ollama for embeddings. The current embedding model is:

```text
qwen3-embedding:0.6b
```

If you want retrieval / vector memory features, make sure that model is available in your Ollama environment.

### Server and Channels

Common settings live in `.env`, for example:

- `HTTP_PORT` — WebUI + trigger server port (default `3001`)
- `ENABLE_WEBUI`
- `ENABLE_TRIGGER`
- Telegram / Matrix / WeChat Work channel tokens if you want those integrations

## Core Concepts

### Agent
A long-lived workspace + memory container.

### Session
A runnable conversation thread bound to exactly one agent.

### Skill
A reusable memory/capability pack attached explicitly to an agent.

Foxwarm can also ship bundled optional skills under `skills/`. For example, `skills/ask_gemini/` provides an external-info lookup helper backed by Gemini; it requires a Gemini API key via `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `~/.secrets/gemini_api_key`.

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
- **WeChat Work**
- **WebUI**

All channels share the same agents, sessions, and memory backend.

## Project Structure

```text
foxwarm/
├── src/                  # TypeScript source
├── lib/                  # Compiled JavaScript
├── agents/               # Agent workspaces and memory
├── skills/               # Optional skill definitions
├── state/                # Runtime state (tokens, logs, models, sessions, db)
├── templates/            # Tracked starter templates
├── packages/webui/       # Browser frontend
├── test/                 # Local test environment
├── scripts/              # Start/restart/stop helpers
└── docs/                 # Documentation
```

## Documentation

- [Session Management](docs/session-management.md)
- [Multi-Agent Guide](docs/multi-agent.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Vector Memory](docs/vector-memory.md)

## Development

```bash
# Watch mode
npm run dev

# Backend-only build
npm run build

# Backend + WebUI install/build
npm run build-all
```

## License

MIT
