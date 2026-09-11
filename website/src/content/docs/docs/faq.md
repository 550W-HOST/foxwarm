---
title: FAQ
description: Answers to common questions about installing, configuring, and running Foxwarm.
---

## Is foxwarm.550w.host a hosted Foxwarm service?

No. The domain serves the static project site, documentation, and installer files. Your WebUI, API, data, model credentials, and Agents stay on the machine where you install Foxwarm.

## Where is my login token?

The installer prints a URL containing the token. You can also read `foxwarm-data/state/token` (or `state/token` under your custom data directory) and open:

```text
http://localhost:3001/#token=<token>
```

## Why is Setup locked open?

Foxwarm needs a valid model configuration before it can open the rest of WebUI. First-run Setup stays open while `state/models.yaml` is absent.

## Do I need an OpenAI account?

Foxwarm supports OpenAI-compatible and Anthropic-compatible providers. You need a reachable endpoint, an exact model ID, and any credentials that endpoint requires.

## Do I need a Node?

No. `master` is the default local Node. Pair another Node when tools need a different environment or a remote, browser, or interactive capability.

## Do I need a messaging Channel?

No. WebUI supports the local workflow by itself. Telegram, Matrix, WeWork, Weixin, and QQ Bot are optional adapters.

## Is Agent memory the same as chat history?

They serve different purposes. Agent memory is curated long-lived Markdown, Session history is the active conversation and tool record, and optional Vector memory is a derived semantic index over archived context.

## Why does a local model URL fail in Docker?

Inside a container, `localhost` points back to the container. Use an address that reaches the model service on the host, such as `host.docker.internal` where supported, and make sure the service accepts the connection.

## How do I change the WebUI port?

Set `bot.httpPort` in `foxwarm-data/state/config.yaml`. For Docker Compose, update the compose port mapping and healthcheck to match.

## How do I inspect startup problems?

- Linux/macOS/WSL: `tmux attach -t foxwarm`
- Any default install: inspect `foxwarm-data/state/logs/`
- Windows: `npm run status:windows`

## Where are the deeper technical docs?

Architecture and reference guides live in the repository under [`docs/`](https://github.com/550W-HOST/foxwarm/tree/main/docs). Contributors and coding agents can use the [Code Index](https://github.com/550W-HOST/foxwarm/tree/main/docs/code-index) to find the relevant source.
