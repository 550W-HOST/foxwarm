# Foxwarm 🦊

Foxwarm is a lightweight, extensible AI assistant framework for development-oriented workflows. It combines WebUI chat, long-term memory, tool calling, agents/sessions, skills, channels, and optional remote nodes in a small TypeScript codebase.

## Features

- **WebUI + Channels**: WebUI, Telegram, Matrix, WeChat Work, Weixin, and external trigger support
- **Agents, Sessions, and Skills**: Separate long-lived memory/workspaces from runnable conversation threads
- **Persistent Memory**: Agent memory files plus LanceDB-based searchable history
- **Nodes**: Optional remote/browser/CLI/sandbox tool hosts
- **Layered-context Compaction**: Automatic multi-level, traceable, archive-backed compaction and recall keep long conversations usable

## Quick Start: one-line install

The recommended first-time path is the installer script. It clones Foxwarm into `./foxwarm`, stores runtime data/config in `./foxwarm-data`, builds the app, starts it in the normal tmux mode, and prints a WebUI URL with token.

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

Prerequisites: Git, Node.js 20+, npm, and tmux. The installer validates these and prints clear instructions if anything is missing; it does not install system packages for you.

Useful overrides:

```bash
# CLI flags
curl -fsSL https://YOUR_PUBLIC_FOXWARM_HOST/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data"

# Environment variables
export FOXWARM_DIR="$PWD/foxwarm"
export FOXWARM_DATA_DIR="$PWD/foxwarm-data"
export FOXWARM_TMUX_SESSION=foxwarm
export FOXWARM_BRANCH=main
export FOXWARM_REPO=https://github.com/550W-HOST/foxwarm.git
curl -fsSL https://YOUR_PUBLIC_FOXWARM_HOST/install-foxwarm.sh | bash
```

The data directory contains runtime `state/`, `agents/`, tokens, logs, models, sessions, and channel config. Bundled skills stay in the program repo under `skills/`. Back up `foxwarm-data/` to preserve your Foxwarm runtime state.

After startup, the installer prints a URL like:

```text
http://localhost:3001/#token=...
```

The installer does not auto-attach. To view the running console/logs:

```bash
tmux attach -t foxwarm
```

Detach without stopping Foxwarm:

```text
Ctrl-b then d
```

Stop later:

```bash
cd foxwarm
npm run stop
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

The Windows script checks for Git and Node.js 20+/npm, builds Foxwarm, stores data in `./foxwarm-data` by default, writes a `data_dir` pointer into the program checkout, starts Foxwarm in the background, and opens the WebUI token URL when available. Rerunning the installer while that Foxwarm instance is active exits before dependency installation; run `npm run stop:windows` first so `npm ci` never replaces loaded native DLLs.

If local script execution is blocked, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

Optional parameters:

```powershell
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data -BranchName main
```

## Manual install / development start

Use this path if you are developing Foxwarm itself.

### Prerequisites

- Git
- Node.js 20+ and npm
- tmux for the normal background start mode on Linux/macOS
- (Optional) Ollama for embeddings / vector memory
- (Optional) Chromium or a browser node for browsing features

### Install and build

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
npm run build-all
```

For a clean manual install with an external data directory:

```bash
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
export FOXWARM_DATA_DIR="$PWD/../foxwarm-data"
```

The installer creates this `data_dir` pointer automatically, so later `npm start` / `npm run restart` from a new shell continue using `foxwarm-data`.

Do **not** copy `templates/models.example.yaml` into `$FOXWARM_DATA_DIR/state/models.yaml` for first-time setup unless you want to configure it manually. If `state/models.yaml` is missing in the data directory, WebUI enters OOBE and helps create it.

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
cat "$FOXWARM_DATA_DIR/state/token"
```

Other tmux helpers:

```bash
tmux attach -t foxwarm
npm run restart
npm run stop
```

On Windows, use the PowerShell helpers or their equivalent npm commands:

```powershell
.\scripts\start.ps1
.\scripts\status.ps1
.\scripts\restart.ps1
.\scripts\stop.ps1

