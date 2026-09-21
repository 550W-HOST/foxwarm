---
title: Model options and routing
description: Set reasoning effort, route between models, and enable supported hosted search or image generation.
---

Start with a working provider from [model setup](/docs/model-setup/). The settings below go in `state/models.yaml`, which you can edit in **Setup → Models**. Use the model IDs and capabilities offered by your endpoint; the names in these examples are placeholders.

## Choose the API format

| `providerType` | Use it for |
| --- | --- |
| `openai-completions` | OpenAI-compatible Chat Completions endpoints |
| `openai-responses` | OpenAI-compatible Responses endpoints |
| `openai-ws` | Responses endpoints that also support the WebSocket transport |
| `anthropic` | Anthropic-compatible endpoints |

`openai` is also accepted for the Responses format. Matching an API format does not guarantee that a gateway supports every optional feature. Start with a normal chat request before enabling hosted tools or WebSocket transport.

The WebSocket transport can reuse a completed connection for later requests. It does not replace Foxwarm's stored conversation history, and its connection cache is lost on restart.

## Reasoning effort

Set the levels a provider accepts and the default to use when a Session has not selected one:

```yaml
default: my-provider/my-model
providers:
  my-provider:
    providerType: openai-responses
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    effort:
      allowed: [low, medium, high]
      default: medium
    models:
      - my-model
```

Foxwarm recognizes `none`, `low`, `medium`, `high`, `xhigh`, and `max`. If `effort` is omitted, Foxwarm allows all six and defaults to `high`; restrict the list to match your endpoint.

A model can override its provider's effort settings. Its `allowed` list replaces the provider list, while omitted fields inherit. The default must be in the resulting allowed list. For example, this entry can replace `- my-model` above:

```yaml
- id: my-model
  effort:
    allowed: [low, high]
    default: high
```

## Aliases and routing

A short alias gives a concrete model a convenient selectable name. Add an alias beside your existing provider entries:

```yaml
default: daily
providers:
  my-provider:
    providerType: openai-completions
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    models: [my-model]
  daily: my-provider/my-model
```

For several endpoints, Foxwarm also supports:

- `session-hash`: assigns a Session's prompt-cache lineage to a stable target from a list.
- `failover`: tries targets in order and temporarily avoids unhealthy non-final targets.

Routing targets must be concrete models in the same configuration; virtual routes cannot target other virtual routes. When a selected target does not accept the requested effort, Foxwarm uses that target's default. See [Virtual models](https://github.com/550W-HOST/foxwarm/blob/main/docs/virtual-models.md) for complete routing examples and failure settings.

## Hosted search and image generation

A compatible Responses endpoint can provide hosted tools alongside Foxwarm's own function tools. Add these fields inside a Responses provider, or inside an individual model entry:

```yaml
webSearch: true
imageGeneration: true
```

Enable only the features your endpoint supports. These flags do not configure an external MCP server, and they do not make hosted search available as a Node tool.

For search, an options object can request automatic or required use and adjust the requested context size:

```yaml
webSearch:
  enabled: true
  toolChoice: auto
  searchContextSize: medium
```

The WebUI displays returned search activity and source citations. Hosted search is not used for compaction planning or Setup test requests.

For generated images, start with the defaults. Add options only when you need a particular output:

```yaml
imageGeneration:
  enabled: true
  action: auto
  outputFormat: png
  background: transparent
```

Generated images appear in the WebUI and remain available after reloading the Session. Continue with the same concrete model for native iterative editing. Switching models does not carry the original hosted-generation result into the new model's request.

Other image options include `model`, `size`, `quality`, and `outputCompression`. Valid output formats are `png`, `jpeg`, and `webp`; compression is a value from 0 to 100 for JPEG or WebP. JPEG cannot preserve a transparent background. The endpoint determines which image models, sizes, and quality settings it actually supports. Foxwarm rejects enabled image generation on non-Responses providers.

Both hosted-tool settings accept `false` to disable them. Model-level options override provider settings; unspecified tuning fields inherit. Hosted image generation is not used for compaction planning or Setup test requests.

## Chat Completions reasoning compatibility

Some compatible endpoints return thinking in `reasoning_content` but require previous thinking under `reasoning` in later requests. If your endpoint requires that dialect, set this inside its `openai-completions` provider:

```yaml
historyReasoningField: reasoning
```

The default is `reasoning_content`. These are the only two values, and the setting applies only to Chat Completions providers. An individual model can override it when models behind one endpoint use different formats.
