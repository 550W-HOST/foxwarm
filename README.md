# Foxwarm 🦊

Foxwarm is a self-hosted TypeScript runtime for AI agents. It combines persistent conversations, Agent memory, tool calling, and a WebUI with optional messaging Channels and execution Nodes.

[Website](https://foxwarm.550w.host/) · [Documentation](https://foxwarm.550w.host/docs/)

## What you can do

- Work with agents in the WebUI, with chat, files, code, and terminals in one place.
- Give each Agent its own workspace, memory, and Skills, and use separate Sessions for different tasks.
- Keep long conversations usable with layered context compaction and recall. Semantic history search is optional.
- Run file and shell tools locally or on configured Nodes, and connect tools through MCP.
- Use OpenAI-compatible or Anthropic model providers, including local gateways.

## Get started

Install Git and Node.js 20+ with npm. Linux, macOS, and WSL also need tmux.

### Linux, macOS, or WSL

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
- [ToolScript examples](examples/toolscript/README.md)

## Development

To build from source:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
npm run build-all
npm run start:notmux
```

See the [development guide](docs/development.md) and [local test guide](docs/testing.md) for the workflow and test commands. The repository's [Code Index](docs/code-index/README.md) maps the implementation and records design decisions. Read the relevant entries before changing source, update them with affected behavior, and run `npm run quality:code-index`.

## License

[MIT](LICENSE)
