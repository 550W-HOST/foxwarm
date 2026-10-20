# Foxwarm 🦊

Foxwarm is a self-hosted runtime for AI agents. It combines persistent conversations, Agent memory, tool calling, and a WebUI with optional messaging Channels and execution Nodes.

[Website](https://foxwarm.550w.host/) · [Documentation](https://foxwarm.550w.host/docs/)

## Managed Main source candidate

This branch selects the .NET Main host at the existing package/directory, npm, tmux and Windows background entries. `npm run build` prepares its complete resources; source builds need a net10.0-capable .NET SDK and the ASP.NET Core 10 runtime in addition to Node/npm. The public `foxwarm` bin still shows help with no arguments and retains its one-shot `model` and `archive` commands. Missing managed output never falls back to TypeScript.

This is a source-entry candidate, not a public release or live-installation cutover. Production/test Docker delivery and default CI/test-lane conversion remain separate work. Main TUI is not implemented (`--tui` fails clearly); Session Worker hosting and managed ToolScript/controllers remain outside this candidate. Retained TypeScript source and other-platform Node clients remain available. See [build, publish and runtime prerequisites](dotnet/README.md#build-publish-and-public-cli) for the Linux x64 / Windows x64 boundary; macOS Main is not qualified.

## What you can do

- Work with agents in the WebUI, with chat, files, code, and terminals in one place.
- Give each Agent its own workspace, memory, and Skills, and use separate Sessions for different tasks.
- Keep long conversations usable with layered context compaction and recall. Semantic history search is optional.
- Run file and shell tools locally or on configured Nodes, and connect tools through MCP.
- Use OpenAI-compatible or Anthropic model providers, including local gateways.

## Get started

Install Git, Node.js 20.19+ (20.x) or 22.12+ with npm, a net10.0-capable .NET SDK, and the ASP.NET Core 10 runtime. Linux x64 (including x64 WSL) also needs tmux, Python 3, make, GCC/G++ and libc/libutil development files. Windows x64 needs Python 3 for a fresh pinned native-worker build. Installers diagnose prerequisites; they do not install host toolchains.

### Linux x64 or x64 WSL

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash
```

### Windows PowerShell

```powershell
irm https://foxwarm.550w.host/install-foxwarm.ps1 | iex
```

The installer creates `./foxwarm` for the program and `./foxwarm-data` for runtime data, builds the app, and starts it. Open the WebUI URL printed by the installer and configure your provider in **Setup → Models** to start chatting.

See the [installation guide](https://foxwarm.550w.host/docs/installing/) for prerequisites, custom paths, manual installation, and startup commands. The installer scripts are available to inspect: [Bash](install-foxwarm.sh) and [PowerShell](install-foxwarm.ps1).

Keep access tokens private. Back up the whole data directory; see [data, upgrades, and backups](https://foxwarm.550w.host/docs/data-upgrades-backups/).

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

Read more about [Agents and Sessions](https://foxwarm.550w.host/docs/agents-sessions-memory/), [tools and Skills](https://foxwarm.550w.host/docs/tools-skills-mcp/), and [Nodes](https://foxwarm.550w.host/docs/nodes/).

## Channels

Connect messaging platforms such as Telegram, Matrix, WeWork, Weixin, or QQ Bot to Foxwarm Sessions. Configure credentials and allowed users in **Setup → Config**; saving refreshes managed Channels.

See the [Channels guide](https://foxwarm.550w.host/docs/channels/) for setup and access controls.

## Documentation

Start with the [documentation site](https://foxwarm.550w.host/docs/) for installation, model setup, everyday use, and administration.

- [Model setup](https://foxwarm.550w.host/docs/model-setup/)
- [Model options and routing](https://foxwarm.550w.host/docs/model-options/)
- [Long conversations and history search](https://foxwarm.550w.host/docs/history-search/)
- [External MCP clients](website/src/content/docs/docs/mcp-inbound.md)
- [ToolScript examples](skills/toolscript-automation/examples/README.md)

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