npm run start:windows
npm run status:windows
npm run restart:windows
npm run stop:windows
```

The Windows start and restart commands build first, then run Foxwarm in the background. Start performs a lockfile install while no instance is running; restart rebuilds against the installed dependency tree before gracefully replacing the running process, avoiding Windows locks on loaded native DLLs. Pass `-SkipBuild` to the PowerShell start/restart helper after a successful build. Status and stop use a local named pipe; stop requests the same graceful shutdown path used by `SIGTERM`. Standard output and errors are appended to `state/logs/foxwarm.stdout.log` and `state/logs/foxwarm.stderr.log` under the resolved data directory.

Logs are written under:

```text
$FOXWARM_DATA_DIR/state/logs/
```

## Docker Compose

Docker Compose is still supported, but the recommended first-time UX is the installer + WebUI OOBE.

```bash
mkdir -p foxwarm-data/state foxwarm-data/agents
docker compose up -d --build
```

Open `http://localhost:3001` and use the token from:

```bash
cat foxwarm-data/state/token
```

The compose file mounts `./foxwarm-data` to `/data` and sets `FOXWARM_DATA_DIR=/data`, so configuration and memory persist outside the program image.

Compose starts in OOBE by default when `foxwarm-data/state/models.yaml` is missing. To skip OOBE, create `foxwarm-data/state/models.yaml` before starting. You can also create `foxwarm-data/state/config.yaml` for app/channel settings. If changing `bot.httpPort` under Docker Compose, update `docker-compose.yml` `ports` and `healthcheck` to match; otherwise keep the default 3001.

## First Run / OOBE Setup

Foxwarm enters **OOBE** (first-time setup) when:

```text
state/models.yaml
```

does not exist.

After logging into WebUI, the OOBE page cannot be closed until models are configured. Once models are saved, you can use WebUI or any configured channel to ask the agent how to explore Foxwarm.

OOBE/Setup supports:

1. **Models** — creates `state/models.yaml`; includes a **Test model** button that sends `Please reply ok` without writing conversation history
2. **Channels** — edits `state/config.yaml` and hot-reloads managed channels
3. **Weixin login** — starts QR login in WebUI, shows the QR image or pairing link when the upstream returns a displayable value, saves the resulting token into channel config, and hot-reloads channels

You can later return to the same page from the WebUI setup/settings button.

## Configuration

Foxwarm's current primary configuration files live inside the data directory:

1. `state/config.yaml` — app settings and channels
2. `state/models.yaml` — model providers, model list, and default model
3. `agents/<agent>/memory/` — long-term memory for each agent
4. `skills/<skill>/` — bundled reusable skill documents in the program repo
5. `state/token` and `state/node_token` — WebUI and node pairing tokens

For installer-based setup, `state/` and `agents/` are under `./foxwarm-data/` by default, and the installer writes `foxwarm/data_dir` so later starts keep using that data directory. For Docker Compose, `state/` and `agents/` are under `./foxwarm-data/` on the host and `/data/` in the container. Bundled skills remain in the program image/repo under `skills/`.

Back up and restore the **whole data directory**, not only configuration or individual SQLite files. The session and LLM archives are SQLite authorities; a live backup must use a SQLite-consistent online snapshot or a quiesced checkpoint/copy rather than copying the main database file without its WAL state. Session archive identity also depends on `state/session-id-reservations.jsonl` (committed move aliases), and an interrupted move may leave `state/session-id-move-pending.json` with explicit rollback/finish intent and target-directory ownership. Pending recovery is fail-closed before ordinary session loading. These files are durable/operator state, not disposable logs. Use `foxwarm archive export-jsonl --output <directory>` when an external workflow needs compatibility JSONL.

Example `state/config.yaml` app settings:

```yaml
bot:
  httpPort: 3001
  enableWebUI: true
  enableTrigger: true
llm:
  compactKeepPercent: 0.3
  compactThresholdPercent: 0.85
vector:
  baseUrl: http://localhost:11434/v1
  lexicalIndex: false
  hybridSearch: false
vectorMaintenance:
  enabled: true
  retentionHours: 24
```

`llm.compactKeepPercent` controls the fraction of recent rendered history kept
by default during compaction. `llm.compactThresholdPercent` controls the
automatic compaction trigger as a fraction of the resolved model context
window. Both values must be greater than `0` and at most `1`; their defaults
are `0.3` and `0.85`, respectively. A positive per-session threshold-token
override still takes precedence over the global threshold percentage.

