# Foxwarm 🦊

Foxwarm is a self-hosted runtime for AI agents. It combines persistent conversations, Agent memory, tool calling, and a WebUI with optional messaging Channels and execution Nodes.

[Website](https://foxwarm.net/) · [Documentation](https://foxwarm.net/docs/)

## What you can do

- Work with agents in the WebUI, with chat, files, code, and terminals in one place.
- Give each Agent its own workspace, memory, and Skills, and use separate Sessions for different tasks.
- Keep long conversations usable with layered context compaction and recall. Semantic history search is optional.
- Run file and shell tools locally or on configured Nodes, and connect tools through MCP.
- Use OpenAI-compatible or Anthropic model providers, including local gateways.

## Get started

Install Foxwarm on **Linux x64** (including x64 WSL) or **Windows x64**. The source installer needs Git, Node.js 20.19+ (20.x) or 22.12+ with npm, a .NET SDK supporting `net10.0`, and the ASP.NET Core 10 runtime.

- **Linux:** also install tmux, Python 3, make, GCC/G++, and libc/libutil development files.
- **Windows:** also install Python 3 for the native worker build.

The installer checks these prerequisites but does not install system packages. For a container installation, use [Docker Compose](https://foxwarm.net/docs/installing/#docker-compose).

### Linux x64 or x64 WSL

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

### Windows PowerShell

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

For a new installation, the installer creates `./foxwarm` for the program and `./foxwarm-data` for data, builds the app, and starts it. The program's `data_dir` file remembers that location for later starts and installer reruns. Open the printed WebUI URL and configure your provider in **Setup → Models** to start chatting.

See the [installation guide](https://foxwarm.net/docs/installing/) for prerequisites, custom paths, manual installation, and startup commands. The installer scripts are available to inspect: [Bash](install-foxwarm.sh) and [PowerShell](install-foxwarm.ps1).

Keep access tokens private. Back up the whole data directory; see [data, updates, and backups](https://foxwarm.net/docs/data-upgrades-backups/). Optional [semantic history search](https://foxwarm.net/docs/history-search/#enable-semantic-search) has additional platform and embedding-service requirements.

Existing TypeScript installations should follow the [migration guide](https://foxwarm.net/docs/typescript-migration/).

## Model defaults

In `state/models.yaml`, `default` selects a model, while `defaults` sets shared model parameters:

```yaml
default: openai/gpt-5.6-sol
defaults:
  contextLimit: 200000
  maxOutput: 32768
  providerImageOutputFormat: webp
```

`defaults` supports only these three fields. Each value resolves in order: individual model → concrete provider → `models.yaml.defaults` → legacy `config.yaml.llm` value → built-in default shown above. Context and output limits must be positive integers; configure the context limit to match your endpoint. Input-image optimization accepts `webp` or `jpeg` (with PNG for transparent images), without changing original images or generated-image settings. Provider-specific `extraFields` may still override requested output tokens. Compaction policy remains in `config.yaml.llm`.

Save Models in Setup to apply changes to subsequent requests; an in-flight request retains its resolved configuration.

## Agents, Sessions, and Nodes

An **Agent** holds a workspace, long-term memory, and instructions. A **Session** is a conversation bound to an Agent; one Agent can have several Sessions and create child Sessions for parallel work. **Skills** provide reusable instructions, and **tools** perform actions such as reading files or running commands.

A **Node** is an execution environment for tools. Use the local Node, pair a remote Node, or configure a supported provider. Tool access is controlled by authorization rules; granting shell access lets the agent run commands in that environment.

Read more about [Agents and Sessions](https://foxwarm.net/docs/agents-sessions-memory/), [tools and Skills](https://foxwarm.net/docs/tools-skills-mcp/), and [Nodes](https://foxwarm.net/docs/nodes/).

## Channels

Connect messaging platforms such as Telegram, Matrix, WeWork, Weixin, or QQ Bot to Foxwarm Sessions. Configure credentials and allowed users in **Setup → Config**; saving refreshes managed Channels.

See the [Channels guide](https://foxwarm.net/docs/channels/) for setup and access controls.

## Documentation

Start with the [documentation site](https://foxwarm.net/docs/) for installation, model setup, everyday use, and administration.

- [Model setup](https://foxwarm.net/docs/model-setup/)
- [Model options and routing](https://foxwarm.net/docs/model-options/)
- [Long conversations and history search](https://foxwarm.net/docs/history-search/)
- [External MCP clients](website/src/content/docs/docs/mcp-inbound.md)
- [ToolScript examples](skills/toolscript-automation/examples/README.md)

## Docker

The Linux x64 image builds Foxwarm from source and includes the ASP.NET Core 10 runtime, Node.js and Chromium. Data is mounted at `/data`; the default port is 3001. See the [Docker Compose installation steps](https://foxwarm.net/docs/installing/#docker-compose). Optional Code workbench and HEIC/HEIF support need additional assets.

## Development

To build from source:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
npm run build-all
npm run start:notmux
```

See the [development guide](docs/development.md) and [local test guide](docs/testing.md) for the workflow and test commands. The repository's [Code Index](docs/code-index/overview.md) maps the implementation and records design decisions. Read the relevant entries before changing source, update them with affected behavior, and run `npm run quality:code-index`.

## License

[MIT](LICENSE)
