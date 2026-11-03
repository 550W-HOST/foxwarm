---
title: Set up your first model
description: Configure an OpenAI-compatible or Anthropic model provider in Foxwarm first-run Setup.
sidebar:
  order: 2
---

When the active data directory has no `state/models.yaml`, Foxwarm opens first-run Setup and keeps it open until you save a valid model configuration.

Open the WebUI using the installer's login URL. If you need to recover it, follow [Open the WebUI](/docs/installing/#open-the-webui).

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

When first-run Setup saves the model configuration, Foxwarm creates the `main` Agent's default Session `main` and opens it when you close Setup. It starts with a prepared welcome in your browser's language (English or Chinese; other languages get English), so it appears even before the provider has answered anything. Reply to it with a small question or with the name you want to be called. That first reply is a simple live check of the provider connection. You can then try a scoped file or shell task in a directory you are comfortable giving the Agent access to.

Installations that already have Sessions, and later model saves, do not create or change any Session. To start another conversation, use **+** above the Session list.

The bundled `about-foxwarm` Skill can explain concepts and point to deeper features after model setup is complete.

## Troubleshooting

- If the first prompt fails, check the provider type, API base URL, model ID, and credentials.
- In Docker, `localhost` refers to the container. Use a host-reachable address such as `host.docker.internal` where supported.
- If a manually edited config blocks setup, fix or remove `state/models.yaml` in the data directory to return to first-run Setup.
- If WebUI shows no response, inspect `foxwarm-data/state/logs/`.

Once basic chat works, see [Model options and routing](/docs/model-options/) for reasoning effort, aliases, failover, hosted search, and image generation.