Vector search is disabled by default. Omit `vector` or set `vector: false` to
keep semantic indexing and recall disabled. Supplying a `vector` object opts in
unless it sets `enabled: false`; enabled Vector requires an absolute HTTP(S)
OpenAI-compatible API base URL, including its version/custom API root. Foxwarm
rejects credentials, query strings, and fragments, and appends only
`/embeddings`, so a custom gateway may use a value such as
`https://gateway.example/openai/v1`. The legacy `llm.ollamaBaseUrl` field is
still read when top-level `vector` is absent, but new configuration should use
`vector.baseUrl`. Optional `vector.lexicalIndex: true` enables a dark,
exact-Vector-owner derived lexical indexing lane; it defaults off and is not
consumed by recall unless `vector.hybridSearch: true` is also set. Hybrid search
requires the lexical index and remains disabled by default. Vector, worker placement, and maintenance settings are read
at process startup.

When explicitly enabled, the lexical derivative follows committed Session rename/fork boundaries and rebuilds incompatible derived schemas through a restart-resumable shadow SQLite file. These operations are best-effort derived maintenance: they do not make Archive commits or dense Vector availability depend on lexical health.

LanceDB maintenance is enabled by default. It compacts fragmented vector data
and removes table versions older than the configured positive whole-hour
retention window; the default is 24 hours. `vectorMaintenance: true` enables
the defaults, `vectorMaintenance: false` disables maintenance, and an object
enables it unless `enabled: false` while allowing `retentionHours` tuning.
Maintenance is a no-op while Vector itself is disabled.

Additional trusted Node providers are configured under `nodeProviders`. Use an
`executable` provider for a generic external adapter launched from a fixed
command; its contract is documented in
[`docs/executable-node-provider-protocol.md`](docs/executable-node-provider-protocol.md).
Use the first-party `docker-worktree` provider for resident Linux Docker
sandboxes bound to existing allowed Git worktrees; setup and limits are in
[`docs/docker-worktree-node-provider.md`](docs/docker-worktree-node-provider.md).
Provider configuration is startup-only and changes require a restart.

## Models (`state/models.yaml`)

The WebUI OOBE page can create a basic model config. You can also edit `state/models.yaml` manually.

Preferred schema:

```yaml
default: openai/gpt-5.6-sol
providers:
  openai:
    providerType: openai-completions
    baseUrl: https://api.openai.com/v1
    apiKey: your-openai-key
    models:
      - gpt-5.6-sol
      - gpt-5.6-terra
      - gpt-5.6-luna
```

Provider notes:

- `openai-completions` uses `/chat/completions`
- `openai` and `openai-responses` use `/responses`
- `anthropic` uses Anthropic-compatible requests
- `gemini` uses Gemini's native `v1beta/models/<model>:streamGenerateContent` API
- OpenAI-compatible local gateways can be configured by changing `baseUrl` and model ids. `apiKey` may be left empty if your gateway does not require one.

Native Gemini configuration uses the API root through `v1beta`; Foxwarm adds
the model-specific streaming path and sends `apiKey` as `x-goog-api-key`:

```yaml
providers:
  google:
    providerType: gemini
    baseUrl: https://generativelanguage.googleapis.com/v1beta
    apiKey: your-google-ai-key
    models:
      - gemini-2.5-flash
      - gemini-2.5-pro
```

Gemini-compatible gateways may replace `baseUrl` while retaining the native
`v1beta` protocol. Native text, thought signatures, function calls/results,
inline images, usage metadata, and SSE streaming are normalized into the same
Foxwarm history as other providers. `effort: none` maps to Gemini's portable
zero thinking budget; non-zero effort leaves the selected model's native
thinking policy unchanged because supported controls differ by model generation.

Provider and model entries can declare first-class effort capabilities and a
default. When omitted, all six levels are allowed and `high` is the default:

```yaml
providers:
  openai:
    providerType: openai-responses
    effort:
      allowed: [none, low, medium, high, xhigh, max]
      default: high
    models:
      - gpt-5.6-sol
      - id: gpt-5.6-terra
        effort:
          allowed: [low, medium, high, xhigh]
          default: high
```

A model-level `allowed` list replaces the provider list; omitted fields inherit
from the provider, and the resolved default must remain allowed. Requests use
the concrete model default when no effort is selected or when a virtual route
selects a leaf that does not allow the requested level.

Responses models can opt into OpenAI's hosted web search without a separate
Foxwarm model request:

```yaml
providers:
  openai:
    providerType: openai-responses
    baseUrl: https://api.openai.com/v1
    apiKey: your-openai-key
    webSearch:
      enabled: true
      toolChoice: auto       # or: required
      searchContextSize: medium
    models:
      - gpt-5.6
```

