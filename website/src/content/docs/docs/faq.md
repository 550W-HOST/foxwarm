---
title: FAQ
description: Short answers about what Foxwarm is, installing and signing in, models, conversations, Nodes, Channels and keeping an instance running.
---

## About Foxwarm

### Is foxwarm.net a hosted service?

No. The site only hosts documentation and installers. Foxwarm runs on your own machine or server; your conversations, files and keys stay there.

### What does it cost?

Foxwarm is free and open source under the MIT license. You pay your model provider for the tokens you use, or nothing if you run a local model. Add [pricing](/docs/model-options/#per-model-settings) to a model to see an estimated cost for each reply.

### Which models can I use?

Any endpoint that speaks the OpenAI Chat Completions, OpenAI Responses or Anthropic Messages format, including local servers and gateways. You can configure several providers and switch per Session. See [Set up your first model](/docs/model-setup/) and [Model options and routing](/docs/model-options/).

### How is this different from a coding agent in my terminal or editor?

Foxwarm is a server you keep running. Conversations persist and can run for days, survive restarts and are compacted rather than cut off. Work can be handed to other Sessions and Agents, run on other machines through Nodes, and be reached from a browser, a phone or a team chat. See [How Foxwarm works](/docs/how-it-works/).

## Installing and signing in

### Does it run on macOS?

Not as the server. Foxwarm runs on Linux x64, x64 WSL and Windows x64, or in Docker on Linux x64. A Mac can join as a [Node](/docs/nodes/), so agents can still work on files and run commands there.

### Where do I sign in?

At your own installation, using the link printed when it starts, such as `http://localhost:3001/#token=...`. If you lost it, read `state/token` in your data directory; see [Open the WebUI](/docs/installing/#open-the-webui).

The WebUI token, Node pairing tokens and external MCP identity tokens are different credentials. Use the one for the interface you are connecting to.

### Can I use it from my phone?

Yes. The WebUI works in mobile browsers; if your server is not reachable from the phone, put it behind your usual VPN or reverse proxy. You can also talk to a Session through a chat app with [Channels](/docs/channels/).

### Can I let someone else use my instance?

Do not share your sign-in token; it is a full administrator credential. Give them an identity that can only open selected Sessions, see [Scoped WebUI access](/docs/access-control/#scoped-webui-access), or add them to a Channel's allow list.

### Why does Setup keep opening?

The data directory Foxwarm is using has no `state/models.yaml` yet. Save a model configuration in [Setup → Models](/docs/model-setup/). If you expected an existing configuration, check that Foxwarm is pointed at the right data directory before creating a new one.

## Models

### Models saved fine, but chat fails. What should I check?

Saving checks the configuration but does not call the provider. Check the provider type, base URL, exact model ID and API key, then send a short text-only message. Turn on hosted tools only after that works. Errors are logged under `state/logs/`.

### Can different Sessions use different models?

Yes. Each Session has its own model and reasoning effort. Change them from the menus next to the message box or with `/model`. Child Sessions can use a different model from their parent.

## Conversations and agents

### What happens when a conversation gets very long?

Foxwarm compacts it: older parts are summarized into blocks you can expand, and the original messages stay in the archive where the agent can recall them. You can also run `/compact` yourself. See [Long conversations](/docs/history-search/).

### Does work survive a restart?

Yes. Sessions, history, queued messages and timers are saved. After a restart, Sessions that were in the middle of a turn are resumed so the agent can check what was interrupted. If one stops instead, `/continue` resumes it without adding a message.

### How do I give an agent lasting instructions?

Put them in the Agent's memory files under `agents/<agent>/memory/`, or ask the agent to remember them. See [Agents, Sessions and memory](/docs/agents-sessions-memory/).

### How do I stop an agent?

Use the stop button in the WebUI or send `/stop`.

### How do I limit what an agent can do?

Use tool rules: per instance, and per Agent so that helpers an agent creates get less access than it has. See [Access control](/docs/access-control/).

## Nodes and security

### Are Nodes sandboxes?

No. A command on a Node runs as the user that runs the Node client and can do what that user can do. Use a container or a dedicated user and machine when you want stronger separation, and [tool rules](/docs/access-control/) to decide which Agents may use which Node.

### Do I need to put API keys on a Node?

No. Models, MCP servers and their credentials stay on the Foxwarm server. A Node only runs the file, shell and browser operations it is given.

### Why can't Foxwarm reach a service at `localhost`?

`localhost` means the machine or container making the request. Inside a container it is that container; on a Node it is that Node. Use an address reachable from where the request is made.

For a model service on the Docker host, use `host.docker.internal`; the repository's Compose file maps it to the host. The service must also listen on an address the container can reach.

## Channels

### A Channel is connected, but my messages get no reply. Why?

Check, in order: the sender's platform user ID is in `allowedUsers` (send `/whoami` to see it), the conversation is attached to the Session you expect, and the bot has permission to post there. The [Channels guide](/docs/channels/#check-a-connection) walks through it.

### The bot ignores messages in a group.

QQ Bot groups need an @mention by default; set `requireMention: false` to handle every message. Group members who are not on the allow list are refused unless you enabled `/channel dangerously-allow-all-users yes` in that group. See [Who can talk to the agent](/docs/channels/#who-can-talk-to-the-agent).

## Running an instance

### I saved Config. Do I need to restart?

Saving **Setup → Config** applies Channel changes and access identities immediately. Startup settings, such as the HTTP port, Node providers, semantic search and the inbound MCP listener, need a restart. Model changes in **Setup → Models** never need one.

With Docker Compose, changing the port also means updating the port mapping and healthcheck. See [Docker Compose](/docs/installing/#docker-compose).

### How do I update?

Back up the data directory, then pull and restart from the program checkout, or rebuild the container. See [Update a source installation](/docs/data-upgrades-backups/#update-a-source-installation).

### What should I back up?

The whole data directory (`foxwarm-data` by default), taken while Foxwarm is stopped or with a SQLite-consistent backup. See [What to back up](/docs/data-upgrades-backups/#what-to-back-up).

### Where do I report a problem?

On the [issue tracker](https://github.com/550W-HOST/foxwarm/issues). Include the Foxwarm commit, platform, install method, the error and steps to reproduce. Remove tokens, API keys, private messages and personal paths from logs first.
