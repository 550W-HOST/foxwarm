---
title: Quick start
description: Install Foxwarm, add a model and give an agent its first task.
---

This page takes the shortest path to a working agent. Each step links to the full guide if you need more options.

## 1. Install

Run the command for your platform from the directory where you want Foxwarm's program and data directories created.

**Linux x64 or x64 WSL**

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

**Windows x64 (PowerShell)**

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

**Docker Compose (Linux x64)**

```bash
git clone https://github.com/550W-HOST/foxwarm.git && cd foxwarm
mkdir -p foxwarm-data/state foxwarm-data/agents
docker compose up -d --build foxwarm
```

The installers build Foxwarm from source. They check for Git, Node.js, the .NET 10 SDK and a few build tools, and tell you what is missing; they do not install system packages. Docker builds everything inside the image. See [Install Foxwarm](/docs/installing/) for the exact requirements.

When the installer finishes, it starts Foxwarm and prints a sign-in link such as `http://localhost:3001/#token=...`. Treat that link like a password.

## 2. Add a model

Open the sign-in link. On a new installation, Foxwarm opens **Setup → Models**. Paste a provider configuration, for example:

```yaml
default: my-provider/my-model
providers:
  my-provider:
    providerType: openai-completions   # or openai-responses, anthropic
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    models:
      - my-model
```

Save, then start chatting. Saving checks the configuration but does not call the provider; your first message is the live test. [Set up your first model](/docs/model-setup/) explains each field.

## 3. Give an agent a task

Foxwarm starts with a `main` Agent and its default Session. Try a short question first. Then give it something real, in a directory you are happy for it to work in:

```text
Look at ~/projects/my-app. Run the tests and tell me which ones fail and why. Don't change anything yet.
```

You will see the agent's tool calls and results in the conversation. The Session keeps its history, so you can come back later and continue where you left off, even after a restart.

## Where to go next

- [How Foxwarm works](/docs/how-it-works/): the server, Agents, Sessions, Nodes and Channels.
- [Agents, Sessions and memory](/docs/agents-sessions-memory/): give an agent lasting instructions and project knowledge.
- [Nodes](/docs/nodes/): run tools on another machine.
- [Channels and group chats](/docs/channels/): reach your agent from a chat app.