Foxwarm appends the hosted search tool beside its normal function tools. The
completed search item is kept only for replay to the same concrete model, and
the WebUI displays returned URL citations as clickable sources. Hosted search
is not enabled for compact planning or setup-test requests. `webSearch: true`
enables the default settings, `webSearch: false` disables it, and an object
enables it unless `enabled: false`; model-level values merge tuning fields from
their provider while overriding the inherited enabled state.

For stable session routing and ordered failover, see
[Virtual models](docs/virtual-models.md).

The runtime resolves model definitions from `state/models.yaml` under the active Foxwarm data directory. If that file is missing, `templates/models.example.yaml` is a read-only fallback; Setup still edits the data-directory file and treats its absence as OOBE.

The template fallback is mainly a fallback for development and diagnostics; OOBE treats missing `state/models.yaml` as first-time setup.

### One-shot model CLI

After building Foxwarm, the repository includes a one-shot CLI that uses the same configuration loader and provider request stack as the server:

```bash
npm run build
node scripts/foxwarm.js model --list
echo "Summarize this text" | node scripts/foxwarm.js model --model openai/gpt-5.6-sol
```

The package declares `foxwarm` as its executable, so an installed or `npm link`ed checkout can use `foxwarm model ...` directly. The command does not start the Foxwarm server, but it does require `lib/` build output and the normal runtime dependencies. It honors the normal data-root and model-config resolution, provider routing, retries, request compression, sanitization, and provider-specific response handling. Use `foxwarm model --help` for options.

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

You can configure Weixin from WebUI Setup without manually editing the token: click **Start Weixin login**, scan the QR code or open the pairing link shown by Setup, then click **Check login**. On success, Setup writes the token to `state/config.yaml` and hot-reloads channels.

Example QQ Bot channel using the official QQ Open Platform gateway:

```yaml
channels:
  qq-primary:
    type: qqbot
    enabled: true
    appId: "qq-bot-app-id"
    clientSecret: "qq-bot-client-secret"
    # QQ OpenIDs, not display names. Omit only when you intentionally use
    # the normal per-attachment allow-all-users control.
    allowedUsers:
      - "qq-user-openid"
```

Create a QQ Bot application in the QQ Open Platform, obtain its **AppID** and
**ClientSecret**, and enable the C2C, group @-message, guild @-message, and
guild-DM event permissions/intents that the application is eligible to use.
Add the bot to each target group or guild before expecting inbound events.
Foxwarm accepts only text from `C2C_MESSAGE_CREATE`, `GROUP_AT_MESSAGE_CREATE`,
`AT_MESSAGE_CREATE`, and `DIRECT_MESSAGE_CREATE`; media and unmentioned group
traffic are intentionally ignored. Its attachment conversation IDs are scoped
as `c2c:<openid>`, `group:<group-openid>`, `guild:<channel-id>`, or
`dm:<guild-id>`, so use those exact values with channel attachment tools.
For a source-bound message, Foxwarm follows the Tencent/OpenClaw local passive
reply policy: up to four successful passive text replies within one hour use
the inbound `msg_id`; later source replies make one proactive text send to the
same conversation. Enable QQ's active-message capability and make sure its
quota is suitable for that fallback. Unknown server failures never infer a
proactive fallback, and a failed proactive send is not retried.

The published `@openclaw/qqbot` package is a complete OpenClaw plugin and was
investigated as a protocol reference, but is not a Foxwarm dependency: it
bundles an `UNLICENSED` QR credential-provisioning connector. The native
adapter avoids both OpenClaw plugin coupling and that dependency risk because
official QQ credentials are configured directly.

Example WeWork/企业微信 intelligent bot channel with opt-in streaming aggregation:

