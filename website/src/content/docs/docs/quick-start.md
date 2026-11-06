---
title: Quick start
description: Install Foxwarm, add a model and give an agent its first task.
---

This page takes the shortest path to a working agent. Each step links to the full guide if you need more options.

## 1. Install

Run the command for your platform from the directory where you want Foxwarm's program and data directories created.

**Linux x64, x64 WSL or macOS on Apple Silicon**

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

**Windows x64 (PowerShell)**

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

**Docker (Linux x64)**

```bash
mkdir -p foxwarm-data
docker run -d --name foxwarm --init -p 3001:3001 \
  -v "$PWD/foxwarm-data:/data" ghcr.io/550w-host/foxwarm:latest
```

The installers download a prebuilt release; nothing is compiled. When the ASP.NET Core 10 runtime is not installed, they use the package that includes .NET. On Windows there is also a desktop app. See [Install Foxwarm](/docs/installing/) for packages and requirements.

When the installer finishes, it starts Foxwarm and prints a sign-in link such as `http://localhost:3001/#token=...`. Treat that link like a password.

## 2. Add a model

Open the sign-in link. On a new installation, Foxwarm opens **Setup → Models**. Choose your service, paste your API key, pick a model (**Load models** lists what the service offers) and select **Test connection**. Then save and start chatting.

Prefer YAML? Switch the Models view to **YAML** and paste a provider configuration, for example:

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

[Set up your first model](/docs/model-setup/) explains each field.

## 3. Give an agent a task

After the first save, Foxwarm creates the `main` Agent's default Session `main` with a short welcome that explains Agents and Sessions and asks what to call you. Closing Setup takes you there. Reply to it: your answer is also the first live test of the provider connection, and the Agent remembers what you tell it. Then give it something real, in a directory you are happy for it to work in:

```text
Look at ~/projects/my-app. Run the tests and tell me which ones fail and why. Don't change anything yet.
```

You will see the agent's tool calls and results in the conversation. The Session keeps its history, so you can come back later and continue where you left off, even after a restart.

## Where to go next

- [How Foxwarm works](/docs/how-it-works/): the server, Agents, Sessions, Nodes and Channels.
- [Agents, Sessions and memory](/docs/agents-sessions-memory/): give an agent lasting instructions and project knowledge.
- [Nodes](/docs/nodes/): run tools on another machine.
- [Channels and group chats](/docs/channels/): reach your agent from a chat app.
