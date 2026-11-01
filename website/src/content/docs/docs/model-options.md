---
title: Model options and routing
description: Configure several providers, switch models per Session, set reasoning effort and limits, route with aliases and failover, and enable hosted search or image generation.
---

All model configuration lives in `state/models.yaml`, which you edit in **Setup → Models**. The editor validates the YAML and suggests field names as you type. Saving applies to the next request; nothing needs a restart. A request already in progress finishes with the settings it started with.

Start with one working provider from [Set up your first model](/docs/model-setup/). This page covers what you can add after that. Model names in the examples are placeholders; use the IDs your endpoint offers.

## A fuller example

```yaml
default: daily                       # for Sessions without a choice

providers:
  gateway:                           # an OpenAI-compatible endpoint
    providerType: openai-responses
    baseUrl: https://api.example.com/v1
    apiKey: replace-with-your-key
    effort:
      allowed: [low, medium, high]
      default: medium
    models:
      - fast-model                   # a plain model ID
      - id: big-model                # or an object with per-model settings
        contextLimit: 400000
        pricing: { cached: 0.5, input: 2, output: 8 }

  claude:                            # an Anthropic-compatible endpoint
    providerType: anthropic
    baseUrl: https://anthropic.example.com
    apiKey: replace-with-your-key
    models: [writer-model]

  daily: gateway/fast-model          # a short alias

  resilient:                         # try big-model, fall back to writer-model
    providerType: failover
    targets: [gateway/big-model, claude/writer-model]
```

Models are referred to as `provider/model`, for example `gateway/big-model`, or by an alias such as `daily`.

## Switch models

Each Session has its own model. Pick one from the model menu next to the message box, or type:

```text
/model                          show the current model and the choices
/model writer                   switch; a partial name is enough
/model big-model --effort high  switch model and effort together
/model --effort low             change only the effort
/model default                  go back to the configured default
```

Changing the model does not lose the conversation; the next request sends the same history to the new model. Agents can also start [child Sessions](/docs/delegation/) on a different model, for example a cheaper one for routine checks.

## API formats

| `providerType` | Use it for |
| --- | --- |
| `openai-completions` | OpenAI-compatible Chat Completions endpoints, including most local servers and gateways |
| `openai-responses` | OpenAI-compatible Responses endpoints |
| `openai-ws` | Responses endpoints that also support the WebSocket transport |
| `anthropic` | Anthropic-compatible endpoints |

`openai` is accepted as another name for the Responses format. Speaking a format does not guarantee that a gateway supports every optional feature, so get a normal chat working before turning on hosted tools or WebSocket transport.

The WebSocket transport reuses an open connection for later requests. Foxwarm still keeps the full conversation itself; the connection cache is simply rebuilt after a restart.

## Reasoning effort

Foxwarm recognizes `none`, `low`, `medium`, `high`, `xhigh` and `max`. Declare which levels your endpoint accepts and which to use by default:

```yaml
effort:
  allowed: [low, medium, high]
  default: medium
```

Put this on a provider, or on an individual model object to override it for that model. A model's `allowed` list replaces the provider's; fields it leaves out are inherited. Without any `effort` setting, all six levels are allowed and the default is `high`, so restrict the list if your endpoint rejects some of them.

The effort picker next to the message box shows the allowed levels for the Session's model. If a routed model does not accept the selected level, Foxwarm uses that model's default.

## Per-model settings

These go on a model object (`- id: ...`) or, for all of a provider's models, on the provider:

| Field | Purpose |
| --- | --- |
| `contextLimit` | The model's context window in tokens. Compaction is triggered relative to it. Default 200,000. |
| `maxOutput` | Requested output-token limit. Default 32,768. |
| `upstreamModelId` | The model name sent to the endpoint, when it differs from the ID you want to use in Foxwarm (model objects only). |
| `pricing` | `{ cached, input, output }` in USD per million tokens. Foxwarm then saves an estimated cost with each reply's token usage (model objects only). |
| `extraFields`, `extraHeaders` | Extra request-body fields or HTTP headers an endpoint needs. |
| `providerImageOutputFormat` | Format for images Foxwarm optimizes before sending them: `webp` (default) or `jpeg`. |

To change a setting for every model, use the root `defaults` block. It accepts only `contextLimit`, `maxOutput` and `providerImageOutputFormat`:

```yaml
defaults:
  contextLimit: 200000
  maxOutput: 32768
```

A model's own value wins over its provider's, which wins over `defaults`.

## Aliases, sticky routing and failover

Besides concrete providers, `models.yaml` can define routes that point at concrete models:

- **Alias**: `daily: gateway/fast-model`. A short, stable name. Change what it points to later without touching the Sessions that use it.
- **Failover** (`providerType: failover`): tries `targets` in order. A target that keeps failing is skipped for a while (by default after 5 consecutive failures, for 10 minutes; set `failureThreshold` and `cooldownMs` to change this). Needs at least two targets.
- **Sticky spread** (`providerType: session-hash`): spreads Sessions across several equivalent `targets`, but keeps each conversation on the same one so the provider's prompt cache stays warm.

Targets must be concrete models from the same file; a route cannot point at another route. A route is selectable like any model, and its context limit is the smallest of its targets'. Each reply in the history records which concrete model actually answered. See the repository's [virtual models reference](https://github.com/550W-HOST/foxwarm/blob/main/docs/virtual-models.md) for every option.

## Hosted search and image generation

A Responses endpoint that offers hosted tools can provide web search and image generation next to Foxwarm's own tools. Turn them on in a Responses provider or a model object:

```yaml
webSearch: true
imageGeneration: true
```

Enable only what your endpoint supports. Foxwarm rejects image generation on other provider types. These are the provider's own tools; they are separate from MCP servers and do not run on a Node.

Both accept an object for finer control:

```yaml
webSearch:
  enabled: true
  toolChoice: auto              # or required
  searchContextSize: medium

imageGeneration:
  enabled: true
  outputFormat: png             # png, jpeg or webp
  background: transparent
```

Other image options are `action`, `model`, `size`, `quality` and `outputCompression` (0–100, for JPEG or WebP). The endpoint decides which values it actually supports.

Search results and citations appear in the timeline. Generated images stay in the Session after reloading; keep the same model to keep editing an image, since another model does not receive the original generation result. Hosted tools are not used during compaction. Model-level settings override the provider's, and `false` turns a tool off.

## Compatibility settings

Most endpoints need none of these. Use them when a particular gateway behaves differently.

- **`historyReasoningField: reasoning`** (Chat Completions only): for endpoints that return thinking in `reasoning_content` but expect earlier thinking back under `reasoning`. The default is `reasoning_content`.
- **`disallowEmptyResponse: true`**: by default, a completed reply with no text and no tool call ends the turn normally. Set this for an endpoint that sometimes returns empty replies by mistake, so Foxwarm retries them instead.
- **`sameModelAs` / `sameProviderAs`**: tell Foxwarm that two configured entries serve the same model, for example the same model through two gateways. Switching between them then keeps provider-specific history such as reasoning, which is otherwise dropped when the model changes.

Compaction thresholds are not set here; see [Long conversations](/docs/history-search/#compaction).
