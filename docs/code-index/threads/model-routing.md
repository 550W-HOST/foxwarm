# Thread: model routing

## Overview

This thread owns the cross-module contract for concrete and virtual model selection, prompt-cache-lineage routing, per-attempt failover, provider request rebuilding, response usability, model attribution, and setup/CLI exposure.

## Configuration and resolved graph

Concrete provider entries continue to use `providerType` plus provider connection fields and `models`. The preferred field remains `providerType`; persisted legacy `provider` is only a reader when `providerType` is absent.

Two virtual `providerType` values are supported:

- `session-hash` — stable session-prefix routing.
- `failover` — ordered health-aware fallback.

A virtual entry uses `targets`, containing model lookup keys that resolve strictly to concrete leaves in the same models-config snapshot. Canonical identity is an actual expansion key, so slash-containing model IDs remain exact and a single-model bare alias and qualified key resolve to the same leaf. Version 1 rejects empty targets, unknown targets, self references, virtual-to-virtual references, and aliases that resolve to the same canonical concrete target. `session-hash` accepts one or more targets; `failover` requires at least two.

Virtual entries do not accept `models`, legacy `model`, `baseUrl`, `apiKey`, `requestCompression`, `extraFields`, `extraHeaders`, `contextLimit`, or `asyncCompact`. `session-hash` also rejects failover-only threshold/cooldown fields. Concrete entries reject virtual routing fields. Provider entries must be plain objects, and failover threshold/cooldown values are positive integers. Request connection and serialization fields always come from the selected concrete leaf.

The resolved virtual model reports:

- the minimum reachable concrete `contextLimit`;
- async compaction enabled only when every reachable leaf allows it;
- canonical concrete target keys;
- failover defaults of five consecutive failures and a 600,000 ms cooldown;
- a deterministic configuration fingerprint covering strategy and the complete resolved leaf request configuration. Secret inputs and header/extra maps contribute through hashes and are not retained in virtual routing metadata.

## Request flow

1. `requestLlmOnce` resolves one models-config snapshot and one prompt-cache routing key for the entire outer request.
2. A concrete model uses its resolved entry directly. A virtual model selects one concrete target for the current attempt.
3. Every outer attempt rebuilds the selected leaf's URL, credentials, headers, payload, request compression, provider serializer, stream collector, and response parser.
4. A successful result records the concrete provider-qualified model ID. The session's selected model remains the virtual key.
5. Retry callbacks retain the compatibility `maxRetries` field, whose value is the total attempt limit. The default total attempt limit is six.

Virtual providers add no retry loop of their own. The one LLM outer loop remains the owner of attempts, delay, abort handling, diagnostics, and terminal `LlmRequestError` creation.

## Session-hash routing

`session-hash` uses SHA-256 highest-random-weight (rendezvous) hashing over the virtual model key, the resolved `Session.promptCacheKey` lineage value, and each canonical target key. The target with the greatest digest wins; a canonical target-key tie break keeps the result independent of configured target order.

The request routing key is resolved once before the attempt loop. Normal sessions persist a random low-sensitivity UUID tied to the model-facing prefix. Forks and same-prefix side/compact requests inherit it; successful compaction and clear operations rotate it. Consequently, forks stay on the same virtual leaf while a rewritten prefix may be re-routed.

A low-level request without a usable key receives one request-scoped random key; retries do not generate another key.

## Failover health

Failover health is process memory, scoped by virtual model key, configuration fingerprint, and canonical concrete target. It is not session state and is not persisted. Restart and configuration changes reset the active route state. Each independent outer request captures the active fingerprint generation once; retries and outcomes continue against that request's local snapshot after another configuration becomes active, including reaching and terminating on its own final target. Detached requests cannot publish into the newer active state, while a later independent request that deliberately rolls back configuration activates a fresh generation.

Selection chooses the first configured target that is not cooling down. Outcomes are applied synchronously in completion order:

- a countable failure increments only the selected target's consecutive-failure streak;
- reaching `failureThreshold` cools a non-final target for `cooldownMs`;
- cooldown expiry removes the old streak before the target becomes eligible again;
- success resets only the successful target;
- a countable failure from the configured final target clears the route's health and terminates the current request, so the next independent request starts from the first target.

