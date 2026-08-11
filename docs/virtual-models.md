# Virtual models

Foxwarm supports two virtual provider types in `state/models.yaml`:

- `session-hash` keeps sessions with the same prompt-cache lineage on a stable
  concrete model through deterministic rendezvous hashing.
- `failover` tries concrete targets in order and temporarily cools unhealthy
  non-final targets.

Define concrete providers and reference their model keys from virtual entries:

```yaml
default: sticky
providers:
  openai:
    providerType: openai-completions
    baseUrl: https://api.openai.com/v1
    apiKey: your-openai-key
    models:
      - gpt-5.6-sol
      - gpt-5.6-terra
      - gpt-5.6-luna

  anthropic:
    providerType: anthropic
    baseUrl: https://api.anthropic.com
    apiKey: your-anthropic-key
    models:
      - claude-opus-5

  sticky:
    providerType: session-hash
    targets:
      - openai/gpt-5.6-sol
      - anthropic/claude-opus-5

  resilient:
    providerType: failover
    targets:
      - openai/gpt-5.6-terra
      - anthropic/claude-opus-5
    failureThreshold: 5
    cooldownMs: 600000
```

Targets must resolve directly to distinct concrete leaves in the same config.
Virtual-to-virtual targets, unknown targets, self references, and duplicate
aliases of the same concrete model are rejected. `session-hash` requires at
least one target; `failover` requires at least two.

Virtual entries contain routing fields only. They do not accept credentials,
endpoints, model lists, request compression, extra request fields or headers,
context limits, effort overrides, or async-compaction overrides. Their exposed
effort capabilities are the ordered union of their concrete leaves. A physical
attempt uses the requested effort when its selected leaf allows it and otherwise
falls back to that leaf's configured default. `session-hash` does not accept
failover thresholds or cooldowns. Concrete entries do not accept virtual
routing fields.

Failover health is process-local and resets after restart or routing-config
changes. The defaults are five consecutive failures and a 600,000 ms cooldown.
Foxwarm keeps one outer retry loop and rebuilds each attempt from the selected
concrete provider. Successful history records the concrete model that answered
while model-selection surfaces continue to show the configured virtual key.

For the canonical implementation contract, see
[model routing](code-index/threads/model-routing.md).
