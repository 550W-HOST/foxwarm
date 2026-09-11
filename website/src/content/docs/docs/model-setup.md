---
title: Set up your first model
description: Configure an OpenAI-compatible or Anthropic model provider in Foxwarm first-run Setup.
sidebar:
  order: 2
---

When the active data directory has no `state/models.yaml`, Foxwarm opens first-run Setup and keeps it open until you save a valid model configuration.

## Open the local WebUI

Open the URL printed by the installer. It looks like:

```text
http://localhost:3001/#token=...
```

If you lost it, read the token from your data directory:

```bash
cat foxwarm-data/state/token
```

## Add a provider

Open **Setup → Models** and enter YAML for one supported provider. **Save models** validates the YAML and resolves the configured model entries. It does not send a live request to the provider. Include:

- a provider type
- the provider's API base URL
- one or more exact model IDs
- an API key when the endpoint requires one
- a default model in `provider/model` form

Here is a minimal OpenAI-compatible Chat Completions configuration:

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

## Files used by Setup

- Model configuration: `foxwarm-data/state/models.yaml`
- Application and Channel configuration: `foxwarm-data/state/config.yaml`
- WebUI access token: `foxwarm-data/state/token`

These paths follow the custom data directory if you chose one.

## Try a first conversation

After saving the model configuration, open the default Session and ask a small question that does not require tools. This first reply is also a simple live check of the provider connection. You can then try a scoped file or shell task in a directory you are comfortable giving the Agent access to.

The bundled `about-foxwarm` Skill can explain concepts and point to deeper features after model setup is complete.

## Troubleshooting

- If the first prompt fails, check the provider type, API base URL, model ID, and credentials.
- In Docker, `localhost` refers to the container. Use a host-reachable address such as `host.docker.internal` where supported.
- If a manually edited config blocks setup, fix or remove `state/models.yaml` in the data directory to return to first-run Setup.
- If WebUI shows no response, inspect `foxwarm-data/state/logs/`.

For virtual routing and failover, see the repository's [Virtual models guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/virtual-models.md).
