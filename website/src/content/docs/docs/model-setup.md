---
title: Set up your first model
description: Complete Foxwarm first-run setup with an OpenAI-compatible or Anthropic model provider.
sidebar:
  order: 2
---

Foxwarm opens its required first-run Setup screen when `state/models.yaml` is missing from the active data directory. Setup cannot be closed until a valid model configuration is saved.

## Open the local WebUI

Use the URL printed by the installer. It looks like:

```text
http://localhost:3001/#token=...
```

If you lost it, read the token from your data directory:

```bash
cat foxwarm-data/state/token
```

## Add a provider

In **Setup → Models**, enter YAML for one supported provider and use the built-in validation/test controls before saving. You need:

- a provider type;
- the provider's API base URL;
- one or more exact model IDs;
- an API key when the endpoint requires one;
- a default model in `provider/model` form.

A minimal OpenAI-compatible Chat Completions configuration looks like:

```yaml
default: my-provider/my-model
providers:
  my-provider:
    providerType: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    models:
      - my-model
```

Use `openai-responses` for an endpoint implementing the Responses API, or `anthropic` for an Anthropic-compatible endpoint. A local OpenAI-compatible gateway can leave `apiKey` empty when the gateway does not require one.

:::caution
Keep real API keys in your own `foxwarm-data/state/models.yaml`. Do not commit that file or paste credentials into public issues, docs, or screenshots.
:::

## What Setup writes

- Model configuration: `foxwarm-data/state/models.yaml`
- Application and Channel configuration: `foxwarm-data/state/config.yaml`
- WebUI access token: `foxwarm-data/state/token`

The exact location changes if you chose a custom data directory.

## Start a first conversation

After saving a working model, open the default Session and ask a small question that does not require tools. Then try a scoped file or shell task in a directory you are comfortable exposing to the Agent.

The bundled `about-foxwarm` Skill can explain concepts and point to deeper features after model setup is complete.

## Troubleshooting

- **Provider test fails:** check provider type, API base URL, model ID, and credentials.
- **Local gateway fails from Docker:** `localhost` inside a container refers to the container. Use a host-reachable address such as `host.docker.internal` where supported.
- **Bad manual config blocks setup:** fix or remove `state/models.yaml` in the data directory to return to first-run Setup.
- **No response:** inspect logs under `foxwarm-data/state/logs/`.

For virtual routing and failover, see the repository's [Virtual models guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/virtual-models.md).