```yaml
channels:
  wework-aibot:
    type: wework
    enabled: true
    # Optional legacy/group-robot webhook used for proactive webhook sends and
    # media upload/download by media_id. Intelligent-bot short-connection
    # callbacks do not require this because replies use per-message response_url
    # or passive stream replies.
    webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
    # Intelligent-bot short-connection callback listener. Configure this URL in
    # WeWork with the matching Token / EncodingAESKey. This is sufficient for
    # receiving intelligent-bot callbacks even when webhookUrl is omitted.
    token: "callback-token"
    encodingAESKey: "callback-encoding-aes-key"
    listenPort: 3003
    listenPath: "/wework/aibot"
    # Optional bot/self display name. If inbound text starts with
    # "@企业微信机器人" followed by whitespace, that prefix is stripped before
    # slash-command parsing so Chinese WeWork mentions can still run commands.
    selfName: "企业微信机器人"
    aibot:
      # When true, incoming intelligent-bot messages use WeWork stream replies:
      # model/tool-loop broadcasts are aggregated into one stream card and the
      # final assistant message marks the stream as finished.
      stream: true
      # Optional WebSocket/long-connection API mode. This can receive callbacks
      # without a public webhook URL and pushes stream updates proactively.
      websocket:
        enabled: false
        botId: "BOTID"
        secret: "LONG_CONNECTION_SECRET"
```

WebUI Setup can edit channels and then reload them without restarting Foxwarm. The reload flow stops registered managed channels and starts the enabled/configured channels again.

Managed channel types currently include:

- `telegram`
- `matrix`
- `wework`
- `weixin`
- `qqbot`

Slash-command alternatives are available for runtime inspection and manual control:

```text
/channel status
/channel start <channel-id>
/channel stop <channel-id>
/channel restart <channel-id>
```

## First-run Troubleshooting

### I do not see the token URL

Read the token directly from the data directory:

```bash
cat foxwarm-data/state/token
```

Then open `http://localhost:3001/#token=<token>`.

### tmux basics

```bash
tmux attach -t foxwarm   # view Foxwarm console/logs
# detach without stopping: Ctrl-b then d
cd foxwarm && npm run stop
cd foxwarm && npm run restart
```

If you used a custom session name, pass `FOXWARM_TMUX_SESSION=<name>` for attach/start/restart/stop.

### Model test or chat fails

Return to WebUI Setup and check provider type, base URL, model id, and API key. Local OpenAI-compatible gateways may leave API key empty, but hosted providers usually require one. If a bad `state/models.yaml` was created manually, fix it or delete it to re-enter OOBE. Check logs under `foxwarm-data/state/logs/`.

### Docker and local model endpoints

Inside Docker, `localhost` means the container itself. To reach a model server on the host machine, use `host.docker.internal` where supported, for example in `foxwarm-data/state/config.yaml` or `state/models.yaml` base URLs.

### Port already in use

For local/tmux installs, edit `foxwarm-data/state/config.yaml` and set `bot.httpPort`. For Docker Compose, also update `docker-compose.yml` `ports` and `healthcheck` to match the new port.

### Channels do not reload

Open WebUI Setup and save channels again, or inspect runtime state with `/channel status`. Channel reload errors are shown in Setup and logged under `foxwarm-data/state/logs/`.

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

- [Code Index](docs/code-index/README.md)
- [Architecture](docs/architecture.md)
- [Session Management](docs/session-management.md)
- [Multi-Agent Guide](docs/multi-agent.md)
- [Node Client](docs/node-client.md)
- [Multica Bridge POC](docs/multica-bridge.md)
- [Vector Memory](docs/vector-memory.md)
- [Development](docs/development.md)
- [Multiprocess Session Workers](docs/multiprocess-session-workers.md)
- [ToolScript examples](examples/toolscript/README.md)

## Development

### Code index workflow for contributors and coding agents

Foxwarm keeps a repository-local code index for both human contributors and coding agents. Before inspecting or modifying code:

1. Read the [code-index governance guide](docs/code-index/README.md) and [architecture overview](docs/code-index/overview.md).
2. Read the relevant module, thread, and unit documents as whole files.
3. Verify important claims against current source and tests; the index is a map, while source and tests remain authoritative.

After changing source:

1. Update the affected `docs/code-index/` documents in the same branch and pull request. Refresh unit behavior, file ownership, and stable-symbol indexes as relevant; update parent navigation only when boundaries change.
2. Record each Design Decision at exactly one canonical owner: unit, module, thread, or overview. Other documents use a short summary and link. Repetition across modules is a signal to create or use a thread.
3. Keep the index public-safe English. Do not add credentials, private paths, deployment runbooks, or private operational context.
4. Run `npm run quality:code-index` before submitting.

```bash
npm run build        # backend/shared/cli-node build
npm run build-all    # install + build backend and WebUI
npm run dev          # TypeScript watch mode
npm run start:notmux # build + foreground backend start
npm start            # build + tmux start
```

## License

MIT
