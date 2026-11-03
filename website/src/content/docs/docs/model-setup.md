---
title: Set up your first model
description: Configure an OpenAI-compatible or Anthropic model provider in Foxwarm first-run Setup.
sidebar:
  order: 2
---

When the active data directory has no `state/models.yaml`, Foxwarm opens first-run Setup and keeps it open until you save a valid model configuration.

Open the WebUI using the installer's login URL. If you need to recover it, follow [Open the WebUI](/docs/installing/#open-the-webui).

## Add a provider

First-run Setup opens on **Setup → Models** with a short form:

1. **Service** — pick OpenAI, Anthropic, OpenRouter, DeepSeek, Ollama, or **Other service** for any compatible endpoint. A service fills in the API type and base URL; you can change both.
2. **API type** — `OpenAI-compatible (Chat Completions)`, `OpenAI Responses`, or `Anthropic Messages`.
3. **API key** — required for hosted services. A local server such as Ollama can leave it empty.
4. **Models** — select **Load models** to fetch the service's model list, then pick one, or type an exact model ID and press Enter. When the service reports a model's context and output limits, or that it can't read images, Setup saves that with the model.
5. **Default model** — the model new conversations use.

Select **Test connection** to send one short message to the default model, then **Save models**. First-run Setup will not finish while the API key is still a placeholder or missing for a hosted service that needs one.

The form writes `models.yaml` for you. Switch to **YAML** at any time to see or edit the file directly. The YAML view is also where aliases, failover, several providers and other model options live. When a saved file uses settings like these, Setup opens it in YAML so nothing is lost.

The same configuration in YAML looks like this:

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

Use `openai-responses` for an endpoint implementing the Responses API, or `anthropic` for an Anthropic-compatible endpoint. A local OpenAI-compatible gateway can leave `apiKey` empty when the gateway does not require one. **Save models** validates the YAML and resolves the model entries; only **Test connection** or your first message sends a live request.

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

- If the API key is rejected or the model ID is unknown, the reply fails right away with the cause and a link to the model settings. Fix the key or model in **Setup → Models**.
- If the first prompt fails for another reason, check the provider type, API base URL, model ID, and credentials. **Test connection** shows the provider's response.
- In Docker, `localhost` refers to the container. Use a host-reachable address such as `host.docker.internal` where supported.
- If a manually edited config blocks setup, fix or remove `state/models.yaml` in the data directory to return to first-run Setup.
- If WebUI shows no response, inspect `foxwarm-data/state/logs/`.

Once basic chat works, see [Model options and routing](/docs/model-options/) for reasoning effort, aliases, failover, hosted search, and image generation.