With defaults and two targets, attempts 1–5 may fail on A, the fifth failure cools A, and attempt 6 selects B.

## Failure and response usability

Failures that are retryable and count toward failover health:

- network, DNS, TLS, timeout, and stream failures;
- HTTP 408, 429, 5xx, and 529;
- HTTP 401, 403, and 404;
- model-not-found responses, including HTTP 400 bodies identified by nested structured error code/type or bounded model-specific text patterns;
- malformed or unusable successful responses.

HTTP 400, 413, and 422 are terminal and do not affect route health unless the body identifies model-not-found. Other HTTP statuses preserve the prior retry behavior but do not affect shared route health until explicitly classified.

Abort, stop, and cancellation terminate immediately and do not count as target health failures.

Across OpenAI Chat Completions, OpenAI Responses, Anthropic, and compatible concrete providers, a successful model turn must contain non-whitespace assistant content or at least one tool call. Thinking/reasoning alone is not content. A tool-call-only response is valid. An empty, whitespace-only, or reasoning-only response is a retryable `response-error` and never creates fake model-visible `Error:` history.

## Surfaces and attribution

- Session and WebUI model selection continue to expose the configured virtual key.
- `ChatResult.modelId`, assistant `__meta.modelId`, logs, and retry diagnostics identify the concrete leaf used by that attempt or success.
- WebUI Setup presents Models as raw YAML only. Its local static schema and current-document suggestions are advisory; save uses the canonical config validator and remains byte-preserving after validation.
- Structured setup input accepts virtual targets and failover settings; setup diagnostics expose `isVirtual`, `targets`, `failureThreshold`, and `cooldownMs`. The model-list API also exposes provider type, virtual status, resolved targets, and effective context limit without leaf credentials.
- The one-shot model CLI lists and accepts virtual keys while reusing production routing.
- Raw model readers that need concrete credentials, such as the bundled web-search helper, skip virtual entries and inspect concrete providers only.
- The active models file follows [D-config-models-data-path](../units/src-config.md#d-config-models-data-path); the packaged template is only a missing-file read fallback.

## Modules and units

- [LLM module](../modules/llm.md)
- [src-config](../units/src-config.md)
- [src-model-routing](../units/src-model-routing.md)
- [src-llm](../units/src-llm.md)
- [src-channels-webui](../units/src-channels-webui.md)
- [model-cli](../units/model-cli.md)
- [src-skills](../units/src-skills.md)
- Prefix lifecycle: [D-lifecycle-prefix-lineage](./session-lifecycle.md#d-lifecycle-prefix-lineage)
- Retry presentation: [D-pipeline-display-only-retries](./message-processing-pipeline.md#d-pipeline-display-only-retries)

## Design decisions

### D-model-routing-provider-type

Virtual routing remains a `providerType` contract. `session-hash` and `failover` are the two current values; the schema does not introduce a replacement `type` field. Concrete legacy `provider` remains a fallback reader only.

### D-model-routing-leaf-only

Version 1 virtual targets are strict concrete leaves. Canonical identity is the actual qualified expansion key, not a reconstruction from the raw model ID. Reject nesting and canonical duplicates rather than defining recursive health, attribution, or cycle semantics implicitly.

### D-model-routing-prefix-hash

Session hashing uses stable SHA-256 rendezvous hashing namespaced by the virtual key and driven by prompt-cache prefix lineage. Target ordering does not affect hash selection.

### D-model-routing-outer-attempts

There is one outer LLM attempt loop, with six total attempts by default. Each virtual attempt selects a leaf and rebuilds the complete concrete request; virtual providers do not contain another retry loop. Compatibility surfaces retain the historical `maxRetries` field name even though it means total attempts.

### D-model-routing-failover-health

Failover health is process-local, configuration-fingerprinted, generation-scoped, and completion-ordered. Activation happens once per independent outer request; detached retries retain local failover semantics but cannot reactivate or mutate a newer configuration. Success resets one target, cooldown expiry starts a fresh streak, and final-target failure always ends that request while only an active generation resets global route state.

### D-model-routing-usable-response

A provider success requires non-whitespace assistant content or a tool call. Reasoning-only and empty responses are retryable response failures across all provider protocols.

### D-model-routing-concrete-attribution

Configured selection surfaces retain the virtual key, while result/history attribution records the concrete leaf that actually succeeded.
