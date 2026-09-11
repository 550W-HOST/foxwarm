---
title: FAQ
description: Common Foxwarm installation, WebUI, model, data, Node, and documentation questions.
---

## Is foxwarm.550w.host a hosted Foxwarm service?

No. It is the static project website, documentation site, and installer download host. Your WebUI, API, data, model credentials, and Agents run on the machine where you install Foxwarm.

## Where is my login token?

The installer prints a URL containing the token. You can also read `foxwarm-data/state/token` (or `state/token` under your custom data directory) and open:

```text
http://localhost:3001/#token=<token>
```

## Why is Setup locked open?

Foxwarm requires a valid model configuration. When `state/models.yaml` is absent, first-run Setup remains open until you save and validate a model provider.

## Do I need an OpenAI account?

No specific vendor is mandatory. Foxwarm supports configured OpenAI-compatible and Anthropic-compatible providers. You need a reachable endpoint, an exact model ID, and any credentials required by that endpoint.

## Do I need a Node?

No. `master` is the default local Node. Pair another Node only when tools should run in a different environment or you want a specific remote/browser/interactive capability.

## Do I need a messaging Channel?

No. WebUI is enough for a complete local workflow. Telegram, Matrix, WeWork, Weixin, and QQ Bot are optional adapters.

## Is Agent memory the same as chat history?

No. Agent memory is curated long-lived Markdown. Session history is the conversation and tool record. Optional Vector memory is a derived semantic index over archived context.

## Why does a local model URL fail in Docker?

Inside a container, `localhost` points to the container itself. Use an address that reaches the host model service, such as `host.docker.internal` where supported, and ensure the service accepts that connection.

## How do I change the WebUI port?

Set `bot.httpPort` in `foxwarm-data/state/config.yaml`. For Docker Compose, update the compose port mapping and healthcheck to match.

## How do I inspect startup problems?

- Linux/macOS/WSL: `tmux attach -t foxwarm`
- Any default install: inspect `foxwarm-data/state/logs/`
- Windows: `npm run status:windows`

## Where are the deeper technical docs?

The project repository keeps architecture and reference guides under [`docs/`](https://github.com/550W-HOST/foxwarm/tree/main/docs). Contributors and coding agents should start with the [Code Index](https://github.com/550W-HOST/foxwarm/tree/main/docs/code-index).
